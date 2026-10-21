'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const core=require('../annotation_core.js');
const source=fs.readFileSync(path.join(__dirname,'assets/connection_recovery.js'),'utf8');
const context={window:{AppConfigManager:{},TaskManager:{isStopped:false}}};vm.createContext(context);vm.runInContext(source,context);
const manager=context.window.AppConfigManager;
(async()=>{
 let decisions=0,release;
 manager.recoverConnection=function(){
  if(this.recoveryPromise)return this.recoveryPromise;
  decisions++;this.isRecovering=true;
  this.recoveryPromise=new Promise(resolve=>{release=()=>{this.recoveryGeneration++;this.isRecovering=false;this.recoveryPromise=null;resolve()}});
  return this.recoveryPromise;
 };
 const attempts=[0,0,0];
 const tasks=attempts.map((_,i)=>manager.executeWithRecovery(async()=>{
  attempts[i]++;if(attempts[i]===1){const error=new Error('connection reset');error.recoverable=true;throw error;}return i;
 }));
 await new Promise(resolve=>setImmediate(resolve));assert.equal(decisions,1);assert.equal(manager.isRecovering,true);release();
 assert.deepEqual(await Promise.all(tasks),[0,1,2]);assert.deepEqual(attempts,[2,2,2]);
 const fatal=new Error('auth');fatal.fatal=true;fatal.recoverable=true;
 await assert.rejects(()=>manager.executeWithRecovery(async()=>{throw fatal}),/auth/);assert.equal(decisions,1);
 context.window.TaskManager.isStopped=true;
 await assert.rejects(()=>manager.executeWithRecovery(async()=>{throw new Error('should not send')}),e=>e.taskStopped===true);
 assert.equal(core.normalizeNumbers({status:'recognized',numbers:['001'],sequence:'001'}).sequence,'001');
 assert.equal(core.normalizeNumbers({status:'uncertain',numbers:['5','6'],sequence:'5'}).sequence,null);
 for(const invalid of [
  {status:'none',numbers:['1'],sequence:null},
  {status:'recognized',numbers:[1],sequence:1},
  {status:'recognized',numbers:['001'],sequence:'1'},
  {status:'recognized',numbers:[],sequence:null}
 ])assert.throws(()=>core.normalizeNumbers(invalid));
 assert.equal(core.parseModelJson('{"status":"none","numbers":[],"sequence":null}','numbers').status,'none');
 console.log('Concurrent recovery gate, fatal/cancel handling and OCR uncertainty regressions: passed');
})().catch(error=>{console.error(error);process.exitCode=1});
