# -*- coding: utf-8 -*-
"""Windows settings store with DPAPI protection for the API key."""

from __future__ import annotations

import base64
import ctypes
import json
import os
import threading
import uuid
from ctypes import wintypes
from pathlib import Path
from urllib.parse import urlparse, urlunparse


SETTINGS_VERSION = 2
CRYPTPROTECT_UI_FORBIDDEN = 0x01


class DataBlob(ctypes.Structure):
    _fields_ = [("cbData", wintypes.DWORD), ("pbData", ctypes.POINTER(ctypes.c_byte))]


def settings_dir() -> Path:
    local_app_data = os.environ.get("LOCALAPPDATA")
    base = Path(local_app_data) if local_app_data else Path.home() / "AppData" / "Local"
    return base / "YOLOAutoTag"


def protect_text(value: str) -> str:
    if os.name != "nt":
        raise RuntimeError("API Key 安全存储仅支持 Windows")
    raw = value.encode("utf-8")
    buffer = ctypes.create_string_buffer(raw)
    input_blob = DataBlob(len(raw), ctypes.cast(buffer, ctypes.POINTER(ctypes.c_byte)))
    output_blob = DataBlob()
    ok = ctypes.windll.crypt32.CryptProtectData(
        ctypes.byref(input_blob),
        "YOLO Auto-Tag API Key",
        None,
        None,
        None,
        CRYPTPROTECT_UI_FORBIDDEN,
        ctypes.byref(output_blob),
    )
    if not ok:
        raise ctypes.WinError()
    try:
        protected = ctypes.string_at(output_blob.pbData, output_blob.cbData)
        return base64.b64encode(protected).decode("ascii")
    finally:
        ctypes.windll.kernel32.LocalFree(output_blob.pbData)


def unprotect_text(value: str) -> str:
    if not value:
        return ""
    raw = base64.b64decode(value.encode("ascii"), validate=True)
    buffer = ctypes.create_string_buffer(raw)
    input_blob = DataBlob(len(raw), ctypes.cast(buffer, ctypes.POINTER(ctypes.c_byte)))
    output_blob = DataBlob()
    ok = ctypes.windll.crypt32.CryptUnprotectData(
        ctypes.byref(input_blob),
        None,
        None,
        None,
        None,
        CRYPTPROTECT_UI_FORBIDDEN,
        ctypes.byref(output_blob),
    )
    if not ok:
        raise ctypes.WinError()
    try:
        return ctypes.string_at(output_blob.pbData, output_blob.cbData).decode("utf-8")
    finally:
        ctypes.windll.kernel32.LocalFree(output_blob.pbData)


def validate_http_url(value: str, field_name: str, allow_empty: bool = False) -> str:
    cleaned = value.strip()
    if not cleaned and allow_empty:
        return ""
    parsed = urlparse(cleaned)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ValueError(f"{field_name} 必须是完整的 http:// 或 https:// 地址")
    if parsed.username or parsed.password:
        raise ValueError(f"{field_name} 不应包含用户名或密码")
    return cleaned


def normalize_api_url(value: str) -> str:
    from provider_api import resolve_endpoint
    return resolve_endpoint(value)[0]


class SettingsStore:
    def __init__(self,path=None):
        self.path=path or (settings_dir()/'settings.json')
        self.path.parent.mkdir(parents=True,exist_ok=True)
        self._lock=threading.RLock()

    def _load_unlocked(self):
        try:
            value=json.loads(self.path.read_text(encoding='utf-8'))
            data=value if isinstance(value,dict) else {}
        except (OSError,ValueError):data={}
        # Read-only migration: leave the old file untouched until an explicit save.
        if not isinstance(data.get('profiles'),list) or not data['profiles']:
            profile={k:data[k] for k in ('api_url','model','proxy_url','api_key_dpapi','auto_model','allow_pro') if k in data}
            profile.update(id='default',name='默认服务',protocol='auto',models=[profile.get('model','gemini-3.8-flash-low')])
            data={**data,'profiles':[profile],'active_profile':'default'}
        if data.get('active_profile') not in {p.get('id') for p in data['profiles']}:data['active_profile']=data['profiles'][0]['id']
        return data

    def _save_unlocked(self,data):
        saved=dict(data);saved['version']=SETTINGS_VERSION
        for key in ('api_url','model','proxy_url','api_key_dpapi','auto_model','allow_pro'):saved.pop(key,None)
        temp=self.path.with_suffix('.tmp')
        temp.write_text(json.dumps(saved,ensure_ascii=False,indent=2),encoding='utf-8');temp.replace(self.path)

    @staticmethod
    def _integer(data,key,default,low,high):
        value=data.get(key,default)
        return value if type(value) is int and low<=value<=high else default

    @staticmethod
    def _concurrency(data):return SettingsStore._integer(data,'max_concurrency',10,1,60)
    @staticmethod
    def _rpm(data):return SettingsStore._integer(data,'request_rpm',0,0,60000)

    def _profile_public(self,profile):
        from provider_api import resolve_endpoint,vision_model_error
        endpoint,protocol=resolve_endpoint(profile['api_url'],profile.get('protocol','auto')) if profile.get('api_url') else ('','chat')
        model=str(profile.get('model','gemini-3.8-flash-low'))
        return {'profile_id':profile['id'],'profile_name':profile.get('name','服务'),
            'api_url':endpoint,'base_url':profile.get('api_url',''),'protocol':protocol,'protocol_setting':profile.get('protocol','auto'),
            'model':model,'models':list(dict.fromkeys([model,*profile.get('models',[])])),
            'proxy_url':str(profile.get('proxy_url','')),'key_configured':bool(profile.get('api_key_dpapi')),
            'configured':bool(endpoint and model and profile.get('api_key_dpapi')),
            'auto_model':profile.get('auto_model') is True,'allow_pro':profile.get('allow_pro') is True,
            'deepseek_thinking':profile.get('deepseek_thinking') is True,
            'vision_warning':vision_model_error({'api_url':endpoint,'model':model})}

    def public(self):
        with self._lock:
            data=self._load_unlocked();profiles=[self._profile_public(p) for p in data['profiles']]
            active=next(p for p in profiles if p['profile_id']==data['active_profile'])
            return {**active,'profiles':profiles,'max_concurrency':self._concurrency(data),'request_rpm':self._rpm(data),
                'max_retries':self._integer(data,'max_retries',2,0,10)}

    def runtime(self,profile_id=None):
        with self._lock:
            data=self._load_unlocked()
            profile=next((p for p in data['profiles'] if p['id']==(profile_id or data['active_profile'])),None)
            if profile is None:raise ValueError('未找到服务配置')
            result=self._profile_public(profile)
            return {**result,'api_key':unprotect_text(profile.get('api_key_dpapi','')),'max_concurrency':self._concurrency(data),
                'request_rpm':self._rpm(data),'max_retries':self._integer(data,'max_retries',2,0,10),'_single_attempt':True}

    def set_request_rpm(self,rpm):
        if type(rpm) is not int or not 0<=rpm<=60000:raise ValueError('每分钟请求上限必须是 0 到 60000 的整数')
        with self._lock:
            data=self._load_unlocked();data['request_rpm']=rpm;self._save_unlocked(data)

    def select_profile(self,profile_id):
        with self._lock:
            data=self._load_unlocked()
            profile=next((p for p in data['profiles'] if p['id']==profile_id),None)
            if profile is None or not profile.get('api_url') or not profile.get('api_key_dpapi'):raise ValueError('所选服务配置不完整')
            data['active_profile']=profile_id;self._save_unlocked(data)
        return self.public()

    def delete_profile(self,profile_id):
        with self._lock:
            data=self._load_unlocked()
            if profile_id==data['active_profile']:raise ValueError('请先切换到另一服务再移除当前配置')
            if not any(p['id']==profile_id for p in data['profiles']):raise ValueError('未找到服务配置')
            data['profiles']=[p for p in data['profiles'] if p['id']!=profile_id];self._save_unlocked(data)
        return self.public()

    def select_model(self,model):
        if not isinstance(model,str) or not model.strip() or len(model)>160 or any(ord(c)<32 for c in model):raise ValueError('模型名称无效')
        with self._lock:
            data=self._load_unlocked();profile=next(p for p in data['profiles'] if p['id']==data['active_profile'])
            profile.update(model=model.strip(),auto_model=False)
            profile['models']=list(dict.fromkeys([model.strip(),*profile.get('models',[])]))[:100]
            self._save_unlocked(data)
        return self.public()

    def update(self,payload):
        from provider_api import resolve_endpoint
        if not isinstance(payload,dict):raise ValueError('配置请求格式错误')
        with self._lock:
            data=self._load_unlocked()
            action=payload.get('profile_action')
            if action=='select':return self.select_profile(payload.get('profile_id'))
            if action=='delete':return self.delete_profile(payload.get('profile_id'))
            identifier=payload.get('profile_id',data['active_profile'])
            new=identifier=='new'
            if new and len(data['profiles'])>=20:raise ValueError('最多保存 20 个服务配置')
            old={} if new else next((p for p in data['profiles'] if p['id']==identifier),None)
            if old is None:raise ValueError('未找到服务配置')
            api_url=str(payload.get('api_url',old.get('api_url',''))).strip()
            protocol=payload.get('protocol',old.get('protocol','auto'))
            resolve_endpoint(api_url,protocol)
            model=str(payload.get('model',old.get('model',''))).strip()
            if not model or len(model)>160 or any(ord(c)<32 for c in model):raise ValueError('模型名称无效')
            auto=payload.get('auto_model',old.get('auto_model',False));pro=payload.get('allow_pro',old.get('allow_pro',False))
            thinking=payload.get('deepseek_thinking',old.get('deepseek_thinking',False))
            if type(thinking) is not bool:raise ValueError('深度思考选项必须为布尔值')
            if type(auto) is not bool or type(pro) is not bool:raise ValueError('自动选择和 Pro 选项必须为布尔值')
            if auto and not model.lower().startswith('gemini'):raise ValueError('自动选择仅支持 Gemini，请关闭自动选择后指定当前模型')
            fields={'max_concurrency':(10,1,60),'request_rpm':(0,0,60000),'max_retries':(2,0,10)}
            for key,(default,low,high) in fields.items():
                value=payload.get(key,data.get(key,default))
                if type(value) is not int or not low<=value<=high:raise ValueError(f'{key} 必须是 {low} 到 {high} 的整数')
                data[key]=value
            name=str(payload.get('profile_name',old.get('name','新服务'))).strip()
            if not name or len(name)>80:raise ValueError('服务名称应为 1—80 个字符')
            models=payload.get('models',old.get('models',[]))
            if not isinstance(models,list) or len(models)>100 or any(not isinstance(m,str) or len(m)>160 or any(ord(c)<32 for c in m) for m in models):raise ValueError('模型列表格式无效，最多 100 项')
            new_key=str(payload.get('api_key','')).strip()
            if old.get('api_url') and urlparse(old['api_url']).netloc!=urlparse(api_url).netloc and not new_key:
                raise ValueError('更换服务地址的域名或端口时，请重新填写该服务的 API Key')
            encrypted=protect_text(new_key) if new_key else old.get('api_key_dpapi','')
            if not encrypted:raise ValueError('新服务必须填写自己的 API Key；不会沿用其他服务的 Key')
            profile={'id':uuid.uuid4().hex if new else identifier,'name':name,'api_url':api_url,'protocol':protocol,
                'model':model,'models':list(dict.fromkeys([model,*[m.strip() for m in models if m.strip()]])),
                'proxy_url':validate_http_url(str(payload.get('proxy_url',old.get('proxy_url',''))),'代理 URL',allow_empty=True),
                'api_key_dpapi':encrypted,'auto_model':auto,'allow_pro':pro,'deepseek_thinking':thinking}
            if new:data['profiles'].append(profile)
            else:data['profiles']=[profile if p['id']==identifier else p for p in data['profiles']]
            data['active_profile']=profile['id'];self._save_unlocked(data)
        return self.public()
