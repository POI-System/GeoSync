'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const vendorRoot = path.join(root, 'public', 'assets', 'vendor');

const files = [
    ['node_modules/maplibre-gl/dist/maplibre-gl.js', 'maplibre/maplibre-gl.js'],
    ['node_modules/maplibre-gl/dist/maplibre-gl.css', 'maplibre/maplibre-gl.css'],
    [
        'node_modules/@supermapgis/iclient-maplibregl/dist/iclient-maplibregl.min.js',
        'supermap-iclient/iclient-maplibregl.min.js'
    ],
    ['node_modules/socket.io-client/dist/socket.io.min.js', 'socket.io/socket.io.min.js']
];

for (const [sourceRelative, targetRelative] of files) {
    const source = path.join(root, sourceRelative);
    const target = path.join(vendorRoot, targetRelative);
    if (!fs.existsSync(source)) {
        throw new Error(`Missing vendor source: ${sourceRelative}. Run npm install first.`);
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
}

const versions = {
    generatedBy: 'npm run vendor:sync',
    packages: {
        '@supermapgis/iclient-maplibregl': require('@supermapgis/iclient-maplibregl/package.json').version,
        'maplibre-gl': require('maplibre-gl/package.json').version,
        'socket.io-client': require('socket.io-client/package.json').version
    }
};

fs.writeFileSync(
    path.join(vendorRoot, 'versions.json'),
    `${JSON.stringify(versions, null, 2)}\n`,
    'utf8'
);

console.log(`Synced ${files.length} browser assets to ${path.relative(root, vendorRoot)}`);
