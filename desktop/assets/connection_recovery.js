/* One recovery decision for the entire batch, after bounded automatic retries. */
(function () {
    'use strict';
    const manager=window.AppConfigManager;
    if (!manager) return;
    manager.recoveryGeneration=0;
    manager.isRecovering=false;
    manager.recoveryPromise=null;
    const stopped=()=>{ const error=new Error('任务已结束，原图与已完成结果已保留');error.taskStopped=true;return error; };
    manager.waitForRecovery=async function () {
        if (this.recoveryPromise) await this.recoveryPromise;
        if (window.TaskManager?.isStopped) throw stopped();
    };
    manager.executeWithRecovery=async function (operation) {
        let generation=this.recoveryGeneration;
        while (true) {
            await this.waitForRecovery();
            generation=this.recoveryGeneration;
            try { return await operation(); }
            catch (error) {
                if (!error.recoverable || error.fatal || error.taskStopped) throw error;
                if (window.TaskManager?.isStopped) throw stopped();
                // Another in-flight worker may still return an old-model error
                // after the user has already chosen a replacement.
                if (generation===this.recoveryGeneration) await this.recoverConnection(error);
                else await this.waitForRecovery();
                generation=this.recoveryGeneration;
            }
        }
    };
    manager.recoverConnection=function (error) {
        if (this.recoveryPromise) return this.recoveryPromise;
        this.isRecovering=true;
        const pending=new Promise((resolve,reject)=>{
            let alive=true,timer,busy=false,probeStarted=false;
            const dialog=document.createElement('dialog');dialog.id='connectionRecoveryDialog';dialog.className='connection-recovery';
            dialog.innerHTML='<h2>连接重试失败，任务已暂停</h2><p id="recoveryError"></p>'+
                '<p>已完成结果保留。每轮最多检测当前服务的 6 个候选模型，会占用 API 配额。也可切换到已经配置好的另一服务后继续；不会同时向多个服务重复发送同一张图。</p>'+
                '<div class="recovery-actions"><select id="recoveryProfile"></select><button id="recoveryUseProfile" type="button">使用所选服务并继续</button></div>'+
                '<p id="recoveryProbeStatus" role="status">正在获取模型状态…</p><div id="recoveryModelList"></div>'+
                '<div class="recovery-actions"><button id="recoveryRescan" type="button">重新检测</button><button id="recoveryRetry" type="button">原配置重试</button><button id="recoveryEnd" type="button">结束并人工复核</button></div>';
            dialog.querySelector('#recoveryError').textContent=error.message;
            const status=dialog.querySelector('#recoveryProbeStatus'),list=dialog.querySelector('#recoveryModelList');
            const profileSelect=dialog.querySelector('#recoveryProfile');
            for(const p of this.publicConfig?.profiles || []){
                if(!p.configured || p.vision_warning)continue;
                const option=document.createElement('option');option.value=p.profile_id;option.textContent=`${p.profile_name} · ${p.model}`;profileSelect.append(option);
            }
            profileSelect.value=this.publicConfig?.profile_id || '';
            const finish=(ok)=>{
                if (!alive) return;alive=false;clearTimeout(timer);
                window.removeEventListener('autotag-task-stop',onStop);
                dialog.close();dialog.remove();
                // Stop issuing new probes; already sent probes may finish.
                if(probeStarted)fetch('/api/models/probe/cancel',{method:'POST'}).catch(()=>{});
                this.isRecovering=false;
                this.recoveryResume=null;
                if(ok){this.recoveryGeneration++;resolve();}else reject(stopped());
            };
            const onStop=()=>finish(false);
            this.recoveryResume=()=>finish(true);
            dialog.querySelector('#recoveryUseProfile').onclick=async()=>{
                if(busy || !alive || !profileSelect.value)return;busy=true;
                try{
                    if(probeStarted)await fetch('/api/models/probe/cancel',{method:'POST'});
                    probeStarted=false;
                    const response=await fetch('/api/app-config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({profile_action:'select',profile_id:profileSelect.value})});
                    const data=await response.json();if(!response.ok || !data.ok)throw new Error(data.message || '切换服务失败');
                    await this.refresh();finish(true);
                }catch(error){if(alive)status.textContent=error.message;}finally{busy=false;}
            };
            window.addEventListener('autotag-task-stop',onStop,{once:true});
            dialog.addEventListener('cancel',event=>event.preventDefault());
            dialog.querySelector('#recoveryEnd').onclick=()=>window.TaskManager?.stop(true);
            dialog.querySelector('#recoveryRetry').onclick=()=>finish(true);
            const select=async model=>{
                if(busy || !alive)return;busy=true;
                list.querySelectorAll('button').forEach(b=>b.disabled=true);
                try {
                    const response=await fetch('/api/models/select',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({model})});
                    const data=await response.json();if(!response.ok || !data.ok)throw new Error(data.message || '保存所选模型失败');
                    if(!alive)return;
                    this.publicConfig=data;this.applyModel(data.model);
                    document.getElementById('desktopModel').value=data.model;
                    document.getElementById('desktopAutoModel').checked=false;
                    this.setActiveModel(data.model,false);
                    finish(true);
                }catch(e){if(alive)status.textContent=e.message;}
                finally{busy=false;if(alive)list.querySelectorAll('button').forEach(b=>b.disabled=false);}
            };
            const render=data=>{
                if(!alive)return;
                const job=data.probe;
                status.textContent=job?`${job.running?'正在检测':'检测完成'} ${job.done}/${job.total}${job.error?' · '+job.error:''}`:'尚未检测';
                list.replaceChildren();
                const labels={vision_ok:'图片小样通过',failed:'请求失败',unverified:'未验证通过',expired:'检测已过期',listed_only:'尚未检测'};
                const categories={auth_or_quota:'鉴权或额度受限',rate_limited:'速率受限',model_or_route_not_found:'模型或路由不存在',routing_unavailable:'路由配置不可用',temporarily_unavailable:'上游暂不可用',timeout_or_network:'超时或网络异常',vision_response_unverified:'图片回答不符合小样',request_error:'请求被拒绝'};
                const rows=(data.models || []).filter(r=>r.status!=='not_candidate').sort((a,b)=>Number(b.status==='vision_ok')-Number(a.status==='vision_ok'));
                for(const row of rows){
                    const item=document.createElement('div');item.className='recovery-model-row';
                    const text=document.createElement('span');
                    text.textContent=`${row.model} · ${labels[row.status] || row.status}${row.latency_seconds!=null?' · '+row.latency_seconds+'s':''}${row.checked_at?' · '+new Date(row.checked_at).toLocaleTimeString():''}${row.category?' · '+(categories[row.category] || row.category):''}`;
                    item.append(text);
                    if(row.status==='vision_ok'){
                        const button=document.createElement('button');button.type='button';button.textContent='使用并继续';button.dataset.model=row.model;button.disabled=busy;
                        button.title='保存为手动模型并重试当前阶段';button.onclick=()=>select(row.model);item.append(button);
                    }
                    list.append(item);
                }
                if(!rows.length)list.textContent='没有可用模型列表。可以网络恢复后重新检测，或使用原配置重试。';
                if(job?.running)timer=setTimeout(poll,1000);
            };
            const poll=async()=>{
                try{
                    const response=await fetch('/api/models',{cache:'no-store'});const data=await response.json();
                    if(!response.ok || !data.ok)throw new Error('读取模型检测结果失败');render(data);
                }catch(e){if(alive){status.textContent=e.message;timer=setTimeout(poll,2000);}}
            };
            const scan=async()=>{
                clearTimeout(timer);status.textContent='正在启动图片小样检测…';
                try{
                    probeStarted=true;
                    const response=await fetch('/api/models/probe',{method:'POST'});const data=await response.json();
                    if(!response.ok || !data.ok)throw new Error(data.message || '无法开始检测');render(data);
                }catch(e){if(alive){status.textContent=e.message;await poll();}}
            };
            dialog.querySelector('#recoveryRescan').onclick=scan;
            document.body.append(dialog);dialog.showModal();scan();
        });
        this.recoveryPromise=pending.finally(()=>{this.recoveryPromise=null;this.isRecovering=false;});
        return this.recoveryPromise;
    };
})();
