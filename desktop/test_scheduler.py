"""Deterministic scheduler tests; no external services or credentials."""
from concurrent.futures import ThreadPoolExecutor
import threading
import time
import unittest
from request_limiter import RequestLimiter,TaskCancelled,retry_after_seconds
from desktop_server import UpstreamResponse


class SchedulerTests(unittest.TestCase):
    def test_adaptive_reduction_route_distinction_and_recovery(self):
        now=[100.]
        gate=RequestLimiter(10,clock=lambda:now[0])
        for _ in range(3):gate.feedback(503,.1,b'Routing configuration unavailable')
        self.assertEqual(gate.snapshot()['effective_limit'],10)
        gate.feedback(0,1,timeout=True);gate.feedback(0,1,timeout=True)
        self.assertEqual(gate.snapshot()['effective_limit'],5)
        gate.feedback(429,.1,retry_after='7')
        self.assertEqual(gate.snapshot()['effective_limit'],3)
        self.assertEqual(gate.snapshot()['cooldown_seconds'],7)
        now[0]+=8
        for _ in range(6):gate.feedback(200,.1)
        self.assertEqual(gate.snapshot()['effective_limit'],4)
        gate.set_limit(10)
        self.assertEqual(gate.snapshot()['effective_limit'],4)
        gate.set_limit(2)
        self.assertEqual(gate.snapshot()['effective_limit'],2)

    def test_shared_rpm_window_without_holding_active_slot(self):
        gate=RequestLimiter(4,rpm=2,window_seconds=.15)
        starts=[]
        def task():
            with gate.slot():starts.append(time.monotonic())
        with ThreadPoolExecutor(max_workers=4) as pool:
            for future in [pool.submit(task) for _ in range(4)]:future.result(timeout=3)
        starts.sort()
        self.assertGreaterEqual(starts[2]-starts[0],.13)
        self.assertEqual(gate.snapshot()['requests_total'],4)
        self.assertEqual(gate.snapshot()['active'],0)

    def test_429_retry_obeys_retry_after_and_counts(self):
        gate=RequestLimiter(4)
        starts=[]
        def operation():
            starts.append(time.monotonic())
            return UpstreamResponse(429 if len(starts)==1 else 200,'application/json',b'{}',{'Retry-After':'.1'})
        first=gate.execute(operation)
        self.assertEqual(first[0],429)
        self.assertEqual(len(starts),1)
        result=gate.execute(operation,retry=True)
        self.assertEqual(result[0],200)
        self.assertGreaterEqual(starts[1]-starts[0],.09)
        stats=gate.snapshot()
        self.assertEqual(stats['requests_total'],2)
        self.assertEqual(stats['retries_total'],1)
        self.assertEqual(stats['effective_limit'],2)

    def test_stop_wakes_rpm_queue_without_sending(self):
        gate=RequestLimiter(1,rpm=1)
        gate.begin_task('task-stop')
        with gate.slot(task_id='task-stop'):pass
        with ThreadPoolExecutor(max_workers=1) as pool:
            future=pool.submit(gate.execute,lambda:200,task_id='task-stop')
            for _ in range(100):
                if gate.snapshot()['queued']:break
                time.sleep(.005)
            gate.cancel_task('task-stop')
            with self.assertRaises(TaskCancelled):future.result(timeout=1)
        self.assertEqual(gate.snapshot()['requests_total'],1)
        self.assertEqual(gate.snapshot()['queued'],0)

    def test_probe_cannot_overtake_waiting_annotation(self):
        gate=RequestLimiter(1)
        entered=threading.Event();release=threading.Event();order=[]
        def blocker():
            with gate.slot():entered.set();release.wait(3)
        def work(kind):
            with gate.slot(kind):order.append(kind)
        with ThreadPoolExecutor(max_workers=3) as pool:
            first=pool.submit(blocker);self.assertTrue(entered.wait(1))
            probe=pool.submit(work,'probe')
            for _ in range(100):
                if gate.snapshot()['queued']:break
                time.sleep(.005)
            annotation=pool.submit(work,'annotation')
            for _ in range(100):
                if gate.snapshot()['queued']==2:break
                time.sleep(.005)
            release.set()
            for future in [first,probe,annotation]:future.result(timeout=2)
        self.assertEqual(order,['annotation','probe'])

    def test_unknown_and_finished_task_fail_closed(self):
        gate=RequestLimiter()
        with self.assertRaises(TaskCancelled):
            with gate.slot(task_id='unknown'):pass
        gate.begin_task('finished');gate.finish_task('finished')
        with self.assertRaises(TaskCancelled):
            with gate.slot(task_id='finished'):pass
        self.assertEqual(gate.snapshot()['requests_total'],0)

    def test_retry_header_validation(self):
        self.assertEqual(retry_after_seconds('nan',3),3)
        self.assertEqual(retry_after_seconds('inf',3),3)
        self.assertEqual(retry_after_seconds('bad',3),3)


if __name__=='__main__':unittest.main()
