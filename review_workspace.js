(function () {
    'use strict';

    const CATEGORY_META = {
        normal: {
            label: '正常图', folder: 'normal', symbol: '✓',
            description: '已确认目标与标注框匹配', rule: '至少保留 1 个有效标注框'
        },
        background: {
            label: '背景图', folder: 'background', symbol: '○',
            description: '确认整张图片没有目标', rule: 'TXT 保留为空文件（0 KB）'
        },
        review: {
            label: '人工复核图', folder: 'manual_review', symbol: '!',
            description: 'AI 不确定，由人工最终决定', rule: '可修改框，也可保留在复核目录'
        }
    };
    const CATEGORY_KEYS = Object.keys(CATEGORY_META);
    const FLIP_DURATION = 470;
    const objectUrls = new WeakMap();
    const deckIndices = { normal: 0, background: 0, review: 0 };
    const wheelStates = {
        normal: { armed: true, timer: null },
        background: { armed: true, timer: null },
        review: { armed: true, timer: null }
    };
    const animatingDecks = new Set();

    let root = null;
    let editorBackdrop = null;
    let editorBoxLayer = null;
    let editorImage = null;
    let activeFilter = 'all';
    let searchTerm = '';
    let editingResult = null;
    let selectedBoxIndex = 0;
    let draggedReviewId = '';
    let toastTimer = null;
    let reviewIdCounter = 0;
    let initialized = false;
    let demoMode = new URLSearchParams(location.search).get('reviewDemo') === '1';

    function escapeHtml(value) {
        return String(value ?? '').replace(/[&<>'"]/g, character => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
        })[character]);
    }

    function clamp(value, min, max) {
        return Math.min(max, Math.max(min, value));
    }

    function clone(value) {
        return JSON.parse(JSON.stringify(value));
    }

    function currentResults() {
        return Array.isArray(state?.imageResults) ? state.imageResults : [];
    }

    function getResultId(result) {
        if (!result.reviewId) {
            reviewIdCounter += 1;
            result.reviewId = `review-${Date.now().toString(36)}-${reviewIdCounter}`;
        }
        return result.reviewId;
    }

    function defaultCategory(result) {
        if (result?.reviewCategory && CATEGORY_META[result.reviewCategory]) return result.reviewCategory;
        const boxes = Array.isArray(result?.annotations) ? result.annotations : [];
        if (result?.needsReview) return 'review';
        if (boxes.length > 0) return 'normal';
        if (result?.verifiedEmpty === true) return 'background';
        return 'review';
    }

    function prepareResults() {
        currentResults().forEach(result => {
            getResultId(result);
            result.annotations = Array.isArray(result.annotations) ? result.annotations : [];
            result.reviewCategory = defaultCategory(result);
        });
    }

    function isValidBox(annotation) {
        if (!annotation || typeof annotation.label !== 'string' || !annotation.label.trim()) return false;
        if (!Array.isArray(annotation.box_2d) || annotation.box_2d.length !== 4) return false;
        const [rawY1, rawX1, rawY2, rawX2] = annotation.box_2d.map(Number);
        if (![rawY1, rawX1, rawY2, rawX2].every(Number.isFinite)) return false;
        const y1 = clamp(rawY1, 0, 1000);
        const x1 = clamp(rawX1, 0, 1000);
        const y2 = clamp(rawY2, 0, 1000);
        const x2 = clamp(rawX2, 0, 1000);
        return y2 - y1 >= 2 && x2 - x1 >= 2;
    }

    function issueFor(result) {
        const boxes = Array.isArray(result.annotations) ? result.annotations : [];
        if (boxes.some(annotation => !isValidBox(annotation))) return '存在无效标注框，请修改或删除';
        if (result.reviewCategory === 'normal' && boxes.length === 0) return '正常图至少需要 1 个标注框';
        if (result.reviewCategory === 'background' && boxes.length > 0) return '背景图必须删除全部标注框';
        return '';
    }

    function syncResultFlags(result, reason = 'manual-review') {
        const boxes = Array.isArray(result.annotations) ? result.annotations : [];
        const issue = issueFor(result);
        result.manualReviewed = true;
        result.manualReviewedAt = Date.now();
        if (result.reviewCategory === 'background' && !issue) {
            result.verifiedEmpty = true;
            result.needsReview = false;
        } else if (result.reviewCategory === 'normal' && !issue) {
            result.verifiedEmpty = false;
            result.needsReview = false;
        } else {
            result.verifiedEmpty = false;
            result.needsReview = true;
        }
        result.validation = {
            ...(result.validation || {}),
            status: `manual_${result.reviewCategory}`,
            verifiedEmpty: result.verifiedEmpty,
            needsReview: result.needsReview,
            estimatedCount: boxes.length,
            reason: issue || reason
        };
    }

    function resultUrl(result) {
        if (result?.dataUrl) return result.dataUrl;
        if (result?.file instanceof Blob) {
            if (!objectUrls.has(result)) objectUrls.set(result, URL.createObjectURL(result.file));
            return objectUrls.get(result);
        }
        return '';
    }

    function categoryResults(category) {
        return currentResults().filter(result => {
            const categoryMatches = result.reviewCategory === category;
            const filterMatches = activeFilter === 'all' || activeFilter === category;
            const searchMatches = String(result.fileName || result.file?.name || '')
                .toLowerCase().includes(searchTerm);
            return categoryMatches && filterMatches && searchMatches;
        });
    }

    function fileNameFor(result) {
        return result.fileName || result.file?.name || '未命名图片';
    }

    function yoloTextFor(result) {
        return (result.annotations || []).map(annotation => {
            if (!isValidBox(annotation)) return null;
            const [rawY1, rawX1, rawY2, rawX2] = annotation.box_2d.map(Number);
            const y1 = clamp(Math.min(rawY1, rawY2), 0, 1000);
            const x1 = clamp(Math.min(rawX1, rawX2), 0, 1000);
            const y2 = clamp(Math.max(rawY1, rawY2), 0, 1000);
            const x2 = clamp(Math.max(rawX1, rawX2), 0, 1000);
            const classId = getClassId(annotation.label.trim());
            const cx = ((x1 + x2) / 2) / 1000;
            const cy = ((y1 + y2) / 2) / 1000;
            const width = (x2 - x1) / 1000;
            const height = (y2 - y1) / 1000;
            return `${classId} ${cx.toFixed(6)} ${cy.toFixed(6)} ${width.toFixed(6)} ${height.toFixed(6)}`;
        }).filter(Boolean).join('\n');
    }

    function textBytes(value) {
        return new TextEncoder().encode(value).length;
    }

    function createRoot() {
        root = document.createElement('section');
        root.id = 'reviewWorkspace';
        root.className = 'rw-root';
        root.setAttribute('aria-hidden', 'true');
        root.innerHTML = `
            <div class="rw-dialog" role="dialog" aria-modal="true" aria-labelledby="rwTitle">
                <header class="rw-topbar">
                    <div class="rw-brand" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M15 10l5-2.4v8.8L15 14M5 6h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2Z"/></svg></div>
                    <div class="rw-title">
                        <div class="rw-kicker">AI 标注完成 · 导出前检查</div>
                        <div class="rw-title-line"><h1 id="rwTitle">标注结果复核台</h1><span class="rw-badge">实时同步 YOLO TXT</span></div>
                        <p>滚轮机械翻页检查图片；分类和框修改会写回当前任务。</p>
                    </div>
                    <div class="rw-top-actions">
                        <button class="rw-button rw-button-ghost" data-rw-action="return-main" type="button">返回主页面</button>
                        <button class="rw-button rw-button-primary" data-rw-action="export" type="button"><svg viewBox="0 0 24 24"><path d="M12 3v12m0 0 4-4m-4 4-4-4M5 17v3h14v-3"/></svg><span>分类导出任务包</span></button>
                    </div>
                </header>
                <section class="rw-summary" aria-label="复核统计">
                    <div class="rw-summary-copy"><small>任务概览</small><strong data-rw-total>共 0 张图片</strong><span>人工复核图会单独保存，不混入正常图。</span></div>
                    <div class="rw-summary-cards">
                        ${CATEGORY_KEYS.map(category => `<div class="rw-summary-card" data-category="${category}"><span class="rw-summary-icon">${CATEGORY_META[category].symbol}</span><span><b data-rw-summary-count="${category}">0</b><small>${CATEGORY_META[category].label}</small></span></div>`).join('')}
                        <div class="rw-summary-card rw-conflicts"><span class="rw-summary-icon">◆</span><span><b data-rw-conflict-count>0</b><small>规则冲突</small></span></div>
                    </div>
                </section>
                <section class="rw-toolbar">
                    <div class="rw-segments" role="group" aria-label="筛选复核结果">
                        <button class="rw-segment rw-active" data-rw-filter="all" type="button">全部</button>
                        <button class="rw-segment" data-rw-filter="normal" type="button">正常图</button>
                        <button class="rw-segment" data-rw-filter="background" type="button">背景图</button>
                        <button class="rw-segment" data-rw-filter="review" type="button">人工复核</button>
                    </div>
                    <label class="rw-search"><svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="m16 16 4 4"/></svg><input data-rw-search type="search" placeholder="搜索文件名…" autocomplete="off"></label>
                    <div class="rw-wheel-hint"><span class="rw-wheel-icon">↕</span><span data-rw-view-hint>鼠标停在卡片上滚动，一次翻一张并交替覆盖置顶</span></div>
                </section>
                <section class="rw-board">
                    ${CATEGORY_KEYS.map(category => createLaneMarkup(category)).join('')}
                </section>
                <footer class="rw-footer">
                    <div class="rw-folder-preview"><span class="rw-folder-icon">⌑</span><div><b>分类任务包结构</b><span>normal/ · background/ · manual_review/ · classes.txt · review_manifest.json</span></div></div>
                    <div class="rw-footer-status"><i></i><span>所有图片符合当前分类规则</span></div>
                    <button class="rw-button rw-button-subtle" data-rw-action="return-main" type="button">稍后处理</button>
                    <button class="rw-button rw-button-primary rw-button-wide" data-rw-action="export" type="button"><span>确认分类并生成任务包</span></button>
                </footer>
                ${createEditorMarkup()}
                <div class="rw-toast" role="status" aria-live="polite"></div>
            </div>`;
        document.body.appendChild(root);
        editorBackdrop = root.querySelector('.rw-editor-backdrop');
        editorBoxLayer = root.querySelector('.rw-editor-box-layer');
        editorImage = root.querySelector('.rw-editor-stage > img');
    }

    function createLaneMarkup(category) {
        const meta = CATEGORY_META[category];
        return `<article class="rw-lane" data-category="${category}">
            <header class="rw-lane-head"><div class="rw-lane-title"><span class="rw-lane-symbol">${meta.symbol}</span><div><h2>${meta.label}</h2><p>${meta.description}</p></div></div><span class="rw-lane-count" data-rw-lane-count="${category}">0 张</span></header>
            <div class="rw-lane-rule"><i></i>${meta.rule}</div>
            <div class="rw-deck"><div class="rw-deck-viewport" data-rw-deck="${category}" tabindex="0" aria-label="${meta.label}机械翻页卡片"></div><div class="rw-deck-controls"><button class="rw-page-button" data-rw-prev="${category}" type="button" aria-label="${meta.label}上一张">↑</button><div class="rw-page-track"><span class="rw-page-number" data-rw-page="${category}">0 / 0</span><span class="rw-page-dots" data-rw-dots="${category}"></span></div><button class="rw-page-button" data-rw-next="${category}" type="button" aria-label="${meta.label}下一张">↓</button></div></div>
        </article>`;
    }

    function createEditorMarkup() {
        return `<aside class="rw-editor-backdrop" aria-hidden="true">
            <section class="rw-editor" role="dialog" aria-modal="true" aria-labelledby="rwEditorTitle">
                <header class="rw-editor-head"><div><div class="rw-kicker">图片标注编辑器</div><h2 id="rwEditorTitle">—</h2></div><button class="rw-icon-button" data-rw-editor-close type="button" aria-label="关闭标注编辑器">×</button></header>
                <div class="rw-editor-content">
                    <div class="rw-editor-main">
                        <div class="rw-editor-tools"><div class="rw-class-pill"><i></i><span data-rw-current-class>当前类别</span></div><span class="rw-editor-tip">拖动框移动 · 拖动右下角缩放</span><button class="rw-mini-button" data-rw-add-box type="button">＋ 添加标注框</button></div>
                        <div class="rw-editor-stage"><img alt="当前复核图片"><div class="rw-editor-box-layer"></div><span class="rw-stage-size">原图尺寸读取中</span></div>
                        <div class="rw-editor-nav"><button class="rw-mini-button" data-rw-editor-prev type="button">← 上一张</button><span data-rw-editor-position>0 / 0</span><button class="rw-mini-button" data-rw-editor-next type="button">下一张 →</button></div>
                    </div>
                    <aside class="rw-editor-side">
                        <section class="rw-side-section"><label class="rw-field-label" for="rwCategorySelect">图片分类</label><select id="rwCategorySelect" class="rw-category-select">${CATEGORY_KEYS.map(key => `<option value="${key}">${CATEGORY_META[key].label}</option>`).join('')}</select><div class="rw-rule-message"></div></section>
                        <section class="rw-side-section rw-side-grow"><div class="rw-section-title"><span>标注框</span><b data-rw-box-count>0 个</b></div><div class="rw-box-list"></div></section>
                        <section class="rw-side-section rw-txt-section"><div class="rw-section-title"><span>TXT 实时预览</span><b data-rw-txt-size>0 KB</b></div><pre class="rw-txt-preview"></pre><p class="rw-txt-note">格式：类别 x中心 y中心 宽 高（归一化坐标）</p></section>
                    </aside>
                </div>
                <footer class="rw-editor-foot"><div class="rw-autosave"><i></i>修改已实时写回当前任务</div><button class="rw-button rw-button-ghost" data-rw-editor-close type="button">关闭</button><button class="rw-button rw-button-primary" data-rw-editor-done type="button">完成并返回复核台</button></footer>
            </section>
        </aside>`;
    }

    function bindEvents() {
        root.querySelectorAll('[data-rw-action="return-main"]').forEach(button => button.addEventListener('click', close));
        root.querySelectorAll('[data-rw-action="export"]').forEach(button => button.addEventListener('click', exportReviewedPackage));
        root.querySelectorAll('[data-rw-filter]').forEach(button => button.addEventListener('click', () => setFilter(button.dataset.rwFilter)));
        root.querySelector('[data-rw-search]').addEventListener('input', event => {
            searchTerm = event.target.value.trim().toLowerCase();
            CATEGORY_KEYS.forEach(category => deckIndices[category] = 0);
            render();
        });
        CATEGORY_KEYS.forEach(category => {
            root.querySelector(`[data-rw-prev="${category}"]`).addEventListener('click', () => flipLane(category, -1));
            root.querySelector(`[data-rw-next="${category}"]`).addEventListener('click', () => flipLane(category, 1));
        });
        root.querySelectorAll('[data-rw-editor-close]').forEach(button => button.addEventListener('click', closeEditor));
        root.querySelector('[data-rw-editor-done]').addEventListener('click', closeEditor);
        root.querySelector('[data-rw-add-box]').addEventListener('click', addBox);
        root.querySelector('[data-rw-editor-prev]').addEventListener('click', () => navigateEditor(-1));
        root.querySelector('[data-rw-editor-next]').addEventListener('click', () => navigateEditor(1));
        root.querySelector('#rwCategorySelect').addEventListener('change', event => {
            if (!editingResult) return;
            moveResult(editingResult, event.target.value, false);
            renderEditorPanels();
        });
        editorBackdrop.addEventListener('click', event => {
            if (event.target === editorBackdrop) closeEditor();
        });
        document.addEventListener('keydown', event => {
            if (event.key !== 'Escape') return;
            if (editorBackdrop?.classList.contains('rw-open')) closeEditor();
            else if (root?.classList.contains('rw-open')) close();
        });
        window.addEventListener('resize', layoutEditorImage);
        const reopenButton = document.getElementById('reviewResultsBtn');
        if (reopenButton) reopenButton.addEventListener('click', () => {
            document.getElementById('fileMenu')?.classList.add('hidden');
            open({ reason: 'manual-open' });
        });
    }

    function setFilter(filter) {
        activeFilter = CATEGORY_META[filter] ? filter : 'all';
        root.querySelectorAll('[data-rw-filter]').forEach(button => button.classList.toggle('rw-active', button.dataset.rwFilter === activeFilter));
        CATEGORY_KEYS.forEach(category => deckIndices[category] = 0);
        render();
    }

    function render() {
        prepareResults();
        const results = currentResults();
        root.querySelector('[data-rw-total]').textContent = `共 ${results.length} 张图片`;
        CATEGORY_KEYS.forEach(category => {
            const count = results.filter(result => result.reviewCategory === category).length;
            root.querySelector(`[data-rw-summary-count="${category}"]`).textContent = count;
            root.querySelector(`[data-rw-lane-count="${category}"]`).textContent = `${count} 张`;
            const lane = root.querySelector(`.rw-lane[data-category="${category}"]`);
            lane.classList.toggle('rw-filter-visible', activeFilter === category);
            renderLane(category);
        });
        root.querySelector('.rw-board').classList.toggle('rw-single-lane', activeFilter !== 'all');
        const folderView = activeFilter !== 'all';
        root.querySelector('.rw-wheel-icon').textContent = folderView ? '▦' : '↕';
        root.querySelector('[data-rw-view-hint]').textContent = folderView
            ? '文件夹视图：同屏浏览全部图片，向下滚动查看更多'
            : '鼠标停在卡片上滚动，一次翻一张并交替覆盖置顶';
        const conflicts = results.filter(issueFor);
        const conflictCard = root.querySelector('.rw-conflicts');
        conflictCard.classList.toggle('rw-visible', conflicts.length > 0);
        root.querySelector('[data-rw-conflict-count]').textContent = conflicts.length;
        const footerStatus = root.querySelector('.rw-footer-status');
        footerStatus.classList.toggle('rw-error', conflicts.length > 0);
        footerStatus.querySelector('span').textContent = conflicts.length
            ? `${conflicts.length} 张图片存在分类或标注规则冲突`
            : '所有图片符合当前分类规则';
        root.querySelectorAll('[data-rw-action="export"]').forEach(button => button.disabled = conflicts.length > 0);
    }

    function renderLane(category) {
        const results = categoryResults(category);
        const folderView = activeFilter !== 'all' && activeFilter === category;
        deckIndices[category] = clamp(deckIndices[category], 0, Math.max(0, results.length - 1));
        const activeIndex = deckIndices[category];
        const viewport = root.querySelector(`[data-rw-deck="${category}"]`);
        viewport.classList.toggle('rw-folder-grid', folderView);
        viewport.replaceChildren();
        if (!results.length) {
            const empty = document.createElement('div');
            empty.className = 'rw-empty-deck';
            empty.textContent = searchTerm ? '当前筛选没有匹配图片' : '可把图片拖到这里';
            viewport.appendChild(empty);
        } else {
            results.forEach((result, index) => {
                const card = createCard(result, category);
                if (folderView) {
                    card.classList.add('rw-card-active', 'rw-folder-card');
                    card.setAttribute('aria-hidden', 'false');
                } else {
                    if (index === activeIndex) card.classList.add('rw-card-active');
                    else card.classList.add(index < activeIndex ? 'rw-card-hidden-before' : 'rw-card-hidden-after');
                    card.setAttribute('aria-hidden', index === activeIndex ? 'false' : 'true');
                }
                viewport.appendChild(card);
            });
        }
        bindDeckViewport(viewport, category, !folderView);
        root.querySelector(`[data-rw-page="${category}"]`).textContent = results.length ? `${activeIndex + 1} / ${results.length}` : '0 / 0';
        root.querySelector(`[data-rw-prev="${category}"]`).disabled = activeIndex <= 0;
        root.querySelector(`[data-rw-next="${category}"]`).disabled = activeIndex >= results.length - 1;
        const dots = root.querySelector(`[data-rw-dots="${category}"]`);
        dots.replaceChildren(...(folderView ? [] : results.slice(0, 12).map((result, index) => {
            const dot = document.createElement('button');
            dot.type = 'button';
            dot.className = `rw-page-dot${index === activeIndex ? ' rw-active' : ''}`;
            dot.title = fileNameFor(result);
            dot.addEventListener('click', () => jumpLane(category, index));
            return dot;
        })));
    }

    function createCard(result, category) {
        const card = document.createElement('article');
        card.className = 'rw-result-card';
        card.dataset.reviewId = getResultId(result);
        card.draggable = true;
        if (issueFor(result)) card.classList.add('rw-conflict');

        const preview = document.createElement('button');
        preview.type = 'button';
        preview.className = 'rw-card-preview';
        preview.setAttribute('aria-label', `编辑 ${fileNameFor(result)} 的标注框`);
        const image = document.createElement('img');
        image.src = resultUrl(result);
        image.alt = `${fileNameFor(result)} 标注预览`;
        const boxLayer = document.createElement('div');
        boxLayer.className = 'rw-card-box-layer';
        (result.annotations || []).forEach(annotation => {
            if (!isValidBox(annotation)) return;
            const [y1, x1, y2, x2] = annotation.box_2d.map(Number);
            const box = document.createElement('span');
            box.className = 'rw-card-box';
            box.style.left = `${clamp(Math.min(x1, x2), 0, 1000) / 10}%`;
            box.style.top = `${clamp(Math.min(y1, y2), 0, 1000) / 10}%`;
            box.style.width = `${clamp(Math.abs(x2 - x1), 0, 1000) / 10}%`;
            box.style.height = `${clamp(Math.abs(y2 - y1), 0, 1000) / 10}%`;
            boxLayer.appendChild(box);
        });
        const chip = document.createElement('span');
        chip.className = 'rw-card-chip';
        chip.textContent = result.annotations.length ? `${result.annotations.length} 个框` : '无标注框';
        const conflict = document.createElement('span');
        conflict.className = 'rw-conflict-chip';
        conflict.textContent = '规则冲突';
        const editHint = document.createElement('span');
        editHint.className = 'rw-edit-hint';
        editHint.textContent = '点击放大并修改标注框';
        preview.append(image, boxLayer, chip, conflict, editHint);
        image.addEventListener('load', () => fitOverlayToContainedImage(image, boxLayer, preview));
        preview.addEventListener('click', () => openEditor(result));

        const info = document.createElement('div');
        info.className = 'rw-card-info';
        const nameRow = document.createElement('div');
        nameRow.className = 'rw-card-name-row';
        const name = document.createElement('b');
        name.className = 'rw-card-name';
        name.textContent = fileNameFor(result);
        const drag = document.createElement('span');
        drag.className = 'rw-card-drag';
        drag.title = '拖动到其他分类';
        drag.textContent = '⠿';
        nameRow.append(name, drag);
        const meta = document.createElement('div');
        meta.className = 'rw-card-meta';
        const confidence = Number(result.validation?.confidence);
        const statusText = document.createElement('span');
        statusText.textContent = result.reviewCategory === 'background'
            ? '状态：确认无目标'
            : Number.isFinite(confidence) ? `复核置信度：${Math.round(confidence * 100)}%` : '人工检查结果';
        const txt = yoloTextFor(result);
        const txtState = document.createElement('b');
        txtState.textContent = txt ? `${textBytes(txt)} B TXT` : '0 KB TXT';
        meta.append(statusText, txtState);
        const select = document.createElement('select');
        select.className = 'rw-card-category';
        select.setAttribute('aria-label', `${fileNameFor(result)} 图片分类`);
        CATEGORY_KEYS.forEach(key => {
            const option = document.createElement('option');
            option.value = key;
            option.textContent = `移动到：${CATEGORY_META[key].label}`;
            select.appendChild(option);
        });
        select.value = category;
        select.addEventListener('change', event => moveResult(result, event.target.value, true));
        info.append(nameRow, meta, select);
        card.append(preview, info);
        card.addEventListener('dragstart', event => {
            draggedReviewId = getResultId(result);
            event.dataTransfer.effectAllowed = 'move';
            event.dataTransfer.setData('text/plain', draggedReviewId);
            requestAnimationFrame(() => card.style.opacity = '.35');
        });
        card.addEventListener('dragend', () => {
            draggedReviewId = '';
            card.style.opacity = '';
            root.querySelectorAll('.rw-drag-over').forEach(node => node.classList.remove('rw-drag-over'));
        });
        return card;
    }

    function fitOverlayToContainedImage(image, overlay, container) {
        if (!image.naturalWidth || !image.naturalHeight || !container.clientWidth || !container.clientHeight) return;
        const scale = Math.min(container.clientWidth / image.naturalWidth, container.clientHeight / image.naturalHeight);
        const width = image.naturalWidth * scale;
        const height = image.naturalHeight * scale;
        overlay.style.position = 'absolute';
        overlay.style.left = `${(container.clientWidth - width) / 2}px`;
        overlay.style.top = `${(container.clientHeight - height) / 2}px`;
        overlay.style.width = `${width}px`;
        overlay.style.height = `${height}px`;
    }

    function bindDeckViewport(viewport, category, enableMechanicalFlip = true) {
        if (enableMechanicalFlip) {
            viewport.addEventListener('wheel', event => {
                event.preventDefault();
                const wheel = wheelStates[category];
                clearTimeout(wheel.timer);
                wheel.timer = setTimeout(() => { wheel.armed = true; }, 190);
                if (!wheel.armed || Math.abs(event.deltaY) < 7) return;
                wheel.armed = false;
                flipLane(category, event.deltaY > 0 ? 1 : -1);
            }, { passive: false });
        }
        viewport.addEventListener('dragover', event => {
            event.preventDefault();
            event.dataTransfer.dropEffect = 'move';
            viewport.classList.add('rw-drag-over');
        });
        viewport.addEventListener('dragleave', event => {
            if (!viewport.contains(event.relatedTarget)) viewport.classList.remove('rw-drag-over');
        });
        viewport.addEventListener('drop', event => {
            event.preventDefault();
            viewport.classList.remove('rw-drag-over');
            const reviewId = draggedReviewId || event.dataTransfer.getData('text/plain');
            const result = currentResults().find(item => getResultId(item) === reviewId);
            if (result) moveResult(result, category, true);
        });
    }

    function flipLane(category, delta) {
        if (animatingDecks.has(category)) return;
        const results = categoryResults(category);
        const currentIndex = clamp(deckIndices[category], 0, Math.max(0, results.length - 1));
        const targetIndex = currentIndex + delta;
        const viewport = root.querySelector(`[data-rw-deck="${category}"]`);
        if (targetIndex < 0 || targetIndex >= results.length) {
            const bumpClass = delta > 0 ? 'rw-bump-down' : 'rw-bump-up';
            viewport.classList.remove(bumpClass);
            void viewport.offsetWidth;
            viewport.classList.add(bumpClass);
            setTimeout(() => viewport.classList.remove(bumpClass), 260);
            return;
        }
        const currentCard = Array.from(viewport.querySelectorAll('.rw-result-card'))
            .find(card => card.dataset.reviewId === getResultId(results[currentIndex]));
        const targetCard = Array.from(viewport.querySelectorAll('.rw-result-card'))
            .find(card => card.dataset.reviewId === getResultId(results[targetIndex]));
        if (!currentCard || !targetCard) {
            deckIndices[category] = targetIndex;
            renderLane(category);
            return;
        }
        animatingDecks.add(category);
        currentCard.classList.add('rw-card-covered');
        targetCard.classList.remove('rw-card-hidden-before', 'rw-card-hidden-after');
        targetCard.classList.add('rw-card-entering', delta > 0 ? 'rw-enter-from-below' : 'rw-enter-from-above');
        targetCard.setAttribute('aria-hidden', 'false');
        requestAnimationFrame(() => requestAnimationFrame(() => targetCard.classList.add('rw-enter-active')));
        setTimeout(() => {
            deckIndices[category] = targetIndex;
            animatingDecks.delete(category);
            renderLane(category);
        }, FLIP_DURATION);
    }

    function jumpLane(category, targetIndex) {
        if (animatingDecks.has(category)) return;
        const currentIndex = deckIndices[category];
        if (targetIndex === currentIndex) return;
        if (Math.abs(targetIndex - currentIndex) === 1) flipLane(category, targetIndex > currentIndex ? 1 : -1);
        else {
            deckIndices[category] = targetIndex;
            renderLane(category);
        }
    }

    function moveResult(result, category, notify) {
        if (!CATEGORY_META[category] || result.reviewCategory === category) return;
        const from = CATEGORY_META[result.reviewCategory].label;
        result.reviewCategory = category;
        syncResultFlags(result, `人工把图片从“${from}”移动到“${CATEGORY_META[category].label}”`);
        CATEGORY_KEYS.forEach(key => deckIndices[key] = 0);
        render();
        if (editingResult === result) renderEditor();
        if (notify) showToast(`已把 ${fileNameFor(result)} 移到“${CATEGORY_META[category].label}”`);
    }

    function openEditor(result) {
        editingResult = result;
        selectedBoxIndex = 0;
        editorBackdrop.classList.add('rw-open');
        editorBackdrop.setAttribute('aria-hidden', 'false');
        renderEditor();
    }

    function closeEditor() {
        if (!editingResult) return;
        const changedResult = editingResult;
        editorBackdrop.classList.remove('rw-open');
        editorBackdrop.setAttribute('aria-hidden', 'true');
        editingResult = null;
        render();
        syncMainPage(changedResult);
    }

    function renderEditor() {
        if (!editingResult) return;
        selectedBoxIndex = clamp(selectedBoxIndex, 0, Math.max(0, editingResult.annotations.length - 1));
        root.querySelector('#rwEditorTitle').textContent = fileNameFor(editingResult);
        root.querySelector('#rwCategorySelect').value = editingResult.reviewCategory;
        const all = currentResults();
        const resultIndex = all.indexOf(editingResult);
        root.querySelector('[data-rw-editor-position]').textContent = `${resultIndex + 1} / ${all.length}`;
        const currentClass = editingResult.annotations[selectedBoxIndex]?.label || getDefaultLabel();
        root.querySelector('[data-rw-current-class]').textContent = `类别 · ${currentClass}`;
        editorImage.onload = () => {
            layoutEditorImage();
            root.querySelector('.rw-stage-size').textContent = `${editorImage.naturalWidth} × ${editorImage.naturalHeight}`;
        };
        editorImage.src = resultUrl(editingResult);
        renderEditorBoxes();
        renderEditorPanels();
    }

    function layoutEditorImage() {
        if (!editorImage || !editorBoxLayer || !editorImage.naturalWidth || !editorImage.naturalHeight) return;
        const stage = root?.querySelector('.rw-editor-stage');
        if (!stage) return;
        fitOverlayToContainedImage(editorImage, editorBoxLayer, stage);
    }

    function renderEditorBoxes() {
        editorBoxLayer.replaceChildren();
        if (!editingResult) return;
        editingResult.annotations.forEach((annotation, index) => {
            if (!isValidBox(annotation)) return;
            const [rawY1, rawX1, rawY2, rawX2] = annotation.box_2d.map(Number);
            const y1 = clamp(Math.min(rawY1, rawY2), 0, 1000);
            const x1 = clamp(Math.min(rawX1, rawX2), 0, 1000);
            const y2 = clamp(Math.max(rawY1, rawY2), 0, 1000);
            const x2 = clamp(Math.max(rawX1, rawX2), 0, 1000);
            annotation.box_2d = [y1, x1, y2, x2];
            const box = document.createElement('div');
            box.className = `rw-editor-box${index === selectedBoxIndex ? ' rw-selected' : ''}`;
            box.dataset.boxIndex = index;
            applyEditorBoxStyle(box, annotation);
            const label = document.createElement('span');
            label.className = 'rw-editor-box-label';
            label.textContent = `${getClassId(annotation.label)} · ${annotation.label} #${index + 1}`;
            const handle = document.createElement('span');
            handle.className = 'rw-resize-handle';
            box.append(label, handle);
            box.addEventListener('pointerdown', event => startBoxGesture(event, index, 'move'));
            handle.addEventListener('pointerdown', event => {
                event.stopPropagation();
                startBoxGesture(event, index, 'resize');
            });
            editorBoxLayer.appendChild(box);
        });
    }

    function applyEditorBoxStyle(element, annotation) {
        const [y1, x1, y2, x2] = annotation.box_2d;
        element.style.left = `${x1 / 10}%`;
        element.style.top = `${y1 / 10}%`;
        element.style.width = `${(x2 - x1) / 10}%`;
        element.style.height = `${(y2 - y1) / 10}%`;
    }

    function startBoxGesture(event, index, mode) {
        event.preventDefault();
        if (!editingResult) return;
        const annotation = editingResult.annotations[index];
        const startBox = annotation.box_2d.map(Number);
        const startX = event.clientX;
        const startY = event.clientY;
        const layerRect = editorBoxLayer.getBoundingClientRect();
        const element = editorBoxLayer.querySelector(`[data-box-index="${index}"]`);
        selectedBoxIndex = index;
        editorBoxLayer.querySelectorAll('.rw-editor-box').forEach(node => node.classList.remove('rw-selected'));
        element.classList.add('rw-selected');
        renderEditorPanels();
        const onMove = moveEvent => {
            const dx = ((moveEvent.clientX - startX) / layerRect.width) * 1000;
            const dy = ((moveEvent.clientY - startY) / layerRect.height) * 1000;
            const [startY1, startX1, startY2, startX2] = startBox;
            if (mode === 'move') {
                const width = startX2 - startX1;
                const height = startY2 - startY1;
                const x1 = clamp(startX1 + dx, 0, 1000 - width);
                const y1 = clamp(startY1 + dy, 0, 1000 - height);
                annotation.box_2d = [y1, x1, y1 + height, x1 + width];
            } else {
                annotation.box_2d = [
                    startY1,
                    startX1,
                    clamp(startY2 + dy, startY1 + 3, 1000),
                    clamp(startX2 + dx, startX1 + 3, 1000)
                ];
            }
            discardStalePreviews(annotation);
            syncResultFlags(editingResult, '人工修改了标注框');
            applyEditorBoxStyle(element, annotation);
            renderEditorPanels();
        };
        const onUp = () => {
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onUp);
            renderEditorBoxes();
            render();
        };
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp, { once: true });
    }

    function discardStalePreviews(annotation) {
        delete annotation.polygon;
        delete annotation.previewDataUrl;
        delete annotation.transparentPreviewUrl;
    }

    function renderEditorPanels() {
        if (!editingResult) return;
        const issue = issueFor(editingResult);
        const message = root.querySelector('.rw-rule-message');
        message.classList.toggle('rw-error', Boolean(issue));
        message.textContent = issue || (editingResult.reviewCategory === 'normal'
            ? '符合规则：图片和包含标注行的 TXT 将保存到 normal。'
            : editingResult.reviewCategory === 'background'
                ? '符合规则：图片和 0 KB 空 TXT 将保存到 background。'
                : '该图片会单独保存到 manual_review，不会伪装成已确认数据。');
        root.querySelector('[data-rw-box-count]').textContent = `${editingResult.annotations.length} 个`;
        const list = root.querySelector('.rw-box-list');
        list.replaceChildren();
        if (!editingResult.annotations.length) {
            const empty = document.createElement('div');
            empty.className = 'rw-empty-boxes';
            empty.innerHTML = '当前没有标注框<br>可点击“添加标注框”手动补充';
            list.appendChild(empty);
        } else {
            editingResult.annotations.forEach((annotation, index) => {
                const row = document.createElement('div');
                row.className = `rw-box-row${index === selectedBoxIndex ? ' rw-selected' : ''}`;
                const number = document.createElement('span');
                number.className = 'rw-box-index';
                number.textContent = index + 1;
                const copy = document.createElement('span');
                copy.className = 'rw-box-copy';
                const label = document.createElement('b');
                label.textContent = annotation.label || '未命名类别';
                const coordinates = document.createElement('span');
                coordinates.textContent = Array.isArray(annotation.box_2d)
                    ? `y1 ${Number(annotation.box_2d[0]).toFixed(1)} · x1 ${Number(annotation.box_2d[1]).toFixed(1)} · y2 ${Number(annotation.box_2d[2]).toFixed(1)} · x2 ${Number(annotation.box_2d[3]).toFixed(1)}`
                    : '无效坐标';
                copy.append(label, coordinates);
                const remove = document.createElement('button');
                remove.type = 'button';
                remove.className = 'rw-delete-box';
                remove.setAttribute('aria-label', `删除第 ${index + 1} 个标注框`);
                remove.textContent = '×';
                remove.addEventListener('click', event => {
                    event.stopPropagation();
                    deleteBox(index);
                });
                row.append(number, copy, remove);
                row.addEventListener('click', () => {
                    selectedBoxIndex = index;
                    renderEditorBoxes();
                    renderEditorPanels();
                });
                list.appendChild(row);
            });
        }
        const text = yoloTextFor(editingResult);
        root.querySelector('.rw-txt-preview').textContent = text;
        root.querySelector('[data-rw-txt-size]').textContent = text ? `${textBytes(text)} B` : '0 KB';
    }

    function getDefaultLabel() {
        const manual = String(els?.classLabelInput?.value || '').trim().split(/\s+/).filter(Boolean);
        if (manual.length) return manual[0];
        const classes = getAllClasses().filter(Boolean);
        return classes[0] || 'object';
    }

    function addBox() {
        if (!editingResult) return;
        const label = getDefaultLabel();
        getClassId(label);
        editingResult.annotations.push({ label, box_2d: [410, 420, 590, 580], manual: true });
        editingResult.reviewCategory = editingResult.reviewCategory === 'background' ? 'review' : editingResult.reviewCategory;
        selectedBoxIndex = editingResult.annotations.length - 1;
        syncResultFlags(editingResult, '人工新增了标注框');
        renderEditor();
        render();
        showToast('已添加标注框，TXT 已同步更新');
    }

    function deleteBox(index) {
        if (!editingResult) return;
        editingResult.annotations.splice(index, 1);
        selectedBoxIndex = clamp(index - 1, 0, Math.max(0, editingResult.annotations.length - 1));
        syncResultFlags(editingResult, '人工删除了标注框');
        renderEditor();
        render();
        showToast('标注框已删除，TXT 已同步更新');
    }

    function navigateEditor(delta) {
        const all = currentResults();
        const index = all.indexOf(editingResult);
        if (index < 0 || !all.length) return;
        editingResult = all[(index + delta + all.length) % all.length];
        selectedBoxIndex = 0;
        renderEditor();
    }

    function syncMainPage(result) {
        const selected = state.files.findIndex(file => file === result.file || file.name === result.fileName);
        if (selected >= 0 && selected === state.currentFileIndex && typeof switchFile === 'function') {
            switchFile(selected);
        }
        const timeline = document.getElementById('timelineResults');
        const timelineContent = document.getElementById('timelineContent');
        if (timeline && timelineContent && typeof appendTimelineItem === 'function') {
            const wasHidden = timeline.classList.contains('hidden');
            timelineContent.innerHTML = '';
            currentResults().forEach((item, index) => appendTimelineItem(item.file, item.annotations || [], index, item));
            timeline.classList.toggle('hidden', wasHidden);
        }
    }

    function baseName(fileName) {
        const index = fileName.lastIndexOf('.');
        return index > 0 ? fileName.slice(0, index) : fileName;
    }

    async function addSourceFile(zip, path, result) {
        if (result.file instanceof Blob) {
            zip.file(path, result.file);
            return;
        }
        const url = resultUrl(result);
        const match = /^data:([^;,]+)?(?:;base64)?,(.*)$/s.exec(url);
        if (!match) throw new Error(`${fileNameFor(result)} 缺少可导出的原图数据`);
        const isBase64 = url.slice(0, url.indexOf(',')).includes(';base64');
        zip.file(path, match[2], isBase64 ? { base64: true } : {});
    }

    async function buildReviewedPackage() {
        const results = currentResults();
        const conflicts = results.filter(issueFor);
        if (conflicts.length) throw new Error(`还有 ${conflicts.length} 张图片存在规则冲突`);
        results.forEach(result => (result.annotations || []).forEach(annotation => getClassId(annotation.label)));
        const zip = new JSZip();
        const manifest = {
            formatVersion: 1,
            exportedAt: new Date().toISOString(),
            application: 'YOLO Auto-Tag',
            summary: Object.fromEntries(CATEGORY_KEYS.map(category => [category, results.filter(result => result.reviewCategory === category).length])),
            items: []
        };
        zip.file('classes.txt', getAllClasses().join('\n'));
        zip.file('README.txt', [
            'YOLO Auto-Tag 分类复核任务包',
            '',
            'normal：人工确认可用的正样本。',
            'background：人工或安全机制确认无目标；labels 中 TXT 为 0 KB。',
            'manual_review：仍需后续处理的数据，不应直接混入训练集。',
            '',
            '每个分类都按 images / labels 对应保存。'
        ].join('\n'));
        for (const result of results) {
            const category = result.reviewCategory;
            const folder = CATEGORY_META[category].folder;
            const name = fileNameFor(result).replace(/[\\/:*?"<>|]/g, '_');
            const labelName = `${baseName(name)}.txt`;
            const text = yoloTextFor(result);
            await addSourceFile(zip, `${folder}/images/${name}`, result);
            zip.file(`${folder}/labels/${labelName}`, text);
            manifest.items.push({
                fileName: name,
                category,
                folder,
                annotationCount: result.annotations.length,
                txtBytes: textBytes(text),
                verifiedEmpty: result.verifiedEmpty === true,
                needsReview: result.needsReview === true,
                manualReviewed: result.manualReviewed === true,
                validationStatus: result.validation?.status || null,
                validationReason: result.validation?.reason || null
            });
        }
        zip.file('review_manifest.json', JSON.stringify(manifest, null, 2));
        return { zip, manifest };
    }

    async function exportReviewedPackage() {
        const buttons = Array.from(root.querySelectorAll('[data-rw-action="export"]'));
        const conflicts = currentResults().filter(issueFor);
        if (conflicts.length) {
            showToast(`还有 ${conflicts.length} 张图片存在规则冲突，暂不能导出`, true);
            return;
        }
        buttons.forEach(button => button.disabled = true);
        const oldStatus = els?.statusMsg?.textContent || '';
        try {
            if (els?.statusMsg) els.statusMsg.textContent = '正在生成分类复核任务包…';
            const { zip, manifest } = await buildReviewedPackage();
            const blob = await zip.generateAsync({ type: 'blob' }, metadata => {
                if (els?.statusMsg) els.statusMsg.textContent = `正在生成分类复核任务包… ${Math.round(metadata.percent || 0)}%`;
            });
            if (demoMode) {
                window.ReviewWorkspace.lastDemoExport = {
                    size: blob.size,
                    files: Object.keys(zip.files).sort(),
                    manifest
                };
                root.dataset.demoExport = JSON.stringify(window.ReviewWorkspace.lastDemoExport);
                if (els?.statusMsg) els.statusMsg.textContent = '复核台演示包结构验证完成';
                showToast(`组合测试通过：已生成 ${manifest.items.length} 张图片的分类包结构`);
                return;
            }
            const fileName = `yolo_reviewed_dataset_${Date.now()}.zip`;
            const destination = typeof TaskManager !== 'undefined'
                ? await TaskManager.chooseTaskExportDestination(fileName)
                : { kind: 'download', fileName };
            if (!destination) {
                if (els?.statusMsg) els.statusMsg.textContent = '已取消导出分类复核任务包';
                return;
            }
            const saved = typeof TaskManager !== 'undefined'
                ? await TaskManager.saveTaskBlob(blob, destination, false)
                : await fallbackDownload(blob, destination);
            if (els?.statusMsg) els.statusMsg.textContent = saved.confirmed
                ? `分类复核任务包已保存：${saved.path}`
                : `分类复核任务包已提交下载：${saved.path}`;
            alert(saved.confirmed
                ? `分类复核任务包已保存到：\n${saved.path}`
                : `分类复核任务包已提交浏览器下载：\n${saved.path}`);
            showToast('分类复核任务包已生成');
        } catch (error) {
            console.error('Reviewed package export failed', error);
            if (els?.statusMsg) els.statusMsg.textContent = `分类复核任务包导出失败：${error.message}`;
            showToast(`导出失败：${error.message}`, true);
        } finally {
            buttons.forEach(button => button.disabled = currentResults().some(issueFor));
            if (!currentResults().length && els?.statusMsg) els.statusMsg.textContent = oldStatus;
        }
    }

    async function fallbackDownload(blob, destination) {
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = destination.fileName;
        anchor.click();
        setTimeout(() => URL.revokeObjectURL(url), 60000);
        return { confirmed: false, path: destination.fileName };
    }

    function showToast(message, isError = false) {
        const toast = root.querySelector('.rw-toast');
        clearTimeout(toastTimer);
        toast.textContent = message;
        toast.classList.toggle('rw-error', isError);
        toast.classList.add('rw-visible');
        toastTimer = setTimeout(() => toast.classList.remove('rw-visible'), 2800);
    }

    function open() {
        init();
        if (state?.isVideoMode) {
            alert('当前复核台先用于图片 YOLO 标注；视频帧复核将在后续版本单独设计。');
            return false;
        }
        if (!currentResults().length) {
            alert('暂无图片识别结果，请先完成图片分析。');
            return false;
        }
        prepareResults();
        root.classList.add('rw-open');
        root.setAttribute('aria-hidden', 'false');
        document.body.classList.add('rw-no-scroll');
        render();
        return true;
    }

    function close() {
        if (!root) return;
        if (editorBackdrop.classList.contains('rw-open')) closeEditor();
        root.classList.remove('rw-open');
        root.setAttribute('aria-hidden', 'true');
        document.body.classList.remove('rw-no-scroll');
    }

    function createDemoImage(index, annotations) {
        const circles = annotations.map(annotation => {
            const [y1, x1, y2, x2] = annotation.box_2d;
            const cx = (x1 + x2) / 2;
            const cy = (y1 + y2) / 2;
            const radius = Math.max(7, Math.min(x2 - x1, y2 - y1) * .28);
            return `<circle cx="${cx}" cy="${cy * .5625}" r="${radius}" fill="${index % 2 ? '#fb923c' : '#f8fafc'}" stroke="#172033" stroke-width="3"/>`;
        }).join('');
        const trees = Array.from({ length: 10 }, (_, treeIndex) => {
            const x = (treeIndex * 117 + index * 53) % 1000;
            const height = 45 + (treeIndex * 31 + index * 11) % 85;
            return `<path d="M${x} 320l30-${height}l30 ${height}z" fill="#245b3d"/>`;
        }).join('');
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 562.5"><defs><linearGradient id="s${index}" x2="0" y2="1"><stop stop-color="#619bd6"/><stop offset="1" stop-color="#a9d6ea"/></linearGradient><linearGradient id="g${index}"><stop stop-color="#235d32"/><stop offset="1" stop-color="#4b9439"/></linearGradient></defs><rect width="1000" height="562.5" fill="url(#s${index})"/><circle cx="${160 + index * 47 % 680}" cy="110" r="90" fill="#fff" opacity=".16"/><rect y="310" width="1000" height="252.5" fill="url(#g${index})"/>${trees}<path d="M0 440Q250 380 500 425t500-15M0 500Q260 445 520 485t480-20M500 310v252" fill="none" stroke="#f8fafc" stroke-width="4" opacity=".7"/><rect x="55" y="345" width="890" height="185" fill="none" stroke="#f8fafc" stroke-width="4" opacity=".65"/>${circles}</svg>`;
        return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    }

    function installDemoResults() {
        const specifications = [
            ['court_A_000184.jpg','normal',[[520,180,610,230],[410,650,480,690]]],
            ['court_A_000185.jpg','normal',[[470,215,550,258]]],
            ['court_B_000071.jpg','normal',[[570,720,640,758],[340,470,400,500],[620,145,710,197]]],
            ['field_C_001203.jpg','normal',[[535,550,635,610]]],
            ['field_C_001204.jpg','normal',[[400,430,470,466],[610,770,690,817]]],
            ['empty_D_000036.jpg','background',[]],
            ['empty_D_000037.jpg','background',[]],
            ['empty_E_000418.jpg','background',[]],
            ['review_F_000092.jpg','review',[[370,580,430,615]]],
            ['review_F_000093.jpg','review',[[600,290,710,355],[460,805,505,830]]],
            ['review_G_000007.jpg','review',[]],
            ['review_G_000008.jpg','review',[[520,115,585,150],[650,510,740,560],[260,830,310,855]]]
        ];
        state.unifiedClassMap.clear();
        state.nextClassId = 0;
        getClassId('small_ball');
        const results = specifications.map(([name, category, rawBoxes], index) => {
            const annotations = rawBoxes.map(box => ({ label: 'small_ball', box_2d: box }));
            const dataUrl = createDemoImage(index + 1, annotations);
            const file = new File([decodeURIComponent(dataUrl.split(',')[1])], name, { type: 'image/svg+xml' });
            return {
                fileName: name,
                file,
                dataUrl,
                annotations,
                reviewCategory: category,
                verifiedEmpty: category === 'background',
                needsReview: category === 'review',
                validation: {
                    status: category === 'background' ? 'verified_empty' : category === 'review' ? 'needs_review' : 'detected',
                    confidence: category === 'review' ? .58 : .96,
                    verifiedEmpty: category === 'background',
                    needsReview: category === 'review',
                    reason: '组合页面交互测试数据'
                }
            };
        });
        state.files = results.map(result => result.file);
        state.imageResults = results;
        state.isVideoMode = false;
        state.currentFileIndex = 0;
        state.file = state.files[0];
        if (typeof renderFileList === 'function') renderFileList();
        if (typeof switchFile === 'function') switchFile(0);
    }

    function init() {
        if (initialized) return;
        createRoot();
        bindEvents();
        initialized = true;
    }

    window.ReviewWorkspace = {
        init,
        open,
        close,
        render,
        buildReviewedPackage,
        lastDemoExport: null
    };

    const start = () => {
        init();
        if (demoMode) {
            installDemoResults();
            setTimeout(() => open({ reason: 'demo' }), 80);
        }
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
    else start();
}());
