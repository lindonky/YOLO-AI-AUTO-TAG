"""Offline regression tests for model discovery, bounded failover and HTTP integration."""
import json
import tempfile
import threading
import unittest
from pathlib import Path
from urllib.error import HTTPError,URLError
from urllib.request import Request,urlopen
from unittest.mock import patch

from desktop_server import create_server,validate_chat_response
from model_router import GeminiRouter,SelectionError,probe_answer_is_valid,probe_payload
from secure_settings import SettingsStore


def chat(content='[]'):
    return json.dumps({'choices':[{'message':{'content':content},'finish_reason':'stop'}]}).encode()


GOOD_PROBE=chat('{"colors":["green","blue","orange"],"black_triangles":1}')
RUNTIME={'api_url':'https://example.invalid/v1/chat/completions','api_key':'fake-test-key','model':'gemini-3.8-flash-low','auto_model':True,'allow_pro':False,'proxy_url':''}
MODELS=[RUNTIME['model'],'gemini-3.1-flash-lite-preview','gemini-3.5-flash-lite','gemini-2.5-flash-lite','gemini-2.5-pro','gemini-image']


class RouterTests(unittest.TestCase):
    def make_router(self,fail=None,models=MODELS):
        calls=[]
        def upstream(body,runtime,**kwargs):
            request=json.loads(body);model=request['model'];probe='max_tokens' in request
            calls.append((model,probe))
            if fail:
                result=fail(model,probe)
                if isinstance(result,Exception):raise result
                if result:return result,'application/json',b'{"error":{"message":"Routing configuration unavailable"}}'
            return 200,'application/json',GOOD_PROBE if probe else chat()
        return GeminiRouter(upstream,lambda runtime:models,validate_chat_response),calls

    def test_probe_requires_correct_image_answer(self):
        self.assertTrue(probe_answer_is_valid(validate_chat_response(GOOD_PROBE)))
        for text in ['{}','{"colors":["green","blue"],"black_triangles":1}','{"colors":["green","blue","orange"],"black_triangles":true}']:
            self.assertFalse(probe_answer_is_valid(validate_chat_response(chat(text))))
        image=probe_payload('test')['messages'][0]['content'][1]['image_url']['url']
        self.assertTrue(image.startswith('data:image/png;base64,iVBOR'))

    def test_503_fallback_records_actual_model_and_cooldown(self):
        router,calls=self.make_router(lambda model,probe:503 if model==RUNTIME['model'] and not probe else None)
        status,_,_,model,attempted=router.route({'messages':[]},RUNTIME)
        self.assertEqual(status,200);self.assertEqual(model,'gemini-3.1-flash-lite-preview')
        self.assertEqual(attempted,[RUNTIME['model'],model])
        before=len(calls);router.route({'messages':[]},RUNTIME)
        self.assertEqual(calls[before:],[(model,False)])
        snapshot=router.snapshot(RUNTIME)
        self.assertEqual(snapshot['active_model'],model)
        self.assertEqual(snapshot['models'][0]['category'],'routing_unavailable')
        self.assertNotIn('fake-test-key',json.dumps(snapshot))

    def test_timeout_falls_back_but_dns_error_does_not(self):
        for error,can_switch in [(TimeoutError('read timed out'),True),(URLError(TimeoutError()),True),(URLError('DNS failed'),False)]:
            router,calls=self.make_router(lambda model,probe:error if model==RUNTIME['model'] and not probe else None)
            if can_switch:self.assertEqual(router.route({'messages':[]},RUNTIME)[3],'gemini-3.1-flash-lite-preview')
            else:
                with self.assertRaises(SelectionError):router.route({'messages':[]},RUNTIME)
                self.assertEqual(len(calls),2)

    def test_all_bad_models_stop_at_global_selection_limit(self):
        router,calls=self.make_router(lambda model,probe:503)
        with self.assertRaises(SelectionError) as raised:router.route({'messages':[]},RUNTIME)
        self.assertEqual(len(calls),4)
        self.assertEqual(len(raised.exception.attempted),4)

    def test_connection_failure_can_retry_the_same_verified_model(self):
        failed=[False]
        router,calls=self.make_router(lambda model,probe:URLError('connection reset') if failed[0] and not probe else None)
        router.route({'messages':[]},RUNTIME)
        failed[0]=True
        with self.assertRaises(SelectionError) as raised:router.route({'messages':[]},RUNTIME)
        self.assertEqual(raised.exception.status,502)
        failed[0]=False
        self.assertEqual(router.route({'messages':[]},RUNTIME)[0],200)
        self.assertEqual(calls,[(RUNTIME['model'],True)]+[(RUNTIME['model'],False)]*3)

    def test_real_requests_have_separate_three_attempt_limit(self):
        router,calls=self.make_router(lambda model,probe:503 if not probe else None)
        with self.assertRaises(SelectionError):router.route({'messages':[]},RUNTIME)
        self.assertEqual(len([c for c in calls if not c[1]]),3)

    def test_auth_or_rate_limit_does_not_rotate(self):
        for status in [401,403,429]:
            router,calls=self.make_router(lambda model,probe:status)
            with self.assertRaises(SelectionError):router.route({'messages':[]},RUNTIME)
            self.assertEqual(len(calls),1)
            router,calls=self.make_router(lambda model,probe:status if not probe else None)
            self.assertEqual(router.route({'messages':[]},RUNTIME)[0],status)
            self.assertEqual(len(calls),2)

    def test_manual_mode_does_not_discover_or_switch(self):
        router,calls=self.make_router(lambda model,probe:503)
        router.catalog_loader=lambda runtime:(_ for _ in ()).throw(AssertionError('manual discovery'))
        self.assertEqual(router.route({'model':'wrong','messages':[]},{**RUNTIME,'auto_model':False})[0],503)
        self.assertEqual(calls,[(RUNTIME['model'],False)])

    def test_pro_policy_and_credential_isolation(self):
        router,_=self.make_router()
        self.assertNotIn('gemini-2.5-pro',router.candidates(RUNTIME))
        self.assertIn('gemini-2.5-pro',router.candidates({**RUNTIME,'allow_pro':True}))
        self.assertIn('gemini-2.5-pro',router.candidates({**RUNTIME,'model':'gemini-2.5-pro'}))
        router.probe_one(RUNTIME,RUNTIME['model'])
        other={**RUNTIME,'api_key':'another-fake-key'}
        router.catalog(other)
        self.assertEqual(router.snapshot(other)['models'][0]['status'],'listed_only')
        self.assertEqual(router.snapshot(RUNTIME)['models'][0]['status'],'vision_ok')

    def test_expired_probe_requires_reverification(self):
        router,calls=self.make_router();router.ensure_model(RUNTIME)
        router._state(RUNTIME)['health'][RUNTIME['model']]['verified_at']-=301
        self.assertEqual(router.snapshot(RUNTIME)['models'][0]['status'],'expired')
        router.ensure_model(RUNTIME)
        self.assertEqual(len(calls),2)

    def test_catalog_failure_is_selection_failure(self):
        router,_=self.make_router()
        router.catalog_loader=lambda runtime:(_ for _ in ()).throw(URLError('offline'))
        with self.assertRaises(SelectionError):router.route({'messages':[]},RUNTIME)

    def test_probe_job_completes_and_excludes_pro(self):
        router,calls=self.make_router();router.start_probe(RUNTIME)
        for thread in threading.enumerate():
            if thread.name=='GeminiModelProbe':thread.join(timeout=5)
        snapshot=router.snapshot(RUNTIME)
        self.assertFalse(snapshot['probe']['running'])
        self.assertEqual(snapshot['probe']['done'],4)
        self.assertFalse(any('pro' in model for model,_ in calls))


class RouterHttpTests(unittest.TestCase):
    def test_settings_and_http_auto_mode(self):
        with tempfile.TemporaryDirectory() as temp:
            store=SettingsStore(Path(temp)/'settings.json')
            saved=store.update(RUNTIME)
            self.assertTrue(saved['auto_model']);self.assertFalse(saved['allow_pro'])
            self.assertNotIn('api_key',saved)
            self.assertNotIn('fake-test-key',store.path.read_text(encoding='utf-8'))
            with self.assertRaises(ValueError):store.update({**RUNTIME,'auto_model':'true'})
            server=create_server(Path(temp),store,port=0)
            thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
            base=f'http://127.0.0.1:{server.server_address[1]}'
            def post(path,body=None):
                request=Request(base+path,data=json.dumps(body or {}).encode(),headers={'Content-Type':'application/json'})
                with urlopen(request,timeout=5) as response:return json.loads(response.read())
            try:
                router,_=RouterTests().make_router();server.model_router=router
                self.assertEqual(post('/api/app-config/test')['model_used'],RUNTIME['model'])
                result=post('/api/proxy/custom',{'messages':[]})
                self.assertEqual(result['_autotag']['model_used'],RUNTIME['model'])
                self.assertTrue(result['_autotag']['auto_model'])
                changed=post('/api/app-config',{**RUNTIME,'max_concurrency':3})
                self.assertEqual(changed['max_concurrency'],3)
                selected=post('/api/models/select',{'model':'gemini-2.5-pro'})
                self.assertFalse(selected['auto_model']);self.assertEqual(selected['model'],'gemini-2.5-pro')
                self.assertEqual(store.runtime()['api_key'],RUNTIME['api_key'])
                post('/api/app-config',{**RUNTIME,'max_concurrency':3})
                with urlopen(base+'/api/models',timeout=5) as response:
                    self.assertEqual(json.loads(response.read())['request_limits']['limit'],3)
                server.model_router,_=RouterTests().make_router(lambda model,probe:503)
                with self.assertRaises(HTTPError) as raised:post('/api/proxy/custom',{'messages':[]})
                self.assertEqual(raised.exception.code,503)
                self.assertFalse(json.loads(raised.exception.read())['error'].get('fatal',False))
                server.model_router,_=RouterTests().make_router(lambda model,probe:429 if not probe else None)
                with self.assertRaises(HTTPError) as raised:post('/api/proxy/custom',{'messages':[]})
                self.assertEqual(raised.exception.code,429)
                self.assertFalse(json.loads(raised.exception.read())['error'].get('fatal',False))
            finally:server.shutdown();server.server_close();thread.join(timeout=5)


if __name__=='__main__':unittest.main()
