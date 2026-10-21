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
        error: {
            label: '待处理', folder: 'error', symbol: '!',
            description: '识别失败或已有框待复核', rule: '原图和已有框均保留；查看卡片原因后确认'
        }
    };
    const CATEGORY_KEYS = Object.keys(CATEGORY_META);
    const FLIP_DURATION = 420;
    const MECHANICAL_CARD_CLASSES = [
        'rw-card-active',
        'rw-card-peek-before',
        'rw-card-peek-after',
        'rw-card-hidden-before',
        'rw-card-hidden-after',
        'rw-card-covered',
        'rw-card-exiting',
        'rw-exit-up',
        'rw-exit-down',
        'rw-exit-active',
        'rw-card-entering',
        'rw-enter-from-below',
        'rw-enter-from-above',
        'rw-enter-active'
    ];
    const objectUrls = new WeakMap();
    const deckIndices = { normal: 0, background: 0, error: 0 };
    const folderScrollTops = { normal: 0, background: 0, error: 0 };
    let viewMode = 'overview';
    try { if (localStorage.getItem('review-view') === 'single') viewMode = 'single'; } catch (_) {}
    const overlayRecords = new WeakMap();
    const overlayObserver = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(entries => {
        for (const entry of entries) {
            const record = overlayRecords.get(entry.target);
            if (record) fitOverlayToContainedImage(record.image, record.overlay, entry.target);
        }
    }) : null;
    const animatingDecks = new Set();

    let root = null;
    let editorBackdrop = null;
    let editorBoxLayer = null;
    let editorImage = null;
    let activeFilter = 'all';
    let searchTerm = '';
    let editor = null;
    let draggedReviewId = '';
    let toastTimer = null;
    let reviewIdCounter = 0;
    let initialized = false;
    let demoMode = window.YOLO_UI_PREVIEW === true
        || new URLSearchParams(location.search).get('reviewDemo') === '1';

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
        if (!Array.isArray(state?.imageResults)) state.imageResults = [];
        return state.imageResults;
    }

    function getResultId(result) {
        if (!result.reviewId) {
            reviewIdCounter += 1;
            result.reviewId = `review-${Date.now().toString(36)}-${reviewIdCounter}`;
        }
        return result.reviewId;
    }

    function defaultCategory(result) {
        return ReviewState.categoryFor(result);
    }

    function prepareResults() {
        const results = currentResults();
        const claimed = new Set();
        const files = Array.isArray(state?.files) ? state.files : [];

        files.forEach(file => {
            let result = results.find(item => !claimed.has(item) && item.file === file);
            if (!result) {
                result = results.find(item =>
                    !claimed.has(item) &&
                    String(item.fileName || item.file?.name || '') === String(file?.name || '')
                );
            }
            if (result) {
                claimed.add(result);
                if (!result.file) result.file = file;
                if (!result.fileName) result.fileName = file.name;
                return;
            }
            results.push({
                fileName: file?.name || '未命名图片',
                file,
                annotations: [],
                reviewCategory: 'error',
                processingError: '该图片没有生成识别结果，已自动保留到 error',
                verifiedEmpty: false,
                needsReview: true,
                validation: {
                    status: 'processing_error',
                    verifiedEmpty: false,
                    needsReview: true,
                    confidence: 0,
                    estimatedCount: 0,
                    reason: '识别结果缺失，原图已保留到 error'
                }
            });
        });

        results.forEach(result => {
            getResultId(result);
            result.annotations = Array.isArray(result.annotations) ? result.annotations : [];
            if ((result.processingError || result.needsReview) && result.manualReviewed && /^manual_(normal|background)$/.test(result.validation?.status || '') && ReviewState.categoryFor(result) !== 'error') {
                ReviewState.applyManualDecision(result, result.validation.reason || '已导入的人工确认', result.manualReviewedAt || Date.now());
            }
            result.reviewCategory = defaultCategory(result);
            const issue = issueFor(result);
            if (issue && result.reviewCategory !== 'error') {
                result.reviewCategory = 'error';
                result.verifiedEmpty = false;
                result.needsReview = true;
                result.validation = {
                    ...(result.validation || {}),
                    status: 'review_error',
                    verifiedEmpty: false,
                    needsReview: true,
                    reason: `${issue}；已自动保留到 error`
                };
            }
        });
    }

    function isValidBox(annotation) {
        return ReviewState.validBox(annotation);
    }

    function issueFor(result) {
        const boxes = Array.isArray(result.annotations) ? result.annotations : [];
        if (boxes.some(annotation => annotation.unclassified || !annotation.label)) return '存在未分类框，请先选择类别；原框会保留到待处理';
        if (boxes.some(annotation => !isValidBox(annotation))) return '存在无效标注框，请修改或删除';
        if (result.reviewCategory === 'normal' && boxes.length === 0) return '正常图至少需要 1 个标注框';
        if (result.reviewCategory === 'background' && boxes.length > 0) return '背景图必须删除全部标注框';
        return '';
    }

    function syncResultFlags(result, reason = 'manual-review') {
        const issue = issueFor(result);
        ReviewState.applyManualDecision(result, issue || reason);
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
                    <div class="rw-title">
                        <h1 id="rwTitle">任务台</h1><span class="rw-title-caption">标注复核</span>
                    </div>
                    <div class="rw-top-actions">
                        <button class="rw-button rw-button-ghost" data-rw-action="return-main" type="button">返回主页面</button>
                        <button class="rw-button rw-button-primary" data-rw-action="export" type="button"><svg viewBox="0 0 24 24"><path d="M12 3v12m0 0 4-4m-4 4-4-4M5 17v3h14v-3"/></svg><span>分类导出任务包</span></button>
                    </div>
                </header>
                <section class="rw-summary" aria-label="复核统计">
                    <div class="rw-summary-copy"><small>任务概览</small><strong data-rw-total>共 0 张图片</strong></div>
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
                        <button class="rw-segment" data-rw-filter="error" type="button" title="包括识别失败和已有框待复核">待处理</button>
                    </div>
                    <div class="rw-view-switch" role="group" aria-label="查看方式"><button data-rw-view="overview" type="button">纵览</button><button data-rw-view="single" type="button">单图</button></div>
                    <div class="rw-display-switch"><button type="button" data-annotation-toggle="labels" aria-pressed="true">名称</button><button type="button" data-annotation-toggle="annotations" aria-pressed="true">标注</button></div>
                    <label class="rw-search"><svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="m16 16 4 4"/></svg><input data-rw-search type="search" placeholder="搜索文件名…" autocomplete="off"></label>
                </section>
                <section class="rw-board">
                    ${CATEGORY_KEYS.map(category => createLaneMarkup(category)).join('')}
                </section>
                <footer class="rw-footer">
                    <div class="rw-folder-preview"><span class="rw-folder-icon">⌑</span><div><b>分类任务包结构</b><span>三类均包含 images/ 与同名 labels/*.txt</span></div></div>
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
        const stage = root.querySelector('.rw-editor-stage');
        overlayRecords.set(stage, {image:editorImage, overlay:editorBoxLayer});
        overlayObserver?.observe(stage);
        window.AnnotationDisplay?.refreshControls();
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
        return AnnotationEditor.markup(CATEGORY_KEYS.map(key => [key,CATEGORY_META[key].label]));
    }

    function bindEvents() {
        root.querySelectorAll('[data-rw-action="return-main"]').forEach(button => button.addEventListener('click', close));
        root.querySelectorAll('[data-rw-action="export"]').forEach(button => button.addEventListener('click', exportReviewedPackage));
        root.querySelectorAll('[data-rw-filter]').forEach(button => button.addEventListener('click', () => setFilter(button.dataset.rwFilter)));
        root.querySelectorAll('[data-rw-view]').forEach(button => button.addEventListener('click', () => {
            viewMode = button.dataset.rwView;
            try { localStorage.setItem('review-view', viewMode); } catch (_) {}
            render();
        }));
        root.querySelector('[data-rw-search]').addEventListener('input', event => {
            searchTerm = event.target.value.trim().toLowerCase();
            CATEGORY_KEYS.forEach(category => deckIndices[category] = 0);
            render();
        });
        CATEGORY_KEYS.forEach(category => {
            root.querySelector(`[data-rw-prev="${category}"]`).addEventListener('click', () => flipLane(category, -1));
            root.querySelector(`[data-rw-next="${category}"]`).addEventListener('click', () => flipLane(category, 1));
        });
        document.addEventListener('keydown', event => {
            if (event.key === 'Escape' && !editor.result && root?.classList.contains('rw-open')) close();
        });
        window.addEventListener('resize', () => {
            layoutEditorImage();
            root.querySelectorAll('.rw-card-preview').forEach(preview => fitOverlayToContainedImage(preview.querySelector('img'), preview.querySelector('.rw-card-box-layer'), preview));
        });
        const reopenButton = document.getElementById('reviewResultsBtn');
        if (reopenButton) reopenButton.addEventListener('click', () => {
            document.getElementById('fileMenu')?.classList.add('hidden');
            open({ reason: 'manual-open' });
        });
    }

    function setFilter(filter) {
        activeFilter = CATEGORY_META[filter] ? filter : 'all';
        root.querySelectorAll('[data-rw-filter]').forEach(button => button.classList.toggle('rw-active', button.dataset.rwFilter === activeFilter));
        render();
    }

    function render() {
        prepareResults();
        const results = currentResults();
        root.dataset.view = viewMode;
        root.querySelectorAll('[data-rw-view]').forEach(button => {
            button.classList.toggle('rw-active', button.dataset.rwView === viewMode);
            button.setAttribute('aria-pressed', String(button.dataset.rwView === viewMode));
        });
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
        const conflicts = results.filter(issueFor);
        const conflictCard = root.querySelector('.rw-conflicts');
        conflictCard.classList.toggle('rw-visible', conflicts.length > 0);
        root.querySelector('[data-rw-conflict-count]').textContent = conflicts.length;
        const footerStatus = root.querySelector('.rw-footer-status');
        const pending = results.filter(result => result.reviewCategory === 'error');
        const pendingWithBoxes = pending.filter(result => ReviewState.assessment(result).hasValidBoxes).length;
        footerStatus.classList.toggle('rw-error', conflicts.length > 0);
        footerStatus.querySelector('span').textContent = conflicts.length
            ? `${conflicts.length} 张图片存在规则问题，导出时会自动放入 error`
            : pending.length ? `${pending.length} 张待处理 · ${pendingWithBoxes} 张已有框可复核` : '分类规则校验通过，训练前仍需抽查';
        root.querySelectorAll('[data-rw-action="export"]').forEach(button => button.disabled = results.length === 0);
    }

    function applyMechanicalCardState(card, index, activeIndex) {
        card.classList.remove('rw-folder-card', ...MECHANICAL_CARD_CLASSES);
        if (index === activeIndex) {
            card.classList.add('rw-card-active');
            card.setAttribute('aria-hidden', 'false');
        } else if (index === activeIndex - 1) {
            card.classList.add('rw-card-peek-before');
            card.setAttribute('aria-hidden', 'true');
        } else if (index === activeIndex + 1) {
            card.classList.add('rw-card-peek-after');
            card.setAttribute('aria-hidden', 'true');
        } else {
            card.classList.add(index < activeIndex ? 'rw-card-hidden-before' : 'rw-card-hidden-after');
            card.setAttribute('aria-hidden', 'true');
        }
    }

    function updateLanePager(category, results, activeIndex, folderView) {
        root.querySelector(`[data-rw-page="${category}"]`).textContent = results.length
            ? `${activeIndex + 1} / ${results.length}`
            : '0 / 0';
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

    function settleMechanicalDeck(category, results, activeIndex, viewport) {
        deckIndices[category] = activeIndex;
        Array.from(viewport.querySelectorAll('.rw-result-card')).forEach((card, index) => {
            applyMechanicalCardState(card, index, activeIndex);
        });
        updateLanePager(category, results, activeIndex, false);
    }

    function renderLane(category) {
        const results = categoryResults(category);
        const folderView = viewMode === 'overview';
        deckIndices[category] = clamp(deckIndices[category], 0, Math.max(0, results.length - 1));
        const activeIndex = deckIndices[category];
        const viewport = root.querySelector(`[data-rw-deck="${category}"]`);
        viewport.dataset.renderRevision = String(Number(viewport.dataset.renderRevision || 0) + 1);
        animatingDecks.delete(category);
        if (viewport.classList.contains('rw-folder-grid')) {
            folderScrollTops[category] = viewport.scrollTop;
        }
        viewport.classList.toggle('rw-folder-grid', folderView);
        viewport.querySelectorAll('.rw-card-preview').forEach(preview => overlayObserver?.unobserve(preview));
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
                    applyMechanicalCardState(card, index, activeIndex);
                }
                viewport.appendChild(card);
            });
        }
        bindDeckViewport(viewport, category);
        viewport.closest('.rw-lane').classList.toggle('rw-overview-lane', folderView);
        if (folderView) {
            const wantedScrollTop = folderScrollTops[category] || 0;
            viewport.scrollTop = wantedScrollTop;
            requestAnimationFrame(() => {
                viewport.scrollTop = Math.min(
                    wantedScrollTop,
                    Math.max(0, viewport.scrollHeight - viewport.clientHeight)
                );
            });
        }
        updateLanePager(category, results, activeIndex, folderView);
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
            if (!ReviewState.validGeometry(annotation)) return;
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
        overlayRecords.set(preview, {image, overlay:boxLayer});
        overlayObserver?.observe(preview);
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
        const removeImage = document.createElement('button');
        removeImage.type = 'button';
        removeImage.className = 'rw-delete-image';
        removeImage.title = '从当前任务中删除这张图片';
        removeImage.setAttribute('aria-label', `删除图片 ${fileNameFor(result)}`);
        removeImage.textContent = '删除';
        removeImage.addEventListener('click', event => {
            event.stopPropagation();
            deleteResult(result);
        });
        nameRow.append(name, drag, removeImage);
        const meta = document.createElement('div');
        meta.className = 'rw-card-meta';
        const rawConfidence = result.validation?.confidence;
        const confidence = rawConfidence === null || rawConfidence === undefined ? NaN : Number(rawConfidence);
        const statusText = document.createElement('span');
        const assessment = ReviewState.assessment(result);
        statusText.textContent = result.reviewCategory === 'error' ? assessment.label
            : result.reviewCategory === 'background'
            ? '状态：确认无目标'
            : Number.isFinite(confidence) ? `复核置信度：${Math.round(confidence * 100)}%`
                : result.validation?.completenessChecked ? '状态：已逐类复核，训练前仍需抽查' : '状态：待人工抽查';
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
        const decision = document.createElement('div'); decision.className = 'rw-card-decision'; decision.append(select);
        if (assessment.requiresReview && assessment.hasValidBoxes) {
            const confirm = document.createElement('button'); confirm.type = 'button'; confirm.className = 'rw-confirm-existing';
            confirm.textContent = '确认现有框'; confirm.title = '人工确认现有框可用，移入正常图；保留原自动复核依据';
            confirm.addEventListener('click', () => moveResult(result, 'normal', true)); decision.append(confirm);
        }
        info.append(nameRow, meta);
        if (assessment.requiresReview) {
            const note = document.createElement('details'); note.className = 'rw-card-reason';
            const summary = document.createElement('summary'); summary.textContent = assessment.reason || '没有可确认的完整标注结果'; summary.title = '点击展开完整原因';
            const detail = document.createElement('p'); detail.textContent = assessment.reason || '请检查图片、目标框及处理记录。';
            note.append(summary, detail); info.append(note);
        }
        info.append(decision);
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

    function bindDeckViewport(viewport, category) {
        if (viewport.dataset.eventsBound) return;
        viewport.dataset.eventsBound = 'true';
        // One listener per persistent viewport; overview scrolling never flips cards.
        let lastFlip = 0;
        viewport.addEventListener('wheel', event => {
            if (viewMode !== 'single' || event.target.closest('select,input,textarea,details')) return;
            event.preventDefault();
            if (Math.abs(event.deltaY) < 7 || performance.now() - lastFlip < 220) return;
            lastFlip = performance.now(); flipLane(category, event.deltaY > 0 ? 1 : -1);
        }, { passive: false });
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
        if (viewMode !== 'single') return;
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
        const renderRevision = viewport.dataset.renderRevision;
        currentCard.classList.add(
            'rw-card-exiting',
            delta > 0 ? 'rw-exit-up' : 'rw-exit-down'
        );
        targetCard.classList.remove(
            'rw-card-peek-before',
            'rw-card-peek-after',
            'rw-card-hidden-before',
            'rw-card-hidden-after'
        );
        targetCard.classList.add('rw-card-entering', delta > 0 ? 'rw-enter-from-below' : 'rw-enter-from-above');
        targetCard.setAttribute('aria-hidden', 'false');
        // 先提交新旧卡的共同起点，再在同一帧启动两条 transform 过渡。
        // 这样不会出现新页先跳、旧页延迟约 300ms 才移动的割裂感。
        void viewport.offsetHeight;
        requestAnimationFrame(() => {
            currentCard.classList.add('rw-exit-active');
            targetCard.classList.add('rw-enter-active');
        });
        let settled = false;
        let fallbackTimer = null;
        const settle = () => {
            if (settled) return;
            settled = true;
            if (fallbackTimer) clearTimeout(fallbackTimer);
            targetCard.removeEventListener('transitionend', onTransitionEnd);
            if (viewMode === 'single' && viewport.dataset.renderRevision === renderRevision) {
                settleMechanicalDeck(category, results, targetIndex, viewport);
                animatingDecks.delete(category);
            }
        };
        const onTransitionEnd = event => {
            if (event.target === targetCard && event.propertyName === 'transform') settle();
        };
        targetCard.addEventListener('transitionend', onTransitionEnd);
        fallbackTimer = setTimeout(settle, FLIP_DURATION + 90);
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
        const fromCategory = result.reviewCategory;
        const from = CATEGORY_META[fromCategory]?.label || '原分类';
        const fromResults = categoryResults(fromCategory);
        const fromIndex = Math.max(0, fromResults.indexOf(result));
        result.reviewCategory = category;
        syncResultFlags(result, `人工把图片从“${from}”移动到“${CATEGORY_META[category].label}”`);
        const issue = issueFor(result);
        let finalCategory = category;
        if (issue && category !== 'error') {
            finalCategory = 'error';
            result.reviewCategory = 'error';
            syncResultFlags(result, `${issue}；已自动保留到 error`);
        }
        const remainingSourceCount = currentResults().filter(item => item.reviewCategory === fromCategory).length;
        deckIndices[fromCategory] = clamp(fromIndex, 0, Math.max(0, remainingSourceCount - 1));
        if (activeFilter === finalCategory || activeFilter === 'all') {
            const destinationResults = currentResults().filter(item => item.reviewCategory === finalCategory);
            deckIndices[finalCategory] = Math.max(0, destinationResults.indexOf(result));
        }
        render();
        if (editor.result === result) renderEditor();
        if (notify) {
            showToast(finalCategory === category
                ? `已把 ${fileNameFor(result)} 移到“${CATEGORY_META[category].label}”`
                : `${fileNameFor(result)} 不符合“${CATEGORY_META[category].label}”规则，已放入 error`);
        }
    }

    function deleteResult(result) {
        const fileName = fileNameFor(result);
        if (!demoMode && !confirm(`确定从当前任务中删除“${fileName}”吗？\n\n删除后它不会进入任务包；此操作不删除电脑上的原始文件。`)) return;

        const resultIndex = currentResults().indexOf(result);
        if (resultIndex >= 0) currentResults().splice(resultIndex, 1);

        let fileIndex = state.files.findIndex(file => file === result.file);
        if (fileIndex < 0) fileIndex = state.files.findIndex(file => file.name === fileName);
        if (fileIndex >= 0) state.files.splice(fileIndex, 1);

        const objectUrl = objectUrls.get(result);
        if (objectUrl) URL.revokeObjectURL(objectUrl);

        if (editor.result === result) editor.close();
        editor.undoStack = []; editor.redoStack = [];

        if (typeof renderFileList === 'function') renderFileList();
        if (state.files.length && typeof switchFile === 'function') {
            const nextIndex = clamp(fileIndex >= 0 ? fileIndex : state.currentFileIndex, 0, state.files.length - 1);
            switchFile(nextIndex);
        } else if (!state.files.length) {
            state.currentFileIndex = 0;
            state.file = null;
            state.img = null;
            state.annotations = [];
            try {
                els.imageCanvas.getContext('2d').clearRect(0, 0, els.imageCanvas.width, els.imageCanvas.height);
                els.overlayCanvas.getContext('2d').clearRect(0, 0, els.overlayCanvas.width, els.overlayCanvas.height);
            } catch (_) {}
        }

        CATEGORY_KEYS.forEach(category => {
            const count = currentResults().filter(item => item.reviewCategory === category).length;
            deckIndices[category] = clamp(deckIndices[category], 0, Math.max(0, count - 1));
        });
        render();
        showToast(`已从任务中删除 ${fileName}`);
    }

    function openEditor(result) { editor.open(result); }
    function closeEditor() { editor.close(); }
    function renderEditor() { editor.render(); }
    function renderEditorPanels() { editor.renderPanels(); }
    function layoutEditorImage() { editor.layout(); }

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
        prepareResults();
        const results = currentResults();
        results.forEach(result => {
            const boxes = Array.isArray(result.annotations) ? result.annotations : [];
            const validNormal =
                result.reviewCategory === 'normal' &&
                !result.needsReview &&
                boxes.length > 0 &&
                boxes.every(isValidBox);
            const validBackground =
                result.reviewCategory === 'background' &&
                result.verifiedEmpty === true &&
                boxes.length === 0;
            if (!validNormal && !validBackground) {
                result.reviewCategory = 'error';
                result.verifiedEmpty = false;
                result.needsReview = true;
            }
        });
        results.forEach(result => (result.annotations || [])
            .filter(isValidBox)
            .forEach(annotation => getClassId(annotation.label.trim())));
        const zip = new JSZip();
        for (const category of CATEGORY_KEYS) {
            const folder = CATEGORY_META[category].folder;
            zip.folder(`${folder}/images`);
            zip.folder(`${folder}/labels`);
        }
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
            'error：识别失败、结果缺失、未确认空结果或规则异常的数据；原图和当前 TXT 都会保留。',
            '',
            '每个分类都按 images / labels 对应保存。'
        ].join('\n'));
        for (const result of results) {
            const category = result.reviewCategory;
            const folder = CATEGORY_META[category].folder;
            const name = fileNameFor(result).replace(/[\\/:*?"<>|]/g, '_');
            const labelName = `${baseName(name)}.txt`;
            const text = yoloTextFor(result);
            const validAnnotationCount = (result.annotations || []).filter(isValidBox).length;
            await addSourceFile(zip, `${folder}/images/${name}`, result);
            zip.file(`${folder}/labels/${labelName}`, text);
            manifest.items.push({
                fileName: name,
                category,
                folder,
                imagePath: `${folder}/images/${name}`,
                labelPath: `${folder}/labels/${labelName}`,
                annotationCount: validAnnotationCount,
                rawAnnotationCount: result.annotations.length,
                annotations: clone(result.annotations),
                txtBytes: textBytes(text),
                verifiedEmpty: result.verifiedEmpty === true,
                needsReview: result.needsReview === true,
                manualReviewed: result.manualReviewed === true,
                processingError: result.processingError || null,
                validationStatus: result.validation?.status || null,
                validationReason: result.validation?.reason || null,
                modelsUsed: result.validation?.modelsUsed || [],
                providersUsed: result.validation?.providersUsed || [],
                automaticAssessment: result.automaticAssessment || null,
                reviewHistory: result.reviewHistory || [],
                numberRecognition: result.numberRecognition || { status: 'disabled', numbers: [], sequence: null },
                jsonRetries: result.validation?.jsonRetries || 0
            });
        }
        zip.file('review_manifest.json', JSON.stringify(manifest, null, 2));
        return { zip, manifest };
    }

    async function exportReviewedPackage() {
        const buttons = Array.from(root.querySelectorAll('[data-rw-action="export"]'));
        prepareResults();
        if (!currentResults().length) return showToast('当前任务没有可导出的图片', true);
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
                window.showExportCompletion?.({
                    title: '导出流程验证完成',
                    message: `已验证 ${manifest.items.length} 张图片的 normal / background / error 分类包结构。`,
                    note: '这是 UI 预览模式，没有写入磁盘，也不会发送 API 请求。'
                });
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
            window.showExportCompletion?.({
                title: saved.confirmed ? '分类数据集导出完成' : '分类数据集已提交下载',
                message: saved.confirmed
                    ? `已保存 ${manifest.items.length} 张图片及对应 YOLO TXT。`
                    : `已生成 ${manifest.items.length} 张图片及对应 YOLO TXT，请在浏览器下载列表中确认完成。`,
                path: saved.path,
                confirmed: saved.confirmed,
                note: `normal ${manifest.summary.normal} 张 · background ${manifest.summary.background} 张 · error ${manifest.summary.error} 张；error 原图未丢弃。`
            });
            showToast(saved.confirmed ? '分类数据集已保存' : '分类数据集已提交下载');
        } catch (error) {
            console.error('Reviewed package export failed', error);
            if (els?.statusMsg) els.statusMsg.textContent = `分类复核任务包导出失败：${error.message}`;
            showToast(`导出失败：${error.message}`, true);
        } finally {
            buttons.forEach(button => button.disabled = currentResults().length === 0);
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
        if (state?.isProcessing) { alert('识别正在进行，结束后可在任务台人工复核。'); return false; }
        if (state?.isVideoMode) {
            alert('当前复核台先用于图片 YOLO 标注；视频帧复核将在后续版本单独设计。');
            return false;
        }
        prepareResults();
        if (!currentResults().length) {
            alert('当前任务没有可复核的图片。');
            return false;
        }
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
            ['error_F_000092.jpg','error',[[370,580,430,615]]],
            ['error_F_000093.jpg','error',[[600,290,710,355],[460,805,505,830]]],
            ['error_G_000007.jpg','error',[]],
            ['error_G_000008.jpg','error',[[520,115,585,150],[650,510,740,560],[260,830,310,855]]]
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
                needsReview: category === 'error',
                validation: {
                    status: category === 'background' ? 'verified_empty' : category === 'error' ? 'needs_review' : 'detected',
                    confidence: category === 'error' ? .58 : .96,
                    verifiedEmpty: category === 'background',
                    needsReview: category === 'error',
                    reason: '组合页面交互测试数据'
                }
            };
        });
        const missingResultName = 'missing_H_000001.jpg';
        const missingResultDataUrl = createDemoImage(specifications.length + 1, []);
        const missingResultFile = new File(
            [decodeURIComponent(missingResultDataUrl.split(',')[1])],
            missingResultName,
            { type: 'image/svg+xml' }
        );
        state.files = [...results.map(result => result.file), missingResultFile];
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
        editor = new AnnotationEditor.Editor({root, results:currentResults, notify:showToast, syncFlags:syncResultFlags,
            changed:syncMainPage, renderBoard:render, url:resultUrl, fit:fitOverlayToContainedImage, issue:issueFor, text:yoloTextFor});
        bindEvents();
        initialized = true;
    }

    window.ReviewWorkspace = {
        init,
        open,
        close,
        render,
        buildReviewedPackage,
        exportReviewedPackage,
        editCurrent() {
            if (!open({reason:'manual-annotation'})) return;
            const result = currentResults().find(item => item.file === state.file || item.fileName === state.file?.name);
            if (result) openEditor(result);
        },
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
