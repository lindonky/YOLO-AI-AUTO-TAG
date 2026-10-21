import json,tempfile,threading,time,unittest
from pathlib import Path
from urllib.request import Request,urlopen
from urllib.error import HTTPError
from unittest.mock import patch
from desktop_server import create_server,UpstreamResponse
from secure_settings import SettingsStore,unprotect_text
from automation import AutomationService
from diagnostics import RequestJournal
from mcp_bridge import dispatch

class AutomationTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name)
        self.store=SettingsStore(self.root/'settings.json');self.store.update({'api_url':'https://private.invalid/v1/chat/completions','api_key':'secret-for-qa','model':'gemini-test'})
        self.server=create_server(self.root,self.store);self.control=AutomationService(self.server,self.root/'automation.json');self.server.automation=self.control
        self.thread=threading.Thread(target=self.server.serve_forever,daemon=True);self.thread.start();self.base=f'http://127.0.0.1:{self.server.server_address[1]}'
    def tearDown(self):
        self.control.close();self.server.shutdown();self.server.server_close();self.thread.join();self.temp.cleanup()
    def post(self,path,data,headers=None):
        req=Request(self.base+path,data=json.dumps(data).encode(),headers={'Content-Type':'application/json',**(headers or {})})
        with urlopen(req,timeout=5) as r:return json.load(r)
    def test_authenticated_origin_and_discovery(self):
        data=json.loads((self.root/'automation.json').read_text());self.assertNotIn(self.control.token,json.dumps(data));self.assertEqual(unprotect_text(data['token_dpapi']),self.control.token)
        for headers in [{},{'Authorization':'Bearer '+self.control.token,'Origin':'https://other.invalid'}]:
            with self.assertRaises(HTTPError) as caught:self.post('/api/automation/call',{'name':'app_status'},headers)
            self.assertEqual(caught.exception.code,403)
        status=self.post('/api/automation/call',{'name':'app_status'},{'Authorization':'Bearer '+self.control.token})
        self.assertTrue(status['ok']);self.assertNotIn('secret-for-qa',json.dumps(status));self.assertNotIn('private.invalid',json.dumps(status))
    def test_ui_queue_ack_and_disallowed_arguments(self):
        self.control.heartbeat({'client_id':'a'*32,'snapshot':{'file_count':0}})
        results=[];thread=threading.Thread(target=lambda:results.append(self.control.call('task_control',{'action':'pause'})));thread.start()
        for _ in range(100):
            if self.control.pending:break
            time.sleep(.005)
        work=self.control.heartbeat({'client_id':'a'*32,'snapshot':{}})['commands'];self.assertEqual(len(work),1)
        self.control.heartbeat({'client_id':'a'*32,'snapshot':{},'completed':[{'id':work[0]['id'],'result':{'ok':True}}]});thread.join(2);self.assertEqual(results,[{'ok':True}])
        for name,args in [('eval',{'code':'1'}),('configure_task',{'api_key':'x'}),('task_control',{'action':'delete'})]:
            with self.assertRaises(ValueError):self.control.call(name,args)

    def test_rejected_control_request_keeps_connection_synchronized(self):
        from http.client import HTTPConnection
        connection=HTTPConnection('127.0.0.1',self.server.server_address[1],timeout=3)
        try:
            for _ in range(2):
                connection.request('POST','/api/automation/call',body=json.dumps({'name':'app_status'}),headers={'Content-Type':'application/json'})
                response=connection.getresponse();self.assertEqual(response.status,403);self.assertFalse(json.loads(response.read())['ok'])
            connection.request('GET','/api/health');response=connection.getresponse();self.assertEqual(response.status,200);response.read()
        finally:connection.close()

    def test_upstream_gateway_524_is_retryable_without_becoming_json_error(self):
        with patch('desktop_server.request_upstream',return_value=UpstreamResponse(524,'application/json',b'{"error":{"message":"All available accounts exhausted"}}')):
            result=self.server.call_api({'messages':[]})
        error=json.loads(result[2])['error']
        self.assertEqual(result[0],524);self.assertTrue(error['retryable']);self.assertEqual(error['origin'],'upstream')
        self.assertEqual(error['code'],'UPSTREAM_HTTP_524');self.assertFalse(error.get('retryable_json',False))
    def test_upstream_conflict_and_local_cancel_are_distinct(self):
        with patch('desktop_server.request_upstream',return_value=UpstreamResponse(409,'application/json',b'{"error":{"message":"busy"}}')):
            result=self.server.call_api({'messages':[]})
        body=json.loads(result[2]);self.assertEqual(result[0],409);self.assertEqual(body['error']['origin'],'upstream');self.assertTrue(body['error']['retryable'])
        gate=self.server.request_limiter;gate.begin_task('test-task-123');gate.cancel_task('test-task-123','upstream_http_403')
        result=self.server.call_api({'messages':[],'_autotag_task_id':'test-task-123'});error=json.loads(result[2])['error']
        self.assertTrue(error['taskStopped']);self.assertEqual(error['origin'],'local');self.assertEqual(error['stop_reason'],'upstream_http_403')
        records=self.server.journal.read();self.assertTrue(any(r.get('origin')=='upstream' and r.get('status')==409 for r in records))
    def test_redaction_and_log_failure_does_not_break_requests(self):
        journal=RequestJournal(['private-key'],self.root/'not-created'/'events.jsonl')
        journal.add('test',message='private-key https://x.invalid/private?a=b Bearer secret',api_key='private-key')
        text=json.dumps(journal.read());self.assertNotIn('private-key',text);self.assertNotIn('x.invalid',text);self.assertNotIn('Bearer secret',text)
    def test_mcp_initialize_tools_and_notifications(self):
        reply=dispatch({'jsonrpc':'2.0','id':1,'method':'initialize','params':{'protocolVersion':'2025-06-18'}},'unused')
        self.assertEqual(reply['result']['protocolVersion'],'2025-06-18')
        tools=dispatch({'jsonrpc':'2.0','id':2,'method':'tools/list'},'unused')['result']['tools'];self.assertEqual(len(tools),12)
        self.assertIsNone(dispatch({'jsonrpc':'2.0','method':'notifications/initialized'},'unused'))
        data=dispatch({'jsonrpc':'2.0','id':3,'method':'tools/call','params':{'name':'app_status'}},self.root/'automation.json')
        self.assertFalse(data['result']['isError'])

    def test_unreadable_saved_key_is_a_local_configuration_error(self):
        with patch.object(self.store,'runtime',side_effect=OSError('DPAPI failed')):
            reply=self.server.call_api({'messages':[]})
            self.assertEqual(reply[0],401);self.assertEqual(json.loads(reply[2])['error']['code'],'LOCAL_KEY_UNAVAILABLE')
            with self.assertRaises(HTTPError) as error:self.post('/api/app-config/test',{})
            self.assertEqual(error.exception.code,401)
            self.assertEqual(self.server.request_limiter.snapshot()['requests_total'],0)

if __name__=='__main__':unittest.main()
