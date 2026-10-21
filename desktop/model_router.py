"""Bounded Gemini discovery, visual smoke tests and transparent failover."""
from __future__ import annotations

import base64
import hashlib
import json
import re
import socket
import struct
import threading
import time
import zlib
from datetime import datetime,timezone
from urllib.error import URLError
from request_limiter import TaskCancelled
from provider_api import vision_model_error


SUCCESS_TTL = 300
FAILURE_COOLDOWN = 60
MAX_SELECTION_ATTEMPTS = 4
MAX_REQUEST_ATTEMPTS = 3


def is_annotation_candidate(model: str) -> bool:
    name=model.lower()
    return name.startswith('gemini') and not any(word in name for word in ('image','tts','audio','embedding','robotics'))


def visual_probe_data_url() -> str:
    width,height=160,112
    raw=bytearray()
    for y in range(height):
        raw.append(0)
        for x in range(width):
            color=(255,255,255)
            if 8<=y<43:
                if 8<=x<43:color=(0,180,0)
                elif 62<=x<97:color=(0,70,240)
                elif 116<=x<151:color=(255,140,0)
            if 60<=y<=104 and abs(x-80)<=(y-60)/2:color=(0,0,0)
            raw.extend(color)
    def chunk(kind,data):
        return struct.pack('>I',len(data))+kind+data+struct.pack('>I',zlib.crc32(kind+data)&0xffffffff)
    png=b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('>IIBBBBB',width,height,8,2,0,0,0))+chunk(b'IDAT',zlib.compress(bytes(raw)))+chunk(b'IEND',b'')
    return 'data:image/png;base64,'+base64.b64encode(png).decode('ascii')


def probe_payload(model: str) -> dict:
    return {'model':model,'stream':False,'max_tokens':768,'messages':[{'role':'user','content':[
        {'type':'text','text':'Inspect this image. Return only JSON with colors (English names of the colored squares) and black_triangles (the count of black triangles). Do not count the white background. No explanation.'},
        {'type':'image_url','image_url':{'url':visual_probe_data_url()}}
    ]}]}


def probe_answer_is_valid(data: dict) -> bool:
    content=data['choices'][0]['message']['content']
    if isinstance(content,list):content='\n'.join(str(p.get('text','')) for p in content if isinstance(p,dict))
    decoder=json.JSONDecoder()
    for match in reversed(list(re.finditer(r'\{',content))):
        try:
            value,_=decoder.raw_decode(content[match.start():])
            if not isinstance(value,dict):continue
            colors=value.get('colors')
            count=value.get('black_triangles')
            if isinstance(colors,list) and {str(c).strip().lower() for c in colors}=={'green','blue','orange'} and count==1 and not isinstance(count,bool):return True
        except (ValueError,TypeError):continue
    return False


def error_category(status: int, body: bytes) -> str:
    if status in (401,403):return 'auth_or_quota'
    if status==429:return 'rate_limited'
    if status in (404,405):return 'model_or_route_not_found'
    if status==503 and b'routing configuration unavailable' in body.lower():return 'routing_unavailable'
    if status in (500,502,503,504,520,521,522,523,524,529):return 'temporarily_unavailable'
    return 'request_error'


class SelectionError(RuntimeError):
    def __init__(self,message,attempted=None,status=503):
        super().__init__(message)
        self.attempted=attempted or []
        self.status=status


class GeminiRouter:
    def __init__(self,requester,catalog_loader,validator):
        self.requester=requester
        self.catalog_loader=catalog_loader
        self.validator=validator
        self.lock=threading.RLock()
        self.selection_lock=threading.Lock()
        self.states={}

    def _state(self,runtime):
        fingerprint=hashlib.sha256(json.dumps([runtime.get('api_url'),runtime.get('api_key'),runtime.get('proxy_url')]).encode()).hexdigest()
        with self.lock:
            if fingerprint not in self.states:
                self.states[fingerprint]={'models':[],'catalog_at':0,'health':{},'active_model':'','job':None,'cancel':threading.Event()}
            return self.states[fingerprint]

    def catalog(self,runtime,force=False):
        state=self._state(runtime)
        with self.lock:
            if state['models'] and not force and time.monotonic()-state['catalog_at']<600:return state['models'][:]
        try:models=self.catalog_loader(runtime)
        except TaskCancelled:raise
        except Exception as exc:
            if not runtime.get('auto_model') and runtime.get('models'):
                models=runtime['models']
            else:
                status=getattr(exc,'code',503)
                raise SelectionError('无法获取模型列表，请检查服务商 /models 接口、网络和 Key 权限',status=status if status in {401,403,429} else 503) from exc
        models=list(dict.fromkeys(name for name in models if isinstance(name,str) and (not runtime.get('auto_model') or name.lower().startswith('gemini')) and len(name)<=160))[:100]
        if not runtime.get('auto_model'):models=list(dict.fromkeys([runtime.get('model',''),*runtime.get('models',[]),*models]))[:100]
        if not models:raise SelectionError('模型接口没有返回 Gemini 列表，请检查服务商模型权限')
        with self.lock:state['models']=models;state['catalog_at']=time.monotonic()
        return models

    def _record(self,runtime,model,status,category='',latency=None):
        state=self._state(runtime)
        with self.lock:
            old=state['health'].get(model,{})
            verified=time.monotonic() if status=='vision_ok' else old.get('verified_at',0)
            state['health'][model]={'model':model,'status':status,'category':category,'checked_at':datetime.now(timezone.utc).isoformat(timespec='seconds'),'latency_seconds':latency,'verified_at':verified,'cooldown_until':0 if status=='vision_ok' else time.monotonic()+FAILURE_COOLDOWN}

    def candidates(self,runtime,excluded=()):
        state=self._state(runtime)
        models=self.catalog(runtime)
        preferred=runtime.get('model','')
        pool=[m for m in models if is_annotation_candidate(m) and (runtime.get('allow_pro') or 'pro' not in m.lower() or m==preferred)]
        # Only well-known low-cost text/vision families are automatic fallbacks.
        # Unknown families (for example argon) remain manually selectable/probeable.
        pool=[m for m in pool if 'flash' in m.lower() or (runtime.get('allow_pro') and 'pro' in m.lower()) or m==preferred]
        anchors=['gemini-3.1-flash-lite-preview','gemini-3.5-flash-lite','gemini-3.1-flash-lite','gemini-2.5-flash-lite','gemini-2.5-flash','gemini-3-flash-preview','gemini-3-flash']
        with self.lock:
            now=time.monotonic()
            health=state['health']
            active=state['active_model']
            def order(model):
                row=health.get(model,{})
                valid=row.get('status')=='vision_ok' and now-row.get('verified_at',0)<SUCCESS_TTL
                return (0 if valid and model==active else 1 if valid else 2 if model==preferred else 3 if model in anchors else 4,anchors.index(model) if model in anchors else 0,model)
            return sorted([m for m in pool if m not in excluded and health.get(m,{}).get('cooldown_until',0)<=now],key=order)

    def probe_one(self,runtime,model,timeout=20):
        if vision_model_error(runtime,model):
            self._record(runtime,model,'not_candidate','image_not_supported')
            return {'ok':False,'model':model,'category':'image_not_supported'}
        start=time.monotonic()
        try:
            status,_,body=self.requester(json.dumps(probe_payload(model)).encode(),{**runtime,'model':model,'_request_kind':'probe'},timeout=timeout)
            if not 200<=status<300:
                category=error_category(status,body)
                if status!=429:self._record(runtime,model,'failed',category,round(time.monotonic()-start,1))
                return {'ok':False,'model':model,'http_status':status,'category':category}
            try:
                data=self.validator(body)
                valid=probe_answer_is_valid(data)
            except (ValueError,KeyError,TypeError):valid=False
            self._record(runtime,model,'vision_ok' if valid else 'unverified','' if valid else 'vision_response_unverified',round(time.monotonic()-start,1))
            return {'ok':valid,'model':model,'http_status':status,'category':'' if valid else 'vision_response_unverified'}
        except TaskCancelled:raise
        except Exception as exc:
            self._record(runtime,model,'unverified','timeout_or_network',round(time.monotonic()-start,1))
            return {'ok':False,'model':model,'category':'timeout_or_network','error_type':type(exc).__name__}

    def ensure_model(self,runtime,excluded=(),timeout=12,budget=MAX_SELECTION_ATTEMPTS):
        with self.selection_lock:
            state=self._state(runtime)
            candidates=self.candidates(runtime,excluded)
            attempted=[]
            for model in candidates[:budget]:
                with self.lock:
                    row=state['health'].get(model,{})
                    valid=row.get('status')=='vision_ok' and time.monotonic()-row.get('verified_at',0)<SUCCESS_TTL
                if valid:
                    with self.lock:state['active_model']=model
                    return model,attempted
                attempted.append(model)
                result=self.probe_one(runtime,model,timeout=timeout)
                if result['ok']:
                    with self.lock:state['active_model']=model
                    return model,attempted
                if result.get('category') in {'auth_or_quota','rate_limited'}:
                    error=SelectionError('服务商鉴权、额度或请求速率受限，未轮换模型',attempted,status=429 if result.get('category')=='rate_limited' else result.get('http_status',401))
                    raise error
                if result.get('category')=='timeout_or_network':
                    # A broken connection can affect every model on this gateway.
                    # Keep it retryable; do not exhaust the whole catalog here.
                    raise SelectionError('图片小样连接中断，将重试当前请求',attempted,status=502)
            raise SelectionError('本轮未找到通过图片小样验证的 Gemini。请点击“检测 Gemini 模型”，或稍后重试；不会把失败结果当作背景',attempted)

    def route(self,payload,runtime):
        state=self._state(runtime)
        attempted=[]
        if not runtime.get('auto_model'):
            model=runtime['model'];request={**payload,'model':model,'stream':False}
            status,kind,body=self.requester(json.dumps(request,ensure_ascii=False).encode('utf-8'),runtime)
            return status,kind,body,model,[model]
        if runtime.get('_single_attempt'):
            # Exactly one inference attempt per frontend budget entry. Discovery
            # is performed by explicit preflight/probes, never multiplied here.
            with self.selection_lock:
                candidates=self.candidates(runtime)
                if not candidates:raise SelectionError('当前候选暂不可用，请选择模型或等待后重试')
                model=candidates[0]
            request={**payload,'model':model,'stream':False}
            result=self.requester(json.dumps(request,ensure_ascii=False).encode('utf-8'),{**runtime,'model':model},timeout=90)
            status,kind,body=result
            if 200<=status<300:
                with self.lock:state['active_model']=model
            elif status!=429:self._record(runtime,model,'failed',error_category(status,body))
            return status,kind,body,model,[model]
        excluded=[]
        budget=MAX_SELECTION_ATTEMPTS
        for _ in range(MAX_REQUEST_ATTEMPTS):
            if budget<=0:break
            try:model,probed=self.ensure_model(runtime,excluded,budget=budget)
            except SelectionError as exc:
                error=SelectionError(str(exc),list(dict.fromkeys(attempted+exc.attempted)))
                error.status=exc.status
                raise error from exc
            budget-=max(1,len(probed))
            attempted.extend(probed)
            attempted.append(model)
            request={**payload,'model':model,'stream':False}
            try:status,kind,body=self.requester(json.dumps(request,ensure_ascii=False).encode('utf-8'),{**runtime,'model':model,'_retry':runtime.get('_retry',False) or _>0},timeout=90)
            except TaskCancelled:raise
            except Exception as exc:
                reason=exc.reason if isinstance(exc,URLError) else exc
                if isinstance(reason,(TimeoutError,socket.timeout)):
                    self._record(runtime,model,'unverified','timeout_or_network')
                    excluded.append(model)
                    continue
                # DNS, proxy and connection failures are not model-specific.
                raise SelectionError('连接中断，将重试当前请求；原图与已有标注已保留',list(dict.fromkeys(attempted)),status=502) from exc
            if 200<=status<300:
                try:self.validator(body)
                except ValueError as exc:
                    exc.model_used=model
                    raise
                with self.lock:state['active_model']=model
                return status,kind,body,model,list(dict.fromkeys(attempted))
            category=error_category(status,body)
            if status!=429:self._record(runtime,model,'failed',category)
            if status not in {404,405,500,502,503,504}:return status,kind,body,model,list(dict.fromkeys(attempted))
            excluded.append(model)
        raise SelectionError('已达到本次自动切换上限，请检测模型列表或稍后重试。原图与已有标注已保留',list(dict.fromkeys(attempted)))

    def snapshot(self,runtime):
        state=self._state(runtime)
        with self.lock:
            now=time.monotonic()
            rows=[]
            for model in state['models']:
                source=state['health'].get(model,{})
                row={k:v for k,v in source.items() if k not in {'verified_at','cooldown_until'}}
                row.setdefault('model',model)
                candidate=is_annotation_candidate(model) if runtime.get('auto_model') else not vision_model_error(runtime,model) and not any(x in model.lower() for x in ('embedding','tts','audio','image-generation'))
                row.setdefault('status','listed_only' if candidate else 'not_candidate')
                if row['status']=='vision_ok' and now-source.get('verified_at',0)>=SUCCESS_TTL:row['status']='expired'
                rows.append(row)
            return {'auto_model':bool(runtime.get('auto_model')),'preferred_model':runtime.get('model',''),'active_model':state['active_model'] if runtime.get('auto_model') else runtime.get('model',''),'models':rows,'probe':dict(state['job']) if state['job'] else None}

    def start_probe(self,runtime):
        state=self._state(runtime)
        with self.lock:
            if state['job'] and state['job']['running']:return self.snapshot(runtime)
            state['cancel']=threading.Event()
            cancel=state['cancel']
            state['job']={'running':True,'done':0,'total':0,'error':'','cancelled':False}
        def run():
            try:
                models=self.catalog(runtime,force=True)
                candidates=[m for m in models if (is_annotation_candidate(m) if runtime.get('auto_model') else not vision_model_error(runtime,m) and not any(x in m.lower() for x in ('embedding','tts','audio','image-generation'))) and (runtime.get('allow_pro') or 'pro' not in m.lower() or m==runtime.get('model'))]
                candidates=sorted(candidates,key=lambda m:m!=runtime.get('model'))[:6]
                with self.lock:state['job']['total']=len(candidates)
                # Two workers, each pulling the next candidate only after finishing.
                index=[0]
                def worker():
                    while not cancel.is_set():
                        with self.lock:
                            if index[0]>=len(candidates):break
                            model=candidates[index[0]];index[0]+=1
                        result=self.probe_one(runtime,model)
                        with self.lock:state['job']['done']+=1
                        if result.get('category') in {'auth_or_quota','rate_limited'}:
                            with self.lock:state['job']['error']='鉴权、额度或速率受限，已停止继续探测'
                            cancel.set()
                workers=[threading.Thread(target=worker,daemon=True) for _ in range(2)]
                for thread in workers:thread.start()
                for thread in workers:thread.join()
            except Exception:
                with self.lock:state['job']['error']='无法获取模型列表，请检查聊天地址、网络和 Key 权限'
            finally:
                with self.lock:state['job']['running']=False;state['job']['cancelled']=cancel.is_set()
        threading.Thread(target=run,name='GeminiModelProbe',daemon=True).start()
        return self.snapshot(runtime)

    def cancel_probe(self,runtime):
        state=self._state(runtime)
        with self.lock:state['cancel'].set()
        return self.snapshot(runtime)
