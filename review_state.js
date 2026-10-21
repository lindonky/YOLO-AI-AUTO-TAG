(function(root,factory){const api=factory();if(typeof module==='object' && module.exports)module.exports=api;else root.ReviewState=api;})(typeof globalThis!=='undefined'?globalThis:this,function(){
    'use strict';
    function validBox(box) {
        return box?.unclassified !== true && typeof box?.label === 'string' && !!box.label.trim() && validGeometry(box);
    }
    function validGeometry(box) {
        if (!box || !Array.isArray(box.box_2d) || box.box_2d.length!==4) return false;
        if (box.box_2d.some(v=>v===null || v==='' || typeof v==='boolean' || !Number.isFinite(Number(v)) || Number(v)<0 || Number(v)>1000)) return false;
        const [y1,x1,y2,x2]=box.box_2d.map(Number);return y2>y1 && x2>x1;
    }
    function categoryFor(result) {
        const boxes=Array.isArray(result?.annotations)?result.annotations:[];
        const manual=result?.manualReviewed && /^manual_(normal|background)$/.test(result?.validation?.status || '');
        if (manual && result.reviewCategory==='normal' && boxes.length && boxes.every(validBox)) return 'normal';
        if (manual && result.reviewCategory==='background' && !boxes.length && result.verifiedEmpty) return 'background';
        if (result?.processingError || result?.validation?.status==='processing_error' || result?.needsReview) return 'error';
        if (result?.reviewCategory==='review')return 'error';
        if (['normal','background','error'].includes(result?.reviewCategory))return result.reviewCategory;
        if (boxes.length) return 'normal';
        return result?.verifiedEmpty===true?'background':'error';
    }
    function assessment(result) {
        const boxes=Array.isArray(result?.annotations)?result.annotations:[];
        const reason=String(result?.processingError || result?.validation?.reason || '');
        let code='ready',label=result?.manualReviewed?'人工已确认':'自动标注完成';
        if (boxes.some(box=>box.unclassified || !box.label)) {code='unclassified';label='保留框 · 类别待分配';}
        else if (boxes.some(box=>!validBox(box))) {code='invalid_boxes';label='标注坐标或类别无效';}
        else if (categoryFor(result)==='error') {
            if (/JSON|格式|结构|坐标|类别列表/i.test(reason) && result?.processingError) {code='format_error';label=boxes.length?'已有框 · 后续格式校验失败':'未完成标注 · 格式校验失败';}
            else if (result?.processingError) {code='request_error';label=boxes.length?'已有框 · 后续处理失败':'未完成标注 · 请求失败';}
            else if (boxes.length && /复核失败|复核请求|超时|HTTP|连接中断/.test(reason)) {code='review_unavailable';label='已有标注 · 复核未完成';}
            else if (boxes.length) {code='completeness_pending';label='已有标注 · 完整性待确认';}
            else {code='unconfirmed_empty';label='无框 · 尚未确认背景';}
        } else if (categoryFor(result)==='background') {code='verified_empty';label=result?.manualReviewed?'人工确认背景':'已确认无目标';}
        return {code,label,reason,hasValidBoxes:boxes.length>0 && boxes.every(validBox),requiresReview:categoryFor(result)==='error'};
    }
    function applyManualDecision(result,reason,now=Date.now()) {
        const boxes=Array.isArray(result.annotations)?result.annotations:[];
        const valid=boxes.every(validBox);
        const accepted=result.reviewCategory==='normal' && boxes.length>0 && valid || result.reviewCategory==='background' && boxes.length===0;
        const validation=result.validation || {};
        if (!result.automaticAssessment) result.automaticAssessment={validation:JSON.parse(JSON.stringify(validation)),processingError:result.processingError || null,needsReview:!!result.needsReview};
        result.manualReviewed=true;result.manualReviewedAt=now;
        result.verifiedEmpty=accepted && result.reviewCategory==='background';result.needsReview=!accepted;
        if (accepted) result.processingError=null;
        result.validation={...validation,status:`manual_${result.reviewCategory}`,verifiedEmpty:result.verifiedEmpty,needsReview:result.needsReview,estimatedCount:boxes.length,reason};
        const history=result.reviewHistory ||= [];
        if (history.at(-1)?.reason!==reason || history.at(-1)?.category!==result.reviewCategory)history.push({at:now,category:result.reviewCategory,reason});
        if(history.length>20)history.splice(0,history.length-20);
        return accepted;
    }
    return {validBox,validGeometry,categoryFor,assessment,applyManualDecision};
});
