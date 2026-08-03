'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const firstPartyRoots = [
    path.join(root, 'public', 'tour.html'),
    path.join(root, 'public', 'assets', 'css'),
    path.join(root, 'public', 'assets', 'js'),
    path.join(root, 'public', 'assets', 'mock')
];
const requiredVendor = [
    'public/assets/vendor/maplibre/maplibre-gl.js',
    'public/assets/vendor/maplibre/maplibre-gl.css',
    'public/assets/vendor/supermap-iclient/iclient-maplibregl.min.js',
    'public/assets/vendor/socket.io/socket.io.min.js',
    'public/assets/vendor/fonts/supermap-components-icons.woff',
    'public/assets/vendor/icons/README.md',
    'public/assets/vendor/versions.json'
];
const forbiddenRemoteUrl = /https?:\/\/[^\s"'`)]+|(?:src|href)\s*=\s*["']\/\/|url\(\s*["']?\/\//i;
const forbiddenBrowserApi = /\b(?:alert|prompt|confirm)\s*\(/;
const expectedVersions = Object.freeze({
    '@supermapgis/iclient-maplibregl': '12.1.0-r',
    'maplibre-gl': '5.6.0',
    'socket.io-client': '4.7.4'
});

function filesUnder(target) {
    const stat = fs.statSync(target);
    if (stat.isFile()) return [target];
    return fs.readdirSync(target, { withFileTypes: true }).flatMap(entry =>
        filesUnder(path.join(target, entry.name)));
}

const violations = [];
for (const file of firstPartyRoots.flatMap(filesUnder)) {
    const content = fs.readFileSync(file, 'utf8');
    if (forbiddenRemoteUrl.test(content)) violations.push(path.relative(root, file));
    if (forbiddenBrowserApi.test(content)) violations.push(`${path.relative(root, file)} (blocking dialog API)`);
}
for (const relative of requiredVendor) {
    const file = path.join(root, relative);
    if (!fs.existsSync(file) || fs.statSync(file).size === 0) violations.push(`${relative} (missing)`);
}

const versions = JSON.parse(fs.readFileSync(path.join(root, 'public/assets/vendor/versions.json'), 'utf8'));
for (const [name, expected] of Object.entries(expectedVersions)) {
    if (versions.packages?.[name] !== expected) {
        violations.push(`public/assets/vendor/versions.json (${name} must be ${expected})`);
    }
}
const forbiddenVendorFiles = filesUnder(path.join(root, 'public', 'assets', 'vendor'))
    .filter(file => /(?:\.map|\.lic|activation(?:\.[^.]+)?)$/i.test(path.basename(file)));
for (const file of forbiddenVendorFiles) violations.push(`${path.relative(root, file)} (forbidden vendor file)`);
if (violations.length) {
    console.error('Tour offline resource check failed:');
    for (const violation of violations) console.error(`- ${violation}`);
    process.exit(1);
}
console.log('Tour offline resource check passed', versions.packages);
