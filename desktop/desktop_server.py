# -*- coding: utf-8 -*-
"""Loopback-only desktop web server and user-configured API proxy."""

from __future__ import annotations

import json
import logging
import math
import os
import re
import secrets
import sys
import threading
import time
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import ProxyHandler as UrlProxyHandler
from urllib.request import Request, build_opener
from urllib.parse import urlsplit,urlunsplit,parse_qs

from branding import APP_VERSION
from secure_settings import SettingsStore
from model_router import GeminiRouter,SelectionError
from request_limiter import RequestLimiter,TaskCancelled
from diagnostics import RequestJournal
from automation import AutomationService
from provider_api import encode_request,decode_response,catalog_endpoint,vision_model_error


HOST = "127.0.0.1"
MAX_API_BODY_BYTES = 128 * 1024 * 1024
MAX_CONFIG_BODY_BYTES = 64 * 1024
MAX_TASK_EXPORT_BYTES = 16 * 1024 * 1024 * 1024
TASK_EXPORT_TOKEN_TTL_SECONDS = 10 * 60


def build_outbound_opener(proxy_url: str):
    if proxy_url:
        return build_opener(UrlProxyHandler({"http": proxy_url, "https": proxy_url}))
    # No explicit value means use Windows/system proxy discovery when available.
    return build_opener()


class UpstreamResponse(tuple):
    def __new__(cls,status,content_type,body,headers=None):
        result=super().__new__(cls,(status,content_type,body))
        result.headers=headers or {}
        return result


def request_upstream(payload: bytes, runtime: dict, timeout: int = 180):
    wire,auth_headers=encode_request(json.loads(payload),runtime)
    request = Request(
        runtime["api_url"],
        data=json.dumps(wire,ensure_ascii=False).encode('utf-8'),
        method="POST",
        headers={
            **auth_headers,
            "Content-Type": "application/json",
            "Accept": "application/json",
            "User-Agent": f"YOLOAutoTagDesktop/{APP_VERSION}",
        },
    )
    opener = build_outbound_opener(runtime.get("proxy_url", ""))
    try:
        with opener.open(request, timeout=timeout) as response:
            return UpstreamResponse(
                int(response.status),
                response.headers.get("Content-Type", "application/json; charset=utf-8"),
                decode_response(response.read(),runtime.get('protocol','chat')),
                {'Retry-After':response.headers.get('Retry-After')},
            )
    except HTTPError as exc:
        return UpstreamResponse(
            int(exc.code),
            exc.headers.get("Content-Type", "application/json; charset=utf-8")
            if exc.headers
            else "application/json; charset=utf-8",
            exc.read(),
            {'Retry-After':exc.headers.get('Retry-After') if exc.headers else None},
        )


def upstream_error_message(status: int, body: bytes) -> str:
    detail = ""
    try:
        error_data = json.loads(body.decode("utf-8", errors="replace"))
        detail = str(error_data.get("error", {}).get("message") or error_data.get("message") or "")
    except (json.JSONDecodeError, AttributeError):
        detail = body.decode("utf-8", errors="replace")
    if status in {404, 405}:
        return (
            f"中转站未找到接口或当前模型（HTTP {status}）。请检查完整 /v1/chat/completions 地址，"
            "并核对模型名是否仍可用；模型列表中出现不代表实际调用一定可用。"
        )
    if status == 403 and "all available accounts exhausted" in detail.lower():
        return (
            "中转站当前没有可用的上游账号或额度（HTTP 403）。"
            "这不是本地 Key 保存错误；请稍后重试、联系中转站，"
            "或切换到中转站当前有资源的模型。"
        )
    if status in {401, 403}:
        return (
            f"中转站拒绝了鉴权或当前模型请求（HTTP {status}）：{detail[:300]}。"
            "请检查 Key、账户额度和模型权限。"
        )
    if status==503 and "routing configuration unavailable" in detail.lower():
        return "服务商当前没有为该模型配置可用路由（HTTP 503）。可检测其他 Gemini 或开启自动选择；本机无法修复服务商路由。"
    return f"上游返回 HTTP {status}：{detail[:300]}"


def validate_chat_response(body: bytes) -> dict:
    try:
        data = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ValueError("接口返回了网页或非 JSON 内容，请检查完整的 /v1/chat/completions 地址") from exc
    try:
        choice = data["choices"][0]
        content = choice["message"]["content"]
    except (KeyError, IndexError, TypeError) as exc:
        raise ValueError("接口响应缺少 choices[0].message.content，请检查 Chat Completions 接口") from exc
    if isinstance(content, list):
        content = "\n".join(str(part.get("text", "")) for part in content if isinstance(part, dict))
    if not isinstance(content, str) or not content.strip():
        raise ValueError("模型返回内容为空，请检查模型可用性与账户额度")
    if choice.get('finish_reason')=='length':raise ValueError('模型响应被截断，不能确认调用完成')
    if choice.get('finish_reason')=='content_filter':raise ValueError('模型响应被拦截，请人工检查')
    return data


def load_gemini_catalog(runtime: dict) -> list[str]:
    url=catalog_endpoint(runtime)
    auth={'x-api-key':runtime['api_key'],'anthropic-version':'2023-06-01'} if runtime.get('protocol')=='anthropic' else {'Authorization':'Bearer '+runtime['api_key']}
    request=Request(url,headers={**auth,'Accept':'application/json','User-Agent':f'YOLOAutoTagDesktop/{APP_VERSION}'})
    with build_outbound_opener(runtime.get('proxy_url','')).open(request,timeout=15) as response:
        raw=response.read(4*1024*1024)
    data=json.loads(raw)
    if not isinstance(data,dict) or not isinstance(data.get('data'),list):
        raise ValueError('模型列表格式错误')
    return [item['id'] for item in data['data'] if isinstance(item,dict) and isinstance(item.get('id'),str)]


def json_reply(status,data,headers=None):
    return status,'application/json; charset=utf-8',json.dumps(data,ensure_ascii=False).encode('utf-8'),headers


class DesktopServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, server_address, handler_class, settings_store: SettingsStore):
        super().__init__(server_address, handler_class)
        self.settings_store = settings_store
        public=settings_store.public()
        self.request_limiter=RequestLimiter(public.get('max_concurrency',10),public.get('request_rpm',0))
        self.model_router=GeminiRouter(self.request_upstream,self.load_catalog,validate_chat_response)
        self.jobs={}
        self.job_condition=threading.Condition()
        self._export_targets: dict[str, tuple[Path, float]] = {}
        self._export_targets_lock = threading.Lock()
        self._last_completed_export: Path | None = None
        self.journal=RequestJournal([public.get('api_url'),public.get('proxy_url')])
        self.automation=AutomationService(self)

    def request_upstream(self,payload,runtime,**kwargs):
        def operation():
            start=time.monotonic()
            fields={'origin':'upstream','kind':runtime.get('_request_kind','annotation'),'model':runtime.get('model',''),'profile_id':runtime.get('profile_id',''),'protocol':runtime.get('protocol','chat'),'task_id':runtime.get('_task_id',''),'retry':runtime.get('_retry',False),**runtime.get('_request_context',{})}
            try:
                response=request_upstream(payload,runtime,**kwargs)
                from model_router import error_category
                status=response[0]
                self.journal.add('request',**fields,status=status,elapsed_seconds=round(time.monotonic()-start,3),category='ok' if 200<=status<300 else error_category(status,response[2]))
                return response
            except Exception as exc:
                reason=exc.reason if isinstance(exc,URLError) else exc
                self.journal.add('request',**fields,status=getattr(exc,'code',0),elapsed_seconds=round(time.monotonic()-start,3),category='connection_error',error_type=type(reason).__name__)
                raise
        return self.request_limiter.execute(operation,
            runtime.get('_request_kind','annotation'),runtime.get('_task_id',''),runtime.get('_retry',False))

    def load_catalog(self,runtime):
        def operation():
            start=time.monotonic()
            try:
                rows=load_gemini_catalog(runtime)
                self.journal.add('request',origin='upstream',kind='catalog',status=200,elapsed_seconds=round(time.monotonic()-start,3),category='ok')
                return rows
            except Exception as exc:
                self.journal.add('request',origin='upstream',kind='catalog',status=getattr(exc,'code',0),elapsed_seconds=round(time.monotonic()-start,3),category='catalog_error',error_type=type(exc).__name__)
                raise
        return self.request_limiter.execute(operation,'catalog',runtime.get('_task_id',''))

    def call_api(self,request_data):
        task_id=request_data.get('_autotag_task_id','')
        result=self._call_api(dict(request_data))
        if not 200<=result[0]<300:
            try:error=json.loads(result[2]).get('error',{})
            except (ValueError,AttributeError):error={}
            self.journal.add('response',origin=error.get('origin','local'),status=result[0],task_id=task_id,code=error.get('code','LOCAL_ERROR'),fatal=error.get('fatal',False),task_stopped=error.get('taskStopped',False),message=error.get('message',''))
        return result

    def _call_api(self,request_data):
        try:runtime = self.settings_store.runtime()
        except OSError:
            return json_reply(401,{'error':{'message':'本机 API Key 无法解密，请在 API 配置中重新填写并保存 Key','code':'LOCAL_KEY_UNAVAILABLE','origin':'local','fatal':True}})
        with self.journal.lock:
            for value in [runtime.get('api_key'),runtime.get('api_url'),runtime.get('proxy_url')]:
                if value and value not in self.journal.secrets:self.journal.secrets.append(value)
        if not runtime["api_url"] or not runtime["api_key"] or not runtime["model"]:
            return json_reply(401, {"error": {"message": "尚未配置 API URL、Key 或模型名称",'fatal':True}})
        if vision_model_error(runtime):
            return json_reply(400,{'error':{'message':vision_model_error(runtime),'code':'UNSUPPORTED_VISION_MODEL','retryable_json':False}})
        try:
            task_id=request_data.pop('_autotag_task_id','')
            retry=request_data.pop('_autotag_retry',False)
            context=request_data.pop('_autotag_context',{})
            context={key:str(context.get(key,''))[:256] for key in ['file_name','phase']} if isinstance(context,dict) else {}
            if not isinstance(task_id,str) or task_id and not re.fullmatch(r'[A-Za-z0-9_-]{8,96}',task_id):
                raise ValueError('任务标识无效')
            runtime={**runtime,'_task_id':task_id,'_retry':retry is True,'_request_context':context}
            status, content_type, response_body,model,attempted=self.model_router.route(request_data,runtime)
            if 200<=status<300:
                data=validate_chat_response(response_body)
                data['_autotag']={'model_used':model,'profile_id':runtime.get('profile_id',''),'profile_name':runtime.get('profile_name',''),'protocol':runtime.get('protocol','chat'),'preferred_model':runtime['model'],'auto_model':bool(runtime.get('auto_model')),'attempted_models':attempted}
                response_body=json.dumps(data,ensure_ascii=False).encode('utf-8')
                content_type='application/json; charset=utf-8'
            elif status in {401,403}:
                if task_id:self.request_limiter.cancel_task(task_id,reason=f'upstream_http_{status}')
                return json_reply(status,{'error':{'message':upstream_error_message(status,response_body),'code':'UPSTREAM_ACCESS_BLOCKED','origin':'upstream','upstream_status':status,'fatal':True}})
            headers={'Retry-After':str(max(1,math.ceil(self.request_limiter.snapshot()['cooldown_seconds'])))} if status==429 else None
            if not 200<=status<300:
                return json_reply(status,{'error':{'message':self.journal.clean(upstream_error_message(status,response_body)),'code':f'UPSTREAM_HTTP_{status}','origin':'upstream','upstream_status':status,'retryable':status in {408,409,425,429,500,502,503,504,520,521,522,523,524,529}}},headers)
            return status,content_type,response_body,headers
        except TaskCancelled as exc:
            return json_reply(409,{'error':{'message':str(exc),'code':'TASK_STOPPED','origin':'local','taskStopped':True,'stop_reason':getattr(exc,'reason','unknown')}})
        except SelectionError as exc:
            status=exc.status
            if status in {401,403} and locals().get('task_id'):self.request_limiter.cancel_task(task_id,reason=f'upstream_http_{status}')
            return json_reply(status,{'error':{'message':str(exc),'code':'MODEL_SELECTION_FAILED','fatal':status in {401,403}},'attempted_models':exc.attempted},
                {'Retry-After':str(max(1,math.ceil(self.request_limiter.snapshot()['cooldown_seconds'])))} if status==429 else None)
        except ValueError as exc:
            return json_reply(400, {"error": {"message": str(exc),'retryable_json':'拦截' not in str(exc),
                'model_used':getattr(exc,'model_used',locals().get('model',''))}})
        except URLError as exc:
            return json_reply(502, {"error": {"message": "无法连接上游 API，将重试当前请求；原图与已有结果已保留",'code':'UPSTREAM_CONNECTION_ERROR'}})
        except (ConnectionError,TimeoutError,OSError):
            return json_reply(502, {'error':{'message':'上游连接中断或超时，将重试当前请求；原图与已有结果已保留','code':'UPSTREAM_CONNECTION_ERROR'}})
        except Exception as exc:
            return json_reply(
                502,
                {"error": {"message": f"本地代理调用失败：{type(exc).__name__}: {exc}"}},
            )


    def submit_job(self,payload):
        task_id=payload.get('_autotag_task_id','')
        if not isinstance(task_id,str) or not re.fullmatch(r'[A-Za-z0-9_-]{8,96}',task_id):raise ValueError('任务标识无效')
        with self.request_limiter.condition:self.request_limiter._check_task(task_id or 'invalid')
        with self.job_condition:
            now=time.monotonic()
            self.jobs={key:row for key,row in self.jobs.items() if row['result'] is None or now-row['created']<300}
            if len(self.jobs)>=256:raise ValueError('本地任务队列已满，请等待当前结果')
            job_id=secrets.token_urlsafe(18)
            self.jobs[job_id]={'task_id':task_id,'result':None,'created':now}
        def run():
            try:result=self.call_api(payload)
            except Exception as exc:result=json_reply(500,{'error':{'message':f'本地请求执行失败：{type(exc).__name__}'}})
            with self.job_condition:
                if job_id in self.jobs:self.jobs[job_id]['result']=result
                self.job_condition.notify_all()
        threading.Thread(target=run,name='AnnotationRequest',daemon=True).start()
        return job_id

    def poll_jobs(self,task_id,acks):
        with self.job_condition:
            for key in acks:
                if key in self.jobs and self.jobs[key]['task_id']==task_id and self.jobs[key]['result'] is not None:del self.jobs[key]
            def ready():return any(row['task_id']==task_id and row['result'] is not None for row in self.jobs.values())
            self.job_condition.wait_for(ready,timeout=1)
            results=[]
            for key,row in self.jobs.items():
                if row['task_id']!=task_id or row['result'] is None:continue
                status,kind,body,headers=row['result']
                results.append({'job_id':key,'status':status,'content_type':kind,'body':body.decode('utf-8',errors='replace'),'headers':headers or {}})
                if len(results)>=16:break
            return results

    def clear_jobs(self,task_id):
        with self.job_condition:
            self.jobs={key:row for key,row in self.jobs.items() if row['task_id']!=task_id}

    def register_export_target(self, target: Path) -> tuple[str, Path]:
        path = Path(target).expanduser()
        if path.suffix.lower() != ".zip":
            path = path.with_suffix(".zip")
        token = secrets.token_urlsafe(32)
        now = time.monotonic()
        with self._export_targets_lock:
            self._export_targets = {
                key: value
                for key, value in self._export_targets.items()
                if value[1] > now
            }
            self._export_targets[token] = (path, now + TASK_EXPORT_TOKEN_TTL_SECONDS)
        return token, path

    def consume_export_target(self, token: str) -> Path | None:
        now = time.monotonic()
        with self._export_targets_lock:
            value = self._export_targets.pop(token, None)
        if value is None or value[1] <= now:
            return None
        return value[0]

    def record_completed_export(self, target: Path) -> None:
        with self._export_targets_lock:
            self._last_completed_export = Path(target)

    def last_completed_export(self) -> Path | None:
        with self._export_targets_lock:
            return self._last_completed_export

    def handle_error(self, request, client_address) -> None:
        _exc_type, exc, _traceback = sys.exc_info()
        if isinstance(exc, (ConnectionResetError, BrokenPipeError)):
            return
        super().handle_error(request, client_address)


class DesktopHandler(SimpleHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    @property
    def settings_store(self) -> SettingsStore:
        return self.server.settings_store

    def log_message(self, format_string: str, *args) -> None:
        # Keep useful request logs without touching stderr in a windowed executable.
        logging.getLogger("desktop.http").info("%s - %s", self.address_string(), format_string % args)

    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        super().end_headers()

    def send_bytes(self, status: int, content_type: str, payload: bytes, headers=None) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(payload)))
        for name,value in (headers or {}).items():self.send_header(name,str(value))
        self.end_headers()
        self.wfile.write(payload)

    def send_json(self, status: int, data: object, headers=None) -> None:
        payload = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_bytes(status, "application/json; charset=utf-8", payload,headers)

    def read_body(self, maximum: int) -> bytes:
        try:
            content_length = int(self.headers.get("Content-Length", "0"))
        except ValueError as exc:
            raise ValueError("Content-Length 无效") from exc
        if content_length <= 0:
            raise ValueError("请求体为空")
        if content_length > maximum:
            raise ValueError("请求体超过允许大小")
        return self.rfile.read(content_length)

    def read_json(self, maximum: int = MAX_CONFIG_BODY_BYTES) -> dict:
        body = self.read_body(maximum)
        try:
            data = json.loads(body.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ValueError("请求不是有效 JSON") from exc
        if not isinstance(data, dict):
            raise ValueError("JSON 顶层必须是对象")
        return data

    def discard_optional_body(self, maximum: int = MAX_CONFIG_BODY_BYTES) -> None:
        """Drain an optional request body so HTTP/1.1 keep-alive stays synchronized."""
        try:
            content_length = int(self.headers.get("Content-Length", "0"))
        except ValueError as exc:
            raise ValueError("Content-Length 无效") from exc
        if content_length < 0:
            raise ValueError("Content-Length 无效")
        if content_length > maximum:
            raise ValueError("请求体超过允许大小")
        if content_length:
            self.rfile.read(content_length)

    def do_GET(self) -> None:
        route = urlsplit(self.path).path
        if route=='/api/automation/bootstrap':
            expected=f'127.0.0.1:{self.server.server_address[1]}'
            if self.headers.get('Host')!=expected or self.headers.get('Origin') not in {None,'http://'+expected}:self.send_json(403,{'ok':False});return
            self.send_json(200,{'ui_token':self.server.automation.ui_token});return
        if route=='/api/automation/image':
            if not self.server.automation.authorized(self,ui=True):self.send_json(403,{'ok':False});return
            try:
                path=self.server.automation.image(parse_qs(urlsplit(self.path).query).get('id',[''])[0])
                import mimetypes
                self.send_bytes(200,mimetypes.guess_type(path.name)[0] or 'image/jpeg',path.read_bytes())
            except (ValueError,OSError):self.send_json(404,{'ok':False})
            return
        if route=='/api/proxy/jobs':
            query=parse_qs(urlsplit(self.path).query)
            task_id=query.get('task_id',[''])[0]
            if not re.fullmatch(r'[A-Za-z0-9_-]{8,96}',task_id):
                self.send_json(400,{'ok':False,'message':'任务标识无效'});return
            acks=query.get('ack',[''])[0][:8192].split(',')
            self.send_json(200,{'ok':True,'results':self.server.poll_jobs(task_id,acks)})
            return
        if route=='/api/scheduler':
            self.send_json(200,{'ok':True,**self.server.request_limiter.snapshot()})
            return
        if route == "/api/health":
            public = self.settings_store.public()
            self.send_json(
                200,
                {
                    "ok": True,
                    "version": APP_VERSION,
                    "configured": public["configured"],
                    "loopback_only": True,
                },
            )
            return
        if route == "/api/app-config":
            self.send_json(
                200,
                {
                    **self.settings_store.public(),
                    "version": APP_VERSION,
                },
            )
            return
        if route == '/api/models':
            try:self.send_json(200,{'ok':True,**self.server.model_router.snapshot(self.settings_store.runtime()),'request_limits':self.server.request_limiter.snapshot()})
            except OSError:self.send_json(401,{'ok':False,'message':'本机 API Key 无法解密，请重新填写并保存 Key','code':'LOCAL_KEY_UNAVAILABLE'})
            return
        super().do_GET()

    def do_OPTIONS(self) -> None:
        route = urlsplit(self.path).path
        if route not in {"/api/app-config", "/api/app-config/test", "/api/proxy/custom",'/api/models/probe','/api/models/probe/cancel','/api/scheduler/task'}:
            self.send_error(404)
            return
        self.send_response(204)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_POST(self) -> None:
        route = urlsplit(self.path).path
        if route in {'/api/automation/ui','/api/automation/call'}:
            control=self.server.automation;ui=route.endswith('/ui')
            if not control.authorized(self,ui=ui):
                # Keep HTTP/1.1 aligned even for rejected requests. Unread JSON
                # otherwise becomes a second request and may reset the socket.
                try:self.discard_optional_body(128*1024)
                except ValueError:self.close_connection=True
                self.send_json(403,{'ok':False,'error':'本机接口鉴权失败'});return
            try:
                data=self.read_json(8*1024*1024 if ui else 128*1024)
                result=control.heartbeat(data) if ui else {'ok':True,'result':control.call(data.get('name'),data.get('arguments',{}))}
                self.send_json(200,result)
            except (ValueError,OSError,TypeError) as exc:self.send_json(400,{'ok':False,'error':self.server.journal.clean(str(exc))})
            return
        if route=='/api/models/select':
            try:self.send_json(200,{'ok':True,**self.settings_store.select_model(self.read_json().get('model'))})
            except ValueError as exc:self.send_json(400,{'ok':False,'message':str(exc)})
            return
        if route=='/api/proxy/jobs':
            try:self.send_json(202,{'ok':True,'job_id':self.server.submit_job(self.read_json(MAX_API_BODY_BYTES))})
            except TaskCancelled as exc:self.send_json(409,{'error':{'message':str(exc),'code':'TASK_STOPPED','origin':'local','taskStopped':True,'stop_reason':getattr(exc,'reason','unknown')}})
            except ValueError as exc:self.send_json(400,{'error':{'message':str(exc)}})
            return
        if route=='/api/scheduler/task':
            self.handle_scheduler_task()
            return
        if route == "/api/app-config":
            self.handle_save_config()
            return
        if route == "/api/app-config/test":
            self.handle_test_config()
            return
        if route == "/api/proxy/custom":
            self.handle_api_proxy()
            return
        if route in {'/api/models/probe','/api/models/probe/cancel'}:
            self.handle_model_probe(cancel=route.endswith('/cancel'))
            return
        if route.startswith("/api/task-export/"):
            self.handle_task_export(route.removeprefix("/api/task-export/"))
            return
        self.send_json(404, {"error": {"message": f"未知路径：{route}"}})

    def handle_save_config(self) -> None:
        try:
            public = self.settings_store.update(self.read_json())
            self.server.request_limiter.set_limit(public.get('max_concurrency',10))
            self.server.request_limiter.set_rpm(public.get('request_rpm',0))
            self.send_json(200, {"ok": True, **public})
        except ValueError as exc:
            self.send_json(400, {"ok": False, "message": str(exc)})
        except Exception as exc:
            self.send_json(500, {"ok": False, "message": f"保存配置失败：{type(exc).__name__}"})

    def handle_test_config(self) -> None:
        try:
            self.discard_optional_body()
        except ValueError as exc:
            self.send_json(400, {"ok": False, "message": str(exc)})
            return
        try:runtime = self.settings_store.runtime()
        except OSError:
            self.send_json(401,{'ok':False,'message':'本机 API Key 无法解密，请重新填写并保存 Key','code':'LOCAL_KEY_UNAVAILABLE'});return
        if not runtime["api_url"] or not runtime["api_key"] or not runtime["model"]:
            self.send_json(400, {"ok": False, "message": "请先完整保存 URL、Key 和模型名称"})
            return
        if vision_model_error(runtime):
            self.send_json(400,{'ok':False,'message':vision_model_error(runtime)});return
        payload = json.dumps(
            {
                "model": runtime["model"],
                "messages": [{"role": "user", "content": "Reply with [] only."}],
                "stream": False,
            },
            ensure_ascii=False,
        ).encode("utf-8")
        try:
            if urlsplit(runtime['api_url']).hostname=='api.deepseek.com':
                probe=self.server.model_router.probe_one(runtime,runtime['model'],timeout=60)
                if not probe['ok']:
                    self.send_json(502,{'ok':False,'message':'DeepSeek 图片小样未通过，请核对 Key、模型权限和图片能力','probe':probe});return
                self.send_json(200,{'ok':True,'message':'DeepSeek 图片小样通过','model_used':runtime['model']});return
            if runtime.get('auto_model'):
                model,attempted=self.server.model_router.ensure_model(runtime,budget=1)
                self.send_json(200,{'ok':True,'message':f'图片小样验证通过，当前自动选择：{model}','model_used':model,'attempted_models':attempted,**self.server.model_router.snapshot(runtime)})
                return
            status, _content_type, body = self.server.request_upstream(payload, runtime, timeout=60)
            if 200 <= status < 300:
                validate_chat_response(body)
                self.send_json(200, {"ok": True, "message": "聊天接口与模型响应测试成功；图片能力将在首次识别时验证"})
                return
            self.send_json(
                502,
                {"ok": False, "message": upstream_error_message(status, body)},
            )
        except ValueError as exc:
            self.send_json(502, {"ok": False, "message": str(exc)})
        except SelectionError as exc:
            self.send_json(getattr(exc,'status',409),{'ok':False,'message':str(exc),'attempted_models':exc.attempted})
        except URLError as exc:
            self.send_json(502, {"ok": False, "message": f"连接失败：{exc.reason}"})
        except Exception as exc:
            self.send_json(502, {"ok": False, "message": f"连接测试失败：{type(exc).__name__}: {exc}"})

    def handle_api_proxy(self) -> None:
        try:
            result=self.server.call_api(self.read_json(MAX_API_BODY_BYTES))
            self.send_bytes(*result)
        except ValueError as exc:self.send_json(400,{'error':{'message':str(exc)}})

    def handle_scheduler_task(self):
        try:
            data=self.read_json()
            action=data.get('action')
            gate=self.server.request_limiter
            if action not in {'start','configure','stop','finish'}:raise ValueError('未知调度操作')
            task_id=data.get('task_id','')
            if action!='configure' and (not isinstance(task_id,str) or not re.fullmatch(r'[A-Za-z0-9_-]{8,96}',task_id)):
                raise ValueError('任务标识无效')
            if action in {'start','configure'}:
                rpm=data.get('rpm',0)
                if type(rpm) is not int or not 0<=rpm<=60000:raise ValueError('RPM 必须为 0—60000，0 表示自动')
                self.settings_store.set_request_rpm(rpm)
                gate.set_rpm(rpm)
            if action in {'start','stop','finish'}:
                if action=='start':gate.begin_task(task_id)
                elif action=='stop':gate.cancel_task(task_id,reason=str(data.get('reason','requested_stop'))[:80])
                else:
                    gate.finish_task(task_id)
                    self.server.clear_jobs(task_id)
                self.server.journal.add('task',origin='local',action=action,task_id=task_id,reason=str(data.get('reason',''))[:80])
            self.send_json(200,{'ok':True,**gate.snapshot()})
        except ValueError as exc:self.send_json(400,{'ok':False,'message':str(exc)})

    def handle_model_probe(self,cancel=False) -> None:
        try:
            self.discard_optional_body()
            runtime=self.settings_store.runtime()
            if not runtime.get('api_url') or not runtime.get('api_key'):
                self.send_json(400,{'ok':False,'message':'请先保存 URL 和 Key'})
                return
            router=self.server.model_router
            snapshot=router.cancel_probe(runtime) if cancel else router.start_probe(runtime)
            self.send_json(200,{'ok':True,**snapshot,'request_limits':self.server.request_limiter.snapshot()})
        except ValueError as exc:
            self.send_json(400,{'ok':False,'message':str(exc)})
        except OSError:
            self.send_json(401,{'ok':False,'message':'本机 API Key 无法解密，请重新填写并保存 Key','code':'LOCAL_KEY_UNAVAILABLE'})

    def handle_task_export(self, token: str) -> None:
        try:
            content_length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            self.send_json(400, {"ok": False, "message": "任务包大小信息无效"})
            return
        if content_length <= 0:
            self.send_json(400, {"ok": False, "message": "任务包内容为空"})
            return
        if content_length > MAX_TASK_EXPORT_BYTES:
            self.send_json(413, {"ok": False, "message": "任务包超过 16 GB 限制"})
            return

        target = self.server.consume_export_target(token)
        if target is None:
            self.send_json(404, {"ok": False, "message": "保存授权已失效，请重新选择保存位置"})
            return

        temporary = target.with_name(f".{target.name}.{secrets.token_hex(6)}.part")
        try:
            if not target.parent.is_dir():
                raise FileNotFoundError(f"保存目录不存在：{target.parent}")
            remaining = content_length
            with temporary.open("wb") as output:
                while remaining:
                    chunk = self.rfile.read(min(1024 * 1024, remaining))
                    if not chunk:
                        raise OSError("任务包传输意外中断")
                    output.write(chunk)
                    remaining -= len(chunk)
                output.flush()
                os.fsync(output.fileno())
            os.replace(temporary, target)
            self.server.record_completed_export(target)
            self.send_json(
                200,
                {"ok": True, "path": str(target), "bytes": content_length},
            )
        except Exception as exc:
            try:
                temporary.unlink(missing_ok=True)
            except OSError:
                pass
            logging.getLogger("desktop.export").exception("Task package export failed")
            self.send_json(
                500,
                {"ok": False, "message": f"写入任务包失败：{type(exc).__name__}: {exc}"},
            )


def create_server(web_root: Path, settings_store: SettingsStore, port: int = 0) -> DesktopServer:
    handler = partial(DesktopHandler, directory=str(web_root))
    return DesktopServer((HOST, port), handler, settings_store)
