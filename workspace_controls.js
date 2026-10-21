/* Display preferences affect previews only; stored annotations and exports stay complete. */
(function () {
    'use strict';
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem('annotation-display') || '{}'); } catch (_) {}
    const preferences = { labels: saved.labels !== false, annotations: saved.annotations !== false };
    function refreshControls() {
        document.body.classList.toggle('app-hide-labels', !preferences.labels);
        document.body.classList.toggle('app-hide-annotations', !preferences.annotations);
        document.querySelectorAll('[data-annotation-toggle]').forEach(button => {
            const key = button.dataset.annotationToggle;
            const visible = preferences[key];
            button.setAttribute('aria-pressed', String(visible));
            button.title = `${visible ? '隐藏' : '显示'}${key === 'labels' ? '类别名称（Alt+L）' : '全部标注（Alt+B）'}`;
            button.setAttribute('aria-label', button.title);
        });
    }
    function set(key, value) {
        if (!Object.hasOwn(preferences, key)) return;
        preferences[key] = value === true;
        try { localStorage.setItem('annotation-display', JSON.stringify(preferences)); } catch (_) {}
        refreshControls();
        if (typeof state !== 'undefined') {
            if (state.isVideoMode) drawVideoOverlay();
            else renderAllAnnotations();
        }
    }
    window.AnnotationDisplay = { get preferences() { return { ...preferences }; }, set, refreshControls };
    document.addEventListener('click', event => {
        const button = event.target.closest('[data-annotation-toggle]');
        if (button) set(button.dataset.annotationToggle, !preferences[button.dataset.annotationToggle]);
    });
    function openWorkbench() {
        if (typeof closeDropdowns === 'function') closeDropdowns();
        window.ReviewWorkspace?.open();
    }
    document.getElementById('taskWorkbenchBtn')?.addEventListener('click', openWorkbench);
    document.getElementById('manualAnnotateBtn')?.addEventListener('click', () => window.ReviewWorkspace?.editCurrent());
    document.addEventListener('keydown', event => {
        if (!event.altKey || event.ctrlKey || event.metaKey || event.repeat || event.target.closest('input,textarea,select,[contenteditable="true"]')) return;
        const key = event.key.toLowerCase();
        if (!['t','l','b'].includes(key)) return;
        event.preventDefault();
        if (key === 't') openWorkbench();
        else set(key === 'l' ? 'labels' : 'annotations', !preferences[key === 'l' ? 'labels' : 'annotations']);
    });
    refreshControls();

    const panel = document.createElement('section');
    panel.id = 'requestStatsPanel'; panel.hidden = true;
    panel.setAttribute('aria-label', '请求与任务详情');
    panel.innerHTML = '<header><div><small>运行状态</small><h2>请求与任务</h2></div><button id="requestStatsClose" type="button" aria-label="关闭请求详情">×</button></header>' +
        '<div class="app-stats-grid"></div><div class="app-stats-state"><span>任务状态</span><p id="requestStatusFull"></p><p id="requestAdjustment"></p></div><footer id="requestStatsMeta"></footer>';
    document.body.appendChild(panel);
    const button = document.getElementById('requestStatsBtn');
    const message = document.getElementById('statusMsg');
    const labels = [['active','在途 / 上限'],['rpm','每分钟请求'],['queued','排队'],['latency','平均耗时'],['requests','累计请求'],['retries','重试请求'],['failures','请求失败'],['images','成功图 / 分钟']];
    for (const [key,label] of labels) {
        const item = document.createElement('div');
        const caption = document.createElement('span'); caption.textContent = label;
        const value = document.createElement('strong'); value.dataset.stat = key; value.textContent = '—';
        item.append(caption,value); panel.querySelector('.app-stats-grid').append(item);
    }
    function openStats(open) { panel.hidden = !open; button?.setAttribute('aria-expanded', String(open)); }
    button?.addEventListener('click', () => openStats(panel.hidden));
    panel.querySelector('#requestStatsClose').addEventListener('click', () => { openStats(false); button?.focus(); });
    document.addEventListener('click', event => { if (!panel.hidden && !panel.contains(event.target) && !button?.contains(event.target)) openStats(false); });
    document.addEventListener('keydown', event => { if (event.key === 'Escape' && !panel.hidden) { openStats(false); button?.focus(); } });
    function syncMessage() {
        if (!message) return;
        message.title = message.textContent;
        panel.querySelector('#requestStatusFull').textContent = message.textContent;
    }
    if (message) new MutationObserver(syncMessage).observe(message, { childList: true, characterData: true, subtree: true });
    syncMessage();
    const footer = document.getElementById('desktopRepositoryFooter');
    if (footer) panel.querySelector('#requestStatsMeta').append(footer);
    const version = document.getElementById('desktopVersionBadge');
    if (version) document.getElementById('statusVersion')?.append(version);
    window.RequestStatus = {
        update(data, imageStats) {
            const minutes = imageStats ? Math.max(.001, ((imageStats.finished || performance.now()) - imageStats.started) / 60000) : 0;
            const rate = imageStats ? (imageStats.completed / minutes).toFixed(1) : '—';
            const values = { active: `${data.active} / ${data.effective_limit}`, rpm: `${data.requests_last_minute}${data.rpm_limit ? ' / '+data.rpm_limit : ''}`,
                queued: data.queued, latency: `${data.average_seconds} s`, requests: data.requests_total, retries: data.retries_total, failures: data.failures_total, images: rate };
            for (const [key,value] of Object.entries(values)) panel.querySelector(`[data-stat="${key}"]`).textContent = value;
            panel.querySelector('#requestAdjustment').textContent = data.cooldown_seconds ? `退让 ${Math.ceil(data.cooldown_seconds)} 秒 · ${data.adjustment || ''}` : data.adjustment || '';
            const info = document.getElementById('apiInfo');
            if (info) info.textContent = `在途 ${data.active}/${data.effective_limit} · ${data.requests_last_minute}/min`;
            const indicator = document.getElementById('statusIndicator');
            if (indicator) indicator.dataset.state = data.cooldown_seconds ? 'waiting' : data.active ? 'busy' : 'ready';
        }
    };
    if (window.AppConfigManager?.lastSchedulerData) window.RequestStatus.update(AppConfigManager.lastSchedulerData, AppConfigManager.imageStats);
})();
