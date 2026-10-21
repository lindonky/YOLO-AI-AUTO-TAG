/* Result views use stable file references; sorting never changes processing state. */
(function () {
    'use strict';
    const $ = id => document.getElementById(id);
    const natural = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });
    function sequence(result) {
        const info = result.numberRecognition;
        return info?.status === 'recognized' && /^\d{1,32}$/.test(info.sequence || '') ? info.sequence : null;
    }
    function compare(a, b, mode) {
        if (mode.startsWith('sequence')) {
            const x = sequence(a.result), y = sequence(b.result);
            if (x === null || y === null) return x === y ? natural.compare(a.result.fileName,b.result.fileName) : x === null ? 1 : -1;
            const nx = BigInt(x), ny = BigInt(y);
            if (nx !== ny) return (nx < ny ? -1 : 1) * (mode.endsWith('desc') ? -1 : 1);
        }
        return mode === 'completed' ? a.index-b.index : natural.compare(a.result.fileName,b.result.fileName) || a.index-b.index;
    }
    function numberText(result) {
        const info = result.numberRecognition;
        if (!info || info.status === 'disabled') return '图片数字：未启用';
        const labels = { none:'未发现数字', uncertain:'不确定', failed:'识别失败', recognized:'已识别' };
        return `图片数字：${info.numbers?.join('、') || labels[info.status] || '待确认'}${info.sequence != null ? ` · 序号 ${info.sequence}` : ''}${info.status === 'uncertain' ? '（不确定，不参与序号排序）' : ''}${info.corrected ? ' · 人工更正' : ''}`;
    }
    function make(tag, text, className) {
        const element = document.createElement(tag);
        if (text !== undefined) element.textContent = text;
        if (className) element.className = className;
        return element;
    }
    const inspector = {
        queued:false,
        schedule() {
            if (this.queued) return;
            this.queued=true;
            requestAnimationFrame(() => { this.queued=false; this.render(); });
        },
        results() {
            if (state.isVideoMode) {
                const rows=(state.videoResults || []).map((result,index)=>({result,index}));
                if(state.file && !rows.some(({result})=>result.fileName===state.file.name))rows.push({index:-1,result:{file:state.file,fileName:state.file.name,annotations:state.annotations || []}});
                return rows;
            }
            return (state.imageResults || []).map((result,index) => ({result,index}));
        },
        render() {
            if (!$('timelineResults')?.classList.contains('hidden')) this.renderTimeline();
            if (!$('cropPreview')?.classList.contains('hidden')) this.renderCrops();
        },
        renderTimeline() {
            const container=$('timelineContent'); if (!container) return;
            const query=($('timelineSearch')?.value || '').trim().toLocaleLowerCase();
            const all=this.results();
            const rows=all.filter(({result}) => [result.fileName,...(result.annotations || []).map(a=>a.label),...(result.numberRecognition?.numbers || []),result.numberRecognition?.sequence || ''].join(' ').toLocaleLowerCase().includes(query));
            rows.sort((a,b)=>compare(a,b,$('timelineSort')?.value || 'file'));
            $('timelineCount').textContent=`显示 ${rows.length} / ${all.length} 个文件`;
            const fragment=document.createDocumentFragment();
            for (const {result,index} of rows) {
                const section=make('section',undefined,'result-file'); section.dataset.fileName=result.fileName;
                const header=make('button',`${result.fileName}（${result.annotations.length} 个目标）${result.needsReview ? ' · 待人工复核' : result.verifiedEmpty ? ' · 已复核无目标' : ''}`,'result-file-title');
                header.type='button'; header.addEventListener('click',()=>this.navigate(result)); section.append(header);
                if (!state.isVideoMode) {
                    const line=make('div',numberText(result),'result-number');line.title=result.numberRecognition?.reason || '';
                    const edit=make('button','更正序号');edit.type='button';edit.className='result-edit-number';
                    edit.disabled=state.isProcessing;
                    edit.title=state.isProcessing?'识别结束后可更正序号':'手动填写或清空图片排序序号';
                    edit.addEventListener('click',()=>{
                        const value=prompt('填写图片排序序号（仅0—9，保留前导零）；留空表示不参与序号排序。',sequence(result) || '');
                        if (value===null) return;
                        const number=value.trim();if(number && !/^\d{1,32}$/.test(number)) { alert('序号须为1—32位数字');return; }
                        const previous=result.numberRecognition || {status:'disabled',numbers:[],sequence:null};
                        result.numberRecognition={...previous,original:previous.original || {...previous},status:number?'recognized':'none',numbers:number?[...new Set([...(previous.numbers || []),number])]:[],sequence:number || null,corrected:true};
                        this.schedule();
                    });line.append(edit);section.append(line);
                }
                for (const [annIndex,ann] of result.annotations.entries()) {
                    const row=make('div',undefined,'result-ann');
                    const go=make('button',`${state.isVideoMode ? Number(ann.time || 0).toFixed(2)+'s' : '#'+(annIndex+1)}  ${ann.label}`);go.type='button';go.addEventListener('click',()=>this.navigate(result,ann));row.append(go);
                    for (const url of [ann.previewDataUrl,ann.transparentPreviewUrl].filter(Boolean)) row.append(this.thumbnail(url,ann.label,result,ann));
                    section.append(row);
                }
                fragment.append(section);
            }
            container.replaceChildren(fragment);
            if (!rows.length) container.append(make('p',all.length?'没有匹配的结果':'暂无识别结果','result-empty'));
        },
        renderCrops() {
            const fragment=document.createDocumentFragment();let count=0;
            for (const {result} of this.results()) for (const ann of result.annotations) {
                if (!ann.previewDataUrl) continue;
                const card=make('div',undefined,'result-crop');card.dataset.fileName=result.fileName;
                card.append(this.thumbnail(ann.previewDataUrl,`${result.fileName} · ${ann.label}`,result,ann));
                card.append(make('p',`${result.fileName} · ${ann.label}`));fragment.append(card);count++;
            }
            if (!count) fragment.append(make('p','暂无裁剪图；先完成图片识别。人工改框后可点击时间轴定位原图。','result-empty'));
            $('cropGallery')?.replaceChildren(fragment);
        },
        thumbnail(url,label,result,ann) {
            const button=make('button',undefined,'result-thumbnail');button.type='button';button.title='点击放大预览';button.setAttribute('aria-label',`放大预览 ${label}`);
            const img=make('img');img.src=url;img.alt=label;img.loading='lazy';button.append(img);
            button.addEventListener('click',()=>this.openPreview(url,label,result,ann));return button;
        },
        navigate(result,ann) {
            const index=state.files.findIndex(f=>f===result.file || f.name===result.fileName);
            if (state.isVideoMode) {
                const seek=()=>{if(ann){els.videoPlayer.currentTime=Number(ann.time || 0);els.videoPlayer.pause();}};
                if(index>=0 && state.file!==state.files[index]){els.videoPlayer.addEventListener('loadeddata',seek,{once:true});window.switchFile(index);}else seek();
                return;
            }
            if(index>=0) window.switchFile(index);
        },
        openPreview(url,label,result,ann) {
            const previous=document.activeElement;
            const dialog=make('dialog',undefined,'result-preview-dialog');dialog.id='cropZoomDialog';
            dialog.append(make('p',label));const image=make('img');image.src=url;image.alt=label;dialog.append(image);
            const close=make('button','关闭预览');close.type='button';close.addEventListener('click',()=>dialog.close());dialog.append(close);
            const go=make('button','定位原图');go.type='button';go.addEventListener('click',()=>{this.navigate(result,ann);dialog.close();});dialog.append(go);
            dialog.addEventListener('click',e=>{if(e.target===dialog){const r=dialog.getBoundingClientRect();if(e.clientX<r.left || e.clientX>r.right || e.clientY<r.top || e.clientY>r.bottom)dialog.close();}});
            dialog.addEventListener('close',()=>{dialog.remove();previous?.focus();},{once:true});document.body.append(dialog);dialog.showModal();close.focus();
        },
        compare,sequence
    };
    window.ResultInspector=inspector;
    $('timelineSearch')?.addEventListener('input',()=>inspector.schedule());
    $('timelineSort')?.addEventListener('change',()=>inspector.schedule());
    $('timelineResultsBtn')?.addEventListener('click',()=>inspector.schedule());
    $('cropPreviewBtn')?.addEventListener('click',()=>inspector.schedule());
    inspector.schedule();
})();
