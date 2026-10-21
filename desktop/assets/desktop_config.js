(function () {
    'use strict';

    // 用户可见文案集中在这里，便于发布前逐句审核。
    const COPY = {
        appName: 'YOLO Auto-Tag',
        version: 'V1.2.7',
        title: 'API 与服务配置',
        intro: '可保存多个官方服务或中转站，每项分别保存自己的 URL、Key 和模型。API Key 使用 Windows DPAPI 加密保存在本机。',
        urlHelp: '支持首页、/v1、完整 /chat/completions、/responses、/messages 或 /anthropic 基础地址。自定义前缀请选择具体接口格式；不会轮流尝试不同 URL。',
        keyHelp: '首次配置必须填写；以后留空表示继续使用已经安全保存的 Key。',
        proxyHelp: '选填。使用 Mihomo 时可填写 http://127.0.0.1:7897；留空时尝试 Windows 系统代理或直连。',
        declaration: '本软件用于辅助整理和标注用户自行选择的图片或视频资料。AI 结果可能出现漏检、误检或框选偏差，正式训练或发布数据集前仍应由用户复核。API 请求仅发送到用户自行填写的中转站。',
        repositoryLabel: 'lindonky/YOLO-AI-AUTO-TAG',
        repositoryUrl: 'https://github.com/lindonky/YOLO-AI-AUTO-TAG'
    };

    const manager = {
        ready: false,
        configured: false,
        publicConfig: null,
        probeTimer: null,
        probeRunning: false,
        schedulerEnabled: false,
        activeTaskId: '',
        schedulerTimer: null,
        imageStats: null,
        pendingJobs: new Map(),
        jobAcks: new Set(),
        pollingJobs: false,
        refreshingScheduler: false,

        async init() {
            this.buildUi();
            if (window.YOLO_UI_PREVIEW === true) {
                this.ready = true;
                document.getElementById('desktopConfigModal')?.remove();
                document.getElementById('desktopConfigBtn')?.remove();
                const startButton = document.getElementById('startBtn');
                if (startButton) {
                    startButton.disabled = true;
                    startButton.title = 'UI 预览版不会发送识别请求';
                }
                const versionBadge = document.getElementById('desktopVersionBadge');
                if (versionBadge) {
                    versionBadge.textContent = 'UI PREVIEW V2';
                    versionBadge.title = '仅供界面确认，不会发送 API 请求';
                }
                return;
            }
            this.bindStartGuard();
            await this.refresh();
            document.getElementById('apiRpm')?.addEventListener('change', () => this.configureRpm());
            this.refreshScheduler();
        },

        buildUi() {
            const style = document.createElement('style');
            style.textContent = `
                #desktopConfigModal { position: fixed; inset: 0; z-index: 10000; display: none; align-items: center; justify-content: center; background: rgba(15, 23, 42, .72); padding: 24px; }
                #desktopConfigModal.open { display: flex; }
                .desktop-config-card { width: min(680px, 96vw); max-height: 92vh; overflow: auto; border-radius: 14px; background: #fff; color: #1f2937; box-shadow: 0 30px 80px rgba(0,0,0,.35); }
                .dark .desktop-config-card { background: #1f2937; color: #e5e7eb; }
                .desktop-config-head { padding: 20px 22px 14px; border-bottom: 1px solid #e5e7eb; }
                .dark .desktop-config-head { border-color: #374151; }
                .desktop-config-body { padding: 18px 22px; display: grid; gap: 15px; }
                .desktop-field label { display: block; margin-bottom: 5px; font-size: 12px; font-weight: 700; }
                .desktop-field input { width: 100%; border: 1px solid #d1d5db; border-radius: 8px; padding: 9px 11px; font-size: 13px; background: #fff; color: #111827; }
                .dark .desktop-field input { border-color: #4b5563; background: #111827; color: #f3f4f6; }
                .desktop-toggle { display: flex; align-items: center; gap: 8px; font-size: 12px; cursor: pointer; }
                .desktop-model-list { max-height: 230px; overflow: auto; font-size: 11px; border-top: 1px solid #64748b; }
                .desktop-model-row { padding: 8px 0; display: flex; gap: 8px; justify-content: space-between; align-items: center; border-bottom: 1px solid #64748b55; overflow-wrap: anywhere; }
                .desktop-model-row button { flex-shrink: 0; border: 1px solid #80cbc4; border-radius: 8px; padding: 4px 8px; }
                .desktop-help { margin-top: 5px; color: #6b7280; font-size: 11px; line-height: 1.5; }
                .desktop-declaration { border-radius: 18px; border: 1px solid rgba(128,203,196,.28); background: rgba(128,203,196,.08); color: inherit; padding: 10px 12px; font-size: 11px; line-height: 1.6; }
                .dark .desktop-declaration { background: rgba(128,203,196,.08); color: #dfe8e8; }
                .desktop-config-actions { display: flex; align-items: center; justify-content: flex-end; gap: 9px; padding: 14px 22px 20px; }
                .desktop-action { border-radius: 999px; padding: 8px 14px; font-size: 12px; font-weight: 700; cursor: pointer; }
                .desktop-primary { border: 1px solid rgba(128,203,196,.65); background: rgba(128,203,196,.18); color: #effffc; }
                .desktop-secondary { background: #e5e7eb; color: #374151; }
                .desktop-test { background: #16a34a; color: #fff; }
                .desktop-status { flex: 1; font-size: 11px; color: #6b7280; }
                #desktopConfigBtn { border: 1px solid rgba(255,255,255,.13); background: rgba(255,255,255,.055); color: #eef3f3; padding: 6px 10px; border-radius: 999px; font-size: 12px; font-weight: 700; white-space: nowrap; }
                #desktopVersionBadge { margin-right: 8px; border: 1px solid rgba(128,203,196,.35); border-radius: 999px; padding: 2px 7px; background: rgba(128,203,196,.08); color: #5faaa3; font-size: 10px; font-weight: 800; white-space: nowrap; }
                .dark #desktopVersionBadge { background: rgba(128,203,196,.08); color: #a9e2dd; }
                #desktopRepositoryFooter { font-size: 10px; color: #5faaa3; white-space: nowrap; margin-right: 10px; text-decoration: none; }
                #desktopRepositoryFooter:hover { color: #80cbc4; text-decoration: underline; }
                .dark #desktopRepositoryFooter { color: #80cbc4; }
            `;
            document.head.appendChild(style);

            const modal = document.createElement('div');
            modal.id = 'desktopConfigModal';
            modal.innerHTML = `
                <div class="desktop-config-card" role="dialog" aria-modal="true" aria-labelledby="desktopConfigTitle">
                    <div class="desktop-config-head">
                        <div style="display:flex;align-items:center;gap:9px;">
                            <div id="desktopConfigTitle" style="font-size:18px;font-weight:800;">${COPY.title}</div>
                            <span style="border:1px solid rgba(128,203,196,.35);border-radius:999px;padding:2px 8px;background:rgba(128,203,196,.08);color:#80cbc4;font-size:11px;font-weight:800;">${COPY.version}</span>
                        </div>
                        <div style="font-size:12px;font-weight:700;margin-top:6px;">${COPY.appName}</div>
                        <div style="font-size:12px;color:#6b7280;margin-top:6px;line-height:1.6;">${COPY.intro}</div>
                    </div>
                    <div class="desktop-config-body">
                        <div class="desktop-field">
                            <label for="desktopProfile">已保存服务（选择后点保存启用）</label>
                            <select id="desktopProfile"></select>
                            <div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap;">
                                <button id="desktopProfileNew" type="button" class="desktop-action desktop-secondary">新增服务</button>
                                <button id="desktopDeepSeekPreset" type="button" class="desktop-action desktop-secondary">新增 DeepSeek V4 Flash</button>
                                <button id="desktopProfileDelete" type="button" class="desktop-action desktop-secondary">移除所选配置</button>
                            </div>
                            <div class="desktop-help" id="desktopProfileActive"></div>
                        </div>
                        <div class="desktop-field"><label for="desktopProfileName">服务名称</label><input id="desktopProfileName" maxlength="80" placeholder="例如：DeepSeek 官方、备用中转站"></div>
                        <div class="desktop-field"><label for="desktopProtocol">接口格式</label><select id="desktopProtocol"><option value="auto">自动识别 URL</option><option value="chat">Chat Completions</option><option value="responses">Responses</option><option value="anthropic">Anthropic Messages</option></select></div>
                        <div class="desktop-field">
                            <label for="desktopApiUrl">中转站 API URL</label>
                            <input id="desktopApiUrl" type="url" autocomplete="url" placeholder="https://.../v1/chat/completions">
                            <div class="desktop-help">${COPY.urlHelp}</div>
                        </div>
                        <div class="desktop-field">
                            <label for="desktopApiKey">API Key</label>
                            <input id="desktopApiKey" type="password" autocomplete="new-password" placeholder="请输入安装用户自己的 Key">
                            <div class="desktop-help" id="desktopKeyHelp">${COPY.keyHelp}</div>
                        </div>
                        <div class="desktop-field">
                            <label for="desktopModel">模型名称（自动模式下作为首选）</label>
                            <input id="desktopModel" type="text" list="desktopSavedModels" value="gemini-3.8-flash-low" autocomplete="off"><datalist id="desktopSavedModels"></datalist>
                            <div class="desktop-help">DeepSeek 官方图片标注可选 deepseek-v4-flash 或 deepseek-flash；V4 Pro 当前不支持图片输入。</div>
                        </div>
                        <div class="desktop-field"><label for="desktopModels">此服务的备用模型（每行一个，或用逗号分隔）</label><textarea id="desktopModels" rows="3" style="width:100%;color:#111827;background:#fff;border-radius:8px;padding:8px;"></textarea><div class="desktop-help">保存后可在模型输入框下拉选择。仅 Gemini 自动模式会自动选择候选，其他服务由你明确选定。</div></div>
                        <label class="desktop-toggle"><input id="desktopAutoModel" type="checkbox">自动选择可用的 Gemini 模型</label>
                        <label class="desktop-toggle"><input id="desktopAllowPro" type="checkbox">允许自动候选包含 Pro 模型（费用可能更高）</label>
                        <label class="desktop-toggle"><input id="desktopDeepSeekThinking" type="checkbox">DeepSeek 官方深度思考（可选，可能增加耗时与输出量；默认关闭）</label>
                        <div class="desktop-field">
                            <label for="desktopMaxConcurrency">最大并发请求数</label>
                            <input id="desktopMaxConcurrency" type="number" min="1" max="60" step="1" value="10">
                            <div class="desktop-help">1—60，默认 10。统一限制模型检测、识别和复核的上游请求；保存后生效。调低时已有请求会继续结束，后续请求排队。并发数与每分钟请求次数是不同限制。</div>
                        </div>
                        <div class="desktop-field"><label for="desktopMaxRetries">额外重试次数</label><input id="desktopMaxRetries" type="number" min="0" max="10" step="1" value="2"><div class="desktop-help">0—10，默认 2。每张图的每个阶段最多请求 1 + 此数次，连接错误与 JSON 修复共用预算；不会在后台额外叠加 429 重试。手动选择继续会开启新一轮预算。</div></div>
                        <div>
                            <div id="desktopActiveModel" style="font-size:12px;">实际模型：等待请求</div>
                            <div class="desktop-help">自动模式先验证图片小样；路由故障或读取超时会限次切换。默认只在 Flash 系列中回退；手填 Pro 首选视为明确选择。切换模型可能影响标注结果，请复核。</div>
                            <button id="desktopModelProbe" class="desktop-action desktop-secondary" type="button" style="margin-top:8px;">保存并检测 Gemini</button>
                            <div class="desktop-help">从当前服务获取模型目录；不支持目录时使用已保存模型。每轮最多检测 6 个候选，每个候选一次小图请求，最多 2 个检测任务并受全局并发限制。会消耗 API 额度，图片小样通过仅代表当前可用。</div>
                            <div id="desktopProbeStatus" class="desktop-help" role="status"></div>
                            <div id="desktopModelList" class="desktop-model-list"></div>
                        </div>
                        <div class="desktop-field">
                            <label for="desktopProxyUrl">网络代理 URL（选填）</label>
                            <input id="desktopProxyUrl" type="url" placeholder="http://127.0.0.1:7897" autocomplete="off">
                            <div class="desktop-help">${COPY.proxyHelp}</div>
                        </div>
                        <div class="desktop-declaration">${COPY.declaration}</div>
                    </div>
                    <div class="desktop-config-actions">
                        <div id="desktopConfigStatus" class="desktop-status">等待配置</div>
                        <button id="desktopConfigClose" class="desktop-action desktop-secondary" type="button">稍后设置</button>
                        <button id="desktopConfigTest" class="desktop-action desktop-test" type="button">保存并测试</button>
                        <button id="desktopConfigSave" class="desktop-action desktop-primary" type="button">保存</button>
                    </div>
                </div>`;
            document.body.appendChild(modal);

            const startButton = document.getElementById('startBtn');
            if (startButton?.parentElement) {
                const configButton = document.createElement('button');
                configButton.id = 'desktopConfigBtn';
                configButton.type = 'button';
                configButton.textContent = 'API 配置';
                configButton.addEventListener('click', () => this.open());
                startButton.parentElement.insertBefore(configButton, startButton);
            }

            const apiInfo = document.getElementById('apiInfo');
            if (apiInfo?.parentElement) {
                const version = document.createElement('span');
                version.id = 'desktopVersionBadge';
                version.textContent = COPY.version;
                version.title = `${COPY.appName} ${COPY.version}`;
                (document.getElementById('statusVersion') || apiInfo.parentElement).appendChild(version);

                const footer = document.createElement('a');
                footer.id = 'desktopRepositoryFooter';
                footer.href = COPY.repositoryUrl;
                footer.target = '_blank';
                footer.rel = 'noopener noreferrer';
                footer.textContent = COPY.repositoryLabel;
                footer.title = '打开项目仓库';
                (document.getElementById('requestStatsMeta') || apiInfo.parentElement).appendChild(footer);
            }

            document.getElementById('desktopConfigClose').addEventListener('click', () => this.close());
            document.getElementById('desktopConfigSave').addEventListener('click', () => this.save(false));
            document.getElementById('desktopConfigTest').addEventListener('click', () => this.save(true));
            document.getElementById('desktopModelProbe').addEventListener('click', () => this.probeModels());
            document.getElementById('desktopProfile').onchange = event => this.fillProfile((this.publicConfig?.profiles || []).find(p => p.profile_id === event.target.value));
            document.getElementById('desktopProfileNew').onclick = () => this.newProfile(false);
            document.getElementById('desktopDeepSeekPreset').onclick = () => this.newProfile(true);
            document.getElementById('desktopProfileDelete').onclick = () => this.deleteProfile();
            modal.addEventListener('click', event => {
                if (event.target === modal && this.configured) this.close();
            });
        },

        bindStartGuard() {
            document.addEventListener('click', event => {
                const target = event.target instanceof Element ? event.target.closest('#startBtn') : null;
                if (!target || this.configured) return;
                event.preventDefault();
                event.stopImmediatePropagation();
                this.setStatus('请先保存 URL、Key 和模型配置', true);
                this.open();
            }, true);
        },

        renderProfiles(data) {
            const select=document.getElementById('desktopProfile');select.replaceChildren();
            for(const p of data.profiles || []){const option=document.createElement('option');option.value=p.profile_id;option.textContent=`${p.profile_name}${p.profile_id===data.profile_id?'（当前）':''}`;select.append(option);}
            select.value=data.profile_id;
            document.getElementById('desktopProfileActive').textContent=`当前启用：${data.profile_name || '默认服务'} · ${data.protocol || 'chat'} · ${data.model || ''}`;
            this.fillProfile(data);
        },

        fillProfile(p) {
            if(!p)return;this.editingProfileId=p.profile_id;
            document.getElementById('desktopProfileName').value=p.profile_name || '';
            document.getElementById('desktopProtocol').value=p.protocol_setting || 'auto';
            document.getElementById('desktopApiUrl').value=p.base_url || p.api_url || '';
            document.getElementById('desktopApiKey').value='';
            document.getElementById('desktopModel').value=p.model || '';
            document.getElementById('desktopModels').value=(p.models || []).join('\n');
            document.getElementById('desktopProxyUrl').value=p.proxy_url || '';
            document.getElementById('desktopAutoModel').checked=p.auto_model===true;
            document.getElementById('desktopAllowPro').checked=p.allow_pro===true;
            document.getElementById('desktopDeepSeekThinking').checked=p.deepseek_thinking===true;
            document.getElementById('desktopKeyHelp').textContent=p.key_configured?'此服务已保存 Key；留空继续使用。修改域名时请填入对应服务的新 Key。':'此服务必须填写自己的 Key，不会沿用其他服务。';
            const list=document.getElementById('desktopSavedModels');list.replaceChildren();
            for(const model of p.models || []){const option=document.createElement('option');option.value=model;list.append(option);}
        },

        newProfile(deepseek) {
            const select=document.getElementById('desktopProfile');
            if(!select.querySelector('option[value="new"]')){const option=document.createElement('option');option.value='new';option.textContent='待保存的新服务';select.append(option);}
            select.value='new';
            this.fillProfile({profile_id:'new',profile_name:deepseek?'DeepSeek 官方':'新服务',base_url:deepseek?'https://api.deepseek.com':'',protocol_setting:'auto',model:deepseek?'deepseek-v4-flash':'',models:deepseek?['deepseek-v4-flash','deepseek-flash']:[]});
            this.setStatus('填写此服务的 Key 后保存启用');
        },

        async deleteProfile() {
            if(!this.editingProfileId || this.editingProfileId==='new')return;
            if(window.TaskManager?.isRunning || this.activeTaskId){this.setStatus('请先结束当前任务再移除服务配置',true);return;}
            try{const response=await fetch('/api/app-config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({profile_action:'delete',profile_id:this.editingProfileId})});const data=await response.json();if(!response.ok || !data.ok)throw new Error(data.message);await this.refresh();this.setStatus('已移除配置');}catch(error){this.setStatus(error.message,true);}
        },

        async refresh() {
            try {
                const response = await fetch('/api/app-config', { cache: 'no-store' });
                const data = await response.json();
                if (!response.ok) throw new Error(data.message || `HTTP ${response.status}`);
                this.publicConfig = data;
                this.configured = Boolean(data.configured);
                this.renderProfiles(data);
                document.getElementById('desktopApiUrl').value = data.api_url || '';
                document.getElementById('desktopModel').value = data.model || 'gemini-3.8-flash-low';
                document.getElementById('desktopProxyUrl').value = data.proxy_url || '';
                document.getElementById('desktopAutoModel').checked = data.auto_model === true;
                document.getElementById('desktopAllowPro').checked = data.allow_pro === true;
                document.getElementById('desktopMaxConcurrency').value = data.max_concurrency || 10;
                document.getElementById('desktopMaxRetries').value = data.max_retries ?? 2;
                document.getElementById('desktopApiKey').value = '';
                if (document.getElementById('apiRpm')) document.getElementById('apiRpm').value = data.request_rpm || 0;
                this.applyModel(data.model || 'gemini-3.8-flash-low');
                this.setStatus(this.configured ? '配置已就绪' : '首次使用，请填写完整配置', !this.configured);
                if (!this.configured) this.open();
            } catch (error) {
                this.configured = false;
                this.setStatus(`读取本地配置失败：${error.message}`, true);
                this.open();
            } finally {
                this.ready = true;
            }
        },

        collect() {
            return {
                profile_id: this.editingProfileId || this.publicConfig?.profile_id || 'default',
                profile_name: document.getElementById('desktopProfileName').value.trim(),
                protocol: document.getElementById('desktopProtocol').value,
                models: document.getElementById('desktopModels').value.split(/[\n,，]+/).map(s=>s.trim()).filter(Boolean),
                api_url: document.getElementById('desktopApiUrl').value.trim(),
                api_key: document.getElementById('desktopApiKey').value.trim(),
                model: document.getElementById('desktopModel').value.trim(),
                auto_model: document.getElementById('desktopAutoModel').checked,
                allow_pro: document.getElementById('desktopAllowPro').checked,
                deepseek_thinking: document.getElementById('desktopDeepSeekThinking').checked,
                max_concurrency: Number(document.getElementById('desktopMaxConcurrency').value),
                max_retries: Number(document.getElementById('desktopMaxRetries').value),
                request_rpm: Math.max(0,Number(document.getElementById('apiRpm')?.value || 0)),
                proxy_url: document.getElementById('desktopProxyUrl').value.trim()
            };
        },

        async save(runTest) {
            const payload = this.collect();
            if(this.activeTaskId && !this.isRecovering){this.setStatus('识别期间请先结束任务，或在连接恢复窗口中切换服务；避免混用配置',true);return false;}
            if (!Number.isInteger(payload.max_concurrency) || payload.max_concurrency < 1 || payload.max_concurrency > 60) {
                this.setStatus('最大并发请求数必须是 1 到 60 的整数', true);
                return false;
            }
            this.setStatus(runTest ? '正在保存并测试连接…' : '正在保存…');
            this.setButtonsDisabled(true);
            try {
                const response = await fetch('/api/app-config', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
                const data = await response.json();
                if (!response.ok || !data.ok) throw new Error(data.message || `HTTP ${response.status}`);
                this.configured = true;
                this.publicConfig = data;
                this.renderProfiles(data);
                this.applyModel(data.model || payload.model);
                document.getElementById('desktopApiUrl').value = data.api_url || payload.api_url;
                document.getElementById('desktopApiKey').value = '';
                if (runTest) {
                    const testData = await this.testConnection();
                    this.setStatus(testData.message || '连接测试成功');
                } else {
                    this.setStatus('配置已安全保存');
                }
                await this.refreshModels();
                return true;
            } catch (error) {
                this.setStatus(error.message || String(error), true);
                return false;
            } finally {
                this.setButtonsDisabled(false);
            }
        },

        async testConnection() {
            const response = await fetch('/api/app-config/test', { method: 'POST' });
            const data = await response.json().catch(() => ({}));
            if (!response.ok || !data.ok) {
                throw new Error(data.message || `连接测试失败（HTTP ${response.status}）`);
            }
            if (data.model_used) this.setActiveModel(data.model_used, data.auto_model);
            return data;
        },

        async schedulerAction(action, extra = {}) {
            const response = await fetch('/api/scheduler/task', { method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action, task_id: this.activeTaskId, ...extra }) });
            const data = await response.json();
            if (!response.ok || !data.ok) throw new Error(data.message || `调度器 HTTP ${response.status}`);
            this.schedulerEnabled = true;
            return data;
        },

        async scheduledFetch(payload) {
            const response = await fetch('/api/proxy/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
            if (!response.ok) return response;
            const data = await response.json();
            if (!data.job_id) throw new Error('本地调度器没有返回任务标识');
            return new Promise((resolve, reject) => {
                this.pendingJobs.set(data.job_id, { resolve, reject });
                this.pollJobs();
            });
        },

        async pollJobs() {
            if (this.pollingJobs) return;
            this.pollingJobs = true;
            let failures = 0;
            try {
                while (this.pendingJobs.size) {
                    try {
                        const acks = [...this.jobAcks];
                        const query = new URLSearchParams({ task_id: this.activeTaskId, ack: acks.join(',') });
                        const response = await fetch(`/api/proxy/jobs?${query}`, { cache: 'no-store' });
                        const data = await response.json();
                        if (!response.ok || !data.ok) throw new Error('无法读取本地任务结果');
                        acks.forEach(id => this.jobAcks.delete(id));
                        for (const row of data.results) {
                            const pending = this.pendingJobs.get(row.job_id);
                            if (!pending) continue;
                            this.pendingJobs.delete(row.job_id);
                            this.jobAcks.add(row.job_id);
                            pending.resolve(new Response(row.body, { status: row.status, headers: { 'Content-Type': row.content_type, ...row.headers } }));
                        }
                        failures = 0;
                    } catch (error) {
                        if (++failures >= 3) {
                            error.fatal = true;
                            for (const pending of this.pendingJobs.values()) pending.reject(error);
                            this.pendingJobs.clear();
                        } else await new Promise(resolve => setTimeout(resolve, 300));
                    }
                }
            } finally { this.pollingJobs = false; }
        },

        async configureRpm() {
            const input = document.getElementById('apiRpm');
            const rpm = Math.max(0, Number(input?.value || 0));
            if (!Number.isInteger(rpm) || rpm > 60000) { this.setStatus('RPM 必须为 0—60000，0 表示自动', true); return; }
            try { await this.schedulerAction('configure', { rpm }); await this.refreshScheduler(); }
            catch (error) { this.setStatus(error.message, true); }
        },

        async beginTask() {
            this.jobAcks.clear();
            this.activeTaskId = crypto.randomUUID();
            const rpm = Math.max(0, Number(document.getElementById('apiRpm')?.value || 0));
            try { await this.schedulerAction('start', { rpm }); }
            catch (error) { this.activeTaskId = ''; throw error; }
            this.imageStats = { started: performance.now(), finished: 0, completed: 0, failed: 0 };
            this.refreshScheduler();
            return this.activeTaskId;
        },

        async stopTask(reason = 'requested_stop') {
            if (this.activeTaskId) await this.schedulerAction('stop', {reason});
        },

        async finishTask() {
            try { if (this.activeTaskId) await this.schedulerAction('finish'); }
            catch (error) { console.warn('Scheduler finish:', error.message); }
            finally {
                this.activeTaskId = '';
                this.jobAcks.clear();
                if (this.imageStats) this.imageStats.finished = performance.now();
                await this.refreshScheduler();
            }
        },

        recordImageCompletion(ok, cancelled = false) {
            if (!this.imageStats || cancelled) return;
            this.imageStats[ok ? 'completed' : 'failed']++;
        },

        async refreshScheduler() {
            if (this.refreshingScheduler) return;
            this.refreshingScheduler = true;
            clearTimeout(this.schedulerTimer);
            try {
                const response = await fetch('/api/scheduler', { cache: 'no-store' });
                const data = await response.json();
                if (!response.ok || !data.ok) return;
                this.schedulerEnabled = true;
                this.lastSchedulerData = data;
                const stats = this.imageStats;
                const minutes = stats ? Math.max(.001, ((stats.finished || performance.now()) - stats.started) / 60000) : 0;
                const imageRate = stats ? `${(stats.completed / minutes).toFixed(1)} 成功图/min` : '';
                const text = `API ${data.requests_last_minute}/min · 在途 ${data.active}/${data.effective_limit} · 排队 ${data.queued} · 平均 ${data.average_seconds}s${imageRate ? ` · ${imageRate}` : ''}${data.cooldown_seconds ? ` · 退让 ${Math.ceil(data.cooldown_seconds)}s` : ''}`;
                const info = document.getElementById('apiInfo');
                if (info) {
                    info.textContent = text;
                    info.title = `并发上限 ${data.limit}；${data.rpm_limit ? `RPM上限 ${data.rpm_limit}` : '自动节流'}；请求 ${data.requests_total}，重试 ${data.retries_total}，失败 ${data.failures_total}。${data.adjustment || ''}`;
                }
                window.RequestStatus?.update(data, stats);
            } catch (_) { /* Local shutdown does not alter saved task results. */ }
            finally {
                this.refreshingScheduler = false;
                if (this.activeTaskId || this.probeRunning) this.schedulerTimer = setTimeout(() => this.refreshScheduler(), 1000);
            }
        },

        async probeModels() {
            const cancel = this.probeRunning;
            if (!cancel && !await this.save(false)) return;
            this.setButtonsDisabled(true);
            try {
                const response = await fetch(cancel ? '/api/models/probe/cancel' : '/api/models/probe', { method: 'POST' });
                const data = await response.json();
                if (!response.ok || !data.ok) throw new Error(data.message || `HTTP ${response.status}`);
                this.renderModels(data);
            } catch (error) {
                this.setStatus(`检测失败：${error.message}`, true);
            } finally {
                this.setButtonsDisabled(false);
            }
        },

        async refreshModels() {
            try {
                const response = await fetch('/api/models', { cache: 'no-store' });
                const data = await response.json();
                if (!response.ok || !data.ok) return;
                this.renderModels(data);
            } catch (_) { /* Configuration remains usable while the local request is retried. */ }
        },

        renderModels(data) {
            clearTimeout(this.probeTimer);
            this.probeRunning = data.probe?.running === true;
            if (this.probeRunning) this.refreshScheduler();
            document.getElementById('desktopModelProbe').textContent = this.probeRunning ? '停止检测' : '保存并检测模型';
            if (data.active_model) this.setActiveModel(data.active_model, data.auto_model);
            const job = data.probe;
            const limits = data.request_limits;
            document.getElementById('desktopProbeStatus').textContent = job
                ? `${job.running ? '正在检测' : job.cancelled ? '已停止' : '检测完成'} ${job.done}/${job.total}${job.error ? ` · ${job.error}` : ''}`
                : '尚未检测。模型目录不代表上游路由当前可用。';
            if (limits) document.getElementById('desktopProbeStatus').textContent += ` · 请求 ${limits.active}/${limits.limit}，排队 ${limits.queued}`;
            const labels = { vision_ok: '图片小样通过', failed: '请求失败', unverified: '未验证通过', expired: '检测已过期', listed_only: '仅在目录列出', not_candidate: '非标注候选' };
            const categories = { auth_or_quota: '鉴权或额度受限', rate_limited: '速率受限', model_or_route_not_found: '模型或路由不存在', routing_unavailable: '路由配置不可用', temporarily_unavailable: '上游暂不可用', timeout_or_network: '超时或网络异常', vision_response_unverified: '图片回答不符合小样', request_error: '请求被拒绝' };
            const list = document.getElementById('desktopModelList');
            list.replaceChildren();
            const rows = [...(data.models || [])].sort((a, b) => Number(b.status === 'vision_ok') - Number(a.status === 'vision_ok'));
            for (const row of rows) {
                const item = document.createElement('div'); item.className = 'desktop-model-row';
                const text = document.createElement('span');
                const checked = row.checked_at ? new Date(row.checked_at).toLocaleTimeString() : '';
                text.textContent = `${row.model} · ${labels[row.status] || row.status}${row.category ? ` · ${categories[row.category] || row.category}` : ''}${checked ? ` · ${checked}` : ''}`;
                item.appendChild(text);
                if (row.status !== 'not_candidate') {
                    const choose = document.createElement('button'); choose.type = 'button'; choose.textContent = '设为首选';
                    choose.addEventListener('click', () => {
                        document.getElementById('desktopModel').value = row.model;
                        this.setStatus('首选已填写，请保存配置');
                    });
                    item.appendChild(choose);
                }
                list.appendChild(item);
            }
            if (this.probeRunning && document.getElementById('desktopConfigModal').classList.contains('open')) {
                this.probeTimer = setTimeout(() => this.refreshModels(), 1000);
            }
        },

        setActiveModel(model, auto = this.publicConfig?.auto_model) {
            document.getElementById('desktopActiveModel').textContent = auto ? `最近实际模型：${model}` : `手动指定模型：${model}`;
            const option = document.querySelector('#modelSelect option[value="user-api"]');
            if (option) option.textContent = auto ? `自动 Gemini (${model})` : `用户配置 (${model})`;
        },

        applyModel(model) {
            if (typeof CONFIGS !== 'undefined' && CONFIGS['user-api']) {
                CONFIGS['user-api'].model = model;
            }
            const select = document.getElementById('modelSelect');
            const option = select?.querySelector('option[value="user-api"]');
            if (option) option.textContent = this.publicConfig?.auto_model ? `自动 Gemini (首选 ${model})` : `用户配置 (${model})`;
            if (select) select.value = 'user-api';
        },

        setButtonsDisabled(disabled) {
            document.getElementById('desktopConfigSave').disabled = disabled;
            document.getElementById('desktopConfigTest').disabled = disabled;
            document.getElementById('desktopModelProbe').disabled = disabled;
        },

        setStatus(message, isError) {
            const status = document.getElementById('desktopConfigStatus');
            if (!status) return;
            status.textContent = message;
            status.style.color = isError ? '#dc2626' : '#047857';
        },

        open() {
            document.getElementById('desktopConfigModal')?.classList.add('open');
            this.refreshModels();
        },

        close() {
            if (!this.configured) {
                this.setStatus('尚未完成配置，开始分析时会再次打开本窗口', true);
            }
            document.getElementById('desktopConfigModal')?.classList.remove('open');
            clearTimeout(this.probeTimer);
        }
    };

    window.AppConfigManager = manager;
    manager.init();
})();
