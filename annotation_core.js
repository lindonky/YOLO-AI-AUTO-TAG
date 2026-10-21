(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.AnnotationCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';
    function modelError(code, message) { const error = new Error(message); error.code = code; return error; }
    function objectList(value) {
        if (Array.isArray(value)) return value;
        if (!value || typeof value !== 'object') return null;
        for (const key of ['objects', 'detections', 'boxes']) {
            if (Object.prototype.hasOwnProperty.call(value, key)) return value[key];
        }
        return null;
    }
    function matchesSchema(value, kind) {
        if (kind === 'numbers') {
            try { normalizeNumbers(value); return true; } catch (_) { return false; }
        }
        if (kind === 'presence') return value && !Array.isArray(value) && typeof value === 'object' && ['has_target', 'hasTarget', 'present'].some(key => key in value);
        if (kind === 'review') return value && !Array.isArray(value) && typeof value.complete === 'boolean' && Array.isArray(value.missing_objects);
        const objects = objectList(value);
        if (Array.isArray(objects)) return objects.every(item => item && typeof item === 'object' && !Array.isArray(item) && typeof item.label === 'string' && (kind === 'polygons' ? Array.isArray(item.polygon) : Array.isArray(item.box_2d)));
        return kind === 'any' && matchesSchema(value, 'presence');
    }
    // Brackets inside JSON strings must not terminate a container.
    function jsonContainers(text) {
        const found = [];
        let start = -1, stack = [], quoted = false, escaped = false;
        for (let i = 0; i < text.length; i++) {
            const char = text[i];
            if (start < 0) {
                if (char === '[' || char === '{') { start = i; stack = [char]; quoted = false; escaped = false; }
                continue;
            }
            if (quoted) {
                if (escaped) escaped = false;
                else if (char === '\\') escaped = true;
                else if (char === '"') quoted = false;
                continue;
            }
            if (char === '"') { quoted = true; continue; }
            if (char === '[' || char === '{') stack.push(char);
            else if (char === ']' || char === '}') {
                const open = stack.pop();
                if ((open === '[' && char !== ']') || (open === '{' && char !== '}')) { start = -1; stack = []; continue; }
                if (!stack.length) { found.push(text.slice(start, i + 1)); start = -1; }
            }
        }
        found.unfinished = start >= 0;
        return found;
    }
    function parseModelJson(content, kind = 'any') {
        if (typeof content !== 'string' || !content.trim()) throw modelError('MODEL_EMPTY', '模型响应内容为空');
        if (content.length > 2 * 1024 * 1024) throw new Error('模型响应过长，请缩小任务范围');
        const candidates = [content.trim()];
        const fences = [...content.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)];
        if (fences.length) {
            const finalFence = fences[fences.length - 1][1].trim();
            try {
                const parsed = JSON.parse(finalFence);
                if (matchesSchema(parsed, kind)) return parsed;
                throw modelError('MODEL_SCHEMA_INVALID', 'JSON 已解析，但字段或任务结构不符合要求');
            } catch (error) { if (error.code) throw error; /* Never fall back to an earlier empty example. */ }
            throw modelError('MODEL_JSON_INVALID', '模型最终 JSON 代码块无效，已保留图片等待复核');
        }
        const containers = jsonContainers(content);
        if (containers.unfinished) throw modelError('MODEL_JSON_INCOMPLETE', '模型最终 JSON 不完整，已保留图片等待复核');
        // Only the final container is an answer candidate. A balanced but
        // invalid final answer must never fall back to an earlier example [].
        if (containers.length) candidates.push(containers[containers.length - 1]);
        let parsedContainer = false;
        for (const candidate of candidates) {
            try { const parsed = JSON.parse(candidate); parsedContainer = true; if (matchesSchema(parsed, kind)) return parsed; }
            catch (_) { /* Never invent missing brackets or repair truncated annotations. */ }
        }
        throw modelError(parsedContainer ? 'MODEL_SCHEMA_INVALID' : 'MODEL_JSON_INVALID', parsedContainer ? 'JSON 已解析，但字段或任务结构不符合要求' : '模型未返回有效 JSON，已保留图片等待复核');
    }
    function normalizeObjects(value, labels = [], kind = 'detections') {
        const objects = objectList(value);
        if (!Array.isArray(objects)) throw new Error('模型返回的目标列表格式错误');
        const invalidNumber = v => v === null || v === '' || typeof v === 'boolean' || !Number.isFinite(Number(v)) || Number(v) < 0 || Number(v) > 1000;
        return objects.map((item, index) => {
            const label = typeof item?.label === 'string' ? item.label.trim() : '';
            if (!label || (labels.length && !labels.includes(label))) throw new Error(`第 ${index + 1} 个目标的类别不在本次类别列表中`);
            const result = { ...item, label };
            if (kind === 'polygons') {
                if (!Array.isArray(item.polygon) || item.polygon.length < 3) throw new Error('目标多边形缺少有效顶点');
                result.polygon = item.polygon.map(point => {
                    if (!Array.isArray(point) || point.length !== 2 || point.some(invalidNumber)) throw new Error('目标多边形坐标无效');
                    return point.map(Number);
                });
            } else {
                const box = item.box_2d;
                if (!Array.isArray(box) || box.length !== 4 || box.some(invalidNumber)) throw new Error(`第 ${index + 1} 个目标的坐标必须在 0—1000 范围内`);
                const [y1, x1, y2, x2] = box.map(Number);
                if (y2 <= y1 || x2 <= x1) throw new Error(`第 ${index + 1} 个目标的框宽高无效`);
                result.box_2d = [y1, x1, y2, x2];
            }
            return result;
        });
    }
    function iou(a, b) {
        const [ay1, ax1, ay2, ax2] = a.box_2d, [by1, bx1, by2, bx2] = b.box_2d;
        const intersection = Math.max(0, Math.min(ax2, bx2) - Math.max(ax1, bx1)) * Math.max(0, Math.min(ay2, by2) - Math.max(ay1, by1));
        const union = (ax2 - ax1) * (ay2 - ay1) + (bx2 - bx1) * (by2 - by1) - intersection;
        return union > 0 ? intersection / union : 0;
    }
    function mergeMissing(original, missing) {
        const boxes = original.slice(); let conflict = false;
        for (const item of missing) {
            if (boxes.some(box => box.label === item.label && iou(box, item) >= 0.65)) continue;
            if (boxes.some(box => box.label !== item.label && iou(box, item) >= 0.85)) { conflict = true; continue; }
            boxes.push(item);
        }
        return { boxes, added: boxes.length - original.length, conflict };
    }
    function normalizeNumbers(value) {
        if (!value || Array.isArray(value) || !['recognized','none','uncertain'].includes(value.status) || !Array.isArray(value.numbers) || value.numbers.length > 32)
            throw new Error('图片数字格式无效');
        if (!value.numbers.every(n => typeof n === 'string' && /^\d{1,32}$/.test(n))) throw new Error('图片数字必须是保留前导零的数字串');
        const numbers = [...new Set(value.numbers)];
        const sequence = value.sequence == null ? null : value.sequence;
        if (sequence !== null && (typeof sequence !== 'string' || !numbers.includes(sequence))) throw new Error('图片序号与识别数字不一致');
        if (value.status === 'none' && numbers.length || value.status === 'recognized' && !numbers.length) throw new Error('图片数字状态矛盾');
        return { status: value.status, numbers, sequence: value.status === 'recognized' ? sequence : null, reason: String(value.reason || '').slice(0,300) };
    }
    return { parseModelJson, normalizeObjects, objectList, mergeMissing, normalizeNumbers };
});
