(function () {
    'use strict';

    // 用户可见文案集中在这里，便于发布前逐句审核。
    const COPY = {
        appName: 'YOLO Auto-Tag',
        version: 'V0.1',
        title: '首次使用配置',
        intro: '请输入你自己的中转站 URL、API Key 和模型名称。配置只保存在本机；API Key 使用 Windows DPAPI 加密，不会写入网页文件。',
        urlHelp: '可填写中转站首页或完整聊天接口；首页地址会自动补全 /v1/chat/completions。',
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

        async init() {
            this.buildUi();
            this.bindStartGuard();
            await this.refresh();
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
                .desktop-help { margin-top: 5px; color: #6b7280; font-size: 11px; line-height: 1.5; }
                .desktop-declaration { border-radius: 8px; background: #eef2ff; color: #3730a3; padding: 10px 12px; font-size: 11px; line-height: 1.6; }
                .dark .desktop-declaration { background: #312e81; color: #e0e7ff; }
                .desktop-config-actions { display: flex; align-items: center; justify-content: flex-end; gap: 9px; padding: 14px 22px 20px; }
                .desktop-action { border-radius: 8px; padding: 8px 14px; font-size: 12px; font-weight: 700; cursor: pointer; }
                .desktop-primary { background: #4f46e5; color: #fff; }
                .desktop-secondary { background: #e5e7eb; color: #374151; }
                .desktop-test { background: #16a34a; color: #fff; }
                .desktop-status { flex: 1; font-size: 11px; color: #6b7280; }
                #desktopConfigBtn { background: #0f766e; color: #fff; padding: 6px 10px; border-radius: 8px; font-size: 12px; font-weight: 700; white-space: nowrap; }
                #desktopVersionBadge { margin-right: 8px; border-radius: 999px; padding: 2px 7px; background: #e0e7ff; color: #3730a3; font-size: 10px; font-weight: 800; white-space: nowrap; }
                .dark #desktopVersionBadge { background: #312e81; color: #e0e7ff; }
                #desktopRepositoryFooter { font-size: 10px; color: #4f46e5; white-space: nowrap; margin-right: 10px; text-decoration: none; }
                #desktopRepositoryFooter:hover { color: #4338ca; text-decoration: underline; }
                .dark #desktopRepositoryFooter { color: #a5b4fc; }
            `;
            document.head.appendChild(style);

            const modal = document.createElement('div');
            modal.id = 'desktopConfigModal';
            modal.innerHTML = `
                <div class="desktop-config-card" role="dialog" aria-modal="true" aria-labelledby="desktopConfigTitle">
                    <div class="desktop-config-head">
                        <div style="display:flex;align-items:center;gap:9px;">
                            <div id="desktopConfigTitle" style="font-size:18px;font-weight:800;">${COPY.title}</div>
                            <span style="border-radius:999px;padding:2px 8px;background:#e0e7ff;color:#3730a3;font-size:11px;font-weight:800;">${COPY.version}</span>
                        </div>
                        <div style="font-size:12px;font-weight:700;margin-top:6px;">${COPY.appName}</div>
                        <div style="font-size:12px;color:#6b7280;margin-top:6px;line-height:1.6;">${COPY.intro}</div>
                    </div>
                    <div class="desktop-config-body">
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
                            <label for="desktopModel">模型名称</label>
                            <input id="desktopModel" type="text" value="gemini-3.6-flash" autocomplete="off">
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
                apiInfo.parentElement.insertBefore(version, apiInfo);

                const footer = document.createElement('a');
                footer.id = 'desktopRepositoryFooter';
                footer.href = COPY.repositoryUrl;
                footer.target = '_blank';
                footer.rel = 'noopener noreferrer';
                footer.textContent = COPY.repositoryLabel;
                footer.title = '打开项目仓库';
                apiInfo.parentElement.insertBefore(footer, apiInfo);
            }

            document.getElementById('desktopConfigClose').addEventListener('click', () => this.close());
            document.getElementById('desktopConfigSave').addEventListener('click', () => this.save(false));
            document.getElementById('desktopConfigTest').addEventListener('click', () => this.save(true));
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

        async refresh() {
            try {
                const response = await fetch('/api/app-config', { cache: 'no-store' });
                const data = await response.json();
                if (!response.ok) throw new Error(data.message || `HTTP ${response.status}`);
                this.publicConfig = data;
                this.configured = Boolean(data.configured);
                document.getElementById('desktopApiUrl').value = data.api_url || '';
                document.getElementById('desktopModel').value = data.model || 'gemini-3.6-flash';
                document.getElementById('desktopProxyUrl').value = data.proxy_url || '';
                document.getElementById('desktopApiKey').value = '';
                this.applyModel(data.model || 'gemini-3.6-flash');
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
                api_url: document.getElementById('desktopApiUrl').value.trim(),
                api_key: document.getElementById('desktopApiKey').value.trim(),
                model: document.getElementById('desktopModel').value.trim(),
                proxy_url: document.getElementById('desktopProxyUrl').value.trim()
            };
        },

        async save(runTest) {
            const payload = this.collect();
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
                this.applyModel(data.model || payload.model);
                document.getElementById('desktopApiUrl').value = data.api_url || payload.api_url;
                document.getElementById('desktopApiKey').value = '';
                if (runTest) {
                    const testResponse = await fetch('/api/app-config/test', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: '{}'
                    });
                    const testData = await testResponse.json();
                    if (!testResponse.ok || !testData.ok) throw new Error(testData.message || `HTTP ${testResponse.status}`);
                    this.setStatus(testData.message || '连接测试成功');
                } else {
                    this.setStatus('配置已安全保存');
                }
            } catch (error) {
                this.setStatus(error.message || String(error), true);
            } finally {
                this.setButtonsDisabled(false);
            }
        },

        applyModel(model) {
            if (typeof CONFIGS !== 'undefined' && CONFIGS['user-api']) {
                CONFIGS['user-api'].model = model;
            }
            const select = document.getElementById('modelSelect');
            const option = select?.querySelector('option[value="user-api"]');
            if (option) option.textContent = `用户配置 (${model})`;
            if (select) select.value = 'user-api';
        },

        setButtonsDisabled(disabled) {
            document.getElementById('desktopConfigSave').disabled = disabled;
            document.getElementById('desktopConfigTest').disabled = disabled;
        },

        setStatus(message, isError) {
            const status = document.getElementById('desktopConfigStatus');
            if (!status) return;
            status.textContent = message;
            status.style.color = isError ? '#dc2626' : '#047857';
        },

        open() {
            document.getElementById('desktopConfigModal')?.classList.add('open');
        },

        close() {
            if (!this.configured) {
                this.setStatus('尚未完成配置，开始分析时会再次打开本窗口', true);
            }
            document.getElementById('desktopConfigModal')?.classList.remove('open');
        }
    };

    window.AppConfigManager = manager;
    manager.init();
})();
