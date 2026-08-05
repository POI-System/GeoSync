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
const requiredFixtures = [
    'public/assets/mock/boundary.geojson',
    'public/assets/mock/pois.geojson'
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

function parseRequiredFixture(relative) {
    const file = path.join(root, relative);
    if (!fs.existsSync(file) || fs.statSync(file).size === 0) {
        violations.push(`${relative} (missing)`);
        return null;
    }
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
        violations.push(`${relative} (invalid JSON)`);
        return null;
    }
}

function validCoordinate(value) {
    return Array.isArray(value)
        && value.length >= 2
        && Number.isFinite(Number(value[0]))
        && Number.isFinite(Number(value[1]));
}

const fixtures = Object.fromEntries(requiredFixtures.map(relative => [relative, parseRequiredFixture(relative)]));
const boundary = fixtures['public/assets/mock/boundary.geojson'];
if (boundary && (boundary.type !== 'FeatureCollection'
    || !Array.isArray(boundary.features)
    || !boundary.features.some(feature => ['Polygon', 'MultiPolygon'].includes(feature?.geometry?.type)))) {
    violations.push('public/assets/mock/boundary.geojson (must contain a Polygon or MultiPolygon FeatureCollection)');
}

const pois = fixtures['public/assets/mock/pois.geojson'];
if (pois) {
    const features = Array.isArray(pois.features) ? pois.features : [];
    const poiIds = new Set();
    const validFeatures = features.every(feature => {
        const properties = feature?.properties || {};
        const poiId = String(properties.poiId || '').trim();
        const unique = Boolean(poiId) && !poiIds.has(poiId);
        if (unique) poiIds.add(poiId);
        return feature?.type === 'Feature'
            && feature?.geometry?.type === 'Point'
            && validCoordinate(feature.geometry.coordinates)
            && unique
            && Boolean(String(properties.name || '').trim())
            && Boolean(String(properties.category || '').trim())
            && Boolean(String(properties.status || '').trim())
            && Number.isFinite(Number(properties.suggestedStayMin))
            && Number(properties.suggestedStayMin) >= 0;
    });
    if (pois.type !== 'FeatureCollection' || features.length !== 5 || !validFeatures) {
        violations.push('public/assets/mock/pois.geojson (must contain 5 unique valid Point features with required properties)');
    }
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
