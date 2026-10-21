/* Typed operations only. No arbitrary JavaScript execution endpoint. */
(function(){
    'use strict';
    const api={clientId:crypto.randomUUID(),token:'',completed:[],busy:false,remoteRun:false,notices:[],lastError:''};
    const oldAlert=window.alert;
    api.recordNotice=message=>{api.notices.push(String(message).slice(0,1000));api.notices=api.notices.slice(-10);};
    window.alert=function(message){if(api.remoteRun)api.recordNotice(message);else oldAlert.call(window,message);};
    api.snapshot=()=>({is_processing:!!window.state?.isProcessing,launching:api.remoteRun && !window.state?.isProcessing,
        is_paused:!!window.TaskManager?.isPaused,is_stopped:!!window.TaskManager?.isStopped,recovering:!!window.AppConfigManager?.isRecovering,
        file_count:window.state?.files?.length || 0,result_count:window.state?.imageResults?.length || 0,
        error_count:(window.state?.imageResults || []).filter(r=>r.needsReview || r.processingError).length,
        status:document.getElementById('statusMsg')?.textContent || '',model:window.AppConfigManager?.publicConfig?.model || '',
        notices:api.notices,last_error:api.lastError,review_open:!!document.getElementById('reviewWorkspace')?.classList.contains('rw-open')});
    api.execute=async function(action,args){
        if(!window.state || !window.TaskManager || !window.AppConfigManager?.ready)throw new Error('应用尚未就绪');
        if(action==='task_results'){
            let rows=state.imageResults || [];if(args.errors_only)rows=rows.filter(r=>r.needsReview || r.processingError);
            return {ok:true,total:rows.length,results:rows.slice(args.offset || 0,(args.offset || 0)+(args.limit || 20)).map(r=>({file_name:r.fileName,annotations:r.annotations.map(a=>({label:a.label,box_2d:a.box_2d,model_used:a.model_used})),validation:r.validation,verified_empty:r.verifiedEmpty,needs_review:r.needsReview,processing_error:r.processingError,number_recognition:r.numberRecognition}))};
        }
        if(action==='preview_image'){
            const file=state.files.find(f=>f.name===args.file_name);if(!file)throw new Error('图片不在当前任务中');
            const {img}=await readImageFile(file);const canvas=document.createElement('canvas');
            let x=0,y=0,w=img.width,h=img.height;
            if(Number.isInteger(args.annotation_index)){
                const ann=state.imageResults.find(r=>r.fileName===file.name)?.annotations[args.annotation_index];if(!ann)throw new Error('目标框不存在');
                const [y1,x1,y2,x2]=ann.box_2d;x=x1/1000*w;y=y1/1000*h;w=(x2-x1)/1000*w;h=(y2-y1)/1000*h;
            }
            const ratio=Math.min(1,1280/Math.max(w,h));canvas.width=Math.max(1,Math.round(w*ratio));canvas.height=Math.max(1,Math.round(h*ratio));canvas.getContext('2d').drawImage(img,x,y,w,h,0,0,canvas.width,canvas.height);
            return {ok:true,mime_type:'image/jpeg',data:canvas.toDataURL('image/jpeg',.85).split(',')[1],width:canvas.width,height:canvas.height};
        }
        if(action==='load_images'){
            if(state.isProcessing || api.remoteRun || state.files.length)throw new Error('当前任务非空，未替换现有数据');
            const files=[];
            for(const row of args.files){const response=await fetch(row.url,{headers:{'X-Autotag-UI':api.token}});if(!response.ok)throw new Error('无法读取选定图片');files.push(new File([await response.blob()],row.name,{type:row.type}));}
            const transfer=new DataTransfer();files.forEach(f=>transfer.items.add(f));els.fileInput.files=transfer.files;els.fileInput.dispatchEvent(new Event('change',{bubbles:true}));
            return {ok:true,loaded:files.map(f=>f.name)};
        }
        if(action==='configure_task'){
            if(state.isProcessing || api.remoteRun)throw new Error('识别过程中不能修改任务配置');
            await AppConfigManager.refresh();
            if(args.classes!==undefined){els.classLabelInput.value=args.classes;els.classLabelInput.dispatchEvent(new Event('input'));}
            if(args.prompt!==undefined)els.promptInput.value=args.prompt;
            if(args.verify_detections!==undefined)els.verifyDetections.checked=args.verify_detections;
            if(args.read_image_numbers!==undefined)els.readImageNumbers.checked=args.read_image_numbers;
            return {ok:true,configured:true};
        }
        if(action==='select_model'){
            if(state.isProcessing && !AppConfigManager.isRecovering)throw new Error('请等待任务结束或连接恢复窗口后切换模型');
            const response=await fetch('/api/models/select',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({model:args.model})});const data=await response.json();if(!response.ok || !data.ok)throw new Error(data.message || '无法切换模型');
            await AppConfigManager.refresh();if(args.resume)AppConfigManager.recoveryResume?.();return {ok:true,model:data.model,auto_model:false};
        }
        if(action==='select_provider'){
            if(state.isProcessing && !AppConfigManager.isRecovering)throw new Error('请等待任务结束或连接恢复窗口后切换服务');
            await fetch('/api/models/probe/cancel',{method:'POST'});
            const response=await fetch('/api/app-config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({profile_action:'select',profile_id:args.profile_id})});
            const data=await response.json();if(!response.ok || !data.ok)throw new Error(data.message || '切换服务失败');
            await AppConfigManager.refresh();if(args.resume)AppConfigManager.recoveryResume?.();return {ok:true,profile_id:data.profile_id,model:data.model};
        }
        if(action==='task_control'){
            if(args.action==='start'){
                if(state.isProcessing || api.remoteRun || !state.files.length)throw new Error('任务已运行或尚未导入图片');
                if(state.isVideoMode)throw new Error('当前自动化入口仅支持图片诊断');
                api.remoteRun=true;api.lastError='';
                api.cancelStart=false;
                Promise.resolve(startAnalysis()).catch(e=>api.lastError=String(e.message || e)).finally(()=>api.remoteRun=false);
                return {ok:true,accepted:true};
            }
            if(args.action==='stop'){api.cancelStart=true;TaskManager.stop(true);return {ok:true,stopping:true};}
            if(args.action==='retry'){if(!AppConfigManager.recoveryResume)throw new Error('当前没有等待重试的恢复窗口');AppConfigManager.recoveryResume();return {ok:true,resuming:true};}
            if(args.action==='pause')TaskManager.pause();
            if(args.action==='resume')TaskManager.resume();
            return {ok:true};
        }
        throw new Error('未支持的操作');
    };
    api.tick=async function(){
        if(api.busy)return;api.busy=true;
        try{
            if(!api.token){const response=await fetch('/api/automation/bootstrap');if(!response.ok)return;api.token=(await response.json()).ui_token;}
            const completed=api.completed.slice();const response=await fetch('/api/automation/ui',{method:'POST',headers:{'Content-Type':'application/json','X-Autotag-UI':api.token},body:JSON.stringify({client_id:api.clientId,snapshot:api.snapshot(),completed})});
            if(!response.ok)return;api.completed.splice(0,completed.length);const data=await response.json();
            for(const command of data.commands || []){
                let result;try{result=await api.execute(command.action,command.arguments || {});}catch(e){result={ok:false,error:String(e.message || e)};}
                api.completed.push({id:command.id,result,image:command.action==='preview_image'});
            }
        }catch(_){/* Local exit or a disconnected control client does not cancel the task. */}
        finally{api.busy=false;setTimeout(api.tick,400);}
    };
    window.AutoTagAutomation=api;api.tick();
})();
