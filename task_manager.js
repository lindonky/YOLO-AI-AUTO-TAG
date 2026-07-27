/**
 * 任务管理模块 (Task Manager)
 * 负责任务的暂停、恢复、结束、导出(备份)与导入(断点续传)
 */

const TaskManager = {
    isPaused: false,
    isStopped: false,
    backupIntervalId: null,
    autoBackupEnabled: true,
    backupIntervalMinutes: 30,

    init() {
        // UI Binding
        const pauseBtn = document.getElementById('pauseBtn');
        const resumeBtn = document.getElementById('resumeBtn');
        const stopBtn = document.getElementById('stopBtn');
        const exportTaskButtons = ['exportTaskBtn', 'exportTaskQuickBtn']
            .map(id => document.getElementById(id))
            .filter(Boolean);
        const importInputs = ['importTaskInput', 'importTaskQuickInput']
            .map(id => document.getElementById(id))
            .filter(Boolean);
        const backupIntervalInput = document.getElementById('autoBackupInterval');
        const backupEnabledInput = document.getElementById('autoBackupEnabled');

        const closeTaskMenus = () => {
            document.getElementById('fileMenu')?.classList.add('hidden');
            document.getElementById('settingsMenu')?.classList.add('hidden');
        };

        if (pauseBtn) pauseBtn.onclick = () => this.pause();
        if (resumeBtn) resumeBtn.onclick = () => this.resume();
        if (stopBtn) stopBtn.onclick = () => this.stop();
        exportTaskButtons.forEach(button => {
            button.onclick = async () => {
                closeTaskMenus();
                exportTaskButtons.forEach(item => { item.disabled = true; });
                try {
                    await this.exportTask(false);
                } finally {
                    exportTaskButtons.forEach(item => { item.disabled = false; });
                }
            };
        });

        importInputs.forEach(importInput => {
            importInput.onchange = async (e) => {
                if (e.target.files.length > 0) {
                    closeTaskMenus();
                    await this.importTask(e.target.files[0]);
                }
                // 清空 input，允许重复导入同名文件
                e.target.value = '';
            };
        });

        if (backupIntervalInput) {
            backupIntervalInput.onchange = (e) => {
                this.backupIntervalMinutes = parseInt(e.target.value) || 30;
                this.resetAutoBackup();
            };
        }

        if (backupEnabledInput) {
            backupEnabledInput.onchange = (e) => {
                this.autoBackupEnabled = e.target.checked;
                this.resetAutoBackup();
            };
        }

        // 覆盖原始的并发执行函数以注入暂停/停止逻辑
        this.originalRunWithConcurrency = window.runWithConcurrency;
        window.runWithConcurrency = this.runWithConcurrencyOverride.bind(this);
    },

    startTaskLifecycle() {
        this.isPaused = false;
        this.isStopped = false;
        this.updateUIState('running');
        this.resetAutoBackup();
    },

    endTaskLifecycle() {
        this.isPaused = false;
        this.isStopped = false;
        this.updateUIState('idle');
        this.stopAutoBackup();
    },

    pause() {
        this.isPaused = true;
        this.updateUIState('paused');
        els.statusMsg.textContent = '任务已暂停...';
    },

    resume() {
        this.isPaused = false;
        this.updateUIState('running');
        els.statusMsg.textContent = '任务继续执行...';
    },

    stop() {
        if (confirm('确定要结束当前任务吗？结束后的数据可以正常导出。')) {
            this.isStopped = true;
            this.resume(); // 恢复以跳出循环
        }
    },

    updateUIState(state) {
       const startBtn = document.getElementById('startBtn');
        const taskControls = document.getElementById('taskControls');
        const pauseBtn = document.getElementById('pauseBtn');
        const resumeBtn = document.getElementById('resumeBtn');

        if (state === 'idle') {
            startBtn.classList.remove('hidden');
            taskControls.classList.add('hidden');
            // 确保按钮可用
            startBtn.disabled = false;
            startBtn.classList.remove('bg-gray-400', 'cursor-not-allowed');
            startBtn.classList.add('bg-indigo-600', 'hover:bg-indigo-700');
        } else if (state === 'running') {
            startBtn.classList.add('hidden');
            taskControls.classList.remove('hidden');
            pauseBtn.classList.remove('hidden');
            resumeBtn.classList.add('hidden');
        } else if (state === 'paused') {
            pauseBtn.classList.add('hidden');
            resumeBtn.classList.remove('hidden');
        }
    },

    resetAutoBackup() {
        this.stopAutoBackup();
        if (this.autoBackupEnabled && (state.isProcessing || this.isPaused)) {
            console.log(`Auto backup scheduled every ${this.backupIntervalMinutes} minutes.`);
            this.backupIntervalId = setInterval(() => {
                this.exportTask(true);
            }, this.backupIntervalMinutes * 60 * 1000);
        }
    },

    stopAutoBackup() {
        if (this.backupIntervalId) {
            clearInterval(this.backupIntervalId);
            this.backupIntervalId = null;
        }
    },

    async chooseTaskExportDestination(fileName) {
        const desktopApi = window.pywebview?.api;
        if (desktopApi?.choose_task_export_path) {
            const selected = await desktopApi.choose_task_export_path(fileName);
            if (!selected?.ok) {
                if (selected?.cancelled) return null;
                throw new Error(selected?.message || '无法打开保存位置选择窗口');
            }
            return {
                kind: 'desktop',
                token: selected.token,
                path: selected.path,
                fileName
            };
        }

        if (window.showSaveFilePicker) {
            try {
                const handle = await window.showSaveFilePicker({
                    suggestedName: fileName,
                    types: [{
                        description: 'YOLO Auto-Tag 任务包',
                        accept: { 'application/zip': ['.zip'] }
                    }]
                });
                return { kind: 'file-picker', handle, fileName };
            } catch (error) {
                if (error?.name === 'AbortError') return null;
                throw error;
            }
        }

        return { kind: 'download', fileName };
    },

    async saveTaskBlob(blob, destination, isBackup = false) {
        if (destination.kind === 'desktop') {
            const response = await fetch(`/api/task-export/${encodeURIComponent(destination.token)}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/zip' },
                body: blob
            });
            const result = await response.json().catch(() => ({}));
            if (!response.ok || !result.ok) {
                throw new Error(result.message || `保存任务包失败（HTTP ${response.status}）`);
            }
            return { confirmed: true, path: result.path || destination.path };
        }

        if (destination.kind === 'file-picker') {
            const writable = await destination.handle.createWritable();
            try {
                await writable.write(blob);
                await writable.close();
            } catch (error) {
                try { await writable.abort(); } catch {}
                throw error;
            }
            return { confirmed: true, path: destination.handle.name || destination.fileName };
        }

        const objectUrl = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = objectUrl;
        link.download = destination.fileName;
        link.style.display = 'none';
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
        return { confirmed: false, path: destination.fileName, isBackup };
    },
    
    async runWithConcurrencyOverride(items, worker, concurrency) {
        this.startTaskLifecycle();
        const processedNames = new Set();
        
        // 只有非视频模式才跳过已处理的；视频模式可能需要继续
        if (!state.isVideoMode) {
            state.imageResults.forEach(r => {
                const hasAnnotations = Array.isArray(r.annotations) && r.annotations.length > 0;
                // 待复核结果和旧版本产生的未验证空结果必须允许重新处理。
                if (!r.needsReview && (hasAnnotations || r.verifiedEmpty === true)) {
                    processedNames.add(r.fileName);
                }
            });
        } else {
             // 视频模式下由 worker 内部逻辑判断是否断点续传，这里不跳过
        }

        let index = 0;
        const total = items.length;
        
        // 并发 Promise 池
        const runners = new Array(Math.min(concurrency, items.length)).fill(0).map(async () => {
            while (index < items.length) {
                if (this.isStopped) break;
                
                // 暂停检查
                while (this.isPaused) {
                    if (this.isStopped) break;
                    await new Promise(r => setTimeout(r, 500));
                }
                if (this.isStopped) break;

                // 取任务
                const currentIndex = index++; 
                if (currentIndex >= items.length) break;
                
                const item = items[currentIndex];

                // 图片模式跳过逻辑
                if (!state.isVideoMode && processedNames.has(item.name)) {
                    continue;
                }
                
                try {
                    await worker(item);
                } catch (err) {
                    console.error("Worker error:", err);
                }
            }
        });

        await Promise.all(runners);
        this.endTaskLifecycle();
        if (this.isStopped) {
            els.statusMsg.textContent = '任务已手动结束';
        }
    },

    async exportTask(isBackup = false) {
        if (!state.files || state.files.length === 0) {
            if (!isBackup) alert('没有可导出的任务数据');
            return false;
        }

        const statusMsg = els.statusMsg.textContent;
        const fileName = isBackup
            ? `autotag_backup_${Date.now()}.zip`
            : `autotag_task_export_${Date.now()}.zip`;
        let destination = { kind: 'download', fileName };
        let completed = false;

        try {
            if (!isBackup) {
                els.statusMsg.textContent = '请选择任务包保存位置...';
                destination = await this.chooseTaskExportDestination(fileName);
                if (!destination) {
                    els.statusMsg.textContent = '已取消导出任务包';
                    return false;
                }
                els.statusMsg.textContent = '正在打包任务数据...';
            }
            if (state.teachingDraftDirty && typeof saveTeachingExample === 'function') {
                saveTeachingExample(false);
            }
            const zip = new JSZip();
            
            const isVideo = state.isVideoMode;
            const exportOpts = [];
            const checkboxes = document.querySelectorAll(isVideo ? 'input[name="exportOptVid"]:checked' : 'input[name="exportOptImg"]:checked');
            checkboxes.forEach(cb => exportOpts.push(cb.value));

            // 获取视频相关的设置
            const frameRateInput = document.getElementById('frameRate');
            const manualFrameInput = document.getElementById('manualFrame');

            // 保存元数据
            const taskConfig = {
                timestamp: Date.now(),
                mode: isVideo ? 'video' : 'image',
                model: els.modelSelect.value,
                prompt: els.promptInput.value,
                classLabel: els.classLabelInput.value, // 保存类别名
                scaleFactor: els.scaleFactor.value,
                apiRpm: els.apiRpm.value,
                parallelCount: els.parallelCountGlobal.value,
                exportOptions: exportOpts,
                // [NEW] 保存视频设置，用于导入时恢复UI
                frameRate: frameRateInput ? frameRateInput.value : '1',
                manualFrame: manualFrameInput ? manualFrameInput.checked : false,
                teachingExamples: Array.isArray(state.teachingExamples)
                    ? state.teachingExamples
                    : [],
                // 保存结果数据 (移除 file 引用)
                results: isVideo ? state.videoResults : state.imageResults
            };

            const safeResults = (isVideo ? state.videoResults : state.imageResults).map(item => {
                const copy = { ...item };
                delete copy.file; // 移除 File 对象避免循环引用
                return copy;
            });
            taskConfig.results = safeResults;

            zip.file("task_config.json", JSON.stringify(taskConfig, null, 2));

            // 保存源文件
            const filesFolder = zip.folder("files");
            for (const file of state.files) {
                filesFolder.file(file.name, file);
            }

            const content = await zip.generateAsync(
                { type: "blob" },
                metadata => {
                    if (!isBackup) {
                        els.statusMsg.textContent = `正在打包任务数据... ${Math.round(metadata.percent || 0)}%`;
                    }
                }
            );
            const saved = await this.saveTaskBlob(content, destination, isBackup);

            if (isBackup) {
                completed = true;
            } else {
                completed = true;
                if (saved.confirmed) {
                    els.statusMsg.textContent = `任务包已保存：${saved.path}`;
                    alert(`任务包已保存到：\n${saved.path}`);
                } else {
                    els.statusMsg.textContent = `任务包已提交到浏览器下载：${saved.path}`;
                    alert(`当前浏览器不支持选择完整保存路径。\n任务包已提交到浏览器下载，请在下载列表或默认“下载”文件夹中查找：\n${saved.path}`);
                }
            }
            return true;
        } catch (e) {
            console.error('Export failed', e);
            els.statusMsg.textContent = '导出失败: ' + e.message;
            if (!isBackup) alert('导出任务包失败：' + e.message);
            return false;
        } finally {
            if (!isBackup && !completed && els.statusMsg.textContent.startsWith('正在')) {
                els.statusMsg.textContent = statusMsg;
            }
        }
    },

    async importTask(zipFile) {
        els.statusMsg.textContent = '正在导入任务...';
        try {
            const zip = await JSZip.loadAsync(zipFile);
            const configText = await zip.file("task_config.json").async("string");
            const taskConfig = JSON.parse(configText);

            // 1. 恢复模式
            if ((taskConfig.mode === 'video' && !state.isVideoMode) || (taskConfig.mode === 'image' && state.isVideoMode)) {
                els.modeToggle.checked = (taskConfig.mode === 'video');
                els.modeToggle.dispatchEvent(new Event('change'));
            }
            
            // 2. 恢复通用UI设置
            els.modelSelect.value = taskConfig.model || els.modelSelect.value;
            els.promptInput.value = taskConfig.prompt || '';
            if (els.classLabelInput) els.classLabelInput.value = taskConfig.classLabel || ''; // 恢复类别名
            if (taskConfig.scaleFactor) els.scaleFactor.value = taskConfig.scaleFactor;
            if (taskConfig.parallelCount) els.parallelCountGlobal.value = taskConfig.parallelCount;
            state.teachingExamples = Array.isArray(taskConfig.teachingExamples)
                ? taskConfig.teachingExamples
                : [];
            state.teachingDraftBoxes = [];
            state.teachingDraftBox = null;
            state.teachingDraftDirty = false;
            if (typeof updateTeachingStatus === 'function') updateTeachingStatus();
            
            // 3. [NEW] 恢复视频模式特有设置 (FPS 和 手动抽帧状态)
            if (taskConfig.mode === 'video') {
                if (taskConfig.frameRate && document.getElementById('frameRate')) {
                    document.getElementById('frameRate').value = taskConfig.frameRate;
                }
                if (taskConfig.manualFrame !== undefined && document.getElementById('manualFrame')) {
                    const cb = document.getElementById('manualFrame');
                    cb.checked = taskConfig.manualFrame;
                    // 触发事件以显示/隐藏 FPS 输入框（依赖 main.js 的事件监听）
                    cb.dispatchEvent(new Event('change')); 
                }
            }

            // 4. 恢复复选框 (导出选项)
            if (taskConfig.exportOptions) {
                const isVideo = (taskConfig.mode === 'video');
                const checkboxes = document.querySelectorAll(isVideo ? 'input[name="exportOptVid"]' : 'input[name="exportOptImg"]');
                checkboxes.forEach(cb => {
                    cb.checked = taskConfig.exportOptions.includes(cb.value);
                });
            }

            // 5. 恢复文件对象
            const filesFolder = zip.folder("files");
            const restoredFiles = [];
            const filePromises = [];
            filesFolder.forEach((relativePath, fileEntry) => {
                filePromises.push(async () => {
                    const blob = await fileEntry.async("blob");
                    const file = new File([blob], relativePath, { type: blob.type });
                    restoredFiles.push(file);
                });
            });

            await Promise.all(filePromises.map(fn => fn()));
            // 按文件名排序，保证列表顺序一致
            restoredFiles.sort((a, b) => a.name.localeCompare(b.name));
            
            state.files = restoredFiles;
            state.file = restoredFiles[0];
            
            // 重要：重置视频状态，因为导入后需要重新走“抽帧”流程（利用缓存或重新解码）
            if (taskConfig.mode === 'video') {
                state.videoAnalysisReady = false; 
                state.videoFramesCache = new Map(); // 清空旧缓存
                els.btnText.textContent = "开始抽帧";
            }
            
            renderFileList();

            // 6. 恢复分析结果
            const restoredResults = taskConfig.results.map(r => {
                const matchingFile = restoredFiles.find(f => f.name === r.fileName);
                return { ...r, file: matchingFile, fps: r.fps || parseFloat(taskConfig.frameRate || 1) };
            });

            if (taskConfig.mode === 'video') {
                state.videoResults = restoredResults;
                els.statusMsg.textContent = `已恢复 ${restoredResults.length} 个视频的处理记录`;
            } else {
                state.imageResults = restoredResults;
                document.getElementById('timelineContent').innerHTML = '';
                document.getElementById('cropGallery').innerHTML = '';
                restoredResults.forEach((r, idx) => {
                    if (Array.isArray(r.annotations)) {
                        appendTimelineItem(r.file, r.annotations, idx, r);
                        if (r.annotations.length > 0) appendCropGallery(r.annotations);
                    }
                });
                els.statusMsg.textContent = `已恢复 ${restoredResults.length} 张图片的处理结果`;
            }

            if (restoredFiles.length > 0 && typeof switchFile === 'function') {
                switchFile(0);
            }

            // 7. 自动开始/继续
            if (confirm(`导入成功！共 ${restoredFiles.length} 个文件。\n是否立即恢复现场并继续执行？\n(视频任务将根据保存的FPS自动重新定位，数据不会丢失)`)) {
                // 调用 main.js 的 startAnalysis，它会自动判断是抽帧还是分析
                window.startAnalysis(); 
            }

        } catch (e) {
            console.error('Import failed', e);
            alert('导入任务失败: ' + e.message);
            els.statusMsg.textContent = '导入失败';
        }
    }
};

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => TaskManager.init());
} else {
    TaskManager.init();
}
