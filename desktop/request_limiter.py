"""Shared adaptive scheduling, rate budgets, cancellation and request metrics."""
from collections import deque
from contextlib import contextmanager
from datetime import datetime,timezone
from email.utils import parsedate_to_datetime
import math
import socket
import threading
import time
from urllib.error import HTTPError,URLError


class TaskCancelled(RuntimeError):
    pass


def retry_after_seconds(value,default=2):
    try:
        parsed=float(value)
        return max(0,parsed) if math.isfinite(parsed) else default
    except (TypeError,ValueError):
        try:return max(0,(parsedate_to_datetime(value)-datetime.now(timezone.utc)).total_seconds())
        except (TypeError,ValueError,OverflowError):return default


class RequestLimiter:
    def __init__(self,limit=10,rpm=0,clock=time.monotonic,window_seconds=60):
        self.condition=threading.Condition()
        self.clock=clock
        self.window_seconds=window_seconds
        self.active=0
        self.probe_active=0
        self.waiters=[]
        self.starts=deque()
        self.samples=deque(maxlen=5000)
        self.tasks={}
        self.cooldown_until=0
        self.pressure=deque()
        self.recovery_successes=0
        self.rate_failures=0
        self.total=0
        self.successes=0
        self.failures=0
        self.retries=0
        self.last_adjustment=''
        self.limit=limit
        self.effective_limit=limit
        self.rpm=0
        self.set_limit(limit)
        self.set_rpm(rpm)

    def set_limit(self,limit):
        if type(limit) is not int or not 1<=limit<=60:
            raise ValueError('最大并发请求数必须是 1 到 60 的整数')
        with self.condition:
            previous=self.limit
            self.limit=limit
            if previous!=limit:self.effective_limit=limit
            self.effective_limit=min(self.effective_limit,limit)
            self.condition.notify_all()

    def set_rpm(self,rpm):
        if type(rpm) is not int or not 0<=rpm<=60000:
            raise ValueError('每分钟请求上限必须是 0 到 60000 的整数，0 表示自动')
        with self.condition:
            self.rpm=rpm
            self.condition.notify_all()

    def begin_task(self,task_id):
        with self.condition:
            if task_id in self.tasks:raise ValueError('任务标识已存在，请重新开始')
            self.tasks[task_id]={'cancelled':False,'finished':False}
            for key in list(self.tasks):
                if len(self.tasks)<=256:break
                if self.tasks[key]['finished']:del self.tasks[key]

    def cancel_task(self,task_id,reason='requested_stop'):
        with self.condition:
            if task_id in self.tasks and not self.tasks[task_id]['cancelled']:self.tasks[task_id].update(cancelled=True,stop_reason=reason)
            self.condition.notify_all()

    def finish_task(self,task_id):
        with self.condition:
            if task_id in self.tasks:self.tasks[task_id]['finished']=True
            self.condition.notify_all()

    def _check_task(self,task_id):
        if task_id and (task_id not in self.tasks or self.tasks[task_id]['cancelled'] or self.tasks[task_id]['finished']):
            reason='unknown_task' if task_id not in self.tasks else self.tasks[task_id].get('stop_reason','task_finished')
            error=TaskCancelled('任务已结束，未发送排队请求（'+reason+'）');error.reason=reason;raise error

    def _trim(self,now):
        while self.starts and self.starts[0]<=now-self.window_seconds:self.starts.popleft()
        while self.pressure and self.pressure[0]<=now-30:self.pressure.popleft()

    @contextmanager
    def slot(self,kind='annotation',task_id='',retry=False):
        ticket=object()
        background=kind in {'probe','catalog'}
        with self.condition:
            self.waiters.append((ticket,background))
            try:
                while True:
                    self._check_task(task_id)
                    now=self.clock();self._trim(now)
                    foreground=[t for t,b in self.waiters if not b]
                    first=(foreground[0] if foreground else self.waiters[0][0]) is ticket
                    room=self.active<self.effective_limit
                    probe_room=not background or self.probe_active<max(1,min(2,self.effective_limit//4))
                    wait_until=self.cooldown_until
                    if self.rpm and len(self.starts)>=self.rpm:wait_until=max(wait_until,self.starts[0]+self.window_seconds)
                    if first and room and probe_room and now>=wait_until:
                        self.active+=1
                        if background:self.probe_active+=1
                        self.starts.append(now);self.total+=1
                        if retry:self.retries+=1
                        break
                    delay=max(.01,wait_until-now) if wait_until>now else None
                    self.condition.wait(timeout=delay)
            finally:
                self.waiters=[item for item in self.waiters if item[0] is not ticket]
                self.condition.notify_all()
        try:yield
        finally:
            with self.condition:
                self.active-=1
                if background:self.probe_active-=1
                self.condition.notify_all()

    def feedback(self,status,latency,body=b'',retry_after=None,timeout=False):
        with self.condition:
            now=self.clock();self._trim(now)
            ok=200<=status<300
            self.samples.append((now,latency,ok))
            if ok:self.successes+=1
            else:self.failures+=1
            route_missing=status==503 and b'routing configuration unavailable' in body.lower()
            pressure=timeout or status in {500,502,503,504,520,521,522,523,524,529} and not route_missing
            if status==429:
                self.rate_failures+=1
                delay=retry_after_seconds(retry_after,min(60,2**min(self.rate_failures,6)))
                self.cooldown_until=max(self.cooldown_until,now+delay)
                self.effective_limit=max(1,math.ceil(self.effective_limit/2))
                self.recovery_successes=0
                self.last_adjustment='服务商限流，等待后以较低并发恢复'
            elif pressure:
                self.pressure.append(now)
                self.recovery_successes=0
                if len(self.pressure)>=2:
                    self.effective_limit=max(1,math.ceil(self.effective_limit/2))
                    self.cooldown_until=max(self.cooldown_until,now+2)
                    self.pressure.clear()
                    self.last_adjustment='持续超时或服务繁忙，已降低并发'
            elif ok:
                self.recovery_successes+=1
                if now>=self.cooldown_until and self.recovery_successes>=max(4,self.effective_limit*2):
                    if self.effective_limit<self.limit:
                        self.effective_limit+=1
                        self.last_adjustment='请求稳定，逐步恢复并发'
                    self.recovery_successes=0
                    self.rate_failures=0
            self.condition.notify_all()

    def execute(self,operation,kind='annotation',task_id='',retry=False):
        # Retry policy is owned by the shared frontend JSON/network budget.
        # This layer counts and gates one actual request, never hides extra 429s.
        for attempt in range(1):
            with self.slot(kind,task_id,retry or attempt>0):
                start=self.clock()
                try:
                    result=operation()
                except Exception as exc:
                    reason=exc.reason if isinstance(exc,URLError) else exc
                    status=exc.code if isinstance(exc,HTTPError) else 0
                    header=exc.headers.get('Retry-After') if isinstance(exc,HTTPError) and exc.headers else None
                    network_failure=isinstance(reason,(TimeoutError,socket.timeout,ConnectionError,OSError)) or isinstance(exc,URLError) and not isinstance(exc,HTTPError)
                    self.feedback(status,self.clock()-start,retry_after=header,timeout=network_failure)
                    raise
                status=result[0] if isinstance(result,tuple) else 200
                body=result[2] if isinstance(result,tuple) else b''
                headers=getattr(result,'headers',{})
                self.feedback(status,self.clock()-start,body,headers.get('Retry-After'))
            return result

    def snapshot(self):
        with self.condition:
            now=self.clock();self._trim(now)
            recent=[row for row in self.samples if row[0]>now-60]
            return {'limit':self.limit,'effective_limit':self.effective_limit,'active':self.active,
                    'queued':len(self.waiters),'probe_active':self.probe_active,'rpm_limit':self.rpm,
                    'requests_last_minute':len(self.starts),'requests_total':self.total,
                    'successes_total':self.successes,'failures_total':self.failures,'retries_total':self.retries,
                    'average_seconds':round(sum(r[1] for r in recent)/len(recent),2) if recent else 0,
                    'cooldown_seconds':round(max(0,self.cooldown_until-now),2),'adjustment':self.last_adjustment}
