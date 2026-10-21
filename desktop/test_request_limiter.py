"""Offline checks for the shared provider-request concurrency limit."""
from concurrent.futures import ThreadPoolExecutor
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from desktop_server import create_server
from request_limiter import RequestLimiter
from secure_settings import SettingsStore


class RequestLimitTests(unittest.TestCase):
    def test_invalid_limits_and_exception_release(self):
        gate=RequestLimiter()
        for value in [0,61,1.5,True,'2',None]:
            with self.assertRaises(ValueError):gate.set_limit(value)
        with self.assertRaises(RuntimeError):
            with gate.slot():raise RuntimeError('test')
        self.assertEqual({k:gate.snapshot()[k] for k in ['limit','active','queued']},{'limit':10,'active':0,'queued':0})
        gate.set_limit(60)
        self.assertEqual(gate.snapshot()['limit'],60)

    def test_resize_preserves_inflight_requests_and_wakes_queue(self):
        gate=RequestLimiter(1)
        entered=[threading.Event() for _ in range(3)]
        release=[threading.Event() for _ in range(3)]
        def task(index):
            with gate.slot():
                entered[index].set()
                self.assertTrue(release[index].wait(5))
        with ThreadPoolExecutor(max_workers=3) as pool:
            futures=[pool.submit(task,0)]
            self.assertTrue(entered[0].wait(2))
            futures.append(pool.submit(task,1))
            self.assertFalse(entered[1].wait(.05))
            gate.set_limit(2)
            self.assertTrue(entered[1].wait(2))
            gate.set_limit(1)
            futures.append(pool.submit(task,2))
            self.assertFalse(entered[2].wait(.05))
            release[0].set()
            self.assertFalse(entered[2].wait(.05))
            release[1].set()
            self.assertTrue(entered[2].wait(2))
            release[2].set()
            for future in futures:future.result(timeout=5)
        self.assertEqual(gate.snapshot()['active'],0)

    def test_catalog_and_chat_share_one_gate(self):
        with tempfile.TemporaryDirectory() as temp:
            store=SettingsStore(Path(temp)/'settings.json')
            server=create_server(Path(temp),store)
            lock=threading.Lock();active=0;peak=0
            def fake_network(*args,**kwargs):
                nonlocal active,peak
                with lock:active+=1;peak=max(active,peak)
                time.sleep(.02)
                with lock:active-=1
                return (200,'application/json',b'{}') if args and isinstance(args[0],bytes) else []
            try:
                with patch('desktop_server.request_upstream',side_effect=fake_network),patch('desktop_server.load_gemini_catalog',side_effect=fake_network):
                    for limit in [1,3]:
                        peak=0;server.request_limiter.set_limit(limit)
                        with ThreadPoolExecutor(max_workers=6) as pool:
                            futures=[pool.submit(server.load_catalog,{}) if i%2 else pool.submit(server.request_upstream,b'{}',{}) for i in range(6)]
                            for future in futures:future.result(timeout=5)
                        self.assertEqual(peak,limit)
                        self.assertEqual(server.request_limiter.snapshot()['queued'],0)
            finally:server.server_close()

    def test_setting_persistence_and_legacy_default(self):
        with tempfile.TemporaryDirectory() as temp:
            store=SettingsStore(Path(temp)/'settings.json')
            self.assertEqual(store.public()['max_concurrency'],10)
            payload={'api_url':'https://example.invalid/v1','api_key':'fake-test-key','model':'gemini-test','max_concurrency':3}
            self.assertEqual(store.update(payload)['max_concurrency'],3)
            self.assertEqual(SettingsStore(store.path).runtime()['max_concurrency'],3)
            for value in [0,61,1.5,True,'2',None]:
                with self.assertRaises(ValueError):store.update({**payload,'max_concurrency':value})
            self.assertEqual(store.runtime()['max_concurrency'],3)
            self.assertEqual(store.update({**payload,'max_concurrency':60})['max_concurrency'],60)
            self.assertEqual(store.update({**payload,'max_concurrency':1})['max_concurrency'],1)
            self.assertEqual(SettingsStore(store.path).runtime()['max_concurrency'],1)


if __name__=='__main__':unittest.main()
