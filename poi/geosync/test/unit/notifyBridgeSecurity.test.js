'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const notifyBridge = require('../../services/notifyBridge');

function fakeIo(sockets = [{}]) {
    const emitted = [];
    return {
        emitted,
        to(room) {
            return {
                emit(event, payload) { emitted.push({ room, event, payload }); }
            };
        },
        in() {
            return { async fetchSockets() { return sockets; } };
        }
    };
}

test('alertAdmin leaves Socket publishing to the event bus and sends only red email alerts', async () => {
    const socketTargets = [];
    const mail = [];
    notifyBridge.setIo({
        to(room) {
            socketTargets.push(room);
            return { emit() {} };
        }
    });
    notifyBridge.setHelpers({
        sendMail: async (to, subject, body) => mail.push({ to, subject, body })
    });
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
        await notifyBridge.alertAdmin('yellow', 'yellow subject', 'yellow body');
        await notifyBridge.alertAdmin('red', 'red subject', 'red body');
    } finally {
        console.warn = originalWarn;
        notifyBridge.setHelpers({ sendMail: null, sendTemplate: null });
        notifyBridge.setIo(null);
    }

    assert.deepEqual(socketTargets, []);
    assert.equal(mail.length, 1);
    assert.match(mail[0].subject, /red subject/);
    assert.equal(mail[0].body, 'red body');
});

test('proposal Socket payload uses one allowlisted public view for flat and nested contracts', async () => {
    const secretOpenId = 'openid-full-secret-sentinel';
    const expireAt = new Date('2026-08-02T02:00:00.000Z');
    const diff = {
        before: ['poi-a'],
        after: ['poi-b'],
        openId: secretOpenId,
        barrierFingerprint: 'internal-diff-fingerprint'
    };
    const publicDiff = { before: ['poi-a'], after: ['poi-b'] };
    const io = fakeIo([]);
    const templateRecipients = [];
    const errors = [];
    notifyBridge.setIo(io);
    notifyBridge.setHelpers({
        sendTemplate: async openId => {
            templateRecipients.push(openId);
            throw new Error(`upstream exposed ${openId}`);
        }
    });
    const originalError = console.error;
    console.error = (...args) => errors.push(args);
    try {
        await notifyBridge.pushProposal(secretOpenId, 'itinerary-1', 8, {
            itineraryId: 'must-not-remain-nested',
            proposalId: 'proposal-1',
            type: 'barrierReroute',
            reason: 'safer route available',
            gainMin: 20,
            expireAt,
            tokenIds: ['internal-token'],
            openId: secretOpenId,
            payload: {
                edgeId: 'edge-1',
                ownerOpenId: secretOpenId,
                nested: {
                    collector_open_id: secretOpenId,
                    openIdValue: secretOpenId,
                    safe: true
                }
            },
            barrierFingerprint: 'internal-fingerprint',
            rawRoute: { secret: true }
        }, diff);
    } finally {
        console.error = originalError;
        notifyBridge.setHelpers({ sendMail: null, sendTemplate: null });
        notifyBridge.setIo(null);
    }

    assert.equal(io.emitted.length, 1);
    assert.equal(io.emitted[0].room, `user:${secretOpenId}`);
    assert.equal(io.emitted[0].event, 'itinerary:proposal');
    const safeProposal = {
        proposalId: 'proposal-1',
        itineraryId: 'itinerary-1',
        version: 8,
        type: 'barrierReroute',
        reason: 'safer route available',
        gainMin: 20,
        expireAt,
        diff: publicDiff
    };
    assert.deepEqual(io.emitted[0].payload, {
        ...safeProposal,
        proposal: safeProposal
    });
    assert.equal(io.emitted[0].payload.tokenIds, undefined);
    assert.equal(io.emitted[0].payload.payload, undefined);
    assert.equal(io.emitted[0].payload.barrierFingerprint, undefined);
    assert.equal(io.emitted[0].payload.rawRoute, undefined);
    assert.equal(JSON.stringify(io.emitted[0].payload).includes(secretOpenId), false);
    assert.deepEqual(templateRecipients, [secretOpenId]);
    assert.equal(JSON.stringify(errors).includes(secretOpenId), false);
});

test('progress Socket payload exposes only documented fields and no OpenID', () => {
    const secretOpenId = 'openid-progress-secret-sentinel';
    const io = fakeIo();
    notifyBridge.setIo(io);
    try {
        notifyBridge.pushProgress(secretOpenId, {
            openId: secretOpenId,
            itineraryId: 'itinerary-2',
            version: 9,
            state: 'active',
            internalTrace: secretOpenId,
            stops: [{
                stopId: 'stop-1',
                poiId: 'poi-1',
                state: 'done',
                actualArrive: '2026-08-02T01:00:00.000Z',
                actualLeave: null,
                openId: secretOpenId,
                pathGeometry: secretOpenId
            }]
        });
    } finally {
        notifyBridge.setIo(null);
    }

    assert.deepEqual(io.emitted, [{
        room: `user:${secretOpenId}`,
        event: 'itinerary:progress',
        payload: {
            itineraryId: 'itinerary-2',
            version: 9,
            state: 'active',
            stops: [{
                stopId: 'stop-1',
                poiId: 'poi-1',
                state: 'done',
                actualArrive: '2026-08-02T01:00:00.000Z',
                actualLeave: null
            }]
        }
    }]);
    assert.equal(JSON.stringify(io.emitted[0].payload).includes(secretOpenId), false);
});

test('engine proposal logging identifies the itinerary without interpolating an OpenID', () => {
    const engineSource = fs.readFileSync(
        path.resolve(__dirname, '../../services/geosyncEngine.js'),
        'utf8'
    );
    const indexSource = fs.readFileSync(path.resolve(__dirname, '../../index.js'), 'utf8');
    const routeSource = fs.readFileSync(
        path.resolve(__dirname, '../../routes/itinerary.js'),
        'utf8'
    );
    const proposalLog = engineSource.split('\n')
        .find(line => line.includes('[ENGINE] proposal')) || '';

    assert.match(proposalLog, /itinerary=\$\{it\._id\}/);
    assert.doesNotMatch(proposalLog, /openId/i);
    assert.doesNotMatch(engineSource, /evaluate failed:',\s*e\.message/);
    assert.match(indexSource, /notifyBridge\.pushProgress\(payload\.openId, payload\)/);
    assert.doesNotMatch(indexSource, /emit\('itinerary:progress', payload\)/);
    assert.match(routeSource, /engine\.publicProposalView\(/);
    assert.match(routeSource, /engine\.proposalDiff\(/);
    assert.doesNotMatch(routeSource, /pendingProposal:\s*\{\s*\.\.\.proposal/);
});
