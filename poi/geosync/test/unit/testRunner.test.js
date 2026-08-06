'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const packageJson = require('../../../package.json');
const {
    POI_ROOT,
    collectTestFiles,
    discoverTests,
    runTests,
    runCli
} = require('../../scripts/run-tests');

test('package scripts use the shell-independent Node test runner', () => {
    assert.equal(packageJson.scripts.test, 'node geosync/scripts/run-tests.js all');
    assert.equal(packageJson.scripts['test:geosync'], 'node geosync/scripts/run-tests.js unit');
    assert.equal(packageJson.scripts['test:integration'], 'node geosync/scripts/run-tests.js integration');
    for (const command of [
        packageJson.scripts.test,
        packageJson.scripts['test:geosync'],
        packageJson.scripts['test:integration']
    ]) {
        assert.doesNotMatch(command, /\*\.test\.js/);
    }
});

test('scope discovery is bounded to the two declared test trees', () => {
    const unit = discoverTests('unit');
    const integration = discoverTests('integration');
    const all = discoverTests('all');

    assert.ok(unit.length > 0);
    assert.ok(integration.length > 0);
    assert.equal(all.length, unit.length + integration.length);
    assert.ok(unit.every(file => file.startsWith(path.join(POI_ROOT, 'geosync', 'test', 'unit'))));
    assert.ok(integration.every(file => file.startsWith(path.join(POI_ROOT, 'test'))));
    assert.throws(() => discoverTests('unknown'), /unit, integration, or all/);
});

test('collector preserves non-ASCII and spaced paths as individual sorted files', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'poi test runner '));
    try {
        fs.mkdirSync(path.join(root, '子目录'));
        fs.writeFileSync(path.join(root, 'z.test.js'), '');
        fs.writeFileSync(path.join(root, '子目录', 'a space.test.js'), '');
        fs.writeFileSync(path.join(root, 'ignored.js'), '');
        assert.deepEqual(collectTestFiles(root).map(file => path.relative(root, file)), [
            'z.test.js',
            path.join('子目录', 'a space.test.js')
        ]);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('runner avoids the shell, forwards options before files, and propagates status', () => {
    let call;
    const status = runTests({
        scope: 'integration',
        runnerArgs: ['--test-name-pattern=single'],
        spawnSyncFn(executable, args, options) {
            call = { executable, args, options };
            return { status: 7 };
        }
    });

    assert.equal(status, 7);
    assert.equal(call.executable, process.execPath);
    assert.deepEqual(call.args.slice(0, 2), ['--test', '--test-name-pattern=single']);
    assert.ok(call.args.slice(2).every(file => file.endsWith('.test.js')));
    assert.equal(call.options.shell, false);
    assert.equal(call.options.stdio, 'inherit');
    assert.equal(call.options.cwd, POI_ROOT);
});

test('CLI fails closed for a missing or invalid scope without spawning tests', () => {
    const messages = [];
    const stderr = { write: value => messages.push(value) };
    assert.equal(runCli([], stderr), 1);
    assert.equal(runCli(['invalid'], stderr), 1);
    assert.ok(messages.every(message => message.startsWith('[test-runner] ')));
});
