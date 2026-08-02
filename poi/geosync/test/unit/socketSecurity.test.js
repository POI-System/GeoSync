'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const modelModule = require('../../models');
const { CONFIG } = require('../../config');

const users = new Map([
    ['user-1', { openId: 'user-1', role: 'collector' }],
    ['user-2', { openId: 'user-2', role: 'reviewer' }],
    ['revoked-user', { openId: 'revoked-user', role: 'collector', enabled: false }]
]);

const ExternalUser = {
    findOne(filter) {
        return { lean: async () => users.get(String(filter.openId)) || null };
    }
};

modelModule.registerModels(new mongoose.Mongoose(), { User: ExternalUser });
const { bindSocket, defaultSocketIdentity } = require('../../index');

class FakeIo {
    constructor() {
        this.handlers = new Map();
    }
    on(event, handler) { this.handlers.set(event, handler); }
    connect(socket) { this.handlers.get('connection')(socket); }
}

class FakeSocket {
    constructor() {
        this.data = {};
        this.handlers = new Map();
        this.joinCalls = [];
        this.leaveCalls = [];
        this.emitted = [];
        this.disconnected = false;
    }
    on(event, handler) { this.handlers.set(event, handler); }
    async join(room) { this.joinCalls.push(room); }
    async leave(room) { this.leaveCalls.push(room); }
    emit(event, payload) { this.emitted.push({ event, payload }); }
    disconnect(force) { this.disconnected = Boolean(force); }
    trigger(event) { this.handlers.get(event)(); }
    joinedEvents() { return this.emitted.filter(item => item.event === 'geosync:joined'); }
}

async function waitFor(predicate) {
    for (let index = 0; index < 100; index++) {
        if (predicate()) return;
        await new Promise(resolve => setImmediate(resolve));
    }
    assert.fail('condition was not reached');
}

test('bindSocket auto-joins verified users and repeated joins are room-idempotent', async () => {
    const previousScenicId = CONFIG.scenicId;
    CONFIG.scenicId = 'scenic-test';
    const io = new FakeIo();
    const socket = new FakeSocket();
    let identity = { kind: 'user', openId: 'user-1', authenticated: true };
    try {
        bindSocket(io, async () => identity);
        io.connect(socket);
        await waitFor(() => socket.joinedEvents().length === 1);

        assert.deepEqual(socket.joinCalls, ['scenic:scenic-test', 'user:user-1']);
        assert.deepEqual(socket.data.geosyncRooms, ['scenic:scenic-test', 'user:user-1']);

        socket.trigger('geosync:join');
        await waitFor(() => socket.joinedEvents().length === 2);
        assert.deepEqual(socket.joinCalls, ['scenic:scenic-test', 'user:user-1']);
        assert.deepEqual(socket.leaveCalls, []);

        identity = { kind: 'user', openId: 'user-2', authenticated: true };
        socket.trigger('geosync:join');
        await waitFor(() => socket.joinedEvents().length === 3);
        assert.deepEqual(socket.leaveCalls, ['user:user-1']);
        assert.deepEqual(socket.joinCalls, ['scenic:scenic-test', 'user:user-1', 'user:user-2']);
        assert.deepEqual(socket.data.geosyncRooms, ['scenic:scenic-test', 'user:user-2']);

        identity = null;
        socket.trigger('geosync:join');
        await waitFor(() => socket.disconnected);
        assert.deepEqual(socket.leaveCalls, ['user:user-1', 'scenic:scenic-test', 'user:user-2']);
        assert.deepEqual(socket.data.geosyncRooms, []);
        assert.equal(socket.joinedEvents().at(-1).payload.ok, false);
    } finally {
        CONFIG.scenicId = previousScenicId;
    }
});

test('bindSocket removes stale admin rooms on downgrade and disconnects revoked users', async () => {
    const previousScenicId = CONFIG.scenicId;
    CONFIG.scenicId = 'scenic-secure';
    const io = new FakeIo();
    const socket = new FakeSocket();
    let identity = { kind: 'admin', subject: 'operator-1', authenticated: true };
    try {
        bindSocket(io, async () => identity);
        io.connect(socket);
        await waitFor(() => socket.joinedEvents().length === 1);
        assert.deepEqual(socket.joinCalls, ['admin:scenic-secure']);

        identity = { kind: 'user', openId: 'user-1', authenticated: true };
        socket.trigger('geosync:join');
        await waitFor(() => socket.joinedEvents().length === 2);
        assert.deepEqual(socket.leaveCalls, ['admin:scenic-secure']);
        assert.deepEqual(socket.data.geosyncRooms, ['scenic:scenic-secure', 'user:user-1']);

        identity = { kind: 'user', openId: 'revoked-user', authenticated: true };
        socket.trigger('geosync:join');
        await waitFor(() => socket.disconnected);
        assert.deepEqual(socket.data.geosyncRooms, []);
    } finally {
        CONFIG.scenicId = previousScenicId;
    }
});

test('bindSocket composes admin and verified user rooms without retaining stale access', async () => {
    const previousScenicId = CONFIG.scenicId;
    CONFIG.scenicId = 'scenic-dual';
    const io = new FakeIo();
    const socket = new FakeSocket();
    let identity = {
        kind: 'admin',
        subject: 'operator-1',
        isAdmin: true,
        openId: 'user-2',
        role: 'reviewer',
        authenticated: true
    };
    try {
        bindSocket(io, async () => identity);
        io.connect(socket);
        await waitFor(() => socket.joinedEvents().length === 1);
        assert.deepEqual(socket.joinCalls, [
            'admin:scenic-dual',
            'scenic:scenic-dual',
            'user:user-2'
        ]);
        assert.deepEqual(socket.data.geosyncRooms, [
            'admin:scenic-dual',
            'scenic:scenic-dual',
            'user:user-2'
        ]);
        assert.equal(socket.data.geosyncIdentity.isAdmin, true);
        assert.equal(socket.data.geosyncIdentity.openId, 'user-2');
        assert.equal(socket.data.geosyncIdentity.role, 'reviewer');

        socket.trigger('geosync:join');
        await waitFor(() => socket.joinedEvents().length === 2);
        assert.equal(socket.joinCalls.length, 3);
        assert.deepEqual(socket.leaveCalls, []);

        identity = { kind: 'admin', subject: 'operator-1', isAdmin: true, authenticated: true };
        socket.trigger('geosync:join');
        await waitFor(() => socket.joinedEvents().length === 3);
        assert.deepEqual(socket.leaveCalls, ['scenic:scenic-dual', 'user:user-2']);
        assert.deepEqual(socket.data.geosyncRooms, ['admin:scenic-dual']);

        identity = { kind: 'user', openId: 'user-1', authenticated: true };
        socket.trigger('geosync:join');
        await waitFor(() => socket.joinedEvents().length === 4);
        assert.deepEqual(socket.leaveCalls, [
            'scenic:scenic-dual',
            'user:user-2',
            'admin:scenic-dual'
        ]);
        assert.deepEqual(socket.data.geosyncRooms, ['scenic:scenic-dual', 'user:user-1']);
    } finally {
        CONFIG.scenicId = previousScenicId;
    }
});

test('bindSocket periodically revokes an idle identity without a client join event', async () => {
    const previousScenicId = CONFIG.scenicId;
    CONFIG.scenicId = 'scenic-periodic';
    const io = new FakeIo();
    const socket = new FakeSocket();
    let identity = { kind: 'user', openId: 'user-1', authenticated: true };
    try {
        bindSocket(io, async () => identity, { refreshIntervalMs: 10 });
        io.connect(socket);
        await waitFor(() => socket.joinedEvents().length === 1);
        identity = null;
        for (let attempt = 0; attempt < 100 && !socket.disconnected; attempt++) {
            await new Promise(resolve => setTimeout(resolve, 5));
        }
        assert.equal(socket.disconnected, true);
        socket.trigger('disconnect');
    } finally {
        CONFIG.scenicId = previousScenicId;
    }
});

test('default socket identity trusts server-authenticated data and rejects query identity by default', async () => {
    const previous = {
        nodeEnv: CONFIG.nodeEnv,
        isProduction: CONFIG.isProduction,
        authSignRequired: CONFIG.authSignRequired,
        legacyOpenIdEnabled: CONFIG.legacyOpenIdEnabled
    };
    try {
        Object.assign(CONFIG, {
            nodeEnv: 'production', isProduction: true,
            authSignRequired: true, legacyOpenIdEnabled: false
        });
        assert.deepEqual(await defaultSocketIdentity({
            data: { authIdentity: { kind: 'user', subject: 'user-1', role: 'collector' } }
        }), {
            kind: 'user', openId: 'user-1', role: 'collector', isAdmin: false, authenticated: true
        });
        assert.equal(await defaultSocketIdentity({ data: {}, openId: 'user-1' }), null);

        Object.assign(CONFIG, {
            nodeEnv: 'development', isProduction: false,
            authSignRequired: false, legacyOpenIdEnabled: true
        });
        assert.deepEqual(await defaultSocketIdentity({ data: {}, openId: 'user-1' }), {
            kind: 'user', openId: 'user-1', isAdmin: false, authenticated: true
        });
    } finally {
        Object.assign(CONFIG, previous);
    }
});
