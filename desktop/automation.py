"""Authenticated loopback control and a bounded UI command queue."""
from collections import deque
import hmac,json,mimetypes,os,re,secrets,threading,time
from pathlib import Path
from branding import APP_VERSION
from secure_settings import protect_text

TOOLS=[
 ('app_status','Read application version, live task status and scheduler counters.',{}),
 ('request_events','Read redacted upstream/local request evidence.',{'after':{'type':'integer','minimum':0},'limit':{'type':'integer','minimum':1,'maximum':200}}),
 ('task_results','Read file results, boxes, model provenance and processing errors.',{'offset':{'type':'integer','minimum':0},'limit':{'type':'integer','minimum':1,'maximum':100},'errors_only':{'type':'boolean'}}),
 ('preview_image','Read a loaded image or a crop as a bounded JPEG.',{'file_name':{'type':'string'},'annotation_index':{'type':'integer','minimum':0}}),
 ('load_images','Load up to 50 explicitly selected local image paths into an empty task.',{'paths':{'type':'array','minItems':1,'maxItems':50,'items':{'type':'string'}}}),
 ('configure_task','Set task prompts, optional review/OCR and request limits while idle.',{'classes':{'type':'string'},'prompt':{'type':'string'},'verify_detections':{'type':'boolean'},'read_image_numbers':{'type':'boolean'},'max_concurrency':{'type':'integer','minimum':1,'maximum':60},'rpm':{'type':'integer','minimum':0,'maximum':60000},'auto_model':{'type':'boolean'}}),
 ('task_control','Start, pause, resume, stop for manual review, or retry a recovery dialog.',{'action':{'type':'string','enum':['start','pause','resume','stop','retry']}}),
 ('providers_status','Read saved provider names, model names, protocol and key-configured flags; never keys.',{}),
 ('select_provider','Select an already configured provider while idle or in recovery.',{'profile_id':{'type':'string'},'resume':{'type':'boolean'}}),
 ('models_status','Read current provider catalog and visual test status without issuing requests.',{}),
 ('probe_models','Run or cancel bounded Gemini visual availability tests (uses provider quota).',{'cancel':{'type':'boolean'}}),
 ('select_model','Select a manual model; optionally resume the current recovery dialog.',{'model':{'type':'string'},'resume':{'type':'boolean'}}),
]
REQUIRED={'preview_image':['file_name'],'load_images':['paths'],'task_control':['action'],'select_model':['model'],'select_provider':['profile_id']}

def tool_schemas():
    read_only={'app_status','request_events','task_results','preview_image','models_status','providers_status'}
    return [{'name':n,'description':d,'inputSchema':{'type':'object','properties':p,'required':REQUIRED.get(n,[]),'additionalProperties':False},
        'annotations':{'readOnlyHint':n in read_only,'destructiveHint':False,'idempotentHint':n in read_only,'openWorldHint':n in {'task_control','probe_models'}}} for n,d,p in TOOLS]

class AutomationService:
    def __init__(self,server,discovery_path=None):
        self.server=server;self.token=secrets.token_urlsafe(32);self.ui_token=secrets.token_urlsafe(32)
        self.instance=secrets.token_hex(12);self.condition=threading.Condition();self.commands={};self.pending=deque()
        self.snapshot={};self.last_seen=0;self.client_id='';self.files={};self.discovery_path=discovery_path
        self.wake_ui=None
        if discovery_path:
            discovery_path.parent.mkdir(parents=True,exist_ok=True)
            data={'version':APP_VERSION,'pid':os.getpid(),'instance':self.instance,'base_url':f'http://127.0.0.1:{server.server_address[1]}','token_dpapi':protect_text(self.token)}
            temporary=discovery_path.with_suffix('.tmp');temporary.write_text(json.dumps(data),encoding='utf-8');temporary.replace(discovery_path)

    def close(self):
        if self.discovery_path and self.discovery_path.exists():
            try:
                if json.loads(self.discovery_path.read_text(encoding='utf-8')).get('instance')==self.instance:self.discovery_path.unlink()
            except (OSError,ValueError):pass

    def authorized(self,handler,ui=False):
        expected=f'127.0.0.1:{self.server.server_address[1]}'
        if handler.headers.get('Host')!=expected:return False
        origin=handler.headers.get('Origin')
        if origin and origin!='http://'+expected:return False
        value=handler.headers.get('X-Autotag-UI','') if ui else handler.headers.get('Authorization','').removeprefix('Bearer ')
        return hmac.compare_digest(value,self.ui_token if ui else self.token)

    def heartbeat(self,data):
        client=data.get('client_id');snapshot=data.get('snapshot')
        if not isinstance(client,str) or not re.fullmatch(r'[a-f0-9-]{16,64}',client) or not isinstance(snapshot,dict):raise ValueError('UI 状态无效')
        with self.condition:
            if self.client_id and client!=self.client_id and time.monotonic()-self.last_seen<5:raise ValueError('另一个操作视图已连接')
            self.client_id=client;self.snapshot=self.server.journal.clean(snapshot);self.last_seen=time.monotonic()
            for item in data.get('completed',[])[:20]:
                if not isinstance(item,dict):continue
                row=self.commands.get(item.get('id'))
                if row is not None:row['result']=self.server.journal.clean(item.get('result')) if not item.get('image') else item.get('result');row['done']=True
            work=[]
            while self.pending:
                key=self.pending.popleft();row=self.commands.get(key)
                if row and not row['done']:work.append({'id':key,'action':row['action'],'arguments':row['arguments']})
            self.condition.notify_all();return {'ok':True,'commands':work,'instance':self.instance}

    def ui(self,action,arguments,timeout=15):
        self.refresh_ui()
        with self.condition:
            if time.monotonic()-self.last_seen>5:raise ValueError('软件操作视图未连接或没有响应')
            if len(self.commands)>100: self.commands={k:r for k,r in self.commands.items() if not r['done']}
            if len(self.commands)>20:raise ValueError('操作队列已满')
            key=secrets.token_hex(12);row={'action':action,'arguments':arguments,'done':False,'result':None};self.commands[key]=row;self.pending.append(key)
            self.condition.wait_for(lambda:row['done'],timeout=timeout)
            if not row['done']:
                row['done']=True;raise ValueError('操作未在时限内确认，请先读取 app_status；不要盲目重复启动')
            result=row['result'];self.commands.pop(key,None)
            return result

    def refresh_ui(self):
        if self.client_id and time.monotonic()-self.last_seen>3 and self.wake_ui:
            threading.Thread(target=self.wake_ui,daemon=True).start()
            with self.condition:self.condition.wait_for(lambda:time.monotonic()-self.last_seen<3,timeout=2)

    def call(self,name,args):
        schema=next((s['inputSchema'] for s in tool_schemas() if s['name']==name),None)
        if not schema or not isinstance(args,dict) or set(args)-set(schema['properties']) or any(k not in args for k in schema['required']):raise ValueError('工具或参数无效')
        for key,value in args.items():
            rule=schema['properties'][key];kind=rule['type']
            valid={'string':isinstance(value,str),'integer':type(value) is int,'boolean':type(value) is bool,'array':isinstance(value,list)}[kind]
            if not valid:raise ValueError(f'{key} 类型无效')
            if kind=='integer' and (value<rule.get('minimum',value) or value>rule.get('maximum',value)):raise ValueError(f'{key} 超出范围')
            if 'enum' in rule and value not in rule['enum']:raise ValueError(f'{key} 无效')
            if kind=='string' and len(value)>8000:raise ValueError('文本过长')
        if name=='app_status':
            self.refresh_ui()
            return {'version':APP_VERSION,'pid':os.getpid(),'instance':self.instance,'ui_connected':time.monotonic()-self.last_seen<=5,'ui':self.snapshot,'scheduler':self.server.request_limiter.snapshot()}
        if name=='request_events':return {'events':self.server.journal.read(args.get('after',0),args.get('limit',100))}
        if name=='models_status':return self.server.model_router.snapshot(self.server.settings_store.runtime())
        if name=='providers_status':
            public=self.server.settings_store.public()
            return {'active_profile':public['profile_id'],'profiles':[{k:p.get(k) for k in ('profile_id','profile_name','model','models','protocol','key_configured','configured','vision_warning')} for p in public['profiles']]}
        if name=='probe_models':return (self.server.model_router.cancel_probe if args.get('cancel') else self.server.model_router.start_probe)(self.server.settings_store.runtime())
        if name=='load_images':
            paths=args.get('paths');total=0;rows=[]
            if not isinstance(paths,list) or not 1<=len(paths)<=50 or not all(isinstance(p,str) for p in paths):raise ValueError('每次请选择 1—50 张图片')
            if self.snapshot.get('is_processing') or self.snapshot.get('launching') or self.snapshot.get('file_count'):raise ValueError('当前任务非空，请先保存现有任务，或使用独立诊断实例')
            for raw in paths:
                path=Path(raw)
                if not path.is_absolute() or not path.is_file() or path.suffix.lower() not in {'.jpg','.jpeg','.png','.webp','.bmp'}:raise ValueError('图片路径无效')
                size=path.stat().st_size;total+=size
                if size>20*1024*1024 or total>100*1024*1024:raise ValueError('图片超过本次诊断加载上限')
                key=secrets.token_urlsafe(24);self.files[key]=(path,time.monotonic()+120)
                rows.append({'name':path.name,'url':'/api/automation/image?id='+key,'type':mimetypes.guess_type(path.name)[0] or 'image/jpeg'})
            if len({r['name'] for r in rows})!=len(rows):raise ValueError('同批图片不能包含重复文件名')
            return self.ui(name,{'files':rows})
        if name=='configure_task':
            if self.snapshot.get('is_processing') or self.snapshot.get('launching'):raise ValueError('请先结束识别，再修改任务配置')
            if self.snapshot.get('result_count') and any(k in args for k in ['classes','prompt']):raise ValueError('已有结果的任务不能通过诊断接口改写类别或目标描述')
            public=self.server.settings_store.public()
            if any(k in args for k in ['max_concurrency','rpm','auto_model']):
                current=self.server.settings_store.runtime()
                updated=self.server.settings_store.update({**current,'max_concurrency':args.get('max_concurrency',public['max_concurrency']),'request_rpm':args.get('rpm',public['request_rpm']),'auto_model':args.get('auto_model',public['auto_model'])})
                self.server.request_limiter.set_limit(updated['max_concurrency']);self.server.request_limiter.set_rpm(updated['request_rpm'])
            return self.ui(name,args)
        if name in {'task_results','preview_image','task_control','select_model','select_provider'}:return self.ui(name,args,timeout=20)
        raise ValueError('未知操作')

    def image(self,key):
        row=self.files.get(key)
        if not row or row[1]<time.monotonic():raise ValueError('图片读取授权已过期')
        return row[0]
