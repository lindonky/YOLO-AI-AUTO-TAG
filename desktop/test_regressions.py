"""Regression tests for API configuration and actual HTTP preflight responses."""
import json
import tempfile
import threading
import unittest
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request,urlopen
from unittest.mock import patch
from secure_settings import SettingsStore,normalize_api_url
from desktop_server import create_server,validate_chat_response

class ConfigurationRegressions(unittest.TestCase):
    def test_base_url_and_custom_paths(self):
        for suffix in ['', '/', '/v1', '/v1/']:
            self.assertEqual(normalize_api_url('https://example.invalid'+suffix),'https://example.invalid/v1/chat/completions')
        self.assertEqual(normalize_api_url('https://example.invalid/relay/v1/?region=test'),'https://example.invalid/relay/v1/chat/completions?region=test')
        self.assertEqual(normalize_api_url('https://example.invalid/custom/vision'),'https://example.invalid/custom/vision')

    def test_legacy_base_url_is_read_without_rewriting_key(self):
        with tempfile.TemporaryDirectory() as temp:
            store=SettingsStore(Path(temp)/'settings.json')
            store.update({'api_url':'https://example.invalid/','api_key':'fake-test-key','model':'test','proxy_url':''})
            saved=json.loads(store.path.read_text(encoding='utf-8'))
            saved['profiles'][0]['api_url']='https://example.invalid/v1'
            store.path.write_text(json.dumps(saved),encoding='utf-8')
            original=store.path.read_bytes()
            self.assertEqual(store.runtime()['api_url'],'https://example.invalid/v1/chat/completions')
            self.assertEqual(store.public()['api_url'],'https://example.invalid/v1/chat/completions')
            self.assertEqual(store.path.read_bytes(),original)
            self.assertEqual(store.runtime()['api_key'],'fake-test-key')
            self.assertEqual(store.update({'api_url':'https://example.invalid/v1/responses','model':'test'})['protocol'],'responses')

    def test_response_validation(self):
        for value in [b'<!doctype html><title>gateway</title>',b'{}',b'{"choices":[]}',b'{"choices":[{"message":{"content":""}}]}',b'{"choices":[{"message":{"content":"[]"},"finish_reason":"length"}]}']:
            with self.assertRaises(ValueError):validate_chat_response(value)
        validate_chat_response(b'{"choices":[{"message":{"content":"[]"},"finish_reason":"stop"}]}')

    def test_http_test_rejects_200_html_and_accepts_valid_chat(self):
        with tempfile.TemporaryDirectory() as temp:
            store=SettingsStore(Path(temp)/'settings.json')
            store.update({'api_url':'https://example.invalid/v1','api_key':'fake-test-key','model':'test','proxy_url':''})
            server=create_server(Path(temp),store,port=0)
            thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
            url=f'http://127.0.0.1:{server.server_address[1]}/api/app-config/test'
            try:
                with patch('desktop_server.request_upstream',return_value=(200,'text/html',b'<html>gateway</html>')):
                    with self.assertRaises(HTTPError) as raised:urlopen(Request(url,method='POST'),timeout=5)
                    self.assertEqual(raised.exception.code,502)
                    self.assertIn('网页',json.loads(raised.exception.read())['message'])
                valid=b'{"choices":[{"message":{"content":"[]"}}]}'
                with patch('desktop_server.request_upstream',return_value=(200,'application/json',valid)) as upstream:
                    with urlopen(Request(url,method='POST'),timeout=5) as response:self.assertTrue(json.loads(response.read())['ok'])
                    self.assertFalse(json.loads(upstream.call_args.args[0])['stream'])
            finally:server.shutdown();server.server_close();thread.join(timeout=5)

if __name__=='__main__':unittest.main()
