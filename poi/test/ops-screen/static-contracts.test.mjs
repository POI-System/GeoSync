import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const publicRoot = path.resolve(here, '../../public');
const projectRoot = path.dirname(publicRoot);

async function source(relativePath) {
    return readFile(path.join(publicRoot, relativePath), 'utf8');
}

test('ops and screen pages expose required application landmarks', async () => {
    const [ops, screen] = await Promise.all([source('ops.html'), source('screen.html')]);
    for (const marker of ['id="ops-map"', 'data-action="close"', 'data-action="open"', 'data-operation-dialog']) {
        assert.match(ops, new RegExp(marker));
    }
    for (const marker of ['data-poi-dialog', 'data-poi-pick', 'data-road-dialog', 'data-action="edit-edge"']) {
        assert.match(ops, new RegExp(marker));
    }
    for (const marker of ['id="screen-map"', 'data-screen-mode="realtime"', 'data-screen-mode="replay"', 'data-replay-range']) {
        assert.match(screen, new RegExp(marker));
    }
});

test('three-client workspace and tourist road network are wired locally', async () => {
    const [workspace, workspaceScript, tourScript, mapFacade, layers] = await Promise.all([
        source('workspace.html'),
        source('assets/js/pages/workspace.js'),
        source('assets/js/pages/tour.js'),
        source('assets/js/map/mapFacade.js'),
        source('assets/js/map/layers.js')
    ]);
    for (const view of ['tour', 'ops', 'screen']) {
        assert.match(workspace, new RegExp(`data-view="${view}"`));
        assert.match(workspace, new RegExp(`data-frame="${view}"`));
    }
    assert.match(workspaceScript, /frame\.dataset\.src/);
    assert.match(tourScript, /getRoadNetwork/);
    assert.match(tourScript, /dataset\.roadCount/);
    assert.match(mapFacade, /setRoadNetwork\(collection\)/);
    assert.match(layers, /geosync-roads-line/);
});

test('portal boot resources are pinned and served locally', async () => {
    const portal = await readFile(path.join(projectRoot, 'portal.html'), 'utf8');
    assert.doesNotMatch(portal, /<script[^>]+src=["']https?:\/\//i);
    assert.doesNotMatch(portal, /@import\s+url\(["']?https?:\/\//i);

    const vendorSources = [...portal.matchAll(/<script[^>]+src="(\/assets\/vendor\/portal\/[^"]+)"/g)]
        .map(match => match[1]);
    assert.equal(vendorSources.length, 6);
    await Promise.all(vendorSources.map(relativePath => (
        readFile(path.join(publicRoot, relativePath.slice(1)))
    )));
});

test('credentials are never placed in screen stream URLs or localStorage', async () => {
    const files = await Promise.all([
        source('assets/js/ops/opsApi.js'),
        source('assets/js/ops/screenStream.js'),
        source('assets/js/pages/ops.js'),
        source('assets/js/pages/screen.js')
    ]);
    const combined = files.join('\n');
    assert.doesNotMatch(combined, /localStorage/);
    assert.doesNotMatch(combined, /screenToken=\$\{/);
    assert.match(combined, /X-Screen-Token/);
});

test('desktop layouts have fixed viewport containment', async () => {
    const [opsCss, screenCss] = await Promise.all([
        source('assets/css/ops.css'), source('assets/css/screen.css')
    ]);
    assert.match(opsCss, /height:\s*100dvh/);
    assert.match(opsCss, /overflow:\s*hidden/);
    assert.match(screenCss, /width:\s*100vw/);
    assert.match(screenCss, /height:\s*100vh/);
    assert.match(screenCss, /overflow:\s*hidden/);
});

test('SXR preview uses direct iServer tiles and a visible screen road style', async () => {
    const [opsMap, screenCss] = await Promise.all([
        source('assets/js/ops/opsMap.js'), source('assets/css/screen.css')
    ]);
    assert.match(opsMap, /zxyTileImage\.png\?z=\{z\}&x=\{x\}&y=\{y\}/);
    assert.match(opsMap, /gis\.source === 'iserver'/);
    assert.match(opsMap, /map\.addSource\(ROAD_SOURCE_ID/);
    assert.match(opsMap, /map\.on\('click', ROAD_HIT_LAYER_ID/);
    assert.match(opsMap, /source\.setData\(roadFeatureCollection\(this\.graph\)\)/);
    assert.match(screenCss, /\.screen-map \.ops-map__edge\s*\{[^}]*stroke:\s*#56e39f/s);
});

test('management forms keep required coordinates and names while optional fields remain optional', async () => {
    const [ops, api] = await Promise.all([source('ops.html'), source('assets/js/ops/opsApi.js')]);
    assert.match(ops, /name="name"[^>]*required/);
    assert.match(ops, /name="lng"[^>]*required/);
    assert.match(ops, /name="lat"[^>]*required/);
    assert.doesNotMatch(ops, /name="(?:photo|note)"[^>]*required/);
    assert.match(api, /updateEdge\(edgeId, patch\)/);
    assert.match(api, /createPoi\(poi\)/);
});
