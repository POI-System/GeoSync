'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const targets = [
    path.join(root, 'public', 'assets', 'js'),
    path.join(root, 'test', 'tour')
];

function sourceFiles(target) {
    return fs.readdirSync(target, { withFileTypes: true }).flatMap(entry => {
        const file = path.join(target, entry.name);
        if (entry.isDirectory()) return sourceFiles(file);
        return /\.(?:js|mjs)$/.test(entry.name) ? [file] : [];
    });
}

const files = [
    ...targets.flatMap(sourceFiles),
    path.join(root, 'scripts', 'check-tour-offline.js'),
    path.join(root, 'scripts', 'sync-tour-vendor.js')
];

for (const file of files) {
    const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    if (result.status !== 0) {
        process.stderr.write(result.stderr || result.stdout || `Syntax check failed: ${file}\n`);
        process.exit(result.status || 1);
    }
}

console.log(`Tour syntax check passed (${files.length} files)`);
