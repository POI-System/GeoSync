'use strict';

function createHostSocketRoomSync(options = {}) {
    const getIdentity = options.getIdentity;
    const ChatRoom = options.ChatRoom;
    const groupRoomForRole = options.groupRoomForRole;
    const socketRoomForGroup = options.socketRoomForGroup;
    const logger = options.logger || console;
    const privateRoomLimit = Number.isInteger(options.privateRoomLimit)
        && options.privateRoomLimit > 0
        ? Math.min(options.privateRoomLimit, 500)
        : 100;

    if (typeof getIdentity !== 'function') throw new TypeError('getIdentity is required');
    if (!ChatRoom || typeof ChatRoom.find !== 'function') throw new TypeError('ChatRoom.find is required');
    if (typeof groupRoomForRole !== 'function') throw new TypeError('groupRoomForRole is required');
    if (typeof socketRoomForGroup !== 'function') throw new TypeError('socketRoomForGroup is required');

    async function syncNow(socket) {
        const identity = await getIdentity(socket);
        if (!identity) {
            socket.disconnect(true);
            return null;
        }

        socket.isAdmin = identity.isAdmin === true;
        socket.openId = identity.openId || null;
        socket.role = identity.role || null;

        const desiredRooms = new Set();
        if (socket.openId) {
            desiredRooms.add(`user_${socket.openId}`);
            desiredRooms.add(socketRoomForGroup(groupRoomForRole(socket.role)));
            if (socket.role === 'reviewer') desiredRooms.add('reviewer_group');
            const rooms = await ChatRoom.find({
                $or: [
                    { collectorOpenId: socket.openId },
                    { reviewerOpenId: socket.openId }
                ]
            }, { roomId: 1 })
                .sort({ lastTime: -1 })
                .limit(privateRoomLimit)
                .lean();
            for (const room of rooms) desiredRooms.add(`chat_${room.roomId}`);
        }

        const previousRooms = new Set(socket.data.hostRooms || []);
        for (const room of previousRooms) {
            if (!desiredRooms.has(room)) await socket.leave(room);
        }
        if (desiredRooms.size) await socket.join([...desiredRooms]);
        socket.data.hostRooms = [...desiredRooms];
        return identity;
    }

    function sync(socket) {
        const previous = socket.data.hostRoomRefresh || Promise.resolve();
        const refresh = previous
            .catch(() => null)
            .then(() => syncNow(socket));
        socket.data.hostRoomRefresh = refresh;
        void refresh.finally(() => {
            if (socket.data.hostRoomRefresh === refresh) {
                delete socket.data.hostRoomRefresh;
            }
        }).catch(() => {});
        return refresh;
    }

    async function refresh(socket) {
        try {
            return await sync(socket);
        } catch (error) {
            logger.warn('[socket refresh]', error?.name || 'Error');
            socket.disconnect(true);
            return null;
        }
    }

    function start(socket, intervalMs = 60 * 1000) {
        const delay = Number(intervalMs);
        if (!Number.isInteger(delay) || delay < 10 || delay > 5 * 60 * 1000) {
            throw new TypeError('intervalMs must be an integer between 10 and 300000');
        }
        const timer = setInterval(() => { void refresh(socket); }, delay);
        timer.unref?.();
        const stop = () => clearInterval(timer);
        if (typeof socket.once === 'function') socket.once('disconnect', stop);
        return stop;
    }

    return Object.freeze({ sync, refresh, start });
}

module.exports = { createHostSocketRoomSync };
