"""URL resolution and non-streaming vision adapters; internal messages stay Chat-shaped."""
import copy
import json
import re
from urllib.parse import urlsplit,urlunsplit

PROTOCOLS={'auto','chat','responses','anthropic'}

def resolve_endpoint(value,protocol='auto'):
    if protocol not in PROTOCOLS:raise ValueError('接口格式必须为 auto、chat、responses 或 anthropic')
    parts=urlsplit(value.strip());path=parts.path.rstrip('/')
    if parts.scheme not in {'http','https'} or not parts.hostname:raise ValueError('API URL 必须是完整 http(s) 地址')
    if parts.username or parts.password:raise ValueError('API URL 不应包含用户名或密码')
    if parts.fragment:raise ValueError('API URL 不应包含 # 片段')
    known=next(((suffix,kind) for suffix,kind in [('/chat/completions','chat'),('/responses','responses'),('/messages','anthropic')] if path.endswith(suffix)),None)
    inferred=known[1] if known else 'anthropic' if path.endswith('/anthropic') else 'chat'
    kind=inferred if protocol=='auto' else protocol
    if known and known[1]!=kind:raise ValueError('所选接口格式与 URL 末尾不一致，请改为自动识别或更换地址')
    if not known:
        suffix={'chat':'/chat/completions','responses':'/responses','anthropic':'/messages'}[kind]
        if not path:
            path='' if parts.hostname.lower()=='api.deepseek.com' and kind!='anthropic' else '/v1'
        elif path.endswith('/anthropic'):path+='/v1'
        # Explicit arbitrary paths remain usable as custom Chat endpoints.
        if protocol=='auto' and inferred=='chat' and path and not path.endswith(('/v1','/api','/openai')):
            return value.strip(),kind
        path+=suffix
    return urlunsplit((parts.scheme,parts.netloc,path,parts.query,'')),kind

def catalog_endpoint(runtime):
    parts=urlsplit(runtime['api_url']);path=parts.path.rstrip('/')
    for suffix in ('/chat/completions','/responses','/messages'):
        if path.endswith(suffix):
            path=path[:-len(suffix)]+'/models'
            return urlunsplit((parts.scheme,parts.netloc,path,parts.query,''))
    raise ValueError('自定义接口无法推导模型目录；请填写已知模型名称')

def vision_model_error(runtime,model=None):
    if urlsplit(runtime.get('api_url','')).hostname!='api.deepseek.com':return ''
    name=(model or runtime.get('model','')).lower()
    if name in {'deepseek-v4-pro','deepseek-chat','deepseek-reasoner'} or name.startswith('claude-opus'):
        return '该 DeepSeek 官方模型当前不支持图片输入，请选择 deepseek-flash 后再进行图片标注'
    return ''

def _blocks(content):
    if isinstance(content,str):return [{'type':'text','text':content}]
    if not isinstance(content,list):raise ValueError('消息内容格式无效')
    return content

def encode_request(payload,runtime):
    data=copy.deepcopy(payload);protocol=runtime.get('protocol','chat')
    data['model']=runtime['model'];data['stream']=False
    headers={'Authorization':'Bearer '+runtime['api_key']}
    messages=data.get('messages',[])
    has_image=any(p.get('type')=='image_url' for m in messages for p in _blocks(m.get('content','')))
    problem=vision_model_error(runtime)
    if has_image and problem:raise ValueError(problem)
    official_deepseek=urlsplit(runtime.get('api_url','')).hostname=='api.deepseek.com'
    thinking=runtime.get('deepseek_thinking') is True and runtime.get('_request_kind')!='probe'
    if official_deepseek:data['thinking']={'type':'enabled' if thinking else 'disabled'}
    if protocol=='chat':return data,headers
    result={'model':data['model'],'stream':False}
    for key in ('temperature','top_p'):
        if key in data:result[key]=data[key]
    if protocol=='responses':
        if official_deepseek:result['reasoning']={'effort':'high' if thinking else 'none'}
        result['input']=[]
        for message in messages:
            role=message.get('role','user');content=[]
            for block in _blocks(message.get('content','')):
                if block.get('type')=='text':content.append({'type':'output_text' if role=='assistant' else 'input_text','text':block.get('text','')})
                elif block.get('type')=='image_url':
                    image=block['image_url'];image={'url':image} if isinstance(image,str) else image
                    content.append({'type':'input_image','image_url':image['url'],**({'detail':image['detail']} if image.get('detail') else {})})
                else:raise ValueError('当前 Responses 适配仅支持文本和图片消息')
            result['input'].append({'role':role,'content':content})
        if 'max_tokens' in data:result['max_output_tokens']=data['max_tokens']
    elif protocol=='anthropic':
        if official_deepseek:result['thinking']=data['thinking']
        headers={'x-api-key':runtime['api_key'],'anthropic-version':'2023-06-01'}
        result['max_tokens']=data.get('max_tokens',8192);result['messages']=[];system=[]
        for message in messages:
            role=message.get('role','user');content=[]
            for block in _blocks(message.get('content','')):
                if block.get('type')=='text':content.append({'type':'text','text':block.get('text','')})
                elif block.get('type')=='image_url':
                    image=block['image_url'];url=image if isinstance(image,str) else image['url']
                    match=re.fullmatch(r'data:(image/[\w.+-]+);base64,(.+)',url,re.S)
                    source={'type':'base64','media_type':match[1],'data':match[2]} if match else {'type':'url','url':url}
                    content.append({'type':'image','source':source})
                else:raise ValueError('当前 Anthropic 适配仅支持文本和图片消息')
            if role in {'system','developer'}:
                if any(b['type']!='text' for b in content):raise ValueError('系统消息不支持图片')
                system.extend(content)
            else:result['messages'].append({'role':role,'content':content})
        if system:result['system']=system
    else:raise ValueError('未知接口格式')
    return result,headers

def decode_response(body,protocol):
    if protocol=='chat':return body
    try:data=json.loads(body)
    except (ValueError,UnicodeError):raise ValueError('接口返回了网页或非 JSON 内容，请核对接口地址与格式')
    if not isinstance(data,dict):raise ValueError('接口响应必须为 JSON 对象')
    if protocol=='anthropic':
        if not isinstance(data.get('content'),list):raise ValueError('Anthropic 响应缺少 content 数组')
        content='\n'.join(p.get('text','') for p in data['content'] if p.get('type')=='text')
        reason={'max_tokens':'length','refusal':'content_filter','end_turn':'stop','stop_sequence':'stop'}.get(data.get('stop_reason'),'stop')
    else:
        if data.get('status') in {'failed','cancelled','in_progress','queued'}:raise ValueError('Responses 请求未完成或失败')
        if not isinstance(data.get('output'),list):raise ValueError('Responses 响应缺少 output 数组')
        blocks=[p for item in data['output'] if item.get('type')=='message' for p in item.get('content',[])]
        content='\n'.join(p.get('text','') for p in blocks if p.get('type')=='output_text')
        reason='length' if data.get('status')=='incomplete' else 'content_filter' if any(p.get('type')=='refusal' for p in blocks) else 'stop'
    return json.dumps({'id':data.get('id'),'model':data.get('model'),'choices':[{'message':{'role':'assistant','content':content},'finish_reason':reason}],'usage':data.get('usage',{})},ensure_ascii=False).encode('utf-8')
