export const MAP_EVENT_NAMES = Object.freeze({
    POI_SELECTED: 'poi:selected',
    ROUTE_COMPARED: 'route:compared',
    MAP_ERROR: 'map:error'
});

export const SOCKET_EVENT_NAMES = Object.freeze({
    JOINED: 'geosync:joined',
    PROPOSAL: 'itinerary:proposal',
    PROGRESS: 'itinerary:progress',
    CROWD: 'crowd:update',
    GRAPH: 'graph:update',
    RAIN_INCOMING: 'rain:incoming',
    RAIN_CLEARED: 'rain:cleared'
});

export function dispatchDetail(target, name, detail) {
    return target.dispatchEvent(new CustomEvent(name, { detail }));
}
