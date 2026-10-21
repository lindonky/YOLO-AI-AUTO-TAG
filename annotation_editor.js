/* Pointer/keyboard editor. Each completed gesture is exactly one undo command. */
(function () {
    'use strict';
    const clamp = (n,a,b) => Math.max(a,Math.min(b,n));
    const escape = value => String(value ?? '').replace(/[&<>"']/g,c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    const clone = value => JSON.parse(JSON.stringify(value));
    const editable = target => target?.closest('input,textarea,select,[contenteditable="true"]');
    const geometry = box => ReviewState.validGeometry(box);
    const caption = box => box?.unclassified || !box?.label ? '未分类' : box.label;
    const color = label => label ? `hsl(${[...label].reduce((sum,c)=>sum+c.charCodeAt(0),0)%360} 80% 65%)` : '#fbbf24';

    function markup(categories) {
        return `<aside class="rw-editor-backdrop" aria-hidden="true"><section class="rw-editor ae-editor" role="dialog" aria-modal="true" aria-labelledby="rwEditorTitle" tabindex="-1">
          <header class="rw-editor-head"><div><div class="rw-kicker">人工标注 / 修改实时写入任务</div><h2 id="rwEditorTitle">—</h2></div><button class="rw-icon-button" data-rw-editor-close type="button" aria-label="关闭标注编辑器">×</button></header>
          <div class="rw-editor-content"><div class="rw-editor-main">
            <div class="rw-editor-tools ae-toolbar" role="toolbar" aria-label="标注工具">
              <div class="ae-tool-group"><button data-ae-tool="select" title="选择、移动和缩放 (V)">↖ 选择 <kbd>V</kbd></button><button data-ae-tool="draw" data-rw-add-box title="左键拖动画矩形 (R / W)">▭ 标注 <kbd>R</kbd></button></div>
              <div class="ae-tool-group"><button data-ae-undo title="撤销 (Ctrl+Z)" aria-label="撤销">↶</button><button data-ae-redo title="重做 (Ctrl+Shift+Z / Ctrl+Y)" aria-label="重做">↷</button><button data-ae-duplicate title="复制选中框 (Ctrl+D)">复制</button><button data-ae-delete title="删除选中框 (Delete)">删除</button></div>
              <label class="ae-active-class"><span data-ae-class-caption>绘制类别</span><select data-ae-current-class aria-label="当前标注类别"></select></label>
              <button data-ae-manage title="增删改作用于整个任务">全局类别</button>
            </div>
            <div class="rw-editor-stage ae-stage" tabindex="0" aria-label="标注画布"><img alt="当前复核图片" draggable="false"><div class="rw-editor-box-layer"></div><span class="rw-stage-size">读取原图尺寸…</span><div class="ae-canvas-hint" data-ae-hint></div></div>
            <div class="rw-editor-nav"><button class="rw-mini-button" data-rw-editor-prev type="button">← 上一张 <kbd>A</kbd></button><span data-rw-editor-position>0 / 0</span><button class="rw-mini-button" data-rw-editor-next type="button">下一张 <kbd>D</kbd> →</button><button class="rw-mini-button" data-ae-help>快捷键 ?</button></div>
          </div><aside class="rw-editor-side">
            <section class="rw-side-section"><label class="rw-field-label" for="rwCategorySelect">图片分类</label><select id="rwCategorySelect" class="rw-category-select">${categories.map(([key,name])=>`<option value="${key}">${name}</option>`).join('')}</select><div class="rw-rule-message"></div></section>
            <details class="rw-side-section ae-catalog"><summary>全局类别 <span data-ae-class-count></span></summary><p>改名应用于整个任务。删除类别后，原框保留为未分类；可撤销。</p><div data-ae-class-list></div><form data-ae-add-form><input data-ae-add-name placeholder="新类别名称" aria-label="新类别名称" maxlength="80"><button type="submit">＋ 添加</button></form><div class="ae-form-error" data-ae-class-error role="status"></div></details>
            <section class="rw-side-section rw-side-grow"><div class="rw-section-title"><span>标注框</span><b data-rw-box-count>0 个</b></div><div class="rw-box-list"></div></section>
            <details class="rw-side-section rw-txt-section ae-txt"><summary>YOLO TXT 预览 <span data-rw-txt-size></span></summary><pre class="rw-txt-preview"></pre><p class="rw-txt-note">未分类框保留在任务中，不生成有效 YOLO 行。</p></details>
          </aside></div>
          <footer class="rw-editor-foot"><div class="rw-autosave" data-ae-status role="status"><i></i>实时保存到当前任务</div><button class="rw-button rw-button-ghost" data-rw-editor-close>关闭</button><button class="rw-button rw-button-ghost" data-rw-confirm-current>确认正常图 <kbd>Ctrl+Enter</kbd></button><button class="rw-button rw-button-primary" data-rw-editor-done>完成并返回任务台</button></footer>
          <div class="ae-context" role="menu" hidden><strong data-ae-context-title></strong><label>框的类别<select data-ae-context-class aria-label="右键修改类别"></select></label><button data-ae-action="unclassify">设为未分类</button><button data-ae-action="duplicate">复制框 <kbd>Ctrl+D</kbd></button><button data-ae-action="delete">删除框 <kbd>Del</kbd></button><hr><button data-ae-action="undo">撤销 <kbd>Ctrl+Z</kbd></button><button data-ae-action="redo">重做 <kbd>Ctrl+Y</kbd></button></div>
          <div class="ae-help" hidden><button data-ae-help-close aria-label="关闭快捷键帮助">×</button><h3>标注快捷键</h3><p>R / W 标注 · V 选择 · 左键拖动画框</p><p>画布滚轮切换类别；选择模式下同步修改选中框。</p><p>Delete / Backspace 删除 · Ctrl+D 复制</p><p>Ctrl+Z 撤销 · Ctrl+Y / Ctrl+Shift+Z 重做</p><p>方向键微调 1 像素，Shift+方向键微调 10 像素</p><p>A / D 或 PageUp / PageDown 切换图片</p><p>1–9 / 0 快选前十类 · Tab / Shift+Tab 切换框</p><p>Esc 取消拖动 / 收起菜单 / 取消选择 / 切到选择工具</p><p>Ctrl+Enter 确认正常图 · Ctrl+S 保存可恢复任务包</p><small>仅画布区域滚轮切换类别，侧栏可正常滚动。输入框内保留文字编辑快捷键。</small></div>
        </section></aside>`;
    }

    class Editor {
        constructor(options) {
            this.o=options; this.root=options.root; this.backdrop=this.root.querySelector('.rw-editor-backdrop');
            this.dialog=this.backdrop.querySelector('.rw-editor'); this.stage=this.dialog.querySelector('.rw-editor-stage');
            this.image=this.stage.querySelector('img'); this.layer=this.stage.querySelector('.rw-editor-box-layer');
            this.menu=this.dialog.querySelector('.ae-context'); this.help=this.dialog.querySelector('.ae-help');
            this.result=null; this.selected=-1; this.tool='select'; this.label=''; this.undoStack=[]; this.redoStack=[]; this.gesture=null; this.wheelSum=0;
            this.bind();
        }
        q(selector) { return this.dialog.querySelector(selector); }
        open(result) {
            if (state.isProcessing) return this.o.notify('请先结束识别，再进行人工标注',true);
            if (this.taskFiles!==state.files || this.taskResults!==state.imageResults) { this.undoStack=[]; this.redoStack=[]; this.taskFiles=state.files; this.taskResults=state.imageResults; }
            this.cancelGesture(); this.result=result; this.selected=result.annotations.length ? 0 : -1;
            const labels=TaskClasses.ensure(); if (!labels.includes(this.label)) this.label=labels[0] || '';
            this.lastFocus=document.activeElement; this.backdrop.classList.add('rw-open'); this.backdrop.setAttribute('aria-hidden','false');
            this.render(); this.stage.focus({preventScroll:true});
        }
        close() {
            if (!this.result) return;
            this.cancelGesture(); this.hideMenu(); this.help.hidden=true;
            const result=this.result; this.result=null; this.backdrop.classList.remove('rw-open'); this.backdrop.setAttribute('aria-hidden','true');
            this.o.changed(result); this.o.renderBoard(); this.lastFocus?.focus?.({preventScroll:true});
        }
        navigate(delta) {
            const all=this.o.results(),index=all.indexOf(this.result); if(index<0 || !all.length)return;
            this.cancelGesture(); this.hideMenu(); this.result=all[(index+delta+all.length)%all.length]; this.selected=this.result.annotations.length?0:-1;
            this.render(); this.stage.focus({preventScroll:true});
        }
        bind() {
            this.dialog.querySelectorAll('[data-rw-editor-close],[data-rw-editor-done]').forEach(b=>b.addEventListener('click',()=>this.close()));
            this.backdrop.addEventListener('pointerdown',e=>{if(e.target===this.backdrop)this.close();});
            this.dialog.querySelectorAll('[data-ae-tool]').forEach(b=>b.addEventListener('click',()=>this.setTool(b.dataset.aeTool)));
            this.q('[data-ae-undo]').onclick=()=>this.history(false); this.q('[data-ae-redo]').onclick=()=>this.history(true);
            this.q('[data-ae-delete]').onclick=()=>this.delete(); this.q('[data-ae-duplicate]').onclick=()=>this.duplicate();
            this.q('[data-rw-editor-prev]').onclick=()=>this.navigate(-1); this.q('[data-rw-editor-next]').onclick=()=>this.navigate(1);
            this.q('[data-ae-current-class]').onchange=e=>{this.chooseClass(e.target.value);this.stage.focus({preventScroll:true});};
            this.q('[data-rw-confirm-current]').onclick=()=>this.confirm();
            this.q('#rwCategorySelect').onchange=e=>this.local('修改图片分类',()=>{this.result.reviewCategory=e.target.value;});
            this.q('[data-ae-manage]').onclick=()=>{this.q('.ae-catalog').open=!this.q('.ae-catalog').open;this.layout();};
            this.q('[data-ae-add-form]').onsubmit=e=>{e.preventDefault();const input=this.q('[data-ae-add-name]');if(this.editClass({kind:'add',to:input.value})){input.value='';}};
            this.q('[data-ae-help]').onclick=()=>this.help.hidden=!this.help.hidden; this.q('[data-ae-help-close]').onclick=()=>{this.help.hidden=true;this.stage.focus();};
            this.layer.addEventListener('pointerdown',e=>this.pointerDown(e));
            this.layer.addEventListener('contextmenu',e=>this.context(e));
            this.stage.addEventListener('wheel',e=>this.wheel(e),{passive:false});
            this.menu.addEventListener('click',e=>{const action=e.target.closest('[data-ae-action]')?.dataset.aeAction;if(!action)return;
                if(action==='unclassify')this.assign('');else if(action==='undo'||action==='redo')this.history(action==='redo');else this[action]();this.hideMenu();this.stage.focus();});
            this.q('[data-ae-context-class]').onchange=e=>{this.assign(e.target.value);this.hideMenu();this.stage.focus();};
            document.addEventListener('pointerdown',e=>{if(!this.menu.contains(e.target))this.hideMenu();});
            document.addEventListener('keydown',e=>this.key(e),true);
            window.addEventListener('blur',()=>this.cancelGesture());
            new ResizeObserver(()=>{this.cancelGesture();this.layout();}).observe(this.stage);
            document.addEventListener('annotation-task-restored',()=>{
                this.cancelGesture();this.hideMenu();this.help.hidden=true;this.result=null;
                this.backdrop.classList.remove('rw-open');this.backdrop.setAttribute('aria-hidden','true');
                this.undoStack=[];this.redoStack=[];
            });
        }
        setTool(tool) {
            this.cancelGesture(); this.hideMenu(); this.tool=tool;
            if(tool==='draw') { AnnotationDisplay?.set('annotations',true); this.selected=-1; }
            this.renderBoxes();this.renderPanels();this.stage.focus({preventScroll:true});
        }
        record(command,name,result=this.result) {
            if(!command)return;
            this.undoStack.push({...command,name,result}); if(this.undoStack.length>60)this.undoStack.shift();this.redoStack=[];
            this.status(`${name} · Ctrl+Z 可撤销`); this.refresh();
        }
        local(name,change) {
            if(!this.result || this.gesture)return;
            const group=[{owner:this.result,key:'annotations',result:this.result}],undo=TaskClasses.capture(group);
            change();this.mark(name);this.record({undo,redo:TaskClasses.capture(group)},name);
        }
        mark(reason) {
            if(this.result.reviewCategory==='background' && this.result.annotations.length || this.result.annotations.some(box=>!ReviewState.validBox(box)))this.result.reviewCategory='error';
            this.o.syncFlags(this.result,reason);
        }
        history(redo) {
            if(this.gesture){this.cancelGesture();return;}
            const from=redo?this.redoStack:this.undoStack,to=redo?this.undoStack:this.redoStack,command=from.pop();if(!command)return;
            command[redo?'redo':'undo']();to.push(command);
            if(this.o.results().includes(command.result))this.result=command.result;
            const labels=TaskClasses.labels();if(!labels.includes(this.label))this.label=labels[0] || '';
            this.selected=clamp(this.selected,-1,this.result.annotations.length-1);this.status(`${redo?'重做':'撤销'}：${command.name}`);this.refresh();
        }
        refresh() {
            // The task data is already updated. Rebuilding hundreds of hidden cards
            // and the main timeline per stroke makes the editor unnecessarily slow.
            // Refresh those views once when the editor closes.
            this.hideMenu();this.render();
            if(typeof updateTeachingStatus==='function')updateTeachingStatus();
        }
        status(text) { this.q('[data-ae-status]').textContent=text; }
        render() {
            if(!this.result)return;
            const all=this.o.results(),index=all.indexOf(this.result);this.q('#rwEditorTitle').textContent=this.result.fileName || this.result.file?.name || '图片';
            this.q('[data-rw-editor-position]').textContent=`${index+1} / ${all.length}`;
            this.q('#rwCategorySelect').value=this.result.reviewCategory;
            this.image.onload=()=>{this.layout();this.q('.rw-stage-size').textContent=`${this.image.naturalWidth} × ${this.image.naturalHeight}`;};
            const url=this.o.url(this.result);if(this.image.getAttribute('src')!==url)this.image.src=url;
            this.renderBoxes();this.renderPanels();this.renderCatalog();this.layout();
        }
        layout() { if(this.image.naturalWidth)this.o.fit(this.image,this.layer,this.stage); }
        options(value,blank=true) {
            return `${blank?'<option value="">未分类</option>':''}${TaskClasses.labels().map((name,id)=>`<option value="${escape(name)}"${name===value?' selected':''}>${id} · ${escape(name)}</option>`).join('')}`;
        }
        renderBoxes() {
            this.layer.replaceChildren();if(!this.result)return;
            this.layer.dataset.tool=this.tool;
            this.result.annotations.forEach((ann,index)=>{
                if(!geometry(ann))return;
                const node=document.createElement('div');node.className=`rw-editor-box${index===this.selected?' rw-selected':''}${ann.unclassified || !ann.label?' ae-unclassified':''}`;node.dataset.boxIndex=index;node.style.setProperty('--ae-color',color(ann.label));this.style(node,ann.box_2d);
                const label=document.createElement('span');label.className='rw-editor-box-label';label.textContent=`${index+1} · ${caption(ann)}`;node.append(label);
                if(index===this.selected && this.tool==='select')for(const handle of ['nw','n','ne','e','se','s','sw','w']){const h=document.createElement('i');h.className=`rw-resize-handle ae-handle-${handle}`;h.dataset.handle=handle;node.append(h);}
                this.layer.append(node);
            });
        }
        style(node,box) { const[y1,x1,y2,x2]=box;Object.assign(node.style,{left:`${x1/10}%`,top:`${y1/10}%`,width:`${(x2-x1)/10}%`,height:`${(y2-y1)/10}%`}); }
        renderPanels() {
            if(!this.result)return;
            const boxes=this.result.annotations,ann=boxes[this.selected],labels=TaskClasses.labels();
            this.q('[data-ae-undo]').disabled=!this.undoStack.length;this.q('[data-ae-redo]').disabled=!this.redoStack.length;
            this.q('[data-ae-delete]').disabled=!ann;this.q('[data-ae-duplicate]').disabled=!geometry(ann);
            this.dialog.querySelectorAll('[data-ae-tool]').forEach(b=>b.setAttribute('aria-pressed',String(this.tool===b.dataset.aeTool)));
            const selector=this.q('[data-ae-current-class]');const selectedClass=this.tool==='select'&&ann ? (ann.unclassified?'':ann.label) : this.label;
            selector.innerHTML=this.options(selectedClass);selector.value=selectedClass || '';
            this.q('[data-ae-class-caption]').textContent=this.tool==='select'&&ann?'选中框类别':'绘制类别';
            this.q('[data-ae-hint]').textContent=this.tool==='draw'?'左键拖动画矩形 · 滚轮切换类别 · Esc 取消':'点击选框，拖动移动 / 八向缩放 · 右键更多操作';
            this.q('[data-ae-class-count]').textContent=`${labels.length} 类`;
            this.q('[data-rw-box-count]').textContent=`${boxes.length} 个${boxes.some(b=>b.unclassified||!b.label)?' · 含未分类':''}`;
            const issue=this.o.issue(this.result);const message=this.q('.rw-rule-message');message.classList.toggle('rw-error',!!issue);message.textContent=issue || (this.result.reviewCategory==='error'?'已有修改保留。检查完整后确认正常图，或将无目标的空图设为背景。':this.result.reviewCategory==='normal'?'正常图：保留有效框。修改实时写入当前任务。':'背景图：已确认整图无目标，TXT 保持为空。');
            const list=this.q('.rw-box-list');list.replaceChildren();
            if(!boxes.length)list.innerHTML='<p class="rw-empty-boxes">当前没有框<br>按 R 或点击“标注”，左键拖动画框。</p>';
            boxes.forEach((box,index)=>{
                const row=document.createElement('div');row.className=`rw-box-row${index===this.selected?' rw-selected':''}`;row.dataset.boxRow=index;
                row.innerHTML=`<span class="rw-box-index">${index+1}</span><span class="rw-box-copy"><b>${escape(caption(box))}</b><span>${geometry(box)?box.box_2d.map(n=>Number(n).toFixed(0)).join(' / '):'坐标无效'}</span></span><button class="rw-delete-box" aria-label="删除第 ${index+1} 个标注框">×</button>`;
                row.onclick=e=>{if(e.target.closest('button'))return;this.select(index);this.stage.focus({preventScroll:true});};
                row.querySelector('button').onclick=e=>{e.stopPropagation();this.selected=index;this.delete();};
                list.append(row);
            });
            const text=this.o.text(this.result);this.q('.rw-txt-preview').textContent=text;this.q('[data-rw-txt-size]').textContent=`${new TextEncoder().encode(text).length} B`;
            this.q('[data-rw-confirm-current]').disabled=!boxes.length || !boxes.every(ReviewState.validBox);
        }
        renderCatalog() {
            const list=this.q('[data-ae-class-list]');list.replaceChildren();
            TaskClasses.labels().forEach((name,id)=>{
                const row=document.createElement('div');row.className='ae-class-row';
                row.innerHTML=`<button class="ae-class-swatch" aria-label="选择类别 ${escape(name)}" style="--ae-color:${color(name)}">${id}</button><input aria-label="类别 ${id} 名称" value="${escape(name)}" maxlength="80"><button data-ae-rename title="全局改名">改名</button><button data-ae-remove title="删除类别；保留为未分类框">×</button>`;
                row.querySelector('.ae-class-swatch').onclick=()=>{this.chooseClass(name);this.stage.focus();};
                const input=row.querySelector('input');row.querySelector('[data-ae-rename]').onclick=()=>this.editClass({kind:'rename',from:name,to:input.value});
                input.onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();this.editClass({kind:'rename',from:name,to:input.value});}};
                row.querySelector('[data-ae-remove]').onclick=()=>this.editClass({kind:'delete',from:name});list.append(row);
            });
        }
        editClass(operation) {
            try {
                const command=TaskClasses.edit(operation);if(!command)return true;
                if(operation.kind==='rename' && this.label===operation.from)this.label=operation.to.trim();
                if(operation.kind==='add')this.label=operation.to.trim();
                if(!TaskClasses.labels().includes(this.label))this.label=TaskClasses.labels()[0]||'';
                this.q('[data-ae-class-error]').textContent='';this.record(command,`${operation.kind==='add'?'新增':operation.kind==='rename'?'改名':'删除'}全局类别`);
                if(typeof updateTeachingStatus==='function')updateTeachingStatus();return true;
            } catch(error){this.q('[data-ae-class-error]').textContent=error.message;return false;}
        }
        select(index) {
            this.selected=index;this.tool='select';const ann=this.result.annotations[index];if(ann?.label&&!ann.unclassified)this.label=ann.label;
            this.renderBoxes();this.renderPanels();
        }
        chooseClass(label) { this.label=label;if(this.tool==='select'&&this.result.annotations[this.selected])this.assign(label);else this.renderPanels(); }
        assign(label) {
            const ann=this.result?.annotations[this.selected];if(!ann || caption(ann)===(label||'未分类'))return;
            this.local('修改框类别',()=>{ann.label=label;ann.unclassified=!label;ann.manual=true;if(label)delete ann.previousLabel;});
        }
        delete() { if(this.selected<0 || !this.result?.annotations[this.selected])return;this.local('删除标注框',()=>{this.result.annotations.splice(this.selected,1);this.selected=Math.min(this.selected,this.result.annotations.length-1);}); }
        duplicate() {
            const ann=this.result?.annotations[this.selected];if(!geometry(ann))return;
            this.local('复制标注框',()=>{const box=clone(ann),[y1,x1,y2,x2]=box.box_2d,dx=Math.min(20,1000-x2),dy=Math.min(20,1000-y2);box.box_2d=[y1+dy,x1+dx,y2+dy,x2+dx];box.manual=true;delete box.previewDataUrl;delete box.transparentPreviewUrl;this.result.annotations.push(box);this.selected=this.result.annotations.length-1;});
        }
        confirm() {
            if(!this.result.annotations.length || !this.result.annotations.every(ReviewState.validBox))return this.o.notify('请先为所有框设置类别并修正坐标',true);
            this.local('人工确认正常图',()=>{this.result.reviewCategory='normal';});
        }
        point(event) {
            const r=this.layer.getBoundingClientRect();return [clamp((event.clientY-r.top)/r.height*1000,0,1000),clamp((event.clientX-r.left)/r.width*1000,0,1000)];
        }
        pointerDown(event) {
            if(event.button!==0 || !this.result || this.gesture || !this.image.complete || !this.image.naturalWidth || !this.layer.clientWidth)return;
            if(!AnnotationDisplay.preferences.annotations){this.status('标注已隐藏，请按 Alt+B 显示后编辑');return;}
            event.preventDefault();this.stage.focus({preventScroll:true});this.hideMenu();
            const node=event.target.closest('[data-box-index]'),index=node?Number(node.dataset.boxIndex):-1;
            if(this.tool==='select' && index<0){this.selected=-1;this.renderBoxes();this.renderPanels();return;}
            const group=[{owner:this.result,key:'annotations',result:this.result}],undo=TaskClasses.capture(group),start=this.point(event);
            const drawing=this.tool==='draw',handle=event.target.closest('[data-handle]')?.dataset.handle || '';
            if(!drawing)this.selected=index;
            const ann=drawing?{label:this.label,unclassified:!this.label,box_2d:[...start,...start],manual:true}:this.result.annotations[index];
            if(!drawing&&!geometry(ann))return;
            const original=ann.box_2d.slice();let preview;
            if(drawing){preview=document.createElement('div');preview.className='rw-editor-box ae-draft';preview.style.setProperty('--ae-color',color(this.label));this.layer.append(preview);}else{this.renderBoxes();preview=this.layer.querySelector(`[data-box-index="${index}"]`);}
            const g={undo,pointer:event.pointerId,start,original,ann,drawing,preview,moved:false};this.gesture=g;this.renderPanels();
            const move=e=>{
                if(e.pointerId!==g.pointer)return;const[y,x]=this.point(e),dy=y-start[0],dx=x-start[1],[y1,x1,y2,x2]=original;
                if(drawing)ann.box_2d=[Math.min(start[0],y),Math.min(start[1],x),Math.max(start[0],y),Math.max(start[1],x)];
                else if(!handle){const top=clamp(y1+dy,0,1000-(y2-y1)),left=clamp(x1+dx,0,1000-(x2-x1));ann.box_2d=[top,left,top+y2-y1,left+x2-x1];}
                else ann.box_2d=[handle.includes('n')?clamp(y1+dy,0,y2-1):y1,handle.includes('w')?clamp(x1+dx,0,x2-1):x1,handle.includes('s')?clamp(y2+dy,y1+1,1000):y2,handle.includes('e')?clamp(x2+dx,x1+1,1000):x2];
                g.moved=ann.box_2d.some((n,i)=>Math.abs(n-original[i])>.01);this.style(preview,ann.box_2d);
            };
            const up=e=>{if(e.pointerId!==g.pointer)return;move(e);this.finishGesture(false);};
            const cancel=e=>{if(e.pointerId===g.pointer)this.finishGesture(true);};
            g.cleanup=()=>{window.removeEventListener('pointermove',move);window.removeEventListener('pointerup',up);window.removeEventListener('pointercancel',cancel);try{this.layer.releasePointerCapture(g.pointer);}catch(_) {}};
            window.addEventListener('pointermove',move);window.addEventListener('pointerup',up);window.addEventListener('pointercancel',cancel);
            try{this.layer.setPointerCapture(event.pointerId);}catch(_){}
        }
        finishGesture(cancel) {
            const g=this.gesture;if(!g)return;this.gesture=null;g.cleanup();
            const pixelW=(g.ann.box_2d[3]-g.ann.box_2d[1])*this.layer.clientWidth/1000,pixelH=(g.ann.box_2d[2]-g.ann.box_2d[0])*this.layer.clientHeight/1000;
            if(cancel || !g.moved || g.drawing&&(pixelW<3||pixelH<3)){g.undo();this.renderBoxes();this.renderPanels();return;}
            if(g.drawing){this.result.annotations.push(g.ann);this.selected=this.result.annotations.length-1;}
            g.ann.manual=true;delete g.ann.polygon;delete g.ann.previewDataUrl;delete g.ann.transparentPreviewUrl;
            const name=g.drawing?'新增标注框':'调整标注框';this.mark(name);
            this.record({undo:g.undo,redo:TaskClasses.capture([{owner:this.result,key:'annotations',result:this.result}])},name);
        }
        cancelGesture() { this.finishGesture(true); }
        wheel(event) {
            if(!this.result || this.gesture || event.ctrlKey || event.metaKey)return;
            event.preventDefault();const labels=TaskClasses.labels();if(!labels.length)return;
            if(Date.now()-(this.lastWheel||0)>220)this.wheelSum=0;this.lastWheel=Date.now();
            this.wheelSum+=event.deltaY*(event.deltaMode===1?18:event.deltaMode===2?this.stage.clientHeight:1);if(Math.abs(this.wheelSum)<32)return;
            const step=Math.sign(this.wheelSum);this.wheelSum=0;
            const ann=this.result.annotations[this.selected],current=this.tool==='select'&&ann&&!ann.unclassified?ann.label:this.label,index=labels.indexOf(current);
            this.chooseClass(labels[(index+step+labels.length)%labels.length]);
        }
        context(event) {
            event.preventDefault();if(this.gesture){this.cancelGesture();return;}
            const node=event.target.closest('[data-box-index]');if(node)this.select(Number(node.dataset.boxIndex));else this.selected=-1;
            this.renderPanels();const ann=this.result.annotations[this.selected];
            this.q('[data-ae-context-title]').textContent=ann?`标注框 #${this.selected+1} · ${caption(ann)}`:'画布操作';
            const selector=this.q('[data-ae-context-class]');selector.innerHTML=this.options(ann?.label);selector.value=ann?.unclassified?'':ann?.label || '';selector.disabled=!ann;
            this.menu.querySelectorAll('[data-ae-action]').forEach(b=>{const action=b.dataset.aeAction;b.disabled=action==='undo'?!this.undoStack.length:action==='redo'?!this.redoStack.length:!ann;});
            this.menu.hidden=false;const r=this.dialog.getBoundingClientRect();this.menu.style.left=`${clamp(event.clientX-r.left,4,r.width-this.menu.offsetWidth-8)}px`;this.menu.style.top=`${clamp(event.clientY-r.top,4,r.height-this.menu.offsetHeight-8)}px`;
        }
        hideMenu() { this.menu.hidden=true; }
        key(event) {
            if(!this.result || !this.backdrop.classList.contains('rw-open'))return;
            // A save-completion dialog or another foreground panel owns its keys.
            if(!this.dialog.contains(event.target) && event.target!==document.body)return;
            const key=event.key.toLowerCase(),modifier=event.ctrlKey||event.metaKey;
            if(key==='escape'){
                if(this.gesture)this.cancelGesture();else if(!this.menu.hidden)this.hideMenu();else if(!this.help.hidden)this.help.hidden=true;else if(this.tool==='draw')this.setTool('select');else if(this.selected>=0){this.selected=-1;this.renderBoxes();this.renderPanels();}else this.close();
                event.preventDefault();event.stopImmediatePropagation();return;
            }
            if(editable(event.target) || event.isComposing || event.altKey)return;
            let handled=true;
            if(modifier&&key==='z')this.history(event.shiftKey);
            else if(modifier&&key==='y')this.history(true);
            else if(modifier&&key==='d')this.duplicate();
            else if(modifier&&key==='enter')this.confirm();
            else if(modifier&&key==='s'){if(!this.gesture)window.TaskManager?.exportTask(false);}
            else if(modifier)handled=false;
            else if(key==='r'||key==='w')this.setTool('draw');else if(key==='v')this.setTool('select');
            else if(key==='delete'||key==='backspace')this.delete();
            else if(key==='a'||key==='pageup')this.navigate(-1);else if(key==='d'||key==='pagedown')this.navigate(1);
            else if(key==='?' || key==='f1')this.help.hidden=!this.help.hidden;
            else if(/^[0-9]$/.test(key)){const index=key==='0'?9:Number(key)-1,label=TaskClasses.labels()[index];if(label)this.chooseClass(label);}
            else if(key==='tab' && (event.target===this.stage || event.target===this.dialog)){const count=this.result.annotations.length;if(count)this.select((this.selected+(event.shiftKey?-1:1)+count)%count);}
            else if(['arrowleft','arrowright','arrowup','arrowdown'].includes(key)){
                const ann=this.result.annotations[this.selected];if(geometry(ann))this.local('键盘微调标注框',()=>{const[y1,x1,y2,x2]=ann.box_2d,step=event.shiftKey?10:1,dx=key==='arrowleft'?-step:key==='arrowright'?step:0,dy=key==='arrowup'?-step:key==='arrowdown'?step:0,x=clamp(x1+dx/this.image.naturalWidth*1000,0,1000-x2+x1),y=clamp(y1+dy/this.image.naturalHeight*1000,0,1000-y2+y1);ann.box_2d=[y,x,y+y2-y1,x+x2-x1];ann.manual=true;delete ann.previewDataUrl;delete ann.transparentPreviewUrl;});
            }else handled=false;
            if(handled){event.preventDefault();event.stopImmediatePropagation();}
        }
    }
    window.AnnotationEditor={markup,Editor};
}());
