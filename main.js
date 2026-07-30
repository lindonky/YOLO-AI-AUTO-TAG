/**
 * 完整优化后的 main.js
 */
const $ = id => document.getElementById(id);

// UI 元素
const els = {
    modeToggle: $('modeToggle'), modeLabel: $('modeLabel'),
    fileInput: $('fileInput'), classesInput: $('classesInput'), promptInput: $('promptInput'), classLabelInput: $('classLabelInput'), modelSelect: $('modelSelect'),
    videoOptions: $('videoOptions'), manualFrame: $('manualFrame'), frameRateDiv: $('frameRateDiv'),
    imageOptions: $('imageOptions'), // 新增
    startBtn: $('startBtn'), downloadBtn: $('downloadBtn'),
    scaleFactor: $('scaleFactor'), parallelCountGlobal: $('parallelCountGlobal'), apiRpm: $('apiRpm'),
    teachingModeBtn: $('teachingModeBtn'), saveTeachingExampleBtn: $('saveTeachingExampleBtn'),
    undoTeachingBoxBtn: $('undoTeachingBoxBtn'), clearTeachingExamplesBtn: $('clearTeachingExamplesBtn'),
    teachingStatus: $('teachingStatus'), teachingHint: $('teachingHint'),
    quickTeachingBtn: $('quickTeachingBtn'), quickTeachingText: $('quickTeachingText'), quickTeachingCount: $('quickTeachingCount'),
    teachingFloatingToolbar: $('teachingFloatingToolbar'), teachingFloatingStatus: $('teachingFloatingStatus'),
    saveTeachingFloatingBtn: $('saveTeachingFloatingBtn'), undoTeachingFloatingBtn: $('undoTeachingFloatingBtn'), exitTeachingFloatingBtn: $('exitTeachingFloatingBtn'),
    extractTransparent: $('extractTransparent'),
    exportAllTransparentBtn: $('exportAllTransparentBtn'), exportAllCropBtn: $('exportAllCropBtn'), exportAllTaggedVideosBtn: $('exportAllTaggedVideosBtn'),
    exportBatchImageLabelsBtn: $('exportBatchImageLabelsBtn'), exportBatchVideoFramesBtn: $('exportBatchVideoFramesBtn'),
    imageCanvas: $('imageCanvas'),
    videoPlayer: $('videoPlayer'), overlayCanvas: $('overlayCanvas'),
    statusMsg: $('statusMsg'), loader: $('loader'), btnText: $('btnText'),
    apiInfo: $('apiInfo'), // 新增引用
    timelineResults: $('timelineResults'), timelineContent: $('timelineContent'), cropPreview: $('cropPreview'), cropGallery: $('cropGallery'),
    progress: { box: $('progressContainer'), fill: $('progressFill'), text: $('progressText'), pct: $('progressPct') },
    exportCanvas: document.createElement('canvas'), // 隐藏的离屏Canvas用于处理导出
    get fileList() { return $('fileList'); },
    get fileCount() { return $('fileCount'); },
    fileMenu: $('fileMenu'), settingsMenu: $('settingsMenu'), // 新增
    get videoControls() { return $('videoControls'); },
    get videoPlayBtn() { return $('videoPlayBtn'); },
    get videoSeek() { return $('videoSeek'); },
    get videoTime() { return $('videoTime'); },
};
// Expose els to global scope for TaskManager
window.els = els;

// --- Panel Manager (Z-Index) ---
const PanelManager = {
    baseZIndex: 50,
    // taskMenu 已合并入设置菜单，fileMenu/settingsMenu 由 dropdown 逻辑管理，此处仅管理浮动侧边栏
    panels: ['cropPreview', 'timelineResults'],

    init() {
        this.panels.forEach(id => {
            const el = $(id);
            if (!el) return;
            el.style.zIndex = 30;
            el.addEventListener('mousedown', () => this.bringToFront(el));
        });

        // 互斥逻辑：剪裁预览 vs 时间轴
        this.setupToggle('cropPreviewBtn', 'cropPreview', 'timelineResults');
        this.setupToggle('timelineResultsBtn', 'timelineResults', 'cropPreview');
    },

    setupToggle(btnId, panelId, otherPanelId) {
        const btn = $(btnId);
        const panel = $(panelId);
        const other = $(otherPanelId);

        if (btn && panel) {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const willShow = panel.classList.contains('hidden');

                if (willShow) {
                    panel.classList.remove('hidden');
                    this.bringToFront(panel);
                    // 互斥：关闭另一个
                    if (other && !other.classList.contains('hidden')) {
                        other.classList.add('hidden');
                    }
                } else {
                    panel.classList.add('hidden');
                }
            });
        }
    },

    bringToFront(el) {
        this.baseZIndex++;
        el.style.zIndex = this.baseZIndex;
    }
};
// --- Theme Manager ---
const ThemeManager = {
    init() {
        const btn = $('themeToggleBtn');
        const sun = $('themeIconSun');
        const moon = $('themeIconMoon');
        if (!btn || !sun || !moon) return;

        const isDark = localStorage.getItem('theme') === 'dark';
        if (isDark) {
            document.documentElement.classList.add('dark');
            sun.classList.remove('hidden');
            moon.classList.add('hidden');
        } else {
            document.documentElement.classList.remove('dark');
            sun.classList.add('hidden');
            moon.classList.remove('hidden');
        }

        btn.onclick = () => {
            document.documentElement.classList.toggle('dark');
            const isDarkMode = document.documentElement.classList.contains('dark');
            localStorage.setItem('theme', isDarkMode ? 'dark' : 'light');
            
            if (isDarkMode) {
                sun.classList.remove('hidden');
                moon.classList.add('hidden');
            } else {
                sun.classList.add('hidden');
                moon.classList.remove('hidden');
            }
        };
    }
};

// 通用下拉菜单切换函数
window.toggleDropdown = function(id) {
    const el = document.getElementById(id);
    if (!el) return;

    // 打开前先关闭其他所有弹出的菜单，避免重叠
    const allMenus = ['fileMenu', 'settingsMenu'];
    allMenus.forEach(menuId => {
        if (menuId !== id) {
            const other = document.getElementById(menuId);
            if (other) other.classList.add('hidden');
        }
    });

    el.classList.toggle('hidden');
};

// 兼容旧调用
window.toggleExportMenu = () => window.toggleDropdown('fileMenu');

// 点击其他地方关闭所有下拉菜单
document.addEventListener('click', function(e) {
    const dropdowns = [
        ['fileBtn', 'fileMenu'],
        ['settingsBtn', 'settingsMenu']
    ];

    dropdowns.forEach(([btnId, menuId]) => {
        const btn = document.getElementById(btnId);
        const menu = document.getElementById(menuId);

        if (menu && !menu.classList.contains('hidden')) {
            // 如果点击的既不是按钮，也不是菜单内部，则关闭
            if (btn && !btn.contains(e.target) && !menu.contains(e.target)) {
                menu.classList.add('hidden');
            }
        }
    });
});
// 状态变量
let state = {
    isVideoMode: false,
    file: null,
    files: [],
    img: null, // 图片模式下的原始图
    annotations: [], // 存储解析结果
    isProcessing: false,
    imageResults: [],
    videoResults: [],
    unifiedClassMap: new Map(), // label -> id
    nextClassId: 0,
    customClassesLoaded: false,
    apiHistory: [], // 记录API请求时间戳
    imageRect: null,
    videoRect: null,
    videoScrubbing: false,
    videoFrameCbHandle: null,
    videoFramesCache: new Map(), // key: filename, value: { frames, fps }
    videoAnalysisReady: false,   // true 表示抽帧完成，按钮变成"开始分析"
    currentFileIndex: -1,
    viewRequestId: 0,
    teachingMode: false,
    teachingDragStart: null,
    teachingDraftBox: null,
    teachingDraftBoxes: [],
    teachingDraftDirty: false,
    teachingExamples: []
};

// Expose state to global scope for TaskManager
window.state = state;

function formatTime(sec) {
    if (!Number.isFinite(sec) || sec < 0) return '0:00';
    const s = Math.floor(sec);
    const m = Math.floor(s / 60);
    const r = s % 60;
    return `${m}:${String(r).padStart(2, '0')}`;
}

function syncVideoControls() {
    const seek = els.videoSeek;
    const timeEl = els.videoTime;
    const btn = els.videoPlayBtn;
    if (!seek || !timeEl || !btn) return;
    const dur = els.videoPlayer.duration;
    if (Number.isFinite(dur) && dur > 0) {
        seek.max = String(dur);
    }
    if (!state.videoScrubbing) {
        seek.value = String(els.videoPlayer.currentTime || 0);
    }
    timeEl.textContent = `${formatTime(els.videoPlayer.currentTime || 0)} / ${formatTime(dur || 0)}`;
    btn.textContent = els.videoPlayer.paused ? '播放' : '暂停';
}

function drawVideoFrame() {
    if (!state.isVideoMode) return;
    if (els.videoPlayer.readyState < 2) return;
    ensureViewCanvasesSize();
    const rect = computeContainRect(els.videoPlayer.videoWidth, els.videoPlayer.videoHeight, els.imageCanvas.width, els.imageCanvas.height);
    state.videoRect = rect;
    const ctx = els.imageCanvas.getContext('2d');
    ctx.clearRect(0, 0, els.imageCanvas.width, els.imageCanvas.height);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, els.imageCanvas.width, els.imageCanvas.height);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(els.videoPlayer, rect.x, rect.y, rect.w, rect.h);
}

// --- 初始化 ---
function initModelSelect() {
    els.modelSelect.innerHTML = '';
    Object.keys(CONFIGS).forEach(key => {
        const option = document.createElement('option');
        option.value = key;
        // 显示 config.js 中的键名，或者可以优化显示格式
        option.textContent = `${key} (${CONFIGS[key].model})`;
        els.modelSelect.appendChild(option);
    });
    if (CONFIGS['gemini-3.6-flash']) {
        els.modelSelect.value = 'gemini-3.6-flash';
    }
}

ThemeManager.init();
PanelManager.init();
initModelSelect();
els.modeToggle.addEventListener('change', toggleMode);
els.fileInput.addEventListener('change', handleFileSelect);
els.classesInput.addEventListener('change', handleClassesSelect);
els.startBtn.addEventListener('click', startAnalysis);
if (els.teachingModeBtn) els.teachingModeBtn.addEventListener('click', () => setTeachingMode(!state.teachingMode));
if (els.saveTeachingExampleBtn) els.saveTeachingExampleBtn.addEventListener('click', () => saveTeachingExample(true));
if (els.undoTeachingBoxBtn) els.undoTeachingBoxBtn.addEventListener('click', undoTeachingBox);
if (els.clearTeachingExamplesBtn) els.clearTeachingExamplesBtn.addEventListener('click', clearTeachingExamples);
if (els.quickTeachingBtn) els.quickTeachingBtn.addEventListener('click', () => setTeachingMode(!state.teachingMode));
if (els.saveTeachingFloatingBtn) els.saveTeachingFloatingBtn.addEventListener('click', () => saveTeachingExample(true));
if (els.undoTeachingFloatingBtn) els.undoTeachingFloatingBtn.addEventListener('click', undoTeachingBox);
if (els.exitTeachingFloatingBtn) els.exitTeachingFloatingBtn.addEventListener('click', () => setTeachingMode(false));
els.overlayCanvas.addEventListener('pointerdown', handleTeachingPointerDown);
els.overlayCanvas.addEventListener('pointermove', handleTeachingPointerMove);
els.overlayCanvas.addEventListener('pointerup', handleTeachingPointerUp);
els.overlayCanvas.addEventListener('pointercancel', cancelTeachingDrag);
updateTeachingStatus();
if (els.exportAllTransparentBtn) els.exportAllTransparentBtn.addEventListener('click', exportAllTransparentImages);
if (els.exportBatchImageLabelsBtn) els.exportBatchImageLabelsBtn.addEventListener('click', exportBatchImageLabels);
if (els.exportBatchVideoFramesBtn) els.exportBatchVideoFramesBtn.addEventListener('click', exportBatchVideoFrames);
if (els.exportAllCropBtn) els.exportAllCropBtn.addEventListener('click', exportAllCroppedImages);
if (els.exportAllTaggedVideosBtn) els.exportAllTaggedVideosBtn.addEventListener('click', exportAllTaggedVideos);
els.videoPlayer.addEventListener('play', () => { syncVideoControls(); requestAnimationFrame(videoLoop); });
els.videoPlayer.addEventListener('pause', syncVideoControls);
els.videoPlayer.addEventListener('loadedmetadata', () => { updateVideoLayout(); syncVideoControls(); drawVideoFrame(); drawVideoOverlay(); });
els.videoPlayer.addEventListener('timeupdate', syncVideoControls);
els.videoPlayer.addEventListener('seeked', () => { drawVideoFrame(); drawVideoOverlay(); syncVideoControls(); });
if (els.videoPlayBtn) {
    els.videoPlayBtn.addEventListener('click', async () => {
        if (els.videoPlayer.paused) {
            await els.videoPlayer.play();
        } else {
            els.videoPlayer.pause();
        }
        syncVideoControls();
    });
}
if (els.videoSeek) {
    els.videoSeek.addEventListener('input', () => {
        state.videoScrubbing = true;
        const t = parseFloat(els.videoSeek.value || '0') || 0;
        els.videoPlayer.currentTime = t;
        drawVideoFrame();
        drawVideoOverlay();
        syncVideoControls();
    });
    els.videoSeek.addEventListener('change', () => {
        state.videoScrubbing = false;
        syncVideoControls();
    });
}
window.addEventListener('resize', () => {
    if (state.isVideoMode) {
        updateVideoLayout();
        drawVideoFrame();
        drawVideoOverlay();
    } else {
        updateImageLayout();
        renderAllAnnotations();
    }
});
// 初始化时执行一次模式切换逻辑，确保按钮状态正确
toggleMode();

els.manualFrame.addEventListener('change', () => {
    if (els.manualFrame.checked) {
        els.frameRateDiv.classList.remove('hidden');
    } else {
        els.frameRateDiv.classList.add('hidden');
    }
});

function toggleMode() {
    state.isVideoMode = els.modeToggle.checked;
    if (state.isVideoMode && state.teachingMode) setTeachingMode(false);
    if (els.quickTeachingBtn) els.quickTeachingBtn.classList.toggle('hidden', state.isVideoMode);
    els.modeLabel.textContent = state.isVideoMode ? '当前: 视频模式' : '当前: 图片模式';
    els.fileInput.accept = state.isVideoMode ? 'video/*' : 'image/*';
    els.videoOptions.classList.toggle('hidden', !state.isVideoMode);

    // Switch Export Options Visibility
    const optImg = document.getElementById('exportOptionsImage');
    const optVid = document.getElementById('exportOptionsVideo');
    if (optImg) optImg.classList.toggle('hidden', state.isVideoMode);
    if (optVid) optVid.classList.toggle('hidden', !state.isVideoMode);

    els.imageCanvas.classList.remove('hidden');
    els.overlayCanvas.classList.remove('hidden');
    els.timelineResults.classList.add('hidden');
    if (els.videoControls) els.videoControls.classList.toggle('hidden', !state.isVideoMode);

    // UI 显隐控制
    if (state.isVideoMode) {        els.imageOptions.classList.add('hidden');
        els.exportAllTransparentBtn.classList.add('hidden');
        els.exportAllCropBtn.classList.add('hidden');
        els.exportBatchImageLabelsBtn.classList.add('hidden');
        
        els.exportAllTaggedVideosBtn.classList.remove('hidden');
        els.exportBatchVideoFramesBtn.classList.remove('hidden');
        
        els.manualFrame.dispatchEvent(new Event('change'));

        // [New Logic] 重置视频抽帧状态
        state.videoAnalysisReady = false;
        els.btnText.textContent = "开始抽帧";
    } else {
        els.imageOptions.classList.remove('hidden');
        els.exportAllTransparentBtn.classList.remove('hidden');
        els.exportAllCropBtn.classList.remove('hidden');
        els.exportBatchImageLabelsBtn.classList.remove('hidden');
        
        els.exportAllTaggedVideosBtn.classList.add('hidden');
        els.exportBatchVideoFramesBtn.classList.add('hidden');
        
        els.btnText.textContent = "开始分析";
    }

    state.annotations = [];
    state.files = [];
    state.imageResults = [];
    state.videoResults = [];
    state.videoFramesCache.clear(); // 清空缓存
    renderFileList(); 
    els.statusMsg.textContent = '模式已切换';

    if (!state.isVideoMode) {
        try { els.videoPlayer.pause(); } catch {}
        els.videoPlayer.removeAttribute('src');
        els.videoPlayer.load();
        state.videoRect = null;
        state.videoFrameCbHandle = null;
        updateImageLayout();
        renderAllAnnotations();
    } else {
        state.img = null;
        state.imageRect = null;
        updateVideoLayout();
        drawVideoFrame();
        drawVideoOverlay();
        syncVideoControls();
    }
}


function handleFileSelect(e) {
    const selected = Array.from(e.target.files || []);
    if (selected.length === 0) return;
    state.files = selected;
    state.currentFileIndex = 0;
    renderFileList();
    switchFile(0);
}

function getViewSize() {
    const container = $('viewContainer');
    if (!container) return { w: 960, h: 540 };
    const w = Math.max(1, Math.floor(container.clientWidth || container.getBoundingClientRect().width));
    const h = Math.max(1, Math.floor(container.clientHeight || container.getBoundingClientRect().height));
    return { w, h };
}

function computeContainRect(srcW, srcH, dstW, dstH) {
    const sw = Math.max(1, srcW || 1);
    const sh = Math.max(1, srcH || 1);
    const scale = Math.min(dstW / sw, dstH / sh);
    const w = sw * scale;
    const h = sh * scale;
    const x = (dstW - w) / 2;
    const y = (dstH - h) / 2;
    return { x, y, w, h, scale };
}

function ensureViewCanvasesSize() {
    const { w, h } = getViewSize();
    if (els.imageCanvas.width !== w) els.imageCanvas.width = w;
    if (els.imageCanvas.height !== h) els.imageCanvas.height = h;
    if (els.overlayCanvas.width !== w) els.overlayCanvas.width = w;
    if (els.overlayCanvas.height !== h) els.overlayCanvas.height = h;
}

function updateImageLayout() {
    ensureViewCanvasesSize();
    if (!state.img) return;
    const { w, h } = getViewSize();
    state.imageRect = computeContainRect(state.img.width, state.img.height, w, h);
    resetImageDisplay();
}

function updateVideoLayout() {
    ensureViewCanvasesSize();
    const vw = els.videoPlayer.videoWidth;
    const vh = els.videoPlayer.videoHeight;
    if (!vw || !vh) return;
    const { w, h } = getViewSize();
    state.videoRect = computeContainRect(vw, vh, w, h);
    els.videoPlayer.style.width = '100%';
    els.videoPlayer.style.height = '100%';
    els.videoPlayer.style.objectFit = 'contain';
}

function renderFileList() {
    const list = els.fileList;
    if (!list) return;

    list.innerHTML = '';
    if (els.fileCount) els.fileCount.textContent = state.files.length;
    
    if (state.files.length === 0) {
        list.innerHTML = '<div class="text-center text-gray-400 text-xs mt-10">暂无文件</div>';
        return;
    }

    state.files.forEach((file, index) => {
        const div = document.createElement('div');
        div.className = `file-item p-2 text-xs text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 cursor-pointer rounded flex items-center gap-2 transition-colors ${index === state.currentFileIndex ? 'active font-medium' : ''}`;
        div.onclick = () => switchFile(index);
        
        // Icon
        const icon = state.isVideoMode ? 
            `<svg class="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z"></path></svg>` :
            `<svg class="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v14a2 2 0 002 2z"></path></svg>`;
            
        div.innerHTML = `
            ${icon}
            <span class="truncate flex-1">${file.name}</span>
        `;
        list.appendChild(div);
    });
}

function switchFile(index) {
    if (index < 0 || index >= state.files.length) return;

    const selectedFile = state.files[index];
    if (
        !state.isVideoMode &&
        state.teachingDraftDirty &&
        state.file &&
        state.file !== selectedFile
    ) {
        saveTeachingExample(false);
    }
    const viewRequestId = ++state.viewRequestId;

    state.currentFileIndex = index;
    state.file = selectedFile;
    state.annotations = [];
    loadTeachingDraftForFile(selectedFile);

    // 切换时立即清掉上一张图的框；异步加载完成后只允许最新请求重绘。
    const overlayContext = els.overlayCanvas.getContext('2d');
    overlayContext.clearRect(0, 0, els.overlayCanvas.width, els.overlayCanvas.height);
    
    // Update UI active state
    const list = els.fileList;
    if (list) {
        const items = list.querySelectorAll('.file-item');
        items.forEach((item, i) => {
            if (i === index) {
                item.classList.add('active', 'font-medium');
            } else {
                item.classList.remove('active', 'font-medium');
            }
        });
    }

    if (state.isVideoMode) {
        els.videoPlayer.src = URL.createObjectURL(selectedFile);
        els.videoPlayer.pause();
        els.videoPlayer.onloadedmetadata = () => {
            if (viewRequestId !== state.viewRequestId || state.file !== selectedFile) return;
            updateVideoLayout();
            els.videoPlayer.currentTime = 0;
            syncVideoControls();
            requestAnimationFrame(() => {
                drawVideoFrame();
                drawVideoOverlay();
            });
            const octx = els.overlayCanvas.getContext('2d');
            octx.clearRect(0, 0, els.overlayCanvas.width, els.overlayCanvas.height);
        };
        // Clear image canvas
        const ctx = els.imageCanvas.getContext('2d');
        ctx.clearRect(0, 0, els.imageCanvas.width, els.imageCanvas.height);
        // Also clear overlays
        const octx = els.overlayCanvas.getContext('2d');
        octx.clearRect(0,0,els.overlayCanvas.width,els.overlayCanvas.height);
        
        // If we have results for this video, maybe show them?
        // But video results are frame-based, hard to show on load.
    } else {
        const reader = new FileReader();
        reader.onload = ev => {
            if (viewRequestId !== state.viewRequestId || state.file !== selectedFile) return;
            const img = new Image();
            img.onload = () => {
                if (viewRequestId !== state.viewRequestId || state.file !== selectedFile) return;
                state.img = img;
                updateImageLayout();
                const octx = els.overlayCanvas.getContext('2d');
                octx.clearRect(0,0,els.overlayCanvas.width,els.overlayCanvas.height);
                
                // If we have results for this image, restore them
                // Note: The original restoreAndGoTo logic used imageResults index.
                // Here we match by file name or just use current index if consistent.
                const result = state.imageResults.find(r =>
                    r.file === selectedFile || r.fileName === selectedFile.name
                );
                if (result) {
                    state.annotations = JSON.parse(JSON.stringify(result.annotations));
                    state.annotations.forEach(ann => drawStyledAnnotation(octx, ann, els.overlayCanvas.width, els.overlayCanvas.height, state.imageRect));
                } else {
                    state.annotations = [];
                }
                drawTeachingBoxes(octx);
                updateTeachingStatus();
            };
            img.src = ev.target.result;
        };
        reader.readAsDataURL(selectedFile);
    }
}

function readImageFile(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();

        reader.onerror = () => reject(new Error(`无法读取图片：${file.name}`));
        reader.onload = event => {
            const dataUrl = event.target.result;
            const img = new Image();

            img.onerror = () => reject(new Error(`无法解码图片：${file.name}`));
            img.onload = () => resolve({ img, dataUrl });
            img.src = dataUrl;
        };

        reader.readAsDataURL(file);
    });
}

function createAnalysisCanvas(sourceImage) {
    const canvas = document.createElement('canvas');
    const sourceWidth = sourceImage.naturalWidth || sourceImage.width;
    const sourceHeight = sourceImage.naturalHeight || sourceImage.height;
    const maxAnalysisSide = 1600;
    const scale = Math.min(
        1,
        maxAnalysisSide / Math.max(sourceWidth, sourceHeight)
    );

    // API 输入必须保持原图宽高比且不带界面黑边。
    // 这样模型返回的 0-1000 坐标可以直接用于原图裁剪和预览绘制。
    canvas.width = Math.max(1, Math.round(sourceWidth * scale));
    canvas.height = Math.max(1, Math.round(sourceHeight * scale));

    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(sourceImage, 0, 0, canvas.width, canvas.height);

    return canvas;
}

function buildTeachingMessages(currentContent) {
    const examples = (state.teachingExamples || [])
        .filter(example => example?.dataUrl && Array.isArray(example.boxes) && example.boxes.length > 0)
        .sort((a, b) => (a.updatedAt || 0) - (b.updatedAt || 0))
        .slice(-3);
    const messages = [];

    examples.forEach((example, index) => {
        const cleanBoxes = example.boxes.map(box => ({
            label: box.label,
            box_2d: box.box_2d
        }));
        messages.push({
            role: 'user',
            content: [
                {
                    type: 'text',
                    text:
                        `人工示例 ${index + 1}：请学习这张图中目标的定义、数量，` +
                        '以及矩形框紧贴目标外轮廓的标注风格。'
                },
                {
                    type: 'image_url',
                    image_url: { url: example.dataUrl }
                }
            ]
        });
        messages.push({
            role: 'assistant',
            content: JSON.stringify(cleanBoxes)
        });
    });

    messages.push({ role: 'user', content: currentContent });
    return messages;
}

function showAnnotationsForFile(file, annotations) {
    const selectedFile = state.files[state.currentFileIndex] || state.file;
    const isSelectedFile = selectedFile && (
        selectedFile === file || selectedFile.name === file.name
    );

    if (
        state.isVideoMode ||
        !isSelectedFile ||
        !state.file ||
        state.file.name !== selectedFile.name
    ) {
        return;
    }

    state.annotations = JSON.parse(JSON.stringify(annotations));

    const octx = els.overlayCanvas.getContext('2d');
    octx.clearRect(0, 0, els.overlayCanvas.width, els.overlayCanvas.height);
    state.annotations.forEach(ann =>
        drawStyledAnnotation(
            octx,
            ann,
            els.overlayCanvas.width,
            els.overlayCanvas.height,
            state.imageRect
        )
    );
}

function handleClassesSelect(e) {
    const file = e.target.files[0];
    if (!file) return;
    
    const reader = new FileReader();
    reader.onload = ev => {
        const content = ev.target.result;
        const lines = content.split(/\r?\n/).map(l => l.trim()).filter(l => l);
        state.unifiedClassMap.clear();
        state.nextClassId = 0;
        
lines.forEach((label) => {
    if (!state.unifiedClassMap.has(label)) {
        state.unifiedClassMap.set(label, state.nextClassId++);
    }
});
els.classLabelInput.value = lines.join(' ');
state.customClassesLoaded = true;
els.statusMsg.textContent = `已加载 ${state.unifiedClassMap.size} 个自定义类别`;    };
    reader.readAsText(file);
}

function getClassId(label) {
    if (!state.unifiedClassMap.has(label)) {
        state.unifiedClassMap.set(label, state.nextClassId++);
    }
    return state.unifiedClassMap.get(label);
}

function getAllClasses() {
    const arr = new Array(state.unifiedClassMap.size);
    for (const [label, id] of state.unifiedClassMap.entries()) {
        arr[id] = label;
    }
    return arr;
}

// 还原/重绘背景图
function resetImageDisplay() {
    if (!state.img) return;
    const ctx = els.imageCanvas.getContext('2d');
    const { width: w, height: h } = els.imageCanvas;
    ctx.clearRect(0, 0, w, h);
    const rect = state.imageRect || computeContainRect(state.img.width, state.img.height, w, h);
    state.imageRect = rect;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(state.img, rect.x, rect.y, rect.w, rect.h);
}

// --- 核心分析逻辑 ---

async function startAnalysis() {
    const hasFiles = (state.files && state.files.length > 0) || !!state.file;
    if (!hasFiles) return alert('请先上传文件');

    if (!state.isVideoMode) {
        if (state.teachingDraftDirty) saveTeachingExample(false);
        setTeachingMode(false);
    }
    
    // [New Logic] 视频模式分两步走
    if (state.isVideoMode) {
        if (!state.videoAnalysisReady) {
            // 第一步：抽帧
            await batchExtractFrames();
            return;
        }
        // 第二步：分析 (继续向下执行 processVideosBatch)
    }

    // 桌面版在开始批量任务前只做一次轻量连接检查。这样中转站账号耗尽、
    // Key 失效或模型不可用时，不会把同一个错误重复发送给每一张图片。
    if (window.AppConfigManager?.testConnection) {
        els.statusMsg.textContent = '正在检查 API、模型和中转站可用性…';
        try {
            await window.AppConfigManager.testConnection();
        } catch (error) {
            const message = String(error?.message || error || '连接测试失败');
            if (!state.isVideoMode) {
                const files = state.files && state.files.length ? state.files : (state.file ? [state.file] : []);
                files.forEach(file => recordImageProcessingError(file, `API 预检失败，未执行识别：${message}`));
            }
            els.statusMsg.textContent = `无法开始分析：${message}`;
            alert(
                `无法开始分析\n\n${message}\n\n` +
                `请在“API 设置”中测试配置，或稍后重试。\n` +
                `当前导入图片已保留到复核台的 error 分类，可连同同名 TXT 一起导出。`
            );
            window.AppConfigManager.open?.();
            return;
        }
    }

    const config = CONFIGS[els.modelSelect.value];
    setLoading(true);
    els.progress.box.classList.remove('hidden');

    try {
        if (state.isVideoMode) {
            await processVideosBatch(config);
        } else {
            const batchSummary = await processImagesBatch(config);
            if (batchSummary?.failed > 0) {
                const firstError = batchSummary.errors?.[0]?.message || '未知错误';
                alert(
                    `本次识别成功 ${batchSummary.succeeded} 张，失败 ${batchSummary.failed} 张。\n\n` +
                    `首个错误：${firstError}\n\n` +
                    `失败图片已保留到 error；每张图片仍会导出同名 TXT，修复配置后也可再次分析。`
                );
            }
            if ((state.files?.length || 0) > 0 && window.ReviewWorkspace?.open) {
                window.ReviewWorkspace.open({ reason: 'analysis-complete' });
            }
        }
    } catch (err) {
        els.statusMsg.textContent = `错误: ${err.message}`;
    } finally {
        setLoading(false);
        if(!state.isVideoMode) els.progress.box.classList.add('hidden');
    }
}

// [必须新增] 请将此函数添加在 startAnalysis 下方
async function batchExtractFrames() {
    if (!state.files || state.files.length === 0) return;
    
    // UI 设置为抽帧中
    state.isProcessing = true;
    els.startBtn.disabled = true; // 变灰
    els.startBtn.classList.remove('bg-indigo-600', 'hover:bg-indigo-700');
    els.startBtn.classList.add('bg-gray-400', 'cursor-not-allowed');
    els.progress.box.classList.remove('hidden');
    
    let completed = 0;
    const total = state.files.length;
    
    const fpsInput = $('frameRate');
    let targetFps = fpsInput ? parseFloat(fpsInput.value || '1') : 1;
    
    for (let i = 0; i < total; i++) {
        const file = state.files[i];
        
        let frames = [];
        let currentFps = targetFps;
        
        // 检查是否有历史记录（修复导入任务FPS丢失）
        const existingResult = state.videoResults.find(r => r.fileName === file.name);
        if (existingResult && existingResult.fps) {
            currentFps = existingResult.fps;
            if(fpsInput) fpsInput.value = currentFps; // 同步UI
        }

        updateProgress(Math.round(((completed) / total) * 100), `正在抽帧 (${i+1}/${total}): ${file.name}`);
        
        const video = document.createElement('video');
        video.src = URL.createObjectURL(file);
        await new Promise(r => video.onloadedmetadata = r);
        frames = await extractFrames(video, currentFps);
        URL.revokeObjectURL(video.src);
        video.remove();
        
        // 存入缓存
        state.videoFramesCache.set(file.name, { frames, fps: currentFps });
        completed++;
    }
    
    updateProgress(100, '所有视频抽帧完成，请开始分析');
    
    // UI 恢复与变身
    state.isProcessing = false;
    state.videoAnalysisReady = true;
    
    els.startBtn.disabled = false;
    els.startBtn.classList.remove('bg-gray-400', 'cursor-not-allowed');
    els.startBtn.classList.add('bg-indigo-600', 'hover:bg-indigo-700');
    els.btnText.textContent = "开始分析"; // 变身
}


async function analyzeImage(config) {
    const base64 = els.imageCanvas.toDataURL('image/jpeg', 0.8).split(',')[1];
    const prompt = els.promptInput.value.trim() || '物体';
    const classLabel = els.classLabelInput.value.trim() || prompt; // 优先使用类别名
    
    const systemPrompt = `任务：识别目标并返回JSON列表。
任务描述：${prompt}
每个对象包含：{"label":"${classLabel}", "polygon":[[y,x],...], "box_2d":[ymin,xmin,ymax,xmax]} 
坐标均为0-1000归一化。`;

    return await callAPI(config, [

        { role: "user", content: [
            { type: "text", text: systemPrompt },
            { type: "image_url", image_url: { url: `data:image/jpeg;base64,${base64}` } }
        ]}
    ]);
}

// --- 绘图逻辑：框选与半透明填色 ---

function renderAllAnnotations() {
    if (state.isVideoMode) return;
    resetImageDisplay();
    const ctx = els.overlayCanvas.getContext('2d');
    ctx.clearRect(0,0,els.overlayCanvas.width,els.overlayCanvas.height);
    state.annotations.forEach(ann => drawStyledAnnotation(ctx, ann, els.overlayCanvas.width, els.overlayCanvas.height, state.imageRect));
    drawTeachingBoxes(ctx);
}

function drawStyledAnnotation(ctx, ann, w, h, rect) {
    const contentRect = rect || { x: 0, y: 0, w, h, scale: 1 };
    const hash = ann.label.split('').reduce((a, b) => a + b.charCodeAt(0), 0);
    const color = `hsl(${hash % 360}, 70%, 50%)`;

    ctx.lineWidth = 3;
    ctx.strokeStyle = color;
    ctx.fillStyle = color + '80';

    if (ann.polygon && ann.polygon.length > 2) {
        ctx.beginPath();
        ann.polygon.forEach((pt, i) => {
            const y = contentRect.y + (pt[0] / 1000) * contentRect.h;
            const x = contentRect.x + (pt[1] / 1000) * contentRect.w;
            if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        });
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
    } else if (ann.box_2d) {
        const [ymin, xmin, ymax, xmax] = ann.box_2d;
        const rx = contentRect.x + (xmin/1000)*contentRect.w;
        const ry = contentRect.y + (ymin/1000)*contentRect.h;
        const rw = ((xmax-xmin)/1000)*contentRect.w;
        const rh = ((ymax-ymin)/1000)*contentRect.h;
        ctx.strokeRect(rx, ry, rw, rh);
    }
    
    // 绘制标签背景
    if (!ann.box_2d) return;
    ctx.fillStyle = color;
    const labelX = contentRect.x + (ann.box_2d[1]/1000)*contentRect.w;
    const labelY = contentRect.y + (ann.box_2d[0]/1000)*contentRect.h - 25;
    ctx.fillRect(labelX, labelY, ann.label.length * 10 + 20, 25);
    ctx.fillStyle = "#fff";
    ctx.fillText(ann.label, labelX + 5, labelY + 18);
}

function getTeachingLabel() {
    const manual = (els.classLabelInput.value || '').trim().split(/\s+/).filter(Boolean);
    if (manual.length > 0) return manual[0];
    const knownClasses = getAllClasses().filter(Boolean);
    return knownClasses[0] || 'target';
}

function getTeachingCanvasPoint(event) {
    const bounds = els.overlayCanvas.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return null;
    return {
        x: (event.clientX - bounds.left) * (els.overlayCanvas.width / bounds.width),
        y: (event.clientY - bounds.top) * (els.overlayCanvas.height / bounds.height)
    };
}

function clampTeachingPoint(point) {
    const rect = state.imageRect;
    if (!point || !rect) return null;
    return {
        x: Math.max(rect.x, Math.min(rect.x + rect.w, point.x)),
        y: Math.max(rect.y, Math.min(rect.y + rect.h, point.y))
    };
}

function teachingBoxFromPoints(start, end) {
    const rect = state.imageRect;
    if (!start || !end || !rect || !rect.w || !rect.h) return null;

    const xminPx = Math.min(start.x, end.x);
    const xmaxPx = Math.max(start.x, end.x);
    const yminPx = Math.min(start.y, end.y);
    const ymaxPx = Math.max(start.y, end.y);
    if (xmaxPx - xminPx < 5 || ymaxPx - yminPx < 5) return null;

    const clamp1000 = value => Math.max(0, Math.min(1000, Math.round(value)));
    return {
        label: getTeachingLabel(),
        box_2d: [
            clamp1000(((yminPx - rect.y) / rect.h) * 1000),
            clamp1000(((xminPx - rect.x) / rect.w) * 1000),
            clamp1000(((ymaxPx - rect.y) / rect.h) * 1000),
            clamp1000(((xmaxPx - rect.x) / rect.w) * 1000)
        ]
    };
}

function drawTeachingBoxes(ctx) {
    if (!state.teachingMode || !state.imageRect) return;
    const boxes = [...state.teachingDraftBoxes];
    if (state.teachingDraftBox) boxes.push(state.teachingDraftBox);
    if (boxes.length === 0) return;

    const rect = state.imageRect;
    ctx.save();
    ctx.setLineDash([8, 5]);
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#22c55e';
    ctx.fillStyle = 'rgba(34, 197, 94, 0.14)';
    ctx.font = 'bold 12px sans-serif';

    boxes.forEach((box, index) => {
        const [ymin, xmin, ymax, xmax] = box.box_2d;
        const x = rect.x + (xmin / 1000) * rect.w;
        const y = rect.y + (ymin / 1000) * rect.h;
        const w = ((xmax - xmin) / 1000) * rect.w;
        const h = ((ymax - ymin) / 1000) * rect.h;
        ctx.fillRect(x, y, w, h);
        ctx.strokeRect(x, y, w, h);

        const text = `示例 ${index + 1}: ${box.label}`;
        const textWidth = ctx.measureText(text).width + 12;
        const textY = y >= 22 ? y - 20 : y;
        ctx.setLineDash([]);
        ctx.fillStyle = '#16a34a';
        ctx.fillRect(x, textY, textWidth, 20);
        ctx.fillStyle = '#fff';
        ctx.fillText(text, x + 6, textY + 14);
        ctx.setLineDash([8, 5]);
        ctx.fillStyle = 'rgba(34, 197, 94, 0.14)';
    });
    ctx.restore();
}

function updateTeachingStatus() {
    const examples = Array.isArray(state.teachingExamples) ? state.teachingExamples : [];
    const savedBoxes = examples.reduce((sum, example) => sum + (example.boxes?.length || 0), 0);
    const draftBoxes = state.teachingDraftBoxes?.length || 0;

    if (els.teachingStatus) {
        els.teachingStatus.textContent =
            `已保存 ${examples.length} 张 / ${savedBoxes} 框 · 当前编辑 ${draftBoxes} 框`;
    }
    if (els.teachingFloatingStatus) {
        els.teachingFloatingStatus.textContent =
            `已保存 ${examples.length} 张 / ${savedBoxes} 框 · 当前图片 ${draftBoxes} 框${state.file?.name ? ` · ${state.file.name}` : ''}`;
    }
    if (els.quickTeachingCount) {
        els.quickTeachingCount.textContent = String(examples.length);
        els.quickTeachingCount.title = `已保存 ${examples.length} 张教学图片，共 ${savedBoxes} 个框`;
    }
    if (els.quickTeachingText) {
        els.quickTeachingText.textContent = state.teachingMode ? '正在框选' : '示例教学';
    }
    if (els.quickTeachingBtn) {
        els.quickTeachingBtn.classList.toggle('bg-green-500', !state.teachingMode);
        els.quickTeachingBtn.classList.toggle('hover:bg-green-600', !state.teachingMode);
        els.quickTeachingBtn.classList.toggle('bg-yellow-500', state.teachingMode);
        els.quickTeachingBtn.classList.toggle('hover:bg-yellow-600', state.teachingMode);
    }
    if (els.teachingFloatingToolbar) {
        els.teachingFloatingToolbar.classList.toggle('hidden', !state.teachingMode);
        els.teachingFloatingToolbar.classList.toggle('flex', state.teachingMode);
    }
    if (els.teachingHint) {
        els.teachingHint.textContent = state.teachingMode
            ? `正在框选 ${state.file?.name || ''}；绿色虚线框只作为教学示例。`
            : examples.length > 0
                ? `识别时将参考最近 ${Math.min(3, examples.length)} 张人工示例。`
                : '先选图片，再开始框选；拖动鼠标画出贴合目标的框。';
    }
    if (els.teachingModeBtn) {
        els.teachingModeBtn.textContent = state.teachingMode ? '退出框选模式' : '开始框选示例';
        els.teachingModeBtn.classList.toggle('bg-indigo-600', !state.teachingMode);
        els.teachingModeBtn.classList.toggle('hover:bg-indigo-700', !state.teachingMode);
        els.teachingModeBtn.classList.toggle('bg-yellow-500', state.teachingMode);
        els.teachingModeBtn.classList.toggle('hover:bg-yellow-600', state.teachingMode);
    }
    if (els.saveTeachingExampleBtn) {
        els.saveTeachingExampleBtn.disabled = !state.file || draftBoxes === 0;
    }
    if (els.saveTeachingFloatingBtn) {
        els.saveTeachingFloatingBtn.disabled = !state.file || draftBoxes === 0;
    }
    if (els.undoTeachingBoxBtn) {
        els.undoTeachingBoxBtn.disabled = draftBoxes === 0;
    }
    if (els.undoTeachingFloatingBtn) {
        els.undoTeachingFloatingBtn.disabled = draftBoxes === 0;
    }
    if (els.clearTeachingExamplesBtn) {
        els.clearTeachingExamplesBtn.disabled = examples.length === 0 && draftBoxes === 0;
    }
}

function loadTeachingDraftForFile(file) {
    const example = (state.teachingExamples || []).find(item => item.fileName === file?.name);
    state.teachingDraftBoxes = example
        ? JSON.parse(JSON.stringify(example.boxes || []))
        : [];
    state.teachingDraftBox = null;
    state.teachingDragStart = null;
    state.teachingDraftDirty = false;
    updateTeachingStatus();
}

function setTeachingMode(enabled) {
    if (enabled && (state.isVideoMode || !state.file || !state.img)) {
        alert('请先在图片模式中选择并加载一张图片');
        return;
    }

    state.teachingMode = !!enabled;
    state.teachingDragStart = null;
    state.teachingDraftBox = null;
    if (state.teachingMode) {
        document.getElementById('settingsMenu')?.classList.add('hidden');
        document.getElementById('fileMenu')?.classList.add('hidden');
    }
    els.overlayCanvas.style.pointerEvents = state.teachingMode ? 'auto' : 'none';
    els.overlayCanvas.style.cursor = state.teachingMode ? 'crosshair' : 'default';
    updateTeachingStatus();
    renderAllAnnotations();
}

function handleTeachingPointerDown(event) {
    if (!state.teachingMode || state.isVideoMode || !state.imageRect) return;
    const point = clampTeachingPoint(getTeachingCanvasPoint(event));
    if (!point) return;
    event.preventDefault();
    state.teachingDragStart = point;
    state.teachingDraftBox = null;
    if (els.overlayCanvas.setPointerCapture) {
        els.overlayCanvas.setPointerCapture(event.pointerId);
    }
}

function handleTeachingPointerMove(event) {
    if (!state.teachingMode || !state.teachingDragStart) return;
    const point = clampTeachingPoint(getTeachingCanvasPoint(event));
    state.teachingDraftBox = teachingBoxFromPoints(state.teachingDragStart, point);
    renderAllAnnotations();
}

function handleTeachingPointerUp(event) {
    if (!state.teachingMode || !state.teachingDragStart) return;
    const point = clampTeachingPoint(getTeachingCanvasPoint(event));
    const box = teachingBoxFromPoints(state.teachingDragStart, point);
    state.teachingDragStart = null;
    state.teachingDraftBox = null;
    if (box) {
        state.teachingDraftBoxes.push(box);
        state.teachingDraftDirty = true;
    }
    if (els.overlayCanvas.releasePointerCapture && els.overlayCanvas.hasPointerCapture?.(event.pointerId)) {
        els.overlayCanvas.releasePointerCapture(event.pointerId);
    }
    updateTeachingStatus();
    renderAllAnnotations();
}

function cancelTeachingDrag() {
    state.teachingDragStart = null;
    state.teachingDraftBox = null;
    renderAllAnnotations();
}

function undoTeachingBox() {
    if (state.teachingDraftBoxes.length === 0) return;
    state.teachingDraftBoxes.pop();
    state.teachingDraftDirty = true;
    updateTeachingStatus();
    renderAllAnnotations();
}

function saveTeachingExample(notify = true) {
    if (!state.file || !state.img || state.teachingDraftBoxes.length === 0) {
        if (notify) alert('请先在当前图片上至少框选一个目标');
        return false;
    }

    const canvas = createAnalysisCanvas(state.img);
    const example = {
        fileName: state.file.name,
        boxes: JSON.parse(JSON.stringify(state.teachingDraftBoxes)),
        dataUrl: canvas.toDataURL('image/jpeg', 0.9),
        updatedAt: Date.now()
    };
    const existingIndex = state.teachingExamples.findIndex(item => item.fileName === example.fileName);
    if (existingIndex >= 0) {
        state.teachingExamples[existingIndex] = example;
    } else {
        state.teachingExamples.push(example);
    }
    state.teachingDraftDirty = false;
    updateTeachingStatus();
    if (notify) {
        els.statusMsg.textContent = `已保存教学示例：${example.fileName}（${example.boxes.length} 个框）`;
    }
    return true;
}

function clearTeachingExamples() {
    if (!confirm('确定清空所有人工教学示例和当前编辑框吗？')) return;
    state.teachingExamples = [];
    state.teachingDraftBoxes = [];
    state.teachingDraftBox = null;
    state.teachingDraftDirty = false;
    updateTeachingStatus();
    renderAllAnnotations();
}

// --- 导出逻辑：时间轴与结果列表 ---

function appendTimelineItem(file, annotations, fileIndex, resultMeta = null) {
    els.timelineResults.classList.remove('hidden');
    const fileName = file.name;
    
    // 创建文件头
    const header = document.createElement('div');
    header.className = 'p-2 bg-gray-100 font-bold text-gray-700 text-xs border-b sticky top-0';
    const validationNote = resultMeta?.needsReview
        ? ' · ⚠ 空结果待人工复核'
        : resultMeta?.verifiedEmpty
            ? ' · 已复核无目标'
            : String(resultMeta?.validation?.status || '').startsWith('recovered')
                ? ' · 空结果复核后已找回'
                : '';
    header.innerText = `文件: ${fileName} (${annotations.length} 个目标)${validationNote}`;
    if (resultMeta?.needsReview) {
        header.style.color = '#b45309';
        header.title = resultMeta.validation?.reason || '模型未能确认这是无目标图片';
    }
    els.timelineContent.appendChild(header);

    const fragment = document.createDocumentFragment();
    annotations.forEach((ann, i) => {
        const div = document.createElement('div');
        div.className = 'flex items-center justify-between p-3 border-b border-gray-100 hover:bg-gray-50 transition';
        div.innerHTML = `
            <div class="cursor-pointer" onclick="restoreAndGoTo(${fileIndex}, ${i})">
                <span class="text-indigo-600 font-bold">${state.isVideoMode ? ann.time.toFixed(2)+'s' : '#'+(i+1)}</span>
                <span class="ml-2 font-medium">${ann.label}</span>
            </div>
            <div class="flex gap-2">
                ${ann.previewDataUrl ? `<img src="${ann.previewDataUrl}" alt="预览" class="w-16 h-16 object-cover rounded border" />` : ''}
                ${ann.transparentPreviewUrl ? `<img src="${ann.transparentPreviewUrl}" alt="透明预览" class="w-16 h-16 object-contain rounded border" />` : ''}
            </div>
        `;
        fragment.appendChild(div);
    });
    els.timelineContent.appendChild(fragment);
}

// 替换原来的 renderTimeline
function renderTimeline(data) {
    // 此函数保留用于单文件模式或视频模式的内部刷新，但在多文件批处理中应使用 appendTimelineItem
    // 为了兼容，如果调用此函数，我们假设是当前 state.file
    if (!state.file) return;
    // 清空内容? 不，我们现在的逻辑是累加。
    // 如果是视频分析过程中的实时更新，可能需要清空？
    // 视频分析是逐步的，我们暂时保持视频分析的原有逻辑（它目前是全量更新 state.annotations）
    if (state.isVideoMode) {
        els.timelineResults.classList.remove('hidden');
        els.timelineContent.innerHTML = data.map((ann, index) => `
        <div class="flex items-center justify-between p-3 border-b border-gray-100 hover:bg-gray-50 transition">
            <div class="cursor-pointer" onclick="goToAnnotation(${index})">
                <span class="text-indigo-600 font-bold">${ann.time.toFixed(2)+'s'}</span>
                <span class="ml-2 font-medium">${ann.label}</span>
            </div>
             <div class="flex gap-2">
                ${ann.previewDataUrl ? `<img src="${ann.previewDataUrl}" alt="预览" class="w-16 h-16 object-cover rounded border" />` : ''}
            </div>
        </div>
        `).join('');
    }
}

// 新增恢复视图函数
window.restoreAndGoTo = function(fileIndex, annIndex) {
    const item = state.imageResults[fileIndex];
    if (!item) return;

    const sourceIndex = state.files.findIndex(file =>
        file === item.file || file.name === item.fileName
    );

    if (sourceIndex >= 0) {
        // 统一通过 switchFile 切图，让文件高亮、当前索引、图片和标注保持一致。
        switchFile(sourceIndex);
    }
};

function appendCropGallery(annotations) {
    const items = annotations.filter(a => a.previewDataUrl);
    if (items.length === 0) return;
    
    els.cropPreview.classList.remove('hidden');
    // 强制竖向排版：grid 默认是流式布局，只要容器宽度受限就会自动换行。
    // 如果用户感觉到横向滑动，可能是容器没有 wrap 或者 overflow-x 设置问题。
    // 我们确保容器是 flex-wrap 或者 grid
    
    const fragment = document.createDocumentFragment();
    items.forEach((a, i) => {
        const div = document.createElement('div');
        div.className = 'border rounded overflow-hidden bg-white shadow-sm flex flex-col';
        div.innerHTML = `
            <img src="${a.previewDataUrl}" class="w-full h-32 object-contain bg-gray-50" />
            <div class="p-2 text-xs text-gray-600 flex justify-between">
                <span>${a.label}</span>
                <span>box</span>
            </div>
        `;
        fragment.appendChild(div);
    });
    els.cropGallery.appendChild(fragment);
}

/**
 * 核心导出函数
 * @param {number} index 数据索引 
 * @param {string} mode 'transparent'(透明背景) 或 'crop'(原始截图)
 */
async function exportResult(index, mode) {
    const ann = state.annotations[index];
    let source;
    
    // 如果是视频，先跳转到对应时间并抓取当前视频帧
    if (state.isVideoMode) {
        els.videoPlayer.currentTime = ann.time;
        await new Promise(r => {
            const handler = () => r();
            els.videoPlayer.addEventListener('seeked', handler, { once: true });
        });
        source = els.videoPlayer;
    } else {
        source = state.img;
    }

    const sw = source.videoWidth || source.width;
    const sh = source.videoHeight || source.height;

    // 获取边界矩形
    const [ymin, xmin, ymax, xmax] = ann.box_2d;
    const rx = (xmin/1000)*sw, ry = (ymin/1000)*sh, rw = ((xmax-xmin)/1000)*sw, rh = ((ymax-ymin)/1000)*sh;

    const canvas = els.exportCanvas;
    canvas.width = rw;
    canvas.height = rh;
    const ctx = canvas.getContext('2d');

    if (mode === 'transparent') {
        // 透明抠图逻辑
        ctx.clearRect(0,0,rw,rh);
        if (ann.polygon) {
            ctx.beginPath();
            ann.polygon.forEach((pt, i) => {
                const px = (pt[1] / 1000) * sw - rx;
                const py = (pt[0] / 1000) * sh - ry;
                if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
            });
            ctx.closePath();
            ctx.clip(); // 建立裁剪区域
        }
        ctx.drawImage(source, rx, ry, rw, rh, 0, 0, rw, rh);
    } else {
        // 普通区域截图
        ctx.drawImage(source, rx, ry, rw, rh, 0, 0, rw, rh);
    }

    // 下载
    const link = document.createElement('a');
    link.download = `${mode}_${ann.label}_${Date.now()}.png`;
    link.href = canvas.toDataURL('image/png');
    link.click();
}

function goToAnnotation(index) {
    const ann = state.annotations[index];
    if (state.isVideoMode) {
        els.videoPlayer.currentTime = ann.time;
    }
}

// --- 视频处理辅助 ---

async function analyzeVideo(config) {
    updateProgress(0, '正在处理视频帧...');
    const frames = await extractFrames(els.videoPlayer, 1); // 每秒1帧
    let allAnns = [];
    
    for (let i = 0; i < frames.length; i++) {
        const res = await callAPI(config, [{ role: "user", content: [
            { type: "text", text: `标注物体并返回 JSON: [{"label":"物体名", "box_2d":[y1,x1,y2,x2]}]` },
            { type: "image_url", image_url: { url: `data:image/jpeg;base64,${frames[i].base64}` } }
        ]}]);
        const timedRes = res.map(r => ({ ...r, time: frames[i].time }));
        allAnns.push(...timedRes);
        updateProgress(((i+1)/frames.length)*100, `分析中: ${i+1}/${frames.length}`);
    }
    
    state.annotations = allAnns;
    renderTimeline(allAnns);
}

function drawVideoOverlay() {
    if (!state.isVideoMode) return;
    const ctx = els.overlayCanvas.getContext('2d');
    const w = els.overlayCanvas.width, h = els.overlayCanvas.height;
    ctx.clearRect(0,0,w,h);
    if (!state.videoRect) updateVideoLayout();
    
    // 找出当前时间附近的标注
    const now = els.videoPlayer.currentTime;
    const currentAnns = state.annotations.filter(a => Math.abs(a.time - now) < 0.5);
    currentAnns.forEach(ann => drawStyledAnnotation(ctx, ann, w, h, state.videoRect));
}

function videoLoop() {
    if (els.videoPlayer.paused || els.videoPlayer.ended) return;
    const v = els.videoPlayer;
    if (typeof v.requestVideoFrameCallback === 'function') {
        v.requestVideoFrameCallback(() => {
            if (!state.isVideoMode) return;
            if (v.paused || v.ended) return;
            drawVideoFrame();
            drawVideoOverlay();
            syncVideoControls();
            videoLoop();
        });
        return;
    }
    drawVideoFrame();
    drawVideoOverlay();
    syncVideoControls();
    requestAnimationFrame(videoLoop);
}

// --- 基础工具函数 ---

async function enforceRateLimit() {
    const rawVal = els.apiRpm && els.apiRpm.value ? els.apiRpm.value : '60';
    const limit = parseInt(rawVal, 10);

    // -1 表示无限制
    if (limit === -1) {
        els.apiInfo.textContent = `API速率: 无限制`;
        return;
    }

    // 默认值保护 (如果输入无效)
    const effectiveLimit = isNaN(limit) ? 60 : limit;
    const windowMs = 60000;
    const now = Date.now();
    
    // 清理过期记录
    while (state.apiHistory.length > 0 && state.apiHistory[0] <= now - windowMs) {
        state.apiHistory.shift();
    }
    
    if (state.apiHistory.length >= effectiveLimit) {
        const oldest = state.apiHistory[0];
        const waitTime = oldest + windowMs - now + 100; // 多等100ms
        if (waitTime > 0) {
            els.apiInfo.textContent = `触发流控: 等待 ${(waitTime/1000).toFixed(1)}s`;
            await new Promise(r => setTimeout(r, waitTime));
            return enforceRateLimit(); // 重新检查
        }
    }
    
    state.apiHistory.push(Date.now());
    els.apiInfo.textContent = `API速率: ${state.apiHistory.length}/${effectiveLimit} (1min)`;
}

async function fetchAPIWithRetry(config, messages, maxAttempts = 3) {
    const retryableStatuses = new Set([408, 425, 429, 500, 502, 503, 504]);
    let lastError = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        await enforceRateLimit();

        let response;
        let rawText = '';

        try {
            response = await fetch(config.url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${config.key}`
                },
                // 部分视觉模型不支持 response_format，且原提示要求顶层数组；
                // 依靠下面的容错解析兼容数组、objects、detections 和 boxes。
                body: JSON.stringify({ model: config.model, messages })
            });
            rawText = await response.text();
        } catch (error) {
            lastError = new Error(`API 网络连接失败：${error?.message || error}`);
        }

        if (response?.ok) {
            return rawText;
        }

        if (response && !response.ok) {
            let detail = rawText;
            try {
                const errorData = JSON.parse(rawText);
                detail = errorData?.error?.message || errorData?.message || rawText;
            } catch (_) {}

            lastError = new Error(
                `API HTTP ${response.status}: ${String(detail).slice(0, 500)}`
            );

            if (!retryableStatuses.has(response.status)) {
                throw lastError;
            }
        }

        if (attempt >= maxAttempts) {
            throw lastError || new Error('API 请求失败');
        }

        const retryAfterSeconds = response
            ? Number(response.headers.get('Retry-After'))
            : NaN;
        const retryAfterMs = Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
            ? retryAfterSeconds * 1000
            : 1500 * (2 ** (attempt - 1));
        const waitMs = Math.min(30000, retryAfterMs) + Math.floor(Math.random() * 250);

        if (els.apiInfo) {
            els.apiInfo.textContent =
                `API 临时断线，${(waitMs / 1000).toFixed(1)} 秒后重试 ` +
                `(${attempt + 1}/${maxAttempts})`;
        }
        await new Promise(resolve => setTimeout(resolve, waitMs));
    }

    throw lastError || new Error('API 请求失败');
}

function parseModelJsonContent(content) {
    if (typeof content !== 'string' || !content.trim()) {
        throw new Error('模型响应内容为空');
    }

    const jsonMatch = content.match(/\[[\s\S]*\]/) || content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
        throw new Error(`模型没有返回可解析的 JSON：${content.slice(0, 500)}`);
    }

    try {
        return JSON.parse(jsonMatch[0]);
    } catch (_) {
        throw new Error(`模型返回的 JSON 格式错误：${content.slice(0, 500)}`);
    }
}

async function callAPIJson(config, messages) {
    const rawText = await fetchAPIWithRetry(config, messages);

    let data;
    try {
        data = JSON.parse(rawText);
    } catch (_) {
        throw new Error(`API 返回的不是 JSON：${rawText.slice(0, 500)}`);
    }

    const rawContent = data?.choices?.[0]?.message?.content;
    const content = Array.isArray(rawContent)
        ? rawContent.map(part => part?.text || part?.content || '').join('\n')
        : rawContent;
    if (typeof content !== 'string' || !content.trim()) {
        throw new Error(`API 响应缺少 choices[0].message.content：${rawText.slice(0, 500)}`);
    }

    return parseModelJsonContent(content);
}

async function callAPI(config, messages) {
    const parsed = await callAPIJson(config, messages);

    const objects = Array.isArray(parsed)
        ? parsed
        : (parsed.objects || parsed.detections || parsed.boxes || []);
    if (!Array.isArray(objects)) {
        throw new Error(`模型返回的目标列表不是数组：${JSON.stringify(parsed).slice(0, 500)}`);
    }

    return objects.filter(item =>
        item &&
        typeof item.label === 'string' &&
        Array.isArray(item.box_2d) &&
        item.box_2d.length === 4 &&
        item.box_2d.every(value => Number.isFinite(Number(value)))
    );
}

async function extractFrames(video, fps, onProgress) {
    const duration = video.duration;
    const frames = [];
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth; canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    for (let t = 0; t < duration; t += (1/fps)) {
        video.currentTime = t;
        await new Promise(r => video.onseeked = r);
        ctx.drawImage(video, 0, 0);
        frames.push({ time: t, base64: canvas.toDataURL('image/jpeg', 0.6).split(',')[1] });
        if (onProgress) onProgress(t / (duration || 1));
    }
    return frames;
}


function updateProgress(pct, text) {
    els.progress.fill.style.width = `${pct}%`;
    els.progress.pct.innerText = `${Math.round(pct)}%`;
    if(text) els.progress.text.innerText = text;
}

function setLoading(isLoading) {
    state.isProcessing = isLoading;
    els.startBtn.disabled = isLoading;
    els.loader.style.display = isLoading ? 'block' : 'none';
    els.btnText.innerText = isLoading ? 'AI正在计算...' : '开始分析';
}

function renderCropGallery() {
    // 此函数现在仅用于单次刷新，如视频模式或非批处理模式
    // 但我们的新逻辑是 append，所以如果是批处理，不应该调用这个
    // 暂时保留，如果是非批处理单张分析，可能需要？
    // 我们的 processImageTwoStage 已经改为 appendCropGallery 了
    // 所以这个函数可能不再需要，或者只用于清空重绘？
    // 实际上 renderCropGallery 是被 appendCropGallery 替代了大部分功能
    // 为了兼容，如果其他地方调用了它：
    const items = state.annotations.filter(a => a.previewDataUrl);
    if (items.length === 0) {
        els.cropPreview.classList.add('hidden');
        els.cropGallery.innerHTML = '';
        return;
    }
    els.cropPreview.classList.remove('hidden');
    els.cropGallery.innerHTML = items.map((a, i) => `
        <div class="border rounded overflow-hidden bg-white shadow-sm flex flex-col">
            <img src="${a.previewDataUrl}" class="w-full h-32 object-contain bg-gray-50" />
            <div class="p-2 text-xs text-gray-600 flex justify-between">
                <span>${a.label}</span>
                <span>box</span>
            </div>
        </div>
    `).join('');
}

async function verifyTargetPresence(config, base64, prompt, targetJsonLabel, teachingCount) {
    const teachingNote = teachingCount > 0
        ? `你已经看过 ${teachingCount} 张人工标注示例；以示例中的目标定义为准。`
        : '严格依据用户描述判断目标，不要把相似背景或干扰物当成目标。';
    const messages = buildTeachingMessages([
        {
            type: 'text',
            text:
                `这是一次独立的“目标是否存在”复核，不负责画框。目标任务：${prompt}。` +
                `目标类别：${targetJsonLabel}。${teachingNote}` +
                '请仔细检查整张图片，尤其是四角、边缘、遮挡处、低对比区域和尺寸很小的目标。' +
                '图片可能完全没有目标，也可能只有一个或包含非常多目标；不要预设数量。' +
                '宁可把不确定情况标记为存在，也不要把可能有目标的图片误判为空。' +
                '只返回一个 JSON 对象，不要返回 Markdown 或解释：' +
                '{"has_target":true或false,"estimated_count":非负整数,"confidence":0到1,"reason":"一句简短依据"}。' +
                '只有在检查完整张图片并确信一个目标都没有时，才允许 has_target=false。'
        },
        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64}` } }
    ]);

    const raw = await callAPIJson(config, messages);
    const value = Array.isArray(raw) ? (raw[0] || {}) : (raw || {});
    const rawCount = value.estimated_count ?? value.estimatedCount ?? value.count;
    const estimatedCount = Math.max(0, Math.round(Number(rawCount) || 0));
    const rawConfidence = Number(value.confidence);
    const confidence = Number.isFinite(rawConfidence)
        ? Math.max(0, Math.min(1, rawConfidence))
        : 0;
    const rawHasTarget = value.has_target ?? value.hasTarget ?? value.present;
    const explicitFalse = rawHasTarget === false || rawHasTarget === 'false' || rawHasTarget === 0;
    const explicitTrue = rawHasTarget === true || rawHasTarget === 'true' || rawHasTarget === 1;

    // 字段缺失、互相矛盾或低置信度都按“可能存在”处理，避免制造错误负样本。
    const hasTarget = estimatedCount > 0 || explicitTrue || !explicitFalse;
    return {
        hasTarget,
        estimatedCount,
        confidence,
        reason: String(value.reason || value.evidence || '').slice(0, 300)
    };
}

function clampDetectionCoordinate(value) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(0, Math.min(1000, number)) : 0;
}

function getDetectionBoxArea(box) {
    if (!Array.isArray(box?.box_2d) || box.box_2d.length !== 4) return 0;
    const [ymin, xmin, ymax, xmax] = box.box_2d.map(clampDetectionCoordinate);
    return Math.max(0, ymax - ymin) * Math.max(0, xmax - xmin);
}

function getDetectionBoxOverlap(a, b) {
    const [ay1, ax1, ay2, ax2] = a.box_2d.map(clampDetectionCoordinate);
    const [by1, bx1, by2, bx2] = b.box_2d.map(clampDetectionCoordinate);
    const intersectionWidth = Math.max(0, Math.min(ax2, bx2) - Math.max(ax1, bx1));
    const intersectionHeight = Math.max(0, Math.min(ay2, by2) - Math.max(ay1, by1));
    const intersection = intersectionWidth * intersectionHeight;
    const areaA = Math.max(0, ax2 - ax1) * Math.max(0, ay2 - ay1);
    const areaB = Math.max(0, bx2 - bx1) * Math.max(0, by2 - by1);
    const union = areaA + areaB - intersection;
    return {
        iou: union > 0 ? intersection / union : 0,
        containment: Math.min(areaA, areaB) > 0 ? intersection / Math.min(areaA, areaB) : 0
    };
}

function deduplicateDetectionBoxes(boxes) {
    const sorted = [...boxes]
        .filter(box => getDetectionBoxArea(box) > 0)
        .sort((a, b) => {
            // 被分块边缘截断的框排在后面；其余候选再优先选择更贴边的小框。
            const edgePriority = Number(Boolean(a._touchesTileEdge)) - Number(Boolean(b._touchesTileEdge));
            return edgePriority || (getDetectionBoxArea(a) - getDetectionBoxArea(b));
        });
    const kept = [];

    sorted.forEach(candidate => {
        const duplicate = kept.some(existing => {
            if (String(existing.label) !== String(candidate.label)) return false;
            const overlap = getDetectionBoxOverlap(existing, candidate);
            return overlap.iou >= 0.45 || overlap.containment >= 0.72;
        });
        if (!duplicate) kept.push(candidate);
    });

    return kept.map(({ _tileIndex, _touchesTileEdge, ...box }) => box);
}

function createHighResolutionTiles(sourceImage) {
    const sourceWidth = sourceImage.naturalWidth || sourceImage.width;
    const sourceHeight = sourceImage.naturalHeight || sourceImage.height;
    const centerX = sourceWidth / 2;
    const centerY = sourceHeight / 2;
    const overlapX = Math.max(1, Math.round(sourceWidth * 0.06));
    const overlapY = Math.max(1, Math.round(sourceHeight * 0.06));
    const leftEnd = Math.min(sourceWidth, Math.ceil(centerX + overlapX));
    const rightStart = Math.max(0, Math.floor(centerX - overlapX));
    const topEnd = Math.min(sourceHeight, Math.ceil(centerY + overlapY));
    const bottomStart = Math.max(0, Math.floor(centerY - overlapY));
    const regions = [
        { x: 0, y: 0, w: leftEnd, h: topEnd, name: '左上' },
        { x: rightStart, y: 0, w: sourceWidth - rightStart, h: topEnd, name: '右上' },
        { x: 0, y: bottomStart, w: leftEnd, h: sourceHeight - bottomStart, name: '左下' },
        { x: rightStart, y: bottomStart, w: sourceWidth - rightStart, h: sourceHeight - bottomStart, name: '右下' }
    ];

    return regions.map((region, index) => {
        const maxTileSide = 1800;
        const scale = Math.min(1, maxTileSide / Math.max(region.w, region.h));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(region.w * scale));
        canvas.height = Math.max(1, Math.round(region.h * scale));
        const context = canvas.getContext('2d');
        context.imageSmoothingEnabled = true;
        context.imageSmoothingQuality = 'high';
        context.drawImage(sourceImage, region.x, region.y, region.w, region.h, 0, 0, canvas.width, canvas.height);
        return {
            ...region,
            index,
            base64: canvas.toDataURL('image/jpeg', 0.94).split(',')[1]
        };
    });
}

function mapTileBoxToFullImage(box, tile, sourceWidth, sourceHeight) {
    const [rawYmin, rawXmin, rawYmax, rawXmax] = box.box_2d.map(clampDetectionCoordinate);
    const localYmin = Math.min(rawYmin, rawYmax);
    const localYmax = Math.max(rawYmin, rawYmax);
    const localXmin = Math.min(rawXmin, rawXmax);
    const localXmax = Math.max(rawXmin, rawXmax);
    const globalYmin = ((tile.y + (localYmin / 1000) * tile.h) / sourceHeight) * 1000;
    const globalYmax = ((tile.y + (localYmax / 1000) * tile.h) / sourceHeight) * 1000;
    const globalXmin = ((tile.x + (localXmin / 1000) * tile.w) / sourceWidth) * 1000;
    const globalXmax = ((tile.x + (localXmax / 1000) * tile.w) / sourceWidth) * 1000;
    return {
        ...box,
        box_2d: [globalYmin, globalXmin, globalYmax, globalXmax].map(clampDetectionCoordinate),
        _tileIndex: tile.index,
        _touchesTileEdge:
            localYmin <= 15 || localXmin <= 15 || localYmax >= 985 || localXmax >= 985
    };
}

async function detectTargetsInHighResolutionTiles(
    config,
    sourceImage,
    prompt,
    targetJsonLabel,
    classInstruction,
    teachingInstruction,
    exhaustiveInstruction,
    reportProgress
) {
    const sourceWidth = sourceImage.naturalWidth || sourceImage.width;
    const sourceHeight = sourceImage.naturalHeight || sourceImage.height;
    const tiles = createHighResolutionTiles(sourceImage);
    const mappedBoxes = [];
    const errors = [];

    for (let index = 0; index < tiles.length; index++) {
        const tile = tiles[index];
        if (reportProgress) {
            els.statusMsg.textContent = `4K 分块复核：${index + 1}/${tiles.length}（${tile.name}）…`;
        }
        const messages = buildTeachingMessages([
            {
                type: 'text',
                text:
                    `Task: ${prompt}. 这是原始高分辨率图片的第 ${index + 1}/${tiles.length} 块（${tile.name}），` +
                    '请检查这个分块中的所有目标，不要假设其他分块的数量。返回 ' +
                    `[{"label":"${targetJsonLabel}","box_2d":[ymin,xmin,ymax,xmax]}]，` +
                    `坐标必须相对于当前分块归一化到0-1000。${classInstruction}${teachingInstruction}${exhaustiveInstruction}` +
                    '目标可能被分块边界截断；只要当前分块中能看到目标主体，就应返回其在当前分块内可见范围的框。'
            },
            { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${tile.base64}` } }
        ]);

        try {
            const tileBoxes = await callAPI(config, messages);
            tileBoxes.forEach(box => mappedBoxes.push(
                mapTileBoxToFullImage(box, tile, sourceWidth, sourceHeight)
            ));
        } catch (error) {
            errors.push({ tile: tile.name, message: String(error?.message || error).slice(0, 300) });
        }
    }

    return {
        boxes: deduplicateDetectionBoxes(mappedBoxes),
        totalTiles: tiles.length,
        successfulTiles: tiles.length - errors.length,
        errors
    };
}

async function processImageTwoStage(
    config,
    reportProgress = true,
    sourceImage = state.img,
    renderToView = true,
    onBoxesDetected = null
) {
    if (!sourceImage) {
        throw new Error('当前没有可分析的图片');
    }

    const t0 = performance.now();
    const analysisCanvas = createAnalysisCanvas(sourceImage);
    const base64 = analysisCanvas.toDataURL('image/jpeg', 0.92).split(',')[1];
    const prompt = els.promptInput.value.trim() || '目标';
    const classLabelInputVal = els.classLabelInput.value.trim();
    // 支持空格分割多标签
    const manualLabels = classLabelInputVal ? classLabelInputVal.split(/\s+/) : [];
    
    // 如果有多个标签，示例中用第一个；如果是单个，就直接用；没填则用prompt
    const targetJsonLabel = (manualLabels.length > 0) ? manualLabels[0] : (classLabelInputVal || prompt);

    // ... (构造 msg1, 调用 callAPI API检测 Box) ...
    let classInstruction = "";
    if (state.unifiedClassMap.size > 0) {
        const classes = getAllClasses();
        const classListStr = classes.map((c, i) => `${i}:${c}`).join(',');
        classInstruction = `\n请严格优先使用以下已知类别标准名称(ID:名称): [${classListStr}]。`;
    } else if (manualLabels.length > 1) {
        // 多标签模式
        classInstruction = `\n多类别检测模式。请识别以下类别: ${JSON.stringify(manualLabels)}。返回的 "label" 字段必须严格匹配其中之一。`;
    } else {
        // 单标签模式（或回退）
        classInstruction = `\nOutput Label MUST be: "${targetJsonLabel}"`;
    }

    const teachingCount = Math.min(3, state.teachingExamples?.length || 0);
    const teachingInstruction = teachingCount > 0
        ? `\n你已经看到 ${teachingCount} 张人工标注示例。请严格模仿示例中的目标定义和贴边框选方式；` +
          '不要把背景、阴影或相邻目标包含进框内。'
        : '';
    const exhaustiveInstruction =
        '\n这是零到多个目标的穷尽检测：图片可能没有目标、只有一个目标，也可能有非常多目标。' +
        '不要根据常见图片预设目标数量，也不要找到少数几个后提前停止。' +
        '请在内部按网格检查完整画面，并特别检查四角、边缘、遮挡处、低对比区域和很小的目标。' +
        '每个独立目标必须分别返回一个紧贴外轮廓的框，不得把多个相邻目标合并成一个框。' +
        '只有仔细检查完整张图片并确信一个目标都没有时，才返回空数组 []。' +
        '只输出 JSON 数组，不要输出 Markdown、计数说明或其他文字。';
    const msg1 = buildTeachingMessages([
        {
            type: "text",
            text:
                `Task: ${prompt}. 仅检测并返回 ` +
                `[{"label":"${targetJsonLabel}","box_2d":[ymin,xmin,ymax,xmax]}]，` +
                `坐标归一化到0-1000。${classInstruction}${teachingInstruction}${exhaustiveInstruction}`
        },
        { type: "image_url", image_url: { url: `data:image/jpeg;base64,${base64}` } }
    ]);

    let boxes = await callAPI(config, msg1);
    let validation = {
        status: boxes.length > 0 ? 'detected' : 'checking_empty',
        verifiedEmpty: false,
        needsReview: false,
        confidence: boxes.length > 0 ? 1 : 0,
        estimatedCount: boxes.length,
        reason: boxes.length > 0 ? '初次检测已定位到目标' : '初次检测返回空数组'
    };

    if (boxes.length === 0) {
        if (reportProgress) {
            els.statusMsg.textContent = '初次检测为 0，正在进行独立空结果复核…';
        }

        let presence;
        try {
            presence = await verifyTargetPresence(
                config,
                base64,
                prompt,
                targetJsonLabel,
                teachingCount
            );
        } catch (error) {
            presence = {
                hasTarget: true,
                estimatedCount: 0,
                confidence: 0,
                reason: `空结果复核失败：${error?.message || error}`
            };
        }

        const confidentlyEmpty =
            presence.hasTarget === false &&
            presence.estimatedCount === 0 &&
            presence.confidence >= 0.90;

        const sourceWidth = sourceImage.naturalWidth || sourceImage.width;
        const sourceHeight = sourceImage.naturalHeight || sourceImage.height;
        const requiresHighResolutionTiles = Math.max(sourceWidth, sourceHeight) > 1800;

        if (requiresHighResolutionTiles) {
            if (reportProgress) {
                els.statusMsg.textContent =
                    `初次检测为 0，正在启动 4K 分块复核${presence.estimatedCount > 0 ? `（全图复核估计 ${presence.estimatedCount} 个）` : ''}…`;
            }
            const tiled = await detectTargetsInHighResolutionTiles(
                config,
                sourceImage,
                prompt,
                targetJsonLabel,
                classInstruction,
                teachingInstruction,
                exhaustiveInstruction,
                reportProgress
            );
            boxes = tiled.boxes;
            const allTilesSucceeded = tiled.successfulTiles === tiled.totalTiles;

            if (boxes.length > 0 && allTilesSucceeded) {
                validation = {
                    status: 'recovered_tiled',
                    verifiedEmpty: false,
                    needsReview: false,
                    confidence: presence.confidence,
                    estimatedCount: boxes.length,
                    tiled: true,
                    successfulTiles: tiled.successfulTiles,
                    totalTiles: tiled.totalTiles,
                    reason: `4K 分块复核找回 ${boxes.length} 个目标，并已合并重叠框`
                };
            } else if (boxes.length > 0) {
                validation = {
                    status: 'recovered_tiled_partial',
                    verifiedEmpty: false,
                    needsReview: true,
                    confidence: presence.confidence,
                    estimatedCount: boxes.length,
                    tiled: true,
                    successfulTiles: tiled.successfulTiles,
                    totalTiles: tiled.totalTiles,
                    reason: `4K 分块找回 ${boxes.length} 个目标，但 ${tiled.errors.length} 个分块调用失败，结果可能不完整`
                };
            } else if (confidentlyEmpty && allTilesSucceeded) {
                validation = {
                    status: 'verified_empty_tiled',
                    verifiedEmpty: true,
                    needsReview: false,
                    confidence: presence.confidence,
                    estimatedCount: 0,
                    tiled: true,
                    successfulTiles: tiled.successfulTiles,
                    totalTiles: tiled.totalTiles,
                    reason: `全图存在性复核与 ${tiled.totalTiles} 个高分辨率分块均确认无目标`
                };
            } else {
                validation = {
                    status: 'needs_review',
                    verifiedEmpty: false,
                    needsReview: true,
                    confidence: presence.confidence,
                    estimatedCount: presence.estimatedCount,
                    tiled: true,
                    successfulTiles: tiled.successfulTiles,
                    totalTiles: tiled.totalTiles,
                    reason: tiled.errors.length > 0
                        ? `有 ${tiled.errors.length} 个分块调用失败，无法确认图片无目标`
                        : (presence.reason || '4K 分块未定位到目标，但全图复核也未能高置信确认无目标')
                };
            }
        } else if (confidentlyEmpty) {
            validation = {
                status: 'verified_empty',
                verifiedEmpty: true,
                needsReview: false,
                confidence: presence.confidence,
                estimatedCount: 0,
                reason: presence.reason || '独立复核确认整张图片没有目标'
            };
        } else {
            if (reportProgress) {
                els.statusMsg.textContent =
                    `空结果未获确认，正在高召回重检${presence.estimatedCount > 0 ? `（复核估计 ${presence.estimatedCount} 个）` : ''}…`;
            }
            const retryMessages = buildTeachingMessages([
                {
                    type: 'text',
                    text:
                        `Task: ${prompt}. 前一次定位返回了 0 个目标，但独立复核未能确认这是一张无目标图片。` +
                        `请以高召回率重新检查并定位每一个目标，返回 ` +
                        `[{"label":"${targetJsonLabel}","box_2d":[ymin,xmin,ymax,xmax]}]，坐标归一化到0-1000。` +
                        `${classInstruction}${teachingInstruction}${exhaustiveInstruction}` +
                        '目标可能很小、部分遮挡、位于边缘或与背景接近；仍需严格排除与人工示例定义不符的干扰物。'
                },
                { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64}` } }
            ]);
            boxes = await callAPI(config, retryMessages);
            validation = boxes.length > 0
                ? {
                    status: 'recovered',
                    verifiedEmpty: false,
                    needsReview: false,
                    confidence: presence.confidence,
                    estimatedCount: presence.estimatedCount,
                    reason: `空结果复核后重检成功：${presence.reason || '复核认为可能存在目标'}`
                }
                : {
                    status: 'needs_review',
                    verifiedEmpty: false,
                    needsReview: true,
                    confidence: presence.confidence,
                    estimatedCount: presence.estimatedCount,
                    reason: presence.reason || '空结果未获高置信确认，重检仍未能定位目标'
                };
        }
    }


    boxes.forEach(b => getClassId(b.label));

    // 第一阶段一拿到框就通知当前视图；调用方会再次核对文件是否仍被选中。
    if (typeof onBoxesDetected === 'function') {
        onBoxesDetected(boxes);
    }
    
    const octx = renderToView ? els.overlayCanvas.getContext('2d') : null;
    if (octx) {
        octx.clearRect(0,0,els.overlayCanvas.width,els.overlayCanvas.height);
        boxes.forEach(b => drawStyledAnnotation(
            octx,
            { ...b, polygon: null },
            els.overlayCanvas.width,
            els.overlayCanvas.height,
            state.imageRect
        ));
    }
    const t1 = performance.now();
    const stage1Time = Math.round(t1 - t0);
    if (reportProgress) {
        els.statusMsg.textContent = `阶段1完成：${stage1Time}ms`;
    }
    const sw = sourceImage.width, sh = sourceImage.height;
    let apiTime = 0, cropTime = 0;

    // 【优化点】：检查是否勾选了透明图（这决定了是否需要第二阶段的API调用）
    const needTransparent = els.extractTransparent && els.extractTransparent.checked;

    for (let i = 0; i < boxes.length; i++) {
        const b = boxes[i];
        const [ymin, xmin, ymax, xmax] = b.box_2d;
        const rx = (xmin/1000)*sw, ry = (ymin/1000)*sh, rw = ((xmax-xmin)/1000)*sw, rh = ((ymax-ymin)/1000)*sh;
        
        const c0 = performance.now();
        const c = els.exportCanvas;
        c.width = rw; c.height = rh;
        const cctx = c.getContext('2d');
        cctx.drawImage(sourceImage, rx, ry, rw, rh, 0, 0, rw, rh);
        let upCanvas = c;
        
        // 如果不需要透明图，不需要进行高质量缩放，scale 1 即可
        const scale = parseFloat(els.scaleFactor && els.scaleFactor.value ? els.scaleFactor.value : '4') || 4;
        const effectiveScale = needTransparent ? scale : 1; 

        if (effectiveScale !== 1) {
            // ... (OpenCV / Canvas 放大逻辑，同原代码) ...
            if (window.cvReady) {
                const src = cv.imread(c);
                const dst = new cv.Mat();
                const dsize = new cv.Size(Math.round(rw*effectiveScale), Math.round(rh*effectiveScale));
                cv.resize(src, dst, dsize, 0, 0, cv.INTER_LINEAR); 
                const oc = document.createElement('canvas');
                oc.width = dsize.width; oc.height = dsize.height;
                cv.imshow(oc, dst);
                src.delete(); dst.delete();
                upCanvas = oc;
            } else {
                 const oc = document.createElement('canvas');
                 oc.width = Math.round(rw*effectiveScale); oc.height = Math.round(rh*effectiveScale);
                 const octx2 = oc.getContext('2d');
                 octx2.imageSmoothingEnabled = true;
                 octx2.imageSmoothingQuality = 'medium'; 
                 octx2.drawImage(c, 0, 0, oc.width, oc.height);
                 upCanvas = oc;
            }
        }
        
        const c1 = performance.now();
        cropTime += (c1 - c0);
        
        // 生成裁剪预览图（这是必要的，用于显示或下一步）
        const previewUrl = upCanvas.toDataURL('image/jpeg', 0.5);
        b.previewDataUrl = previewUrl;

        // 【关键逻辑】：仅当勾选了 extractTransparent 时才请求多边形分割 API
        if (needTransparent) {
            const up64 = previewUrl.split(',')[1];
            const a0 = performance.now();
            const msg2 = [{ role: "user", content: [
                { type: "text", text: `返回精确多边形 [{"label":"${b.label}","polygon":[[y,x],...]]}]，坐标归一化到0-1000。尤其要包含向外突出或向内凹的尖角和转折处` },
                { type: "image_url", image_url: { url: `data:image/jpeg;base64,${up64}` } }
            ]}];
            const polys = await callAPI(config, msg2);
            const a1 = performance.now();
            apiTime += (a1 - a0);
            
            if (polys && polys[0] && polys[0].polygon) {
                const mapped = polys[0].polygon.map(([y,x]) => {
                    const oy = ymin + (y/1000)*(ymax - ymin);
                    const ox = xmin + (x/1000)*(xmax - xmin);
                    return [oy, ox];
                });
                b.polygon = mapped;
                
                // 为了前端预览，这里仍会生成透明图数据
                const tc = document.createElement('canvas');
                tc.width = rw; tc.height = rh;
                const tctx = tc.getContext('2d');
                tctx.clearRect(0,0,rw,rh);
                tctx.beginPath();
                b.polygon.forEach((pt, k) => { 
                   const px = (pt[1] / 1000) * sw - rx;
                   const py = (pt[0] / 1000) * sh - ry;
                   if (k === 0) tctx.moveTo(px, py); else tctx.lineTo(px, py);
                });
                tctx.closePath();
                tctx.clip();
                tctx.drawImage(sourceImage, rx, ry, rw, rh, 0, 0, rw, rh);
                b.transparentPreviewUrl = tc.toDataURL('image/png');
            }
        } else {
            // 清理旧数据（防止复用对象污染）
            delete b.polygon;
            delete b.transparentPreviewUrl;
        }

        if (octx) {
            drawStyledAnnotation(
                octx,
                b,
                els.overlayCanvas.width,
                els.overlayCanvas.height,
                state.imageRect
            );
        }
        if (reportProgress) {
            updateProgress(Math.round(((i+1)/boxes.length)*100), `阶段2: ${i+1}/${boxes.length}`);
        }
    }
    const t2 = performance.now();
    if (reportProgress) {
        els.statusMsg.textContent = `阶段1：${stage1Time}ms，裁剪：${Math.round(cropTime)}ms，API：${Math.round(apiTime)}ms，总计：${Math.round(t2 - t0)}ms`;
    }
    return { boxes, validation };
}

async function processImagesBatch(config) {
    const files = state.files && state.files.length ? state.files : (state.file ? [state.file] : []);
    if (files.length === 0) return;
    const concurrency = 1;
    // state.imageResults = []; // Modified for resume support
    if (!state.imageResults) state.imageResults = [];
    
    let completed = 0;
    if (state.imageResults.length > 0) {
        const fileNames = new Set(files.map(f => f.name));
        completed = state.imageResults.filter(r => {
            if (!fileNames.has(r.fileName) || r.needsReview) return false;
            const hasAnnotations = Array.isArray(r.annotations) && r.annotations.length > 0;
            return hasAnnotations || r.verifiedEmpty === true;
        }).length;
    }
    const total = files.length;
    // 如果是单文件，允许内部报告详细进度；如果是多文件，禁用内部报告，改用外部计数
    const isSingleFile = total === 1;

    const worker = async (file) => {
        try {
            const { img, dataUrl } = await readImageFile(file);
            const detection = await processImageTwoStage(
                config,
                isSingleFile,
                img,
                false,
                boxes => showAnnotationsForFile(file, boxes)
            );
            const anns = detection.boxes;
            const result = {
                fileName: file.name,
                file,
                annotations: JSON.parse(JSON.stringify(anns)),
                dataUrl,
                validation: detection.validation,
                verifiedEmpty: detection.validation?.verifiedEmpty === true,
                needsReview: detection.validation?.needsReview === true
            };

            const existingIndex = state.imageResults.findIndex(item =>
                item.file === file || item.fileName === file.name
            );

            let resultIndex;
            if (existingIndex >= 0) {
                state.imageResults[existingIndex] = result;
                resultIndex = existingIndex;
            } else {
                state.imageResults.push(result);
                resultIndex = state.imageResults.length - 1;
            }

            appendTimelineItem(file, anns, resultIndex, result);
            appendCropGallery(anns);
            showAnnotationsForFile(file, anns);
        } catch (error) {
            recordImageProcessingError(file, String(error?.message || error || '未知错误'));
            throw error;
        } finally {
            if (!isSingleFile) {
                completed++;
                updateProgress(Math.round((completed / total) * 100), `批量处理中: ${completed}/${total}`);
            }
        }
    };
    
    if (!isSingleFile) updateProgress(0, `准备处理 ${total} 张图片...`);
    
    // 如果只有一张图，不需要 concurrency 逻辑，直接跑
    let batchSummary;
    if (isSingleFile) {
        try {
            await worker(files[0]);
            batchSummary = { attempted: 1, succeeded: 1, failed: 0, skipped: 0, errors: [] };
        } catch (error) {
            batchSummary = {
                attempted: 1,
                succeeded: 0,
                failed: 1,
                skipped: 0,
                errors: [{ fileName: files[0]?.name || '当前图片', message: String(error?.message || error) }]
            };
        }
    } else {
        batchSummary = await runWithConcurrency(files, worker, concurrency);
    }

    // 兼容未加载 task_manager.js 的普通网页运行路径。
    batchSummary = batchSummary || {
        attempted: total,
        succeeded: total,
        failed: 0,
        skipped: 0,
        errors: []
    };
    
    const reviewCount = state.imageResults.filter(item => item.needsReview).length;
    const verifiedEmptyCount = state.imageResults.filter(item => item.verifiedEmpty).length;
    const recoveredCount = state.imageResults.filter(item =>
        String(item.validation?.status || '').startsWith('recovered')
    ).length;
    const selectedNames = new Set(files.map(file => file.name));
    const availableResults = state.imageResults.filter(item => selectedNames.has(item.fileName)).length;
    batchSummary.availableResults = availableResults;

    if (batchSummary.failed > 0) {
        const firstError = batchSummary.errors?.[0]?.message || '未知错误';
        els.statusMsg.textContent =
            `图片处理未完成：成功 ${batchSummary.succeeded} 张 · 失败 ${batchSummary.failed} 张 · ` +
            `已有结果 ${availableResults} 张 · 原因：${firstError}`;
    } else {
        els.statusMsg.textContent =
            `图片处理完成：${availableResults} 项 · 找回漏检 ${recoveredCount} · ` +
            `确认无目标 ${verifiedEmptyCount} · 待人工复核 ${reviewCount}`;
    }

    return batchSummary;
}

function recordImageProcessingError(file, message) {
    if (!file) return null;
    if (!Array.isArray(state.imageResults)) state.imageResults = [];
    const normalizedMessage = String(message || '未知错误');
    const existingIndex = state.imageResults.findIndex(item =>
        item.file === file || item.fileName === file.name
    );
    const existing = existingIndex >= 0 ? state.imageResults[existingIndex] : null;
    const annotations = Array.isArray(existing?.annotations)
        ? JSON.parse(JSON.stringify(existing.annotations))
        : [];
    const result = {
        ...(existing || {}),
        fileName: file.name,
        file,
        annotations,
        reviewCategory: 'error',
        processingError: normalizedMessage,
        verifiedEmpty: false,
        needsReview: true,
        validation: {
            ...(existing?.validation || {}),
            status: 'processing_error',
            verifiedEmpty: false,
            needsReview: true,
            estimatedCount: annotations.length,
            reason: normalizedMessage
        }
    };
    if (existingIndex >= 0) state.imageResults[existingIndex] = result;
    else state.imageResults.push(result);
    return result;
}

async function processVideosBatch(config) {
    const files = state.files && state.files.length ? state.files : (state.file ? [state.file] : []);
    if (files.length === 0) return;
    const concurrency = parseInt(els.parallelCountGlobal && els.parallelCountGlobal.value ? els.parallelCountGlobal.value : '3', 10) || 3;
    // state.videoResults = []; // Modified for resume support
    if (!state.videoResults) state.videoResults = [];
    
    let completed = 0;
    if (state.videoResults.length > 0) {
        const fileNames = new Set(files.map(f => f.name));
        completed = state.videoResults.filter(r => fileNames.has(r.fileName)).length;
    }
    const total = files.length;
    const isSingleFile = total === 1;

    const worker = async (file) => {
        // 如果是单文件，传入进度回调；如果是多文件，不传回调（或者传空）
        const onProgress = isSingleFile 
            ? (pct, text) => updateProgress(pct, text)
            : null;

        const result = await analyzeVideoFile(file, config, onProgress);
        // state.videoResults.push({ fileName: file.name, file, annotations: result.annotations, fps: result.fps });
        // Result is already updated in state.videoResults by analyzeVideoFile (via partialResult update)
        
        if (!isSingleFile) {
            completed++;
            updateProgress(Math.round((completed / total) * 100), `视频批量处理中: ${completed}/${total}`);
        }
    };
    
    if (!isSingleFile) updateProgress(0, `准备处理 ${total} 个视频...`);

    await runWithConcurrency(files, worker, concurrency);
    els.statusMsg.textContent = `视频批量处理完成：${state.videoResults.length}项`;
}

async function analyzeVideoFile(file, config, onProgress) {
    return new Promise(async (resolve, reject) => {
        let frames = [];
        let fps = 1;

        // 1. 优先尝试从缓存获取抽帧结果 (Phase 1 产物)
        if (state.videoFramesCache.has(file.name)) {
            const cache = state.videoFramesCache.get(file.name);
            frames = cache.frames;
            fps = cache.fps;
        } 
        // 2. 如果没有缓存，则检查是否是恢复任务/导入任务 (Bug Fix核心)
        else {
            const video = document.createElement('video');
            video.src = URL.createObjectURL(file);
            await new Promise(r => video.onloadedmetadata = r);

            // [Bug Fix]: 检查 videoResults 中是否有旧的任务设置
            const existingResult = state.videoResults.find(r => r.fileName === file.name);
            
            if (existingResult && existingResult.fps) {
                fps = existingResult.fps;
                // 同步 UI 告诉用户这是恢复的FPS
                if($('frameRate')) $('frameRate').value = fps;
            } else {
                const fpsInput = $('frameRate');
                fps = fpsInput ? parseFloat(fpsInput.value || '1') : 1;
            }

            frames = await extractFrames(video, fps);
            URL.revokeObjectURL(video.src);
            video.remove();
        }

        // 接下来的逻辑是处理帧分析（API调用）
        let allAnns = [];
        let startIndex = 0;
        
        const existingResultIndex = state.videoResults.findIndex(r => r.fileName === file.name);
        if (existingResultIndex !== -1) {
            const existing = state.videoResults[existingResultIndex];
            if (existing.annotations && existing.annotations.length > 0) {
                 const lastTime = existing.annotations[existing.annotations.length - 1].time;
                 const nextFrameIndex = frames.findIndex(f => f.time > lastTime + 0.01);
                 if (nextFrameIndex !== -1) {
                     startIndex = nextFrameIndex;
                     allAnns = [...existing.annotations];
                     state.videoResults.splice(existingResultIndex, 1);
                     if (onProgress) onProgress(Math.round((startIndex / frames.length) * 100), `恢复进度: 从第 ${startIndex + 1} 帧继续...`);
                 } else {
                     resolve(existing);
                     return;
                 }
            }
        }
        
        const prompt = els.promptInput.value.trim() || '物体';
        const classLabelInputVal = els.classLabelInput.value.trim();
        const manualLabels = classLabelInputVal ? classLabelInputVal.split(/\s+/) : [];
        const targetJsonLabel = (manualLabels.length > 0) ? manualLabels[0] : (classLabelInputVal || prompt);
        
        const partialResult = { fileName: file.name, file, annotations: allAnns, fps, isPartial: true };
        state.videoResults.push(partialResult);
        
        let classInstruction = "";
        if (state.unifiedClassMap.size > 0) {
            const classes = getAllClasses();
            const classListStr = classes.map((c, i) => `${i}:${c}`).join(',');
            classInstruction = `\n请严格优先使用以下已知类别标准名称(ID:名称): [${classListStr}]。`;
        } else if (manualLabels.length > 1) {
             classInstruction = `\n多类别检测模式。请识别: ${JSON.stringify(manualLabels)}。返回的 "label" 字段必须严格匹配其中之一。`;
        } else {
             classInstruction = `\nOutput Label MUST be: "${targetJsonLabel}"`; 
        }

        for (let i = startIndex; i < frames.length; i++) {
            while (window.TaskManager && window.TaskManager.isPaused) {
                if (window.TaskManager.isStopped) break;
                await new Promise(r => setTimeout(r, 500));
            }
            if (window.TaskManager && window.TaskManager.isStopped) break;

            try {
                const res = await callAPI(config, [{ role: "user", content: [
                    { type: "text", text: `Task: ${prompt}. 标注并返回 JSON: [{"label":"${targetJsonLabel}", "box_2d":[y1,x1,y2,x2]}]${classInstruction}` },
                    { type: "image_url", image_url: { url: `data:image/jpeg;base64,${frames[i].base64}` } }
                ]}]);


                
                res.forEach(b => getClassId(b.label));

                const timedRes = res.map(r => ({ ...r, time: frames[i].time }));
                allAnns.push(...timedRes);
                
                partialResult.annotations = allAnns;
                
                if (onProgress) {
                    onProgress(Math.round(((i + 1) / frames.length) * 100), `视频分析中: ${i + 1}/${frames.length} 帧`);
                }
            } catch (e) {
                console.error("Frame analysis failed", e);
            }
        }
        
        delete partialResult.isPartial;
        resolve({ annotations: allAnns, fps });
    });
}


async function runWithConcurrency(items, worker, concurrency) {
    let index = 0;
    const runners = new Array(Math.min(concurrency, items.length)).fill(0).map(async () => {
        while (index < items.length) {
            const current = index++;
            await worker(items[current]);
        }
    });
    await Promise.all(runners);
}

async function exportAllTransparentImages() {
    if (!state.imageResults || state.imageResults.length === 0) return alert('暂无可导出的透明图');
    const zip = new JSZip();
    const folder = zip.folder('transparent');
    for (const item of state.imageResults) {
        const sub = folder.folder(item.fileName);
        let idx = 1;
        for (const ann of item.annotations) {
            if (!ann.transparentPreviewUrl) continue;
            const base64 = ann.transparentPreviewUrl.split(',')[1];
            sub.file(`${ann.label}_${idx}.png`, base64, { base64: true });
            idx++;
        }
    }
    const blob = await zip.generateAsync({ type: 'blob' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `transparent_all_${Date.now()}.zip`;
    a.click();
}

async function exportBatchImageLabels() {
    if (window.ReviewWorkspace?.exportReviewedPackage) {
        return window.ReviewWorkspace.exportReviewedPackage();
    }
    alert('分类复核模块尚未加载完成，请刷新页面后重试。');
}

async function exportBatchVideoFrames() {
    if (!state.videoResults || state.videoResults.length === 0) return alert('暂无视频标注结果');
    const zip = new JSZip();
    const imgFolder = zip.folder('images');
    const lblFolder = zip.folder('labels');

    // 确保所有结果中的标签都已注册到统一映射中
    state.videoResults.forEach(item => {
        item.annotations.forEach(ann => getClassId(ann.label));
    });
    const classes = getAllClasses();
    zip.file('classes.txt', classes.join('\n'));

    els.statusMsg.textContent = '正在导出视频帧...';

    for (const item of state.videoResults) {
        // 重新提取帧
        const video = document.createElement('video');
        video.src = URL.createObjectURL(item.file);
        // 等待元数据以确保提取准确
        await new Promise(r => video.onloadedmetadata = r);
        
        const fps = item.fps || 1;
        const frames = await extractFrames(video, fps);
        
        // 基础文件名（无扩展名）
        const baseName = item.fileName.substring(0, item.fileName.lastIndexOf('.'));

        for (let i = 0; i < frames.length; i++) {
            const frame = frames[i];
            const frameName = `${baseName}_${String(i).padStart(5, '0')}`;
            
            // 保存图片
            const base64 = frame.base64; 
            imgFolder.file(`${frameName}.jpg`, base64, { base64: true });

            // 查找该帧的标注
            // 使用时间匹配，允许小误差
            const frameAnns = item.annotations.filter(ann => Math.abs(ann.time - frame.time) < (0.5/fps));
            
            if (frameAnns.length > 0) {
                const lines = frameAnns.map(ann => {
                    const clsId = getClassId(ann.label);
                    const [ymin, xmin, ymax, xmax] = ann.box_2d;
                    const cx = ((xmin + xmax) / 2) / 1000;
                    const cy = ((ymin + ymax) / 2) / 1000;
                    const w = (xmax - xmin) / 1000;
                    const h = (ymax - ymin) / 1000;
                    return `${clsId} ${cx.toFixed(6)} ${cy.toFixed(6)} ${w.toFixed(6)} ${h.toFixed(6)}`;
                });
                lblFolder.file(`${frameName}.txt`, lines.join('\n'));
            } else {
                lblFolder.file(`${frameName}.txt`, "");
            }
        }
    }

    els.statusMsg.textContent = '正在打包...';
    const blob = await zip.generateAsync({ type: 'blob' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `video_frames_yolo_${Date.now()}.zip`;
    a.click();
    els.statusMsg.textContent = '导出完成';
}

async function exportAllCroppedImages() {
    if (!state.imageResults || state.imageResults.length === 0) return alert('暂无可导出的截取图');
    const zip = new JSZip();
    const folder = zip.folder('crop');
    for (const item of state.imageResults) {
        const sub = folder.folder(item.fileName);
        let idx = 1;
        for (const ann of item.annotations) {
            if (!ann.previewDataUrl) continue;
            const base64 = ann.previewDataUrl.split(',')[1];
            sub.file(`${ann.label}_${idx}.png`, base64, { base64: true });
            idx++;
        }
    }
    const blob = await zip.generateAsync({ type: 'blob' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `crop_all_${Date.now()}.zip`;
    a.click();
}

async function exportAllTaggedVideos() {
    if (!state.videoResults || state.videoResults.length === 0) return alert('暂无可导出的视频');
    
    // 1. 为所有结果分配追踪ID (Track IDs)
    state.videoResults.forEach(item => {
        if (item.annotations && item.annotations.length > 0) {
            item.annotations = assignTrackIds(item.annotations);
        }
    });

    const zip = new JSZip();
    const folder = zip.folder('videos_tagged');
    
    els.statusMsg.textContent = '正在准备导出...';
    els.progress.box.classList.remove('hidden'); // 显示进度条容器
    
    let completed = 0;
    const total = state.videoResults.length;

    // 2. 逐个处理视频导出
    for (const item of state.videoResults) {
        if (!item.annotations || item.annotations.length === 0) {
            completed++;
            continue;
        }
        
        // 定义单个视频的进度回调
        const onProgress = (pct) => {
            const currentVideoProgress = pct / 100;
            // 总进度 = (已完成视频数 + 当前视频进度) / 总视频数
            const totalProgress = ((completed + currentVideoProgress) / total) * 100;
            
            updateProgress(totalProgress, `正在导出 ${completed + 1}/${total}: ${item.fileName} (${Math.round(pct)}%)`);
        };

        els.statusMsg.textContent = `正在渲染并导出视频 ${completed + 1}/${total}: ${item.fileName}`;
        
        try {
            const videoBlob = await exportTaggedVideo(item, onProgress);
            // 默认导出为 webm 格式，兼容性最好
            const ext = videoBlob.type.includes('mp4') ? '.mp4' : '.webm';
            const outName = item.fileName.substring(0, item.fileName.lastIndexOf('.')) + '_tagged' + ext;
            folder.file(outName, videoBlob);
        } catch (e) {
            console.error(`Export failed for ${item.fileName}`, e);
            els.statusMsg.textContent = `导出失败: ${item.fileName}`;
        }
        
        completed++;
    }

    els.statusMsg.textContent = '正在打包所有视频...';
    updateProgress(100, '正在打包...');
    const blob = await zip.generateAsync({ type: 'blob' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `videos_tagged_tracked_${Date.now()}.zip`;
    a.click();
    
    els.statusMsg.textContent = '所有视频导出完成';
    els.progress.box.classList.add('hidden'); // 隐藏进度条
}

// --- 追踪与导出辅助函数 ---

function assignTrackIds(annotations) {
    // 按时间排序
    const sorted = [...annotations].sort((a, b) => a.time - b.time);
    const result = sorted.map(ann => ({ ...ann, trackId: -1 }));
    
    let nextTrackId = 1;
    // 按时间分组
    const frames = {};
    result.forEach(ann => {
        const key = Math.round(ann.time * 100) / 100; // 0.01s 精度
        if (!frames[key]) frames[key] = [];
        frames[key].push(ann);
    });
    
    const timeKeys = Object.keys(frames).sort((a, b) => parseFloat(a) - parseFloat(b));
    const activeTracks = []; // { id, label, box, time }
    
    timeKeys.forEach(t => {
        const time = parseFloat(t);
        const currentAnns = frames[t];
        
        // 移除超过 5.0 秒未更新的轨迹 (增加容错，避免断连)
        for(let i = activeTracks.length - 1; i >= 0; i--) {
            if (time - activeTracks[i].time > 5.0) {
                activeTracks.splice(i, 1);
            }
        }
        
        currentAnns.forEach(ann => {
            // 贪心匹配：寻找最近的同类轨迹
            let bestMatch = -1;
            let minDist = 200; // 阈值：归一化坐标 200 (即 1/5 屏幕宽度)
            
            activeTracks.forEach((track, idx) => {
                if (track.label === ann.label) {
                    const dist = getDistance(track.box, ann.box_2d);
                    if (dist < minDist) {
                        minDist = dist;
                        bestMatch = idx;
                    }
                }
            });
            
            if (bestMatch !== -1) {
                ann.trackId = activeTracks[bestMatch].id;
                // 更新轨迹
                activeTracks[bestMatch].box = ann.box_2d;
                activeTracks[bestMatch].time = time;
            } else {
                // 新轨迹
                ann.trackId = nextTrackId++;
                activeTracks.push({ id: ann.trackId, label: ann.label, box: ann.box_2d, time: time });
            }
        });
    });
    
    return result;
}

function getDistance(box1, box2) {
    const cx1 = (box1[1] + box1[3]) / 2;
    const cy1 = (box1[0] + box1[2]) / 2;
    const cx2 = (box2[1] + box2[3]) / 2;
    const cy2 = (box2[0] + box2[2]) / 2;
    return Math.sqrt(Math.pow(cx1 - cx2, 2) + Math.pow(cy1 - cy2, 2));
}

function exportTaggedVideo(item, onProgress) {
    return new Promise(async (resolve, reject) => {
        const video = document.createElement('video');
        video.muted = true;
        video.src = URL.createObjectURL(item.file);
        video.crossOrigin = "anonymous";
        video.playsInline = true; // 关键：防止全屏
        
        await new Promise(r => video.onloadedmetadata = r);
        
        const width = video.videoWidth;
        const height = video.videoHeight;
        const duration = video.duration;
        
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        
        // 30fps 录制
        const stream = canvas.captureStream(30);
        
        // 优先使用 MP4 格式
        let mimeType = 'video/webm';
        if (MediaRecorder.isTypeSupported('video/mp4')) {
            mimeType = 'video/mp4';
        } else if (MediaRecorder.isTypeSupported('video/webm;codecs=vp9')) {
            mimeType = 'video/webm;codecs=vp9';
        }
        
        const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 5000000 }); // 5Mbps
        const chunks = [];
        recorder.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };
        
        recorder.onstop = () => {
            const blob = new Blob(chunks, { type: mimeType });
            resolve(blob);
        };
        
        recorder.start();
        video.play();
        
        // 预处理：按 trackId 分组并排序
        const tracks = {}; // trackId -> [sorted annotations]
        item.annotations.forEach(ann => {
            if (ann.trackId !== -1) {
                if (!tracks[ann.trackId]) tracks[ann.trackId] = [];
                tracks[ann.trackId].push(ann);
            }
        });
        Object.values(tracks).forEach(list => list.sort((a, b) => a.time - b.time));
        
        const trackHistory = {}; // trackId -> [{x, y}]
        
        const drawFrame = () => {
            if (video.paused || video.ended) {
                recorder.stop();
                return;
            }
            
            // 绘制视频帧
            ctx.drawImage(video, 0, 0, width, height);
            
            const now = video.currentTime;
            
            if (onProgress && duration > 0) {
                const pct = Math.min(100, (now / duration) * 100);
                onProgress(pct);
            }
            
            // 计算当前帧的插值框
            const currentBoxes = [];
            const MAX_GAP = 5.0; // 最大插值间隔，超过此值认为物体暂时消失或重置
            
            Object.entries(tracks).forEach(([trackId, list]) => {
                // 找到 now 前后的关键帧
                let prev = null, next = null;
                for (let i = 0; i < list.length; i++) {
                    if (list[i].time <= now) {
                        prev = list[i];
                    } else {
                        next = list[i];
                        break; // 找到第一个大于 now 的即为 next
                    }
                }
                
                let interpolatedBox = null;
                
                if (prev && next) {
                    // 在两个关键帧之间，进行线性插值
                    const gap = next.time - prev.time;
                    if (gap < MAX_GAP) {
                        const alpha = (now - prev.time) / gap;
                        // 线性插值：box = prev + alpha * (next - prev)
                        const b1 = prev.box_2d;
                        const b2 = next.box_2d;
                        interpolatedBox = [
                            b1[0] + alpha * (b2[0] - b1[0]), // ymin
                            b1[1] + alpha * (b2[1] - b1[1]), // xmin
                            b1[2] + alpha * (b2[2] - b1[2]), // ymax
                            b1[3] + alpha * (b2[3] - b1[3])  // xmax
                        ];
                    }
                } else if (prev) {
                    // 只有前一帧（可能是最后一帧，或者暂时没找到下一帧）
                    // 如果离得很近，可以显示（保持最后一帧的位置，或者淡出）
                    // 为了平滑，如果距离 prev 时间很短（例如 < 0.2s），显示静止框
                    if (now - prev.time < 0.2) {
                        interpolatedBox = prev.box_2d;
                    }
                } else if (next) {
                    // 只有后一帧（刚开始出现）
                     if (next.time - now < 0.2) {
                        interpolatedBox = next.box_2d;
                    }
                }
                
                if (interpolatedBox) {
                    currentBoxes.push({
                        label: list[0].label, // 假设同 trackId label 一致
                        box_2d: interpolatedBox,
                        trackId: parseInt(trackId)
                    });
                }
            });
            
            // 2. 绘制插值后的标注框
            currentBoxes.forEach(ann => {
                 drawStyledAnnotation(ctx, ann, width, height);
            });
            
            requestAnimationFrame(drawFrame);
        };
        
        drawFrame();
    });
}
// [新增] 批量抽帧函数
async function batchExtractFrames() {
    if (!state.files || state.files.length === 0) return;
    
    // UI状态：锁定按钮
    state.isProcessing = true;
    els.startBtn.disabled = true; 
    els.startBtn.classList.remove('bg-indigo-600', 'hover:bg-indigo-700');
    els.startBtn.classList.add('bg-gray-400', 'cursor-not-allowed');
    els.progress.box.classList.remove('hidden');
    
    let completed = 0;
    const total = state.files.length;
    
    const fpsInput = $('frameRate');
    let targetFps = fpsInput ? parseFloat(fpsInput.value || '1') : 1;
    
    for (let i = 0; i < total; i++) {
        const file = state.files[i];
        
        let frames = [];
        let currentFps = targetFps;
        
        const existingResult = state.videoResults.find(r => r.fileName === file.name);
        if (existingResult && existingResult.fps) {
            currentFps = existingResult.fps;
            if(fpsInput) fpsInput.value = currentFps;
        }

        // 定义细粒度进度回调
        const onFrameProgress = (fileProgress) => {
             // 总进度 = (已完成视频数 + 当前视频解码比例) / 总视频数
             const totalPct = ((completed + fileProgress) / total) * 100;
             updateProgress(totalPct, `正在抽帧 (${i+1}/${total}): ${file.name} - ${Math.round(fileProgress * 100)}%`);
        };
        
        onFrameProgress(0); // 初始化进度显示

        const video = document.createElement('video');
        video.src = URL.createObjectURL(file);
        await new Promise(r => video.onloadedmetadata = r);
        
        // 传入回调函数
        frames = await extractFrames(video, currentFps, onFrameProgress);
        
        URL.revokeObjectURL(video.src);
        video.remove();
        
        state.videoFramesCache.set(file.name, { frames, fps: currentFps });
        completed++;
    }
    
    updateProgress(100, '所有视频抽帧完成，请开始分析');
    state.isProcessing = false;
    state.videoAnalysisReady = true;
    
    els.startBtn.disabled = false;
    els.startBtn.classList.remove('bg-gray-400', 'cursor-not-allowed');
    els.startBtn.classList.add('bg-indigo-600', 'hover:bg-indigo-700');
    els.btnText.textContent = "开始分析"; 
}


