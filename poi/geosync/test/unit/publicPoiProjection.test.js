'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { serializePublicPoi } = require('../../services/publicPoiProjection');

test('public POI projection exposes only approved display fields', () => {
    const projected = serializePublicPoi({
        _id: 'poi-1',
        poiName: 'Lake Gate',
        category: 'gate',
        description: 'Public description',
        imageUrl: '/uploads/gate.jpg',
        location: { lng: '120.25', lat: 30.5 },
        status: 'approved',
        createTime: new Date('2026-08-02T00:00:00.000Z'),
        userOpenId: 'collector-private-sentinel',
        reviewerId: 'reviewer-private-sentinel',
        rejectReason: 'internal-only',
        superMapRef: { datasetName: 'private-dataset', smId: 91 },
        __v: 7
    });

    assert.equal(projected.id, 'poi-1');
    assert.equal(projected.lng, 120.25);
    assert.equal(projected.lat, 30.5);
    assert.equal(projected.status, 'approved');
    for (const privateField of [
        'userOpenId', 'reviewerId', 'rejectReason', 'superMapRef', '__v'
    ]) {
        assert.equal(Object.hasOwn(projected, privateField), false);
    }
    const serialized = JSON.stringify(projected);
    assert.doesNotMatch(serialized, /private-sentinel|private-dataset|internal-only/);
});

test('public POI projection normalizes invalid coordinates without leaking source fields', () => {
    const projected = serializePublicPoi({
        _id: 'poi-2',
        location: { lng: 'not-a-number', lat: Infinity },
        userOpenId: 'hidden'
    });

    assert.equal(projected.lng, null);
    assert.equal(projected.lat, null);
    assert.deepEqual(projected.location, { lng: null, lat: null });
    assert.equal(Object.hasOwn(projected, 'userOpenId'), false);
});
