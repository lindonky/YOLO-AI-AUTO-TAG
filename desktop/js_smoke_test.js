'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

async function main() {
    const projectRoot = path.resolve(__dirname, '..');
    const source = fs.readFileSync(path.join(projectRoot, 'task_manager.js'), 'utf8');
    const context = {
        console: { log() {}, warn() {}, error() {} },
        window: {},
        document: {
            readyState: 'loading',
            addEventListener() {}
        },
        state: {
            isVideoMode: false,
            imageResults: [
                { fileName: 'already.jpg', annotations: [{ label: 'ball' }], verifiedEmpty: false }
            ]
        },
        els: { statusMsg: { textContent: '' } },
        setTimeout,
        setInterval,
        clearInterval
    };

    vm.createContext(context);
    vm.runInContext(`${source}\n;globalThis.__TaskManager = TaskManager;`, context);
    const manager = context.__TaskManager;
    manager.startTaskLifecycle = () => {
        manager.isStopped = false;
        manager.isPaused = false;
    };
    manager.endTaskLifecycle = () => {};

    const items = [
        { name: 'already.jpg' },
        { name: 'ok.jpg' },
        { name: 'bad-a.jpg' },
        { name: 'bad-b.jpg' }
    ];
    const summary = await manager.runWithConcurrencyOverride(
        items,
        async item => {
            if (item.name.startsWith('bad-')) throw new Error(`mock failure: ${item.name}`);
        },
        2
    );

    assert.equal(summary.attempted, 3);
    assert.equal(summary.succeeded, 1);
    assert.equal(summary.failed, 2);
    assert.equal(summary.skipped, 1);
    assert.equal(summary.errors.length, 2);
    assert.match(summary.errors[0].message, /mock failure/);

    // 视频模式不能因为存在历史结果就整段跳过：worker 需要看到每个视频，
    // 再依据 lastProcessedFrameIndex 判断是续跑还是已完成。同时单视频失败
    // 仍必须被汇总，不能打断其他视频。
    context.state.isVideoMode = true;
    context.state.videoResults = [
        { fileName: 'already.mp4', lastProcessedFrameIndex: 8, isPartial: true }
    ];
    const visitedVideos = [];
    const videoSummary = await manager.runWithConcurrencyOverride(
        [
            { name: 'already.mp4' },
            { name: 'ok.mp4' },
            { name: 'bad.mp4' }
        ],
        async item => {
            visitedVideos.push(item.name);
            if (item.name === 'bad.mp4') throw new Error('mock video failure');
        },
        2
    );

    assert.deepEqual([...visitedVideos].sort(), ['already.mp4', 'bad.mp4', 'ok.mp4']);
    assert.equal(videoSummary.attempted, 3);
    assert.equal(videoSummary.succeeded, 2);
    assert.equal(videoSummary.failed, 1);
    assert.equal(videoSummary.skipped, 0);
    assert.match(videoSummary.errors[0].message, /mock video failure/);
    console.log('Desktop JavaScript image/video batch-failure smoke test: passed');
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
