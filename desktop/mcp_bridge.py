"""MCP stdio transport and CLI for the running desktop application's local tools."""
from pathlib import Path
import argparse,base64,json,sys
from urllib.request import Request,urlopen
from urllib.parse import urlsplit
from urllib.error import HTTPError
from automation import tool_schemas
from branding import APP_VERSION
from secure_settings import settings_dir,unprotect_text

def invoke(name,arguments,discovery):
    data=json.loads(Path(discovery).read_text(encoding='utf-8'));base=data['base_url'];parts=urlsplit(base)
    if parts.scheme!='http' or parts.hostname!='127.0.0.1' or not parts.port or parts.path:raise ValueError('本机接口发现文件无效')
    token=unprotect_text(data['token_dpapi'])
    body=json.dumps({'name':name,'arguments':arguments},ensure_ascii=False).encode('utf-8')
    request=Request(base+'/api/automation/call',data=body,headers={'Content-Type':'application/json','Authorization':'Bearer '+token})
    try:
        with urlopen(request,timeout=25) as response:return json.load(response)
    except HTTPError as exc:
        try:return json.loads(exc.read())
        except ValueError:return {'ok':False,'error':f'本机接口 HTTP {exc.code}'}
        finally:exc.close()

def dispatch(message,discovery):
    method=message.get('method');identifier=message.get('id')
    if 'id' not in message:return None
    reply={'jsonrpc':'2.0','id':identifier}
    if not isinstance(message.get('params',{}),dict):
        reply['error']={'code':-32602,'message':'Invalid params'};return reply
    if method=='initialize':
        requested=message.get('params',{}).get('protocolVersion')
        version=requested if requested in {'2024-11-05','2025-03-26','2025-06-18'} else '2025-06-18'
        reply['result']={'protocolVersion':version,'capabilities':{'tools':{'listChanged':False}},'serverInfo':{'name':'yolo-auto-tag','version':APP_VERSION},'instructions':'Control the local YOLO Auto-Tag desktop app. Read app_status before mutations. API requests use the user configured provider and quota.'}
    elif method=='ping':reply['result']={}
    elif method=='tools/list':reply['result']={'tools':tool_schemas()}
    elif method=='tools/call':
        params=message.get('params',{})
        try:
            data=invoke(params.get('name'),params.get('arguments',{}),discovery)
            result=data.get('result',{});ok=data.get('ok',False) and not(isinstance(result,dict) and result.get('ok') is False)
            if isinstance(result,dict) and result.get('mime_type')=='image/jpeg' and result.get('data'):
                base64.b64decode(result['data'],validate=True)
                content=[{'type':'image','data':result['data'],'mimeType':'image/jpeg'}]
            else:content=[{'type':'text','text':json.dumps(data,ensure_ascii=False)}]
            reply['result']={'content':content,'isError':not ok}
        except Exception as exc:
            reply['result']={'content':[{'type':'text','text':'本机应用未连接或操作失败：'+type(exc).__name__+': '+str(exc)[:300]}],'isError':True}
    else:reply['error']={'code':-32601,'message':'Method not found'}
    return reply

def main():
    parser=argparse.ArgumentParser(description='YOLO Auto-Tag MCP stdio / local CLI')
    parser.add_argument('--discovery',default=str(settings_dir()/'automation.json'));parser.add_argument('--call');parser.add_argument('--args',default='{}');parser.add_argument('--list',action='store_true')
    args=parser.parse_args()
    if args.list:
        print(json.dumps(tool_schemas(),ensure_ascii=True));return 0
    if args.call:
        try:print(json.dumps(invoke(args.call,json.loads(args.args),args.discovery),ensure_ascii=True));return 0
        except Exception as exc:print(json.dumps({'ok':False,'error':type(exc).__name__+': '+str(exc)[:300]},ensure_ascii=True));return 1
    # MCP stdio: one UTF-8 JSON-RPC message per line; stdout contains no logs.
    for line in sys.stdin.buffer:
        try:
            if len(line)>4*1024*1024:raise ValueError('Message too large')
            message=json.loads(line)
            if not isinstance(message,dict) or message.get('jsonrpc')!='2.0':raise ValueError('Invalid JSON-RPC request')
            result=dispatch(message,args.discovery)
        except (ValueError,TypeError):result={'jsonrpc':'2.0','id':None,'error':{'code':-32700,'message':'Parse error'}}
        if result is not None:sys.stdout.buffer.write(json.dumps(result,ensure_ascii=False).encode('utf-8')+b'\n');sys.stdout.buffer.flush()
    return 0

if __name__=='__main__':raise SystemExit(main())
