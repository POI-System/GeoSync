'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const firstPartyRoots = [
    path.join(root, 'public', 'tour.html'),
    path.join(root, 'public', 'assets', 'css'),
    path.join(root, 'public', 'assets', 'js')
];
const requiredVendor = [
    'public/assets/vendor/maplibre/maplibre-gl.js',
    'public/assets/vendor/maplibre/maplibre-gl.css',
    'public/assets/vendor/supermap-iclient/iclient-maplibregl.min.js',
    'public/assets/vendor/socket.io/socket.io.min.js',
    'public/assets/vendor/versions.json'
];
const forbidden = /(?:https?:)?\/\/(?:unpkg|cdn|cdnjs|jsdelivr|iclient\.supermap\.io)/i;

function filesUnder(target) {
    const stat = fs.statSync(target);
    if (stat.isFile()) return [target];
    return fs.readdirSync(target, { withFileTypes: true }).flatMap(entry =>
        filesUnder(path.join(target, entry.name)));
}

const violations = [];
for (const file of firstPartyRoots.flatMap(filesUnder)) {
    const content = fs.readFileSync(file, 'utf8');
    if (forbidden.test(content)) violations.push(path.relative(root, file));
}
for (const relative of requiredVendor) {
    const file = path.join(root, relative);
    if (!fs.existsSync(file) || fs.statSync(file).size === 0) violations.push(`${relative} (missing)`);
}

if (violations.length) {
    console.error('Tour offline resource check failed:');
    for (const violation of violations) console.error(`- ${violation}`);
    process.exit(1);
}

const versions = JSON.parse(fs.readFileSync(path.join(root, 'public/assets/vendor/versions.json'), 'utf8'));
console.log('Tour offline resource check passed', versions.packages);
