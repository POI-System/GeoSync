'use strict';

function validScenicId(value) {
    const scenicId = String(value || '').trim();
    if (!scenicId || scenicId.length > 128 || /[\u0000-\u001f\u007f]/.test(scenicId)) {
        throw new TypeError('scenicId is invalid');
    }
    return scenicId;
}

function openIdOf(identity) {
    const value = identity?.openId ?? identity?.subject;
    const openId = value === undefined || value === null ? '' : String(value).trim();
    if (!openId || openId.length > 128 || /[\u0000-\u001f\u007f]/.test(openId)) return '';
    return openId;
}

function adminIdentity(identity) {
    return identity?.isAdmin === true || identity?.kind === 'admin';
}

function createSocketRoomAuthorizer({ socket, scenicId, getIdentity, getUser, isRevoked } = {}) {
    if (!socket || typeof socket.join !== 'function' || typeof socket.leave !== 'function'
        || typeof socket.emit !== 'function' || typeof socket.disconnect !== 'function') {
        throw new TypeError('socket must implement join, leave, emit, and disconnect');
    }
    if (typeof getIdentity !== 'function') throw new TypeError('getIdentity must be a function');
    if (typeof getUser !== 'function') throw new TypeError('getUser must be a function');
    if (isRevoked !== undefined && typeof isRevoked !== 'function') {
        throw new TypeError('isRevoked must be a function');
    }

    const resolvedScenicId = validScenicId(scenicId);
    const revoked = isRevoked || (user => !user || user.enabled === false || user.disabled === true || user.banned === true);
    const joinedRooms = new Set();
    let queue = Promise.resolve();

    async function leaveAll() {
        for (const room of [...joinedRooms]) {
            try {
                await socket.leave(room);
            } catch {
                // The connection is being revoked; local authorization state must still be cleared.
            }
            joinedRooms.delete(room);
        }
    }

    async function disconnect(message) {
        await leaveAll();
        if (socket.data && typeof socket.data === 'object') {
            delete socket.data.geosyncIdentity;
            socket.data.geosyncRooms = [];
        }
        try { socket.emit('geosync:joined', { ok: false, message }); } catch {}
        try { socket.disconnect(true); } catch {}
        return { ok: false, rooms: [] };
    }

    async function synchronize() {
        let identity;
        try {
            identity = await getIdentity(socket);
        } catch {
            return disconnect('Authentication failed');
        }
        if (!identity || identity.revoked === true || identity.authenticated === false) {
            return disconnect('Authentication required');
        }

        const isAdmin = adminIdentity(identity);
        const openId = isAdmin
            ? openIdOf({ openId: identity.openId })
            : openIdOf(identity);
        if (!isAdmin && !openId) return disconnect('Authentication required');
        if (isAdmin && identity.openId && !openId) return disconnect('Authentication required');

        let user = null;
        if (openId) {
            try {
                user = await getUser(openId);
            } catch {
                return disconnect('Authentication failed');
            }
            if (revoked(user)) return disconnect('User is unavailable');
        }

        const desiredRooms = new Set();
        if (isAdmin) desiredRooms.add(`admin:${resolvedScenicId}`);
        if (user) {
            desiredRooms.add(`scenic:${resolvedScenicId}`);
            desiredRooms.add(`user:${openId}`);
        }
        const normalizedIdentity = Object.freeze({
            kind: isAdmin ? 'admin' : 'user',
            subject: isAdmin
                ? String(identity.subject || identity.adminUsername || 'admin').slice(0, 128)
                : openId,
            ...(user ? { openId, role: String(user.role || '') } : {}),
            isAdmin
        });

        for (const room of [...joinedRooms]) {
            if (!desiredRooms.has(room)) {
                await socket.leave(room);
                joinedRooms.delete(room);
            }
        }
        for (const room of desiredRooms) {
            if (!joinedRooms.has(room)) {
                await socket.join(room);
                joinedRooms.add(room);
            }
        }

        const rooms = [...joinedRooms];
        if (socket.data && typeof socket.data === 'object') {
            socket.data.geosyncIdentity = normalizedIdentity;
            socket.data.geosyncRooms = rooms;
        }
        socket.emit('geosync:joined', { ok: true, rooms });
        return { ok: true, identity: normalizedIdentity, rooms };
    }

    function refresh() {
        const operation = queue.catch(() => {}).then(async () => {
            try {
                return await synchronize();
            } catch {
                return disconnect('Room authorization failed');
            }
        });
        queue = operation;
        return operation;
    }

    return {
        refresh,
        rooms: () => [...joinedRooms]
    };
}

module.exports = {
    createSocketRoomAuthorizer,
    openIdOf,
    adminIdentity
};
