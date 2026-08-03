export const SOURCE_IDS = Object.freeze({
    boundary: 'geosync-boundary',
    pois: 'geosync-pois',
    route: 'geosync-route',
    routeOld: 'geosync-route-old',
    routeNew: 'geosync-route-new',
    user: 'geosync-user',
    closedEdges: 'geosync-closed-edges'
});

export const LAYER_IDS = Object.freeze({
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
    for (const sourceId of Object.values(SOURCE_IDS)) {
        if (!map.getSource(sourceId)) {
            map.addSource(sourceId, { type: 'geojson', data: emptyFeatureCollection() });
        }
    }

    const addLayer = layer => {
        if (!map.getLayer(layer.id)) map.addLayer(layer);
    };

    addLayer({
        id: LAYER_IDS.boundaryFill,
        type: 'fill',
        source: SOURCE_IDS.boundary,
        paint: { 'fill-color': '#087f73', 'fill-opacity': 0.06 }
    });
    addLayer({
        id: LAYER_IDS.boundaryLine,
        type: 'line',
        source: SOURCE_IDS.boundary,
        paint: { 'line-color': '#087f73', 'line-width': 2, 'line-dasharray': [3, 2] }
    });
    addLayer({
        id: LAYER_IDS.routeOld,
        type: 'line',
        source: SOURCE_IDS.routeOld,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#707a80', 'line-width': 6, 'line-opacity': 0.65, 'line-dasharray': [2, 2] }
    });
    addLayer({
        id: LAYER_IDS.route,
        type: 'line',
        source: SOURCE_IDS.route,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
            'line-color': ['coalesce', ['get', 'color'], '#087f73'],
            'line-width': 6,
            'line-opacity': 0.92,
            'line-dasharray': [1, 0]
        }
    });
    addLayer({
        id: LAYER_IDS.routeNew,
        type: 'line',
        source: SOURCE_IDS.routeNew,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#087f73', 'line-width': 5, 'line-opacity': 0.9 }
    });
    addLayer({
        id: LAYER_IDS.closedEdges,
        type: 'line',
        source: SOURCE_IDS.closedEdges,
        layout: { 'line-cap': 'round' },
        paint: {
            'line-color': '#b42318',
            'line-width': ['case', ['boolean', ['get', 'selected'], false], 8, 5],
            'line-dasharray': [1, 1]
        }
    });
    addLayer({
        id: LAYER_IDS.poiCrowd,
        type: 'circle',
        source: SOURCE_IDS.pois,
        filter: ['!=', ['get', 'status'], 'closed'],
        paint: {
            'circle-radius': ['interpolate', ['linear'], ['zoom'], 13, 10, 18, 17],
            'circle-color': ['coalesce', ['get', 'crowdColor'], '#8e8e93'],
            'circle-opacity': ['case', ['==', ['get', 'status'], 'limited'], 0.5, 0.92],
            'circle-stroke-width': 3,
            'circle-stroke-color': '#ffffff'
        }
    });
    addLayer({
        id: LAYER_IDS.poiIcon,
        type: 'symbol',
        source: SOURCE_IDS.pois,
        filter: ['!=', ['get', 'status'], 'closed'],
        layout: {
            'icon-image': ['coalesce', ['get', 'iconId'], 'geosync-poi-default'],
            'icon-size': ['interpolate', ['linear'], ['zoom'], 13, 0.62, 18, 0.86],
            'icon-allow-overlap': true
        }
    });
    if (map.getStyle()?.glyphs) {
        addLayer({
            id: LAYER_IDS.poiLabel,
            type: 'symbol',
            source: SOURCE_IDS.pois,
            minzoom: 15,
            layout: {
                'text-field': ['concat', ['coalesce', ['get', 'name'], ''], '\n', ['coalesce', ['get', 'crowdLabel'], '准备中']],
                'text-size': 12,
                'text-offset': [0, 1.8],
                'text-anchor': 'top',
                'text-allow-overlap': false
            },
            paint: { 'text-color': '#17222a', 'text-halo-color': '#ffffff', 'text-halo-width': 2 }
        });
    }
    addLayer({
        id: LAYER_IDS.userAccuracy,
        type: 'circle',
        source: SOURCE_IDS.user,
        paint: { 'circle-radius': 18, 'circle-color': '#2774ae', 'circle-opacity': 0.14 }
    });
    addLayer({
        id: LAYER_IDS.userPoint,
        type: 'circle',
        source: SOURCE_IDS.user,
        paint: { 'circle-radius': 7, 'circle-color': '#2774ae', 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 3 }
    });
}
