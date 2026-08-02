'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const {
    addHostPoiGeoSyncFields,
    isValidGeoPoint,
    pointFromLocation,
    visitMetaDefaults
} = require('../../services/hostPoiSchema');

function createHarness() {
    const isolated = new mongoose.Mongoose();
    const schema = new isolated.Schema({
        poiName: String,
        category: String,
        location: { lng: Number, lat: Number },
        status: String
    });
    addHostPoiGeoSyncFields(schema);
    return {
        schema,
        Model: isolated.model('HostPoiSchemaTest', schema)
    };
}

test('host POI extension registers the complete GeoSync field and index contract once', () => {
    const { schema } = createHarness();
    addHostPoiGeoSyncFields(schema);

    const geoSchema = schema.path('geo').schema;
    const visitSchema = schema.path('visitMeta').schema;
    const superMapSchema = schema.path('superMapRef').schema;
    assert.ok(geoSchema.path('type'));
    assert.ok(geoSchema.path('coordinates'));
    for (const field of [
        'category', 'capacity', 'dwellMin', 'openHours', 'accessible', 'scenicId',
        'suggestedStayMin', 'baselineStayMin', 'comfortCapacity', 'ticketRequired',
        'sheltered', 'tags'
    ]) {
        assert.ok(visitSchema.path(field), `visitMeta.${field} must be registered`);
    }
    assert.ok(schema.path('gateNodeId'));
    for (const field of ['datasetName', 'smId', 'dataVersion']) {
        assert.ok(superMapSchema.path(field), `superMapRef.${field} must be registered`);
    }

    const indexes = schema.indexes().map(([keys, options]) => ({ keys, options }));
    assert.equal(indexes.filter(index => index.keys.geo === '2dsphere').length, 1);
    assert.equal(indexes.filter(index =>
        index.keys.status === 1 && index.keys['visitMeta.tags'] === 1).length, 1);
});

test('host POI validation keeps location and WGS84 GeoJSON in sync', async () => {
    const { Model } = createHarness();
    const poi = new Model({
        poiName: 'Gate',
        category: 'history',
        location: { lng: '120.1234567', lat: '30.7654321' }
    });

    await poi.validate();
    assert.deepEqual(poi.geo.toObject(), {
        type: 'Point',
        coordinates: [120.1234567, 30.7654321]
    });
    assert.equal(poi.visitMeta.category, 'history');
    assert.equal(poi.visitMeta.capacity, 50);
    assert.equal(poi.visitMeta.dwellMin, 20);
    assert.equal(poi.visitMeta.scenicId, 'default');
    assert.deepEqual(poi.visitMeta.openHours, []);

    poi.location = { lng: 121, lat: 31 };
    await poi.validate();
    assert.deepEqual(poi.geo.coordinates, [121, 31]);
});

test('host POI validation accepts complete GeoJSON and planner-compatible open hours', async () => {
    const { Model } = createHarness();
    const poi = new Model({
        geo: { type: 'Point', coordinates: [120.5, 30.5] },
        visitMeta: {
            openHours: [
                { start: '09:00', end: '17:30' },
                { start: '18:00', end: '23:59' }
            ]
        }
    });

    await poi.validate();
    assert.deepEqual(poi.geo.coordinates, [120.5, 30.5]);
    assert.deepEqual(
        poi.visitMeta.openHours.map(window => ({ start: window.start, end: window.end })),
        [
            { start: '09:00', end: '17:30' },
            { start: '18:00', end: '23:59' }
        ]
    );
});

test('host POI validation rejects incomplete GeoJSON and malformed open-hour entries', async () => {
    const { Model } = createHarness();

    for (const geo of [{}, { type: 'Point', coordinates: [120] }]) {
        await assert.rejects(new Model({ geo }).validate(), error => {
            assert.ok(error.errors?.['geo.coordinates']);
            return true;
        });
    }

    for (const openHours of [
        [{}],
        [{ start: '9:00', end: '17:00' }],
        [{ start: '09:00', end: '24:00' }],
        [null]
    ]) {
        await assert.rejects(new Model({ visitMeta: { openHours } }).validate(), error => {
            assert.ok(Object.keys(error.errors || {}).some(path =>
                path.startsWith('visitMeta.openHours')));
            return true;
        });
    }
});

test('point and visit defaults reject invalid coordinates and preserve compatibility aliases', () => {
    assert.equal(pointFromLocation({ lng: 181, lat: 30 }), null);
    assert.equal(pointFromLocation({ lng: 120, lat: Number.NaN }), null);
    assert.equal(isValidGeoPoint({ type: 'Point', coordinates: [120, 30] }), true);
    assert.equal(isValidGeoPoint({ type: 'Point', coordinates: [30, 200] }), false);

    assert.deepEqual(visitMetaDefaults({
        category: 'viewpoint',
        scenicId: 'scenic-a',
        existing: { suggestedStayMin: 35, comfortCapacity: 80 }
    }), {
        category: 'viewpoint',
        capacity: 80,
        dwellMin: 35,
        openHours: [],
        accessible: false,
        scenicId: 'scenic-a',
        suggestedStayMin: 35,
        baselineStayMin: 0,
        comfortCapacity: 80,
        ticketRequired: false,
        sheltered: false,
        tags: []
    });
});
