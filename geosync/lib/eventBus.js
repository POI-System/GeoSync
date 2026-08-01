'use strict';
// 01文档 §5：进程内事件总线。升级 Redis Pub/Sub 只改本文件。

const { EventEmitter } = require('events');

const EVENTS = {
    POSITION_REPORTED: 'position:reported',
    STAY_OPENED: 'stay:opened',
    STAY_CLOSED: 'stay:closed',
    CI_UPDATED: 'ci:updated',
    CI_LEVEL_CHANGED: 'ci:levelChanged',
    RAIN_INCOMING: 'rain:incoming',
    RAIN_CLEARED: 'rain:cleared',
    EDGE_CLOSED: 'graph:edgeClosed',
    EDGE_OPENED: 'graph:edgeOpened',
    ITINERARY_DEVIATED: 'itinerary:deviated',
    ITINERARY_PROGRESS: 'itinerary:progress',
    STAY_OVERTIME: 'itinerary:stayOvertime',
    REROUTE_PROPOSED: 'reroute:proposed',
    REROUTE_DECIDED: 'reroute:decided',
    PAIRING_PROPOSED: 'pairing:proposed',
    CHECKIN_VERIFIED: 'checkin:verified',
    ALERT_CROWD: 'alert:crowd',
    ALERT_ANOMALY: 'alert:anomaly',
    SPOT_APPROVED: 'spot:approved'
};

const bus = new EventEmitter();
bus.setMaxListeners(50);

module.exports = {
    EVENTS,
    emit(event, payload) {
        setImmediate(() => bus.emit(event, payload)); // 异步派发，生产者不被消费者阻塞
    },
    on(event, handler) {
        bus.on(event, async payload => {
            try {
                await handler(payload);
            } catch (e) {
                console.error(`[GeoSync] [BUS] handler for ${event} failed:`, e.message);
            }
        });
    }
};
