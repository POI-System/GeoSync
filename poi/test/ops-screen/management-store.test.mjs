import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createManagementStore, normalizeEdgePatch, normalizePoi } = require('../../scripts/sxr-management-store.js');

test('managed POIs require name and valid coordinates while optional fields stay optional', () => {
    assert.throws(() => normalizePoi({ lng: 114.3, lat: 30.5 }), /POI_NAME_REQUIRED/);
    assert.throws(() => normalizePoi({ name: '测试点', lng: 999, lat: 30.5 }), /POI_COORDINATE_INVALID/);
    const poi = normalizePoi({ name: ' 测试点 ', lng: 114.3, lat: 30.5 });
    assert.equal(poi.name, '测试点');
    assert.equal(poi.photo, '');
    assert.equal(poi.note, '');
});

test('road management validates status, congestion and warning fields', () => {
    const patch = normalizeEdgePatch({ status: 'closed', congestion: 'congested', warning: '施工' });
    assert.equal(patch.status, 'closed');
    assert.equal(patch.congestion, 'congested');
    assert.equal(patch.warning, '施工');
    assert.equal(typeof patch.updatedAt, 'string');
    assert.throws(() => normalizeEdgePatch({ congestion: 'unknown' }), /EDGE_CONGESTION_INVALID/);
});

test('management state persists POIs and applies road overrides without changing source graph', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sjp-management-'));
    const filePath = path.join(directory, 'state.json');
    const store = createManagementStore({ filePath });
    const poi = store.createPoi({ name: '行政楼', lng: 114.36, lat: 30.54, note: '北门入口' });
    store.updateEdge('WHU_E_1', { status: 'closed', congestion: 'busy', warning: '临时管制' });
    const source = { readOnly: true, edges: [{ edgeId: 'WHU_E_1', status: 'open' }] };
    const graph = store.applyGraph(source);
    assert.equal(source.edges[0].status, 'open');
    assert.equal(graph.edges[0].status, 'closed');
    assert.equal(graph.edges[0].congestion, 'busy');
    assert.equal(graph.sourceReadOnly, true);
    const reloaded = createManagementStore({ filePath });
    assert.equal(reloaded.listPois()[0].poiId, poi.poiId);
});
