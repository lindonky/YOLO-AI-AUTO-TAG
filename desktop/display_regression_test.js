'use strict';
const assert=require('node:assert/strict'),fs=require('fs'),vm=require('vm'),path=require('path');
const source=fs.readFileSync(path.join(__dirname,'../main.js'),'utf8');const start=source.indexOf('function drawStyledAnnotation('),end=source.indexOf('\nfunction ',start+1);
const overlay={},exportCanvas={},ann={label:'黑色三棱锥',box_2d:[100,100,300,300]},snapshot=JSON.stringify(ann);
let preferences={annotations:true,labels:false};const context={els:{overlayCanvas:overlay},window:{AnnotationDisplay:{get preferences(){return preferences;}}}};
vm.createContext(context);vm.runInContext(source.slice(start,end),context);
function draw(canvas){const calls={boxes:0,labels:0};const ctx={canvas,strokeRect(){calls.boxes++},fillRect(){},fillText(){calls.labels++}};context.drawStyledAnnotation(ctx,ann,640,480);return calls;}
assert.deepEqual(draw(overlay),{boxes:1,labels:0});preferences={annotations:false,labels:false};assert.deepEqual(draw(overlay),{boxes:0,labels:0});assert.deepEqual(draw(exportCanvas),{boxes:1,labels:1});
preferences={annotations:true,labels:true};assert.deepEqual(draw(overlay),{boxes:1,labels:1});assert.equal(JSON.stringify(ann),snapshot);
console.log('Annotation visibility affects viewport only and retains offscreen export labels: passed');
