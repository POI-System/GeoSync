'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHostSocketRoomSync } = require('../../services/hostSocketRooms');

function fakeChatRoomModel(rows, observed) {
    return {
        find(filter, projection) {
            observed.filter = filter;
            observed.projection = projection;
            return {
                sort(value) { observed.sort = value; return this; },
                limit(value) { observed.limit = value; return this; },
                async lean() { return rows; }
            };
        }
    };
}

function fakeSocket() {
    const joined = new Set();
    return {
        data: {},
        joined,
        disconnected: false,
        async join(rooms) {
            for (const room of Array.isArray(rooms) ? rooms : [rooms]) joined.add(room);
        },
        async leave(room) { joined.delete(room); },
        disconnect() { this.disconnected = true; }
    };
}

function nextTurn() {
    return new Promise(resolve => setImmediate(resolve));
}

test('host Socket room refreshes serialize role changes and remove stale rooms', async () => {
    const pendingIdentities = [];
    const observed = {};
    const socket = fakeSocket();
    const roomSync = createHostSocketRoomSync({
        getIdentity: () => new Promise(resolve => pendingIdentities.push(resolve)),
        ChatRoom: fakeChatRoomModel([{ roomId: 'audit-1' }], observed),
        groupRoomForRole: role => role === 'reviewer' ? 'reviewer_group' : 'collector_group',
        socketRoomForGroup: room => `chat_${room}`,
        privateRoomLimit: 100
    });

    const first = roomSync.sync(socket);
    const second = roomSync.sync(socket);
    await nextTurn();
    assert.equal(pendingIdentities.length, 1, 'the second refresh must wait for the first');

    pendingIdentities[0]({ isAdmin: false, openId: 'user-a', role: 'reviewer' });
    await nextTurn();
    assert.equal(pendingIdentities.length, 2);
    pendingIdentities[1]({ isAdmin: false, openId: 'user-a', role: 'collector' });
    await Promise.all([first, second]);

    assert.deepEqual(new Set(socket.data.hostRooms), new Set([
        'user_user-a',
        'chat_collector_group',
        'chat_audit-1'
    ]));
    assert.equal(socket.joined.has('reviewer_group'), false);
    assert.equal(socket.joined.has('chat_reviewer_group'), false);
    assert.equal(observed.limit, 100);
    assert.deepEqual(observed.sort, { lastTime: -1 });
});

test('host Socket room refresh disconnects identities that no longer authenticate', async () => {
    const socket = fakeSocket();
    socket.data.hostRooms = ['user_user-a', 'chat_collector_group'];
    const roomSync = createHostSocketRoomSync({
        getIdentity: async () => null,
        ChatRoom: fakeChatRoomModel([], {}),
        groupRoomForRole: () => 'collector_group',
        socketRoomForGroup: room => `chat_${room}`
    });

    assert.equal(await roomSync.refresh(socket), null);
    assert.equal(socket.disconnected, true);
});

test('host Socket room refresh periodically revokes an idle connection', async () => {
    const socket = fakeSocket();
    let currentIdentity = { isAdmin: false, openId: 'user-a', role: 'collector' };
    const roomSync = createHostSocketRoomSync({
        getIdentity: async () => currentIdentity,
        ChatRoom: fakeChatRoomModel([], {}),
        groupRoomForRole: () => 'collector_group',
        socketRoomForGroup: room => `chat_${room}`
    });

    await roomSync.sync(socket);
    const stop = roomSync.start(socket, 10);
    currentIdentity = null;
    try {
        for (let attempt = 0; attempt < 50 && !socket.disconnected; attempt++) {
            await new Promise(resolve => setTimeout(resolve, 5));
        }
        assert.equal(socket.disconnected, true);
    } finally {
        stop();
    }
});
