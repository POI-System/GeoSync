import {
    CROWD_COLORS,
    MAP_COLORS,
    MAP_LAYER_STYLES,
    ROUTE_COLORS
} from './styles.js';

const SOURCE_IDS = Object.freeze({
    boundary: 'geosync-boundary',
    pois: 'geosync-pois',
    route: 'geosync-route',
    routeOld: 'geosync-route-old',
    routeNew: 'geosync-route-new',
    user: 'geosync-user',
    closedEdges: 'geosync-closed-edges'
});

const LAYER_IDS = Object.freeze({
    boundaryFill: 'geosync-boundary-fill',
    boundaryLine: 'geosync-boundary-line',
    routeOld: 'geosync-route-old-line',
    route: 'geosync-route-line',
    routeNew: 'geosync-route-new-line',
    closedEdges: 'geosync-closed-edges-line',
    poiCrowd: 'geosync-poi-crowd',
    poiIcon: 'geosync-poi-icon',
    poiLabel: 'geosync-poi-label',
    userAccuracy: 'geosync-user-accuracy',
    userPoint: 'geosync-user-point'
});

export const emptyFeatureCollection = () => ({ type: 'FeatureCollection', features: [] });

export function installSourcesAndLayers(map) {
    const sources = SOURCE_IDS;
    const layers = LAYER_IDS;
    const style = MAP_LAYER_STYLES;
    for (const sourceId of Object.values(sources)) {
        if (!map.getSource(sourceId)) {
            map.addSource(sourceId, { type: 'geojson', data: emptyFeatureCollection() });
        }
    }

    const addLayer = layer => {
        if (!map.getLayer(layer.id)) map.addLayer(layer);
    };

    addLayer({
        id: layers.boundaryFill,
        type: 'fill',
        source: sources.boundary,
        paint: { 'fill-color': MAP_COLORS.boundary, 'fill-opacity': style.boundary.fillOpacity }
    });
    addLayer({
        id: layers.boundaryLine,
        type: 'line',
        source: sources.boundary,
        paint: {
            'line-color': MAP_COLORS.boundary,
            'line-width': style.boundary.lineWidth,
            'line-dasharray': style.boundary.dash
        }
    });
    addLayer({
        id: layers.routeOld,
        type: 'line',
        source: sources.routeOld,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
            'line-color': ROUTE_COLORS.old,
            'line-width': style.routeOld.width,
            'line-opacity': style.routeOld.opacity,
            'line-dasharray': style.routeOld.dash
        }
    });
    addLayer({
        id: layers.route,
        type: 'line',
        source: sources.route,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
            'line-color': ['coalesce', ['get', 'color'], ROUTE_COLORS.normal],
            'line-width': style.route.width,
            'line-opacity': style.route.opacity,
            'line-dasharray': style.route.solidDash
        }
    });
    addLayer({
        id: layers.routeNew,
        type: 'line',
        source: sources.routeNew,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
            'line-color': ['coalesce', ['get', 'color'], ROUTE_COLORS.normal],
            'line-width': style.routeNew.width,
            'line-opacity': style.routeNew.opacity
        }
    });
    addLayer({
        id: layers.closedEdges,
        type: 'line',
        source: sources.closedEdges,
        layout: { 'line-cap': 'round' },
        paint: {
            'line-color': ROUTE_COLORS.closed,
            'line-width': ['case', ['boolean', ['get', 'selected'], false], style.closedEdge.selectedWidth, style.closedEdge.width],
            'line-dasharray': style.closedEdge.dash
        }
    });
    addLayer({
        id: layers.poiCrowd,
        type: 'circle',
        source: sources.pois,
        filter: ['!=', ['get', 'status'], 'closed'],
        paint: {
            'circle-radius': ['interpolate', ['linear'], ['zoom'], 13, style.poi.minRadius, 18, style.poi.maxRadius],
            'circle-color': ['coalesce', ['get', 'crowdColor'], CROWD_COLORS.unknown],
            'circle-opacity': ['case', ['==', ['get', 'status'], 'limited'], style.poi.limitedOpacity, style.poi.opacity],
            'circle-stroke-width': style.poi.strokeWidth,
            'circle-stroke-color': MAP_COLORS.white
        }
    });
    addLayer({
        id: layers.poiIcon,
        type: 'symbol',
        source: sources.pois,
        filter: ['!=', ['get', 'status'], 'closed'],
        layout: {
            'icon-image': ['coalesce', ['get', 'iconId'], 'geosync-poi-default'],
            'icon-size': ['interpolate', ['linear'], ['zoom'], 13, 0.62, 18, 0.86],
            'icon-allow-overlap': true
        }
    });
    if (map.getStyle()?.glyphs) {
        addLayer({
            id: layers.poiLabel,
            type: 'symbol',
            source: sources.pois,
            minzoom: 15,
            filter: ['!=', ['get', 'status'], 'closed'],
            layout: {
                'text-field': ['concat', ['coalesce', ['get', 'name'], ''], '\n', ['coalesce', ['get', 'crowdLabel'], '准备中']],
                'text-size': 12,
                'text-offset': [0, 1.8],
                'text-anchor': 'top',
                'text-allow-overlap': false
            },
            paint: { 'text-color': MAP_COLORS.text, 'text-halo-color': MAP_COLORS.white, 'text-halo-width': 2 }
        });
    }
    addLayer({
        id: layers.userAccuracy,
        type: 'circle',
        source: sources.user,
        paint: {
            'circle-radius': style.user.accuracyRadius,
            'circle-color': MAP_COLORS.user,
            'circle-opacity': style.user.accuracyOpacity
        }
    });
    addLayer({
        id: layers.userPoint,
        type: 'circle',
        source: sources.user,
        paint: {
            'circle-radius': style.user.pointRadius,
            'circle-color': MAP_COLORS.user,
            'circle-stroke-color': MAP_COLORS.white,
            'circle-stroke-width': style.user.strokeWidth
        }
    });

    return Object.freeze({
        getSource(key) {
            const id = sources[key];
            return id ? map.getSource(id) : null;
        },
        getLayer(key) {
            const id = layers[key];
            return id ? map.getLayer(id) : null;
        },
        setPaintProperty(key, property, value) {
            const id = layers[key];
            if (id) map.setPaintProperty(id, property, value);
        },
        onLayer(event, key, handler) {
            const id = layers[key];
            if (id) map.on(event, id, handler);
        },
        offLayer(event, key, handler) {
            const id = layers[key];
            if (id) map.off?.(event, id, handler);
        }
    });
}
