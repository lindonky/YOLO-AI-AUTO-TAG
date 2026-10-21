"""Actual loopback HTTP tests for asynchronous jobs and cancellation."""
import json,tempfile,threading,time,unittest
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import Request,urlopen
from unittest.mock import patch
from desktop_server import create_server,UpstreamResponse
from secure_settings import SettingsStore


GOOD=b'{"choices":[{"message":{"content":"[]"},"finish_reason":"stop"}]}'


class JobApiTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.store=SettingsStore(Path(self.temp.name)/'settings.json')
        self.store.update({'api_url':'https://example.invalid/v1','api_key':'fake-test-key','model':'gemini-test','max_concurrency':2})
        self.server=create_server(Path(self.temp.name),self.store)
        self.thread=threading.Thread(target=self.server.serve_forever,daemon=True);self.thread.start()
        self.base=f'http://127.0.0.1:{self.server.server_address[1]}'
    def tearDown(self):
        self.server.shutdown();self.server.server_close();self.thread.join(3);self.temp.cleanup()
    def post(self,path,data):
        request=Request(self.base+path,data=json.dumps(data).encode(),headers={'Content-Type':'application/json'})
        with urlopen(request,timeout=5) as response:return json.loads(response.read())
    def get(self,path):
        with urlopen(self.base+path,timeout=5) as response:return json.loads(response.read())
    def task(self,action,task_id='task-alpha'):
        return self.post('/api/scheduler/task',{'action':action,'task_id':task_id,'rpm':0})

    def test_submission_returns_before_provider_and_stop_cancels_queued(self):
        release=threading.Event();entered=threading.Event();calls=[]
        def provider(payload,runtime,**kwargs):
            calls.append(json.loads(payload))
            if len(calls)>=2:entered.set()
            release.wait(5)
            return 200,'application/json',GOOD
        self.task('start')
        try:
            with patch('desktop_server.request_upstream',side_effect=provider):
                ids=[self.post('/api/proxy/jobs',{'model':'ignored','messages':[],'_autotag_task_id':'task-alpha'})['job_id'] for _ in range(8)]
                self.assertEqual(len(set(ids)),8)
                self.assertTrue(entered.wait(2))
                self.task('stop');release.set()
                rows={};acks=[]
                for _ in range(20):
                    result=self.get('/api/proxy/jobs?'+urlencode({'task_id':'task-alpha','ack':','.join(acks)}))
                    for row in result['results']:rows[row['job_id']]=row
                    acks=list(rows)
                    if len(rows)==8:break
                self.assertEqual(len(rows),8)
                self.assertEqual(len(calls),2)
                self.assertEqual(sum(row['status']==200 for row in rows.values()),2)
                self.assertEqual(sum(row['status']==409 for row in rows.values()),6)
                self.assertTrue(all('_autotag_task_id' not in body and '_autotag_retry' not in body for body in calls))
                self.assertNotIn('fake-test-key',json.dumps(rows))
                self.task('finish');self.assertFalse(self.server.jobs)
                self.assertEqual(self.get('/api/scheduler')['active'],0)
        finally:release.set()

    def test_unknown_or_malformed_task_does_not_submit(self):
        for task_id,expected in [('not-started',409),([],400)]:
            with self.assertRaises(HTTPError) as raised:self.post('/api/proxy/jobs',{'_autotag_task_id':task_id,'messages':[]})
            self.assertEqual(raised.exception.code,expected)
        self.assertEqual(self.server.request_limiter.snapshot()['requests_total'],0)

    def test_ack_cannot_remove_other_task_results(self):
        self.task('start');self.task('start','task-bravo')
        with patch('desktop_server.request_upstream',return_value=(200,'application/json',GOOD)):
            first=self.post('/api/proxy/jobs',{'_autotag_task_id':'task-alpha','messages':[]})['job_id']
            rows=self.get('/api/proxy/jobs?task_id=task-alpha')['results'];self.assertEqual(rows[0]['job_id'],first)
            self.get('/api/proxy/jobs?'+urlencode({'task_id':'task-bravo','ack':first}))
            self.assertIn(first,self.server.jobs)
            self.get('/api/proxy/jobs?'+urlencode({'task_id':'task-alpha','ack':first}))
            self.assertNotIn(first,self.server.jobs)

    def test_retry_header_and_json_error_classification(self):
        responses=[UpstreamResponse(429,'application/json',b'{"error":{"message":"busy"}}',{'Retry-After':'.05'}),(200,'application/json',GOOD)]
        with patch('desktop_server.request_upstream',side_effect=responses) as provider:
            with self.assertRaises(HTTPError) as rate:self.post('/api/proxy/custom',{'messages':[]})
            self.assertEqual(rate.exception.code,429)
            self.assertIn('Retry-After',rate.exception.headers)
            rate.exception.close()
            self.assertEqual(provider.call_count,1)
            result=self.post('/api/proxy/custom',{'messages':[],'_autotag_retry':True})
            self.assertIn('choices',result);self.assertEqual(provider.call_count,2)
            self.assertEqual(self.get('/api/scheduler')['retries_total'],1)
        for content in [b'{"choices":[{"message":{"content":"[]"},"finish_reason":"length"}]}',b'<html>gateway</html>']:
            with patch('desktop_server.request_upstream',return_value=(200,'application/json',content)):
                with self.assertRaises(HTTPError) as raised:self.post('/api/proxy/custom',{'messages':[]})
                self.assertTrue(json.loads(raised.exception.read())['error']['retryable_json'])
        with patch('desktop_server.request_upstream',return_value=(401,'application/json',b'{"error":{"message":"unauthorized"}}')):
            with self.assertRaises(HTTPError) as raised:self.post('/api/proxy/custom',{'messages':[]})
            self.assertTrue(json.loads(raised.exception.read())['error']['fatal'])


if __name__=='__main__':unittest.main()
