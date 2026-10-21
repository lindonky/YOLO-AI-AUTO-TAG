'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const core = require('../annotation_core.js');
const labels = ['绿色正方体','蓝色正方体','橙色长方体','黑色三棱锥'];
const green = {label:labels[0], box_2d:[100,100,300,300]};
const black = {label:labels[3], box_2d:[500,500,700,700]};
const final = JSON.stringify([green,black]);
assert.equal(core.parseModelJson('分析 [1,2,3,4]\n```json\n'+final+'\n```','detections').length,2);
assert.equal(core.parseModelJson('坐标 [1,2,3,4]\n最后：'+final,'detections').length,2);
assert.deepEqual(core.parseModelJson('排除边框 \\[0,0,20,20]。\n[]','detections'),[]);
assert.equal(core.parseModelJson('{"has_target":false,"estimated_count":0,"confidence":0.99,"reason":"[背景]"}','presence').has_target,false);
assert.throws(()=>core.parseModelJson('{"unexpected":[]}','detections'));
assert.throws(()=>core.parseModelJson('[1,2,3,4]','detections'));
assert.throws(()=>core.parseModelJson('[{"label":"a","box_2d":[1,2,3,4]}','detections'));
assert.throws(()=>core.parseModelJson('分析 []\n```json\n[{"label":"a","box_2d":[1,2,3,4]}\n```','detections'));
assert.throws(()=>core.parseModelJson('分析 []\n[{"label":"a","box_2d":[1,2,3,4]}','detections'));
assert.throws(()=>core.normalizeObjects([{...green,box_2d:[1,2,0,4]}],labels));
assert.throws(()=>core.normalizeObjects([{...green,box_2d:[1,2,1001,4]}],labels));
assert.throws(()=>core.normalizeObjects([{...green,box_2d:[null,2,3,4]}],labels));
assert.throws(()=>core.normalizeObjects([{...green,label:'unknown'}],labels));
assert.equal(core.normalizeObjects([{label:labels[0],polygon:[[0,0],[1,1],[1,0]]}],labels,'polygons').length,1);
assert.equal(core.mergeMissing([green],[green,black]).boxes.length,2);
assert.equal(core.mergeMissing([green],[{...green,label:labels[1]}]).conflict,true);

const source=fs.readFileSync(path.join(__dirname,'../main.js'),'utf8');
function extract(name) {
    const start=source.search(new RegExp('(?:async )?function '+name+'\\('));
    assert.ok(start>=0,name);
    const rest=source.slice(start),next=rest.slice(1).search(/\n(?:async )?function /);
    return next<0?rest:rest.slice(0,next+1);
}
async function pipeline(contents, review=true, stopAfterDetection=false) {
    const queue=contents.slice(); const requests=[];
    const canvas={width:640,height:480,getContext:()=>({drawImage(){}}),toDataURL:()=> 'data:image/jpeg;base64,TEST'};
    const ctx={AnnotationCore:core,performance,window:{},document:{createElement:()=>canvas},waitForTaskDelay:async()=>{},
        state:{teachingExamples:[],unifiedClassMap:new Map([[labels[0],0]]),nextClassId:1},
        els:{promptInput:{value:'检测四类几何体'},classLabelInput:{value:labels.join(' ')},verifyDetections:{checked:review},extractTransparent:{checked:false},exportCanvas:canvas},
        createAnalysisCanvas:()=>canvas,
        fetchAPIWithRetry:async(_config,messages)=>{
            requests.push(messages);
            assert.ok(queue.length,'unexpected API call');
            if(stopAfterDetection)ctx.window.TaskManager={isStopped:true};
            return JSON.stringify({choices:[{finish_reason:'stop',message:{content:queue.shift()}}]});
        }
    };
    vm.createContext(ctx);
    for(const name of ['getRequestedClassNames','buildTaskClassInstruction','getClassId','getAllClasses','buildTeachingMessages','buildTaskTeachingMessages','assertTaskNotStopped','parseModelJsonContent','callAPIJson','callAPI','verifyTargetPresence','reviewDetectionCompleteness','processImageTwoStage'])vm.runInContext(extract(name),ctx);
    const result=await ctx.processImageTwoStage({model:'test-actual-model'},false,{width:640,height:480,naturalWidth:640,naturalHeight:480},false);
    return {result,requests,ctx};
}
(async()=>{
    const reviewed=await pipeline([JSON.stringify([green]),JSON.stringify({missing_objects:[black],complete:true,reason:'补充黑色目标'})]);
    assert.equal(reviewed.result.boxes.length,2);
    assert.equal(reviewed.result.validation.needsReview,false);
    assert.equal(reviewed.result.validation.confidence,null);
    assert.deepEqual([...reviewed.result.validation.modelsUsed],['test-actual-model']);
    assert.equal(reviewed.result.boxes[0].model_used,'test-actual-model');
    assert.equal(reviewed.requests.length,2);
    assert.equal(reviewed.ctx.state.unifiedClassMap.size,4);
    const uncertain=await pipeline([JSON.stringify([green]),JSON.stringify({missing_objects:[black],complete:false,reason:'仍无法确认边缘是否还有目标'})]);
    assert.equal(uncertain.result.boxes.length,2);assert.equal(uncertain.result.validation.needsReview,true);
    assert.equal(uncertain.result.validation.completenessReview.status,'uncertain');assert.equal(uncertain.result.validation.jsonRetries,0);
    const prompt=reviewed.requests[0][0].content[0].text;
    labels.forEach(label=>assert.ok(prompt.includes(label)));
    const failed=await pipeline([JSON.stringify([green]),'review response is broken']);
    assert.equal(failed.result.boxes.length,1);
    assert.equal(failed.result.validation.needsReview,true);
    const empty=await pipeline(['[]',JSON.stringify({has_target:false,estimated_count:0,confidence:0.99,reason:'背景'})]);
    assert.equal(empty.result.validation.verifiedEmpty,true);
    assert.equal(empty.requests.length,2);
    const suspicious=await pipeline(['[]',JSON.stringify({has_target:false,confidence:0.99}),'[]']);
    assert.equal(suspicious.result.validation.verifiedEmpty,false);
    assert.equal(suspicious.result.validation.needsReview,true);
    const disabled=await pipeline([final],false);
    assert.equal(disabled.requests.length,1);
    await assert.rejects(()=>pipeline(['invalid JSON'],false),error=>error.modelsUsed[0]==='test-actual-model');
    const stopped=await pipeline([final],true,true);
    assert.equal(stopped.requests.length,1);
    assert.equal(stopped.result.boxes.length,2);
    assert.equal(stopped.result.validation.status,'stopped_pending_review');
    assert.equal(stopped.result.validation.needsReview,true);
    const stoppedEmpty=await pipeline(['[]'],true,true);
    assert.equal(stoppedEmpty.requests.length,1);
    assert.equal(stoppedEmpty.result.validation.verifiedEmpty,false);
    console.log('Annotation parser, class mapping, missing-target review and empty-result regressions: passed');
})().catch(error=>{console.error(error);process.exitCode=1});
