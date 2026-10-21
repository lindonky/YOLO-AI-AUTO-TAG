/* Task-wide labels. A deleted label never becomes a new class during rendering. */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.TaskClasses = new api.Catalog(() => state, () => els.classLabelInput, () => window.ReviewState);
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';
    const copy = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
    const META = ['reviewCategory', 'needsReview', 'verifiedEmpty', 'validation', 'manualReviewed', 'manualReviewedAt', 'automaticAssessment', 'reviewHistory', 'processingError'];
    const classified = box => !!box && box.unclassified !== true && typeof box.label === 'string' && !!box.label.trim();
    class Catalog {
        constructor(getState, getInput, getReview) { this.getState = getState; this.getInput = getInput; this.getReview = getReview; }
        groups() {
            const s = this.getState(), groups = [], seen = new Set();
            const add = (owner, key, result = null) => {
                if (Array.isArray(owner?.[key]) && !seen.has(owner[key])) { seen.add(owner[key]); groups.push({owner, key, result}); }
            };
            for (const result of [...(s.imageResults || []), ...(s.videoResults || [])]) add(result, 'annotations', result);
            add(s, 'annotations'); add(s, 'teachingDraftBoxes');
            for (const example of s.teachingExamples || []) add(example, 'boxes');
            return groups;
        }
        labels() { return [...this.getState().unifiedClassMap.entries()].sort((a,b) => a[1]-b[1]).map(([name]) => name); }
        setLabels(names, syncInput = true) {
            const s = this.getState();
            const labels = [...new Set(names.filter(name => typeof name === 'string' && name.trim()).map(name => name.trim()))];
            s.unifiedClassMap = new Map(labels.map((name, id) => [name, id])); s.nextClassId = labels.length;
            if (syncInput && this.getInput()) this.getInput().value = labels.join(' ');
        }
        ensure() {
            const labels = this.labels();
            const add = name => { if (name && !labels.includes(name)) labels.push(name); };
            String(this.getInput()?.value || '').trim().split(/\s+/).filter(Boolean).forEach(add);
            for (const {owner,key} of this.groups()) owner[key].filter(classified).forEach(box => add(box.label.trim()));
            this.setLabels(labels);
            return labels;
        }
        restore(config, results) {
            const explicit = Array.isArray(config.classes);
            const names = explicit ? config.classes.slice() : String(config.classLabel || '').trim().split(/\s+/).filter(Boolean);
            for (const result of results) for (const box of result.annotations || []) {
                if (!classified(box)) { box.label = ''; box.unclassified = true; continue; }
                if (!names.includes(box.label)) {
                    if (explicit) { box.previousLabel = box.label; box.label = ''; box.unclassified = true; }
                    else names.push(box.label);
                }
            }
            this.setLabels(names);
            this.getState().customClassesLoaded = true;
        }
        capture(groups, registry = false) {
            const data = groups.map(({owner,key,result}) => ({owner,key,result,boxes:copy(owner[key]),meta:result ? Object.fromEntries(META.filter(k => Object.hasOwn(result,k)).map(k => [k,copy(result[k])])) : null}));
            const labels = registry ? this.labels() : null;
            return () => {
                for (const item of data) {
                    item.owner[item.key] = copy(item.boxes);
                    if (item.result) { for (const key of META) delete item.result[key]; Object.assign(item.result,copy(item.meta)); }
                }
                if (labels) this.setLabels(labels);
            };
        }
        edit(operation) {
            if (this.getState().isProcessing) throw new Error('请先结束识别，再修改全局类别');
            this.ensure();
            const labels = this.labels(), {kind,from} = operation, to = String(operation.to || '').trim();
            if (!['add','rename','delete'].includes(kind)) throw new Error('未知类别操作');
            if (kind !== 'delete' && (!to || /\s/.test(to) || to === '未分类' || to.length > 80)) throw new Error('类别名需为 1–80 个字符，不含空白；“未分类”为保留名称');
            if (kind !== 'add' && !labels.includes(from)) throw new Error('该类别已不存在');
            if (kind !== 'delete' && labels.includes(to) && to !== from) throw new Error('类别名已存在');
            if (kind === 'rename' && from === to) return null;
            const groups = kind === 'add' ? [] : this.groups().filter(({owner,key}) => owner[key].some(box => classified(box) && box.label === from));
            const undo = this.capture(groups,true);
            for (const {owner,key,result} of groups) {
                for (const box of owner[key]) if (classified(box) && box.label === from) {
                    box.label = kind === 'delete' ? '' : to;
                    if (kind === 'delete') { box.unclassified = true; box.previousLabel = from; }
                    delete box.previewDataUrl; delete box.transparentPreviewUrl;
                }
                if (result && kind === 'delete') {
                    if (!result.automaticAssessment) result.automaticAssessment = {validation:copy(result.validation || {}),processingError:result.processingError || null,needsReview:!!result.needsReview};
                    result.reviewCategory = 'error'; result.needsReview = true; result.verifiedEmpty = false;
                    result.validation = {...result.validation,status:'unclassified',needsReview:true,verifiedEmpty:false,reason:`类别“${from}”已删除，请为保留的框重新分类`};
                }
            }
            this.setLabels(kind === 'add' ? [...labels,to] : kind === 'rename' ? labels.map(name => name === from ? to : name) : labels.filter(name => name !== from));
            return {undo,redo:this.capture(groups,true),affected:groups.filter(g => g.result).length};
        }
    }
    return {Catalog,classified};
}));
