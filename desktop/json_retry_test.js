'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../main.js'),'utf8');
const core=require('../annotation_core.js');
const box={label:'目标',box_2d:[100,100,300,300]};
const chat=(content,finish_reason='stop')=>({status:200,data:{choices:[{message:{content},finish_reason}]}});
const good=chat(JSON.stringify([box]));
function extract(name){const start=source.search(new RegExp('(?:async )?function '+name+'\\('));const rest=source.slice(start),next=rest.slice(1).search(/\n(?:async )?function /);return next<0?rest:rest.slice(0,next+1)}
async function run(responses,stop=false,retries=2){
 const calls=[];let context;
 context={AnnotationCore:core,els:{apiInfo:{textContent:''}},window:{TaskManager:{isStopped:false},addEventListener(){},removeEventListener(){}},
  getRequestedClassNames:()=>['目标'],enforceRateLimit:async()=>{},setTimeout:callback=>{queueMicrotask(callback);return 0},clearTimeout(){},
  fetch:async(url,options)=>{calls.push(JSON.parse(options.body));const next=responses.shift();assert.ok(next,'unexpected extra HTTP request');
   if(stop)context.window.TaskManager.isStopped=true;
   return {status:next.status,ok:next.status>=200&&next.status<300,text:async()=>JSON.stringify(next.data),headers:{get:()=>null}};
  }};
 vm.createContext(context);
 context.window.AppConfigManager={publicConfig:{max_retries:retries}};
 for(const name of ['assertTaskNotStopped','waitForTaskDelay','fetchAPIWithRetry','parseModelJsonContent','callAPIJson','callAPI'])vm.runInContext(extract(name),context);
 try{return {value:await context.callAPI({url:'http://example.invalid',model:'test'},[{role:'user',content:'original image task'}]),calls}}
 catch(error){return {error,calls}}
}
(async()=>{
 const retained={state:{imageResults:[]},window:{}};vm.createContext(retained);vm.runInContext(extract('recordImageProcessingError'),retained);
 const partial=retained.recordImageProcessingError({name:'partial.png'},'segmentation JSON failed',['test'],[box]);
 assert.equal(partial.annotations.length,1);assert.equal(partial.needsReview,true);assert.equal(partial.verifiedEmpty,false);
 let result=await run([chat('[{"label":"目标"'),good]);
 assert.equal(result.calls.length,2);assert.equal(result.value.length,1);
 assert.ok(result.calls[1].messages.at(-1).content.includes('完整有效 JSON'));
 result=await run([chat('[]','length'),good]);assert.equal(result.calls.length,2);assert.equal(result.value.length,1);
 result=await run([chat(JSON.stringify([{...box,box_2d:[null,1,2,3]}])),good]);assert.equal(result.calls.length,2);assert.equal(result.value.length,1);
 result=await run([chat('broken'),chat('broken'),chat('broken')]);assert.equal(result.calls.length,3);assert.ok(result.error);assert.equal(result.error.fatal,undefined);
 result=await run([{status:503,data:{error:{message:'busy'}}},chat('broken'),good]);assert.equal(result.calls.length,3);assert.equal(result.value.length,1);
 result=await run(Array.from({length:3},()=>({status:503,data:{error:{message:'busy'}}})));assert.equal(result.calls.length,3);assert.ok(result.error.transportFailure);
 result=await run([{status:400,data:{error:{message:'truncated',retryable_json:true}}},good]);assert.equal(result.calls.length,2);assert.equal(result.value.length,1);
 result=await run([chat('broken')],true);assert.equal(result.calls.length,1);assert.equal(result.error.taskStopped,true);
 result=await run([chat('','content_filter')]);assert.equal(result.calls.length,1);assert.ok(result.error);
 result=await run([{status:409,data:{error:{message:'busy',origin:'upstream',retryable:true}}},good]);assert.equal(result.calls.length,2);assert.equal(result.value.length,1);
 result=await run([{status:409,data:{error:{message:'cancelled',origin:'local',taskStopped:true}}}]);assert.equal(result.calls.length,1);assert.ok(result.error.taskStopped);
 result=await run([chat('broken')],false,0);assert.equal(result.calls.length,1);assert.ok(result.error);
 result=await run([{status:429,data:{error:{message:'rate limited'}}}],false,0);assert.equal(result.calls.length,1);assert.ok(result.error.recoverable);
 result=await run([chat('broken'),chat('broken'),chat('broken'),good],false,3);assert.equal(result.calls.length,4);assert.equal(result.value.length,1);
 result=await run([{status:503,data:{error:{message:'busy'}}},chat('broken')],false,1);assert.equal(result.calls.length,2);assert.ok(result.error);
 result=await run([{status:524,data:{error:{message:'all available accounts exhausted',origin:'upstream',retryable:true}}},good]);assert.equal(result.calls.length,2);assert.equal(result.value.length,1);
 console.log('JSON/network shared configurable retry budget and cancellation: 16 cases passed');
})().catch(error=>{console.error(error);process.exitCode=1});
