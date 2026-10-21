"""Bounded, redacted request evidence. Never store payloads, keys or raw images."""
from collections import deque
from datetime import datetime,timezone
import json,re,threading

class RequestJournal:
    def __init__(self,secrets=(),path=None):
        self.lock=threading.RLock();self.rows=deque(maxlen=2000);self.sequence=0
        self.secrets=[str(s) for s in secrets if s];self.path=path

    def clean(self,value):
        if isinstance(value,dict):return {k:self.clean(v) for k,v in value.items() if k.lower() not in {'api_key','authorization','api_key_dpapi','payload','body','messages','token'}}
        if isinstance(value,list):return [self.clean(v) for v in value[:1000]]
        if not isinstance(value,str):return value
        for secret in self.secrets:value=value.replace(secret,'[redacted]')
        value=re.sub(r'https?://[^\s"<>]+','[endpoint]',value,flags=re.I)
        value=re.sub(r'(?i)Bearer\s+\S+|\bsk-[\w-]+','[redacted]',value)
        return value[:800]

    def add(self,event,**fields):
        with self.lock:
            self.sequence+=1
            row={'id':self.sequence,'time':datetime.now(timezone.utc).isoformat(timespec='milliseconds'),'event':event,**self.clean(fields)}
            self.rows.append(row)
            if self.path:
                try:
                    if self.path.exists() and self.path.stat().st_size>2*1024*1024:self.path.replace(self.path.with_suffix('.previous.jsonl'))
                    with self.path.open('a',encoding='utf-8') as out:out.write(json.dumps(row,ensure_ascii=False)+'\n')
                except OSError:pass
            return row

    def read(self,after=0,limit=100):
        with self.lock:return [r.copy() for r in self.rows if r['id']>after][-max(1,min(200,limit)):]
