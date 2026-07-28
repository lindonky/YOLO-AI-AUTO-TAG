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
    console.log('Desktop JavaScript batch-failure smoke test: passed');
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
