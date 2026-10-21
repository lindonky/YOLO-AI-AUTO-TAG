"""Provider compatibility, migration, key isolation and real wire-adapter checks."""
import json,tempfile,threading,time,unittest
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
from pathlib import Path
from provider_api import resolve_endpoint,encode_request,decode_response,vision_model_error
from secure_settings import SettingsStore,protect_text
from desktop_server import request_upstream,create_server

class ProviderTests(unittest.TestCase):
    def test_url_matrix(self):
        cases=[
          ('https://api.deepseek.com','auto','https://api.deepseek.com/chat/completions','chat'),
          ('https://api.deepseek.com/v1/','auto','https://api.deepseek.com/v1/chat/completions','chat'),
          ('https://api.deepseek.com/anthropic','auto','https://api.deepseek.com/anthropic/v1/messages','anthropic'),
          ('https://x.invalid/v1/messages/','auto','https://x.invalid/v1/messages','anthropic'),
          ('https://x.invalid/v1/responses','auto','https://x.invalid/v1/responses','responses'),
          ('https://x.invalid','responses','https://x.invalid/v1/responses','responses'),
          ('https://x.invalid/relay/api','chat','https://x.invalid/relay/api/chat/completions','chat'),
          ('https://x.invalid/prefix/v1/?region=cn','auto','https://x.invalid/prefix/v1/chat/completions?region=cn','chat'),
          ('https://x.invalid/custom/vision','auto','https://x.invalid/custom/vision','chat'),
          ('https://x.invalid/prefix','anthropic','https://x.invalid/prefix/messages','anthropic')]
        for url,protocol,expected,kind in cases:
            with self.subTest(url=url):self.assertEqual(resolve_endpoint(url,protocol),(expected,kind))
        for url,protocol in [('https://u:p@x.invalid','auto'),('file:///tmp/a','auto'),('https://x.invalid/v1/responses','chat'),('https://x.invalid/#login','auto')]:
            with self.assertRaises(ValueError):resolve_endpoint(url,protocol)

    def test_legacy_migration_does_not_write_until_saved(self):
        with tempfile.TemporaryDirectory() as temp:
            store=SettingsStore(Path(temp)/'settings.json')
            legacy={'version':1,'api_url':'https://relay.invalid/v1','model':'gemini-a','api_key_dpapi':protect_text('isolated-key-a'),'max_concurrency':8}
            store.path.write_text(json.dumps(legacy),encoding='utf-8');before=store.path.read_bytes()
            self.assertEqual(store.runtime()['api_key'],'isolated-key-a');self.assertEqual(store.public()['max_concurrency'],8)
            self.assertEqual(store.path.read_bytes(),before)
            store.update({'api_url':legacy['api_url'],'model':'gemini-a','max_retries':4})
            self.assertEqual(store.runtime()['max_retries'],4);self.assertEqual(store.runtime()['api_key'],'isolated-key-a')
            self.assertEqual(json.loads(store.path.read_text(encoding='utf-8'))['version'],2)

    def test_profiles_do_not_inherit_or_return_keys(self):
        with tempfile.TemporaryDirectory() as temp:
            store=SettingsStore(Path(temp)/'settings.json')
            a=store.update({'api_url':'https://relay.invalid/v1','api_key':'isolated-key-a','model':'gemini-a','profile_name':'中转 A'})
            new={'profile_id':'new','profile_name':'DeepSeek','api_url':'https://api.deepseek.com','model':'deepseek-v4-flash','models':['deepseek-v4-flash','deepseek-flash']}
            with self.assertRaises(ValueError):store.update(new)
            self.assertEqual(len(store.public()['profiles']),1)
            b=store.update({**new,'api_key':'isolated-key-b','max_retries':0,'max_concurrency':8})
            self.assertEqual(store.runtime()['api_key'],'isolated-key-b');self.assertEqual(store.public()['max_retries'],0)
            store.select_profile(a['profile_id']);self.assertEqual(store.runtime()['api_key'],'isolated-key-a')
            store.select_profile(b['profile_id']);self.assertEqual(store.runtime()['model'],'deepseek-v4-flash')
            public=json.dumps(store.public());self.assertNotIn('isolated-key',public);self.assertNotIn('api_key_dpapi',public)
            with self.assertRaises(ValueError):store.update({'api_url':'https://other.invalid','model':'test'})
            self.assertEqual(store.runtime()['api_key'],'isolated-key-b')
            with self.assertRaises(ValueError):store.delete_profile(b['profile_id'])
            store.delete_profile(a['profile_id']);self.assertEqual(len(store.public()['profiles']),1)

    def test_retry_validation_and_vision_guard(self):
        with tempfile.TemporaryDirectory() as temp:
            store=SettingsStore(Path(temp)/'settings.json')
            payload={'api_url':'https://api.deepseek.com','model':'deepseek-v4-flash','api_key':'isolated-key'}
            for count in (0,2,10):self.assertEqual(store.update({**payload,'max_retries':count})['max_retries'],count)
            for count in (-1,11,True,'2',2.5):
                with self.assertRaises(ValueError):store.update({**payload,'max_retries':count})
            for model in ('deepseek-v4-flash','deepseek-flash'):self.assertFalse(vision_model_error({**payload,'model':model}))
            self.assertTrue(vision_model_error({**payload,'model':'deepseek-v4-pro'}))
            self.assertFalse(vision_model_error({'api_url':'https://relay.invalid','model':'deepseek-v4-pro'}))

    def test_wire_protocols_with_images_and_separate_auth(self):
        seen=[]
        class Handler(BaseHTTPRequestHandler):
            def log_message(self,*args):pass
            def do_POST(self):
                value=json.loads(self.rfile.read(int(self.headers['Content-Length'])));seen.append((self.path,dict(self.headers),value))
                if self.path.endswith('responses'):result={'status':'completed','output':[{'type':'message','content':[{'type':'output_text','text':'[]'}]}]}
                elif self.path.endswith('messages'):result={'content':[{'type':'thinking','thinking':'hidden'},{'type':'text','text':'[]'}],'stop_reason':'end_turn'}
                else:result={'choices':[{'message':{'content':'[]'},'finish_reason':'stop'}]}
                raw=('\n\n'+json.dumps(result)).encode();self.send_response(200);self.send_header('Content-Length',str(len(raw)));self.end_headers();self.wfile.write(raw)
        server=ThreadingHTTPServer(('127.0.0.1',0),Handler);thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        content=[{'type':'text','text':'inspect'},{'type':'image_url','image_url':{'url':'data:image/png;base64,aGVsbG8='}}]
        payload={'messages':[{'role':'system','content':'JSON only'},{'role':'user','content':content},{'role':'assistant','content':'[]'},{'role':'user','content':'retry'}]}
        try:
            for protocol,suffix in [('chat','chat/completions'),('responses','responses'),('anthropic','messages')]:
                runtime={'api_url':f'http://127.0.0.1:{server.server_address[1]}/v1/'+suffix,'api_key':'isolated-'+protocol,'model':'deepseek-v4-flash','protocol':protocol}
                status,_,body=request_upstream(json.dumps(payload).encode(),runtime,timeout=3)
                self.assertEqual(status,200);self.assertEqual(json.loads(body)['choices'][0]['message']['content'],'[]')
                _,headers,data=seen[-1];headers={k.lower():v for k,v in headers.items()}
                if protocol=='anthropic':
                    self.assertEqual(headers.get('x-api-key'),'isolated-anthropic');self.assertNotIn('authorization',headers)
                    self.assertEqual(data['messages'][0]['content'][1]['source']['type'],'base64');self.assertIn('system',data)
                else:self.assertEqual(headers.get('authorization'),'Bearer isolated-'+protocol)
                if protocol=='responses':self.assertEqual(data['input'][1]['content'][1]['type'],'input_image')
                self.assertFalse(data['stream'])
        finally:server.shutdown();server.server_close();thread.join()

    def test_truncation_remains_visible(self):
        for protocol,data in [('anthropic',{'content':[{'type':'text','text':'[{'}],'stop_reason':'max_tokens'}),('responses',{'status':'incomplete','output':[{'type':'message','content':[{'type':'output_text','text':'[{'}]}]})]:
            decoded=json.loads(decode_response(json.dumps(data).encode(),protocol));self.assertEqual(decoded['choices'][0]['finish_reason'],'length')
        for protocol in ('anthropic','responses'):
            with self.assertRaises(ValueError):decode_response(b'<html>gateway</html>',protocol)

    def test_official_thinking_controls_and_probe_budget(self):
        for protocol in ('chat','anthropic','responses'):
            for thinking in (False,True):
                runtime={'api_url':'https://api.deepseek.com/v1/'+{'chat':'chat/completions','anthropic':'messages','responses':'responses'}[protocol],'model':'deepseek-v4-flash','api_key':'isolated-key','protocol':protocol,'deepseek_thinking':thinking}
                data,_=encode_request({'messages':[{'role':'user','content':'test'}]},runtime)
                expected={'effort':'high' if thinking else 'none'} if protocol=='responses' else {'type':'enabled' if thinking else 'disabled'}
                self.assertEqual(data.get('reasoning' if protocol=='responses' else 'thinking'),expected)
                probe,_=encode_request({'messages':[]},{**runtime,'_request_kind':'probe'})
                self.assertEqual(probe.get('reasoning' if protocol=='responses' else 'thinking'),{'effort':'none'} if protocol=='responses' else {'type':'disabled'})
        data,_=encode_request({'messages':[]},{'api_url':'https://relay.invalid/v1/chat/completions','model':'gemini-flash','api_key':'key','protocol':'chat'})
        self.assertNotIn('thinking',data)

    def test_unsupported_official_image_model_stops_before_network(self):
        from unittest.mock import patch
        with tempfile.TemporaryDirectory() as temp:
            store=SettingsStore(Path(temp)/'settings.json')
            store.update({'api_url':'https://api.deepseek.com','api_key':'isolated-key','model':'deepseek-v4-pro'})
            server=create_server(Path(temp),store)
            try:
                with patch('desktop_server.request_upstream') as network:
                    response=server.call_api({'messages':[]});self.assertEqual(response[0],400)
                    self.assertEqual(json.loads(response[2])['error']['code'],'UNSUPPORTED_VISION_MODEL')
                    network.assert_not_called();self.assertEqual(server.request_limiter.snapshot()['requests_total'],0)
            finally:server.server_close()

    def test_eight_global_slots_across_providers_models_and_retries(self):
        from request_limiter import RequestLimiter
        gate=RequestLimiter(8);lock=threading.Lock();active=0;peak=0
        def operation():
            nonlocal active,peak
            with lock:active+=1;peak=max(peak,active)
            time.sleep(.025)
            with lock:active-=1
            return 200,'application/json',b'{}'
        with ThreadPoolExecutor(max_workers=24) as pool:
            jobs=[pool.submit(gate.execute,operation,kind='probe' if i%5==0 else 'annotation',retry=i%3==0) for i in range(48)]
            for job in jobs:job.result(timeout=5)
        self.assertEqual(peak,8);self.assertEqual(gate.snapshot()['requests_total'],48);self.assertEqual(gate.snapshot()['retries_total'],16)

if __name__=='__main__':unittest.main()
