'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const POI_ROOT = path.resolve(__dirname, '..', '..');
const SCOPE_DIRECTORIES = Object.freeze({
    unit: [path.join('geosync', 'test', 'unit')],
    integration: ['test'],
    all: [path.join('geosync', 'test', 'unit'), 'test']
});

function collectTestFiles(directory, fileSystem = fs) {
    const files = [];
    function visit(current) {
        const entries = fileSystem.readdirSync(current, { withFileTypes: true });
        for (const entry of entries) {
            if (entry.isSymbolicLink()) continue;
            const target = path.join(current, entry.name);
            if (entry.isDirectory()) visit(target);
            else if (entry.isFile() && entry.name.endsWith('.test.js')) files.push(target);
        }
    }
    visit(path.resolve(directory));
    return files.sort((left, right) => left.localeCompare(right, 'en'));
}

function discoverTests(scope, options = {}) {
    const directories = SCOPE_DIRECTORIES[scope];
    if (!directories) throw new TypeError('test scope must be unit, integration, or all');
    const root = path.resolve(options.root || POI_ROOT);
    const fileSystem = options.fileSystem || fs;
    const files = directories.flatMap(directory =>
        collectTestFiles(path.join(root, directory), fileSystem));
    const unique = [...new Set(files)].sort((left, right) => left.localeCompare(right, 'en'));
    if (!unique.length) throw new Error(`no test files found for scope ${scope}`);
    return unique;
}

function runTests({
    scope,
    runnerArgs = [],
    root = POI_ROOT,
    spawnSyncFn = spawnSync
}) {
    if (!Array.isArray(runnerArgs) || runnerArgs.some(value => !String(value).startsWith('-'))) {
        throw new TypeError('test runner arguments must be options');
    }
    const files = discoverTests(scope, { root });
    const result = spawnSyncFn(
        process.execPath,
        ['--test', ...runnerArgs.map(String), ...files],
        { cwd: path.resolve(root), stdio: 'inherit', shell: false, windowsHide: true }
    );
    if (result.error) throw result.error;
    return Number.isInteger(result.status) ? result.status : 1;
}

function runCli(argv = process.argv.slice(2), stderr = process.stderr) {
    try {
        const [scope, ...runnerArgs] = argv;
        return runTests({ scope, runnerArgs });
    } catch (error) {
        stderr.write(`[test-runner] ${error?.message || 'test execution failed'}\n`);
        return 1;
    }
}

if (require.main === module) process.exitCode = runCli();

module.exports = {
    POI_ROOT,
    SCOPE_DIRECTORIES,
    collectTestFiles,
    discoverTests,
    runTests,
    runCli
};
