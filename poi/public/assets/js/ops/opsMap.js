const SVG_NS = 'http://www.w3.org/2000/svg';
const ROAD_SOURCE_ID = 'sjp-real-roads';
const ROAD_LAYER_ID = 'sjp-real-roads-line';
const ROAD_SELECTED_LAYER_ID = 'sjp-real-roads-selected';
const ROAD_HIT_LAYER_ID = 'sjp-real-roads-hit';

function coordinatePartsOf(edge, nodeIndex) {
    if (Array.isArray(edge?.geometry) && edge.geometry.length >= 2) return [edge.geometry];
    if (edge?.geometry?.type === 'LineString') return [edge.geometry.coordinates];
    if (edge?.geometry?.type === 'MultiLineString') return edge.geometry.coordinates;
    const from = nodeIndex.get(String(edge?.from));
    const to = nodeIndex.get(String(edge?.to));
    return from && to ? [[from, to]] : [];
}

function nodeCoordinate(node) {
    const value = node?.geo?.coordinates || node?.lnglat || node?.coordinates;
    return Array.isArray(value) && value.length >= 2 ? [Number(value[0]), Number(value[1])] : null;
}

function extentFromConfig(config) {
    const value = config?.gis?.extent || config?.extent;
    return Array.isArray(value) && value.length === 4 ? value.map(Number) : [114.352, 30.536, 114.367, 30.547];
}

function projection(extent, width = 1000, height = 700) {
    const [west, south, east, north] = extent;
    return ([lng, lat]) => [
        ((Number(lng) - west) / Math.max(0.000001, east - west)) * width,
        height - ((Number(lat) - south) / Math.max(0.000001, north - south)) * height
    ];
}

function rectangleBoundary(extent) {
    const [west, south, east, north] = extent;
    return {
        type: 'FeatureCollection',
        features: [{
            type: 'Feature', properties: { fallback: true },
            geometry: { type: 'Polygon', coordinates: [[[west, south], [east, south], [east, north], [west, north], [west, south]]] }
        }]
    };
}

function roadFeatureCollection(graph) {
    const nodes = new Map((graph?.nodes || []).map(node => [String(node.nodeId), nodeCoordinate(node)]));
    const features = [];
    for (const edge of graph?.edges || []) {
        if (!edge?.edgeId || edge.status === 'candidate') continue;
        const parts = coordinatePartsOf(edge, nodes).map(coordinates =>
            (coordinates || []).filter(coordinate => Array.isArray(coordinate) && coordinate.length >= 2)
                .map(coordinate => [Number(coordinate[0]), Number(coordinate[1])])
                .filter(coordinate => coordinate.every(Number.isFinite))
        ).filter(coordinates => coordinates.length >= 2);
        if (!parts.length) continue;
        features.push({
            type: 'Feature',
            properties: {
                edgeId: String(edge.edgeId),
                name: String(edge.name || edge.edgeId),
                status: String(edge.status || 'open'),
                congestion: String(edge.congestion || 'smooth'),
                warning: String(edge.warning || '')
            },
            geometry: parts.length === 1
                ? { type: 'LineString', coordinates: parts[0] }
                : { type: 'MultiLineString', coordinates: parts }
        });
    }
    return { type: 'FeatureCollection', features };
}

function iServerRasterAdapter(onMapCreated = () => {}) {
    return {
        init(container, config, { maplibregl, Map }) {
            const Constructor = Map || maplibregl?.Map;
            if (typeof Constructor !== 'function') throw new Error('MapLibreGL unavailable');
            const baseUrl = config.mapUrl.replace(/\/$/, '');
            const tileUrl = `${baseUrl}/zxyTileImage.png?z={z}&x={x}&y={y}&width=256&height=256&transparent=false`;
            const map = new Constructor({
                container,
                style: {
                    version: 8,
                    sources: {
                        'sxr-iserver': {
                            type: 'raster',
                            tiles: [tileUrl],
                            tileSize: 256,
                            attribution: 'SuperMap iServer'
                        }
                    },
                    layers: [{ id: 'sxr-iserver-base', type: 'raster', source: 'sxr-iserver' }]
                },
                center: config.center,
                zoom: config.zoom,
                minZoom: config.minZoom,
                maxZoom: config.maxZoom,
                attributionControl: false
            });
            onMapCreated(map);
            return map;
        }
    };
}

export class OpsMapView {
    constructor(container, { onEdgeSelected = null } = {}) {
        this.container = container;
        this.onEdgeSelected = typeof onEdgeSelected === 'function' ? onEdgeSelected : () => {};
        this.interactiveEdges = typeof onEdgeSelected === 'function';
        this.sharedMap = null;
        this.sharedReady = false;
        this.nativeMap = null;
        this.nativeRoadsInstalled = false;
        this.nativeRoadHandlers = null;
        this.nativePickHandler = null;
        this.config = null;
        this.graph = { nodes: [], edges: [] };
        this.heatmap = [];
        this.managedPois = [];
        this.selectedEdgeId = null;
        this.pointPicker = null;
        this.svg = container.querySelector('[data-map-overlay]');
        this.base = container.querySelector('[data-shared-map]');
    }

    async init(config) {
        this.config = config;
        try {
            const { MapFacade } = await import('../map/mapFacade.js');
            const gis = config?.gis || {};
            let nativeMap = null;
            const map = new MapFacade({
                adapter: gis.source === 'iserver'
                    ? iServerRasterAdapter(instance => { nativeMap = instance; })
                    : null
            });
            const center = gis.center || config?.scenicCenter;
            const extent = extentFromConfig(config);
            await map.init(this.base, {
                demo: gis.source === 'demo' || !gis.publicServices?.map,
                mapUrl: gis.publicServices?.map || '',
                center,
                extent,
                zoom: 15,
                minZoom: 13,
                maxZoom: 20,
                crs: gis.crs || 'EPSG:4326'
            });
            nativeMap ||= map.requireReady('OpsMapView.init');
            map.setBoundary(rectangleBoundary(extent));
            this.sharedMap = map;
            this.sharedReady = true;
            this.nativeMap = nativeMap;
            this.installNativeRoadLayers();
            this.container.dataset.mapMode = gis.source === 'local-snapshot' ? 'local-snapshot' : 'shared';
            delete this.container.dataset.mapError;
        } catch (error) {
            this.container.dataset.mapMode = 'fallback';
            this.container.dataset.mapError = error?.code || 'MAP_UNAVAILABLE';
        }
        this.render();
    }

    setGraph(graph) {
        this.graph = graph || { nodes: [], edges: [] };
        this.render();
        this.syncClosedEdges();
    }

    setCrowd(snapshot) {
        this.heatmap = Array.isArray(snapshot?.items) ? snapshot.items : [];
        if (this.sharedReady) {
            try {
                this.syncPois();
                this.sharedMap.setCrowd(snapshot);
            } catch { /* Overlay remains available. */ }
        }
        this.render();
    }

    setManagedPois(pois) {
        this.managedPois = Array.isArray(pois) ? pois.map(poi => ({ ...poi })) : [];
        if (this.sharedReady) this.syncPois();
    }

    syncPois() {
        const crowdPois = this.heatmap.filter(item => Array.isArray(item?.lnglat)).map(item => ({
            poiId: item.poiId,
            name: item.name,
            lng: item.lnglat[0],
            lat: item.lnglat[1],
            category: item.category || 'default',
            status: 'approved'
        }));
        const managed = this.managedPois.map(poi => ({
            poiId: poi.poiId,
            name: poi.name,
            lng: Number(poi.lng),
            lat: Number(poi.lat),
            category: poi.category || '旅游景点',
            status: 'approved'
        }));
        this.sharedMap.setPois([...crowdPois, ...managed]);
    }

    pickPoint(callback) {
        if (typeof callback !== 'function') return;
        this.cancelPointSelection();
        this.pointPicker = callback;
        this.container.dataset.pickMode = 'point';
        const canvas = this.nativeMap?.getCanvas?.();
        if (canvas) canvas.style.cursor = 'crosshair';
    }

    cancelPointSelection() {
        this.pointPicker = null;
        delete this.container.dataset.pickMode;
        const canvas = this.nativeMap?.getCanvas?.();
        if (canvas) canvas.style.cursor = '';
    }

    selectEdge(edgeId) {
        this.selectedEdgeId = edgeId == null ? null : String(edgeId);
        this.render();
        if (this.sharedReady && !this.nativeRoadsInstalled) {
            try { this.sharedMap.selectEdge(this.selectedEdgeId); } catch { /* Open edges live in the ops overlay. */ }
        }
    }

    setConnectionState(state) {
        if (this.sharedReady) this.sharedMap.setConnectionState(state);
    }

    flashAlert() {
        this.container.classList.remove('is-alerting');
        void this.container.offsetWidth;
        this.container.classList.add('is-alerting');
        setTimeout(() => this.container.classList.remove('is-alerting'), 900);
    }

    syncClosedEdges() {
        if (!this.sharedReady || this.nativeRoadsInstalled) return;
        const nodes = new Map(this.graph.nodes.map(node => [String(node.nodeId), nodeCoordinate(node)]));
        const closed = this.graph.edges.filter(edge => edge.status === 'closed').flatMap(edge =>
            coordinatePartsOf(edge, nodes).map(coordinates => ({
                edgeId: String(edge.edgeId),
                geometry: { type: 'LineString', coordinates }
            }))
        ).filter(edge => edge.geometry.coordinates.length >= 2);
        try { this.sharedMap.setClosedEdges(closed); } catch { /* The overlay still reflects authoritative status. */ }
    }

    installNativeRoadLayers() {
        const map = this.nativeMap;
        if (!map?.addSource || !map?.addLayer || map.getSource?.(ROAD_SOURCE_ID)) return;
        const screenTheme = this.container.classList.contains('screen-map');
        map.addSource(ROAD_SOURCE_ID, { type: 'geojson', data: roadFeatureCollection(this.graph) });
        map.addLayer({
            id: ROAD_LAYER_ID,
            type: 'line',
            source: ROAD_SOURCE_ID,
            paint: {
                'line-color': [
                    'case',
                    ['==', ['get', 'status'], 'closed'], screenTheme ? '#ff5147' : '#b42318',
                    ['==', ['get', 'congestion'], 'congested'], screenTheme ? '#ff5147' : '#d92d20',
                    ['==', ['get', 'congestion'], 'busy'], screenTheme ? '#ffb020' : '#d97706',
                    screenTheme ? '#56e39f' : '#087f5b'
                ],
                'line-width': screenTheme ? 4 : 6,
                'line-opacity': screenTheme ? .88 : .94
            }
        });
        if (this.interactiveEdges) {
            map.addLayer({
                id: ROAD_SELECTED_LAYER_ID,
                type: 'line',
                source: ROAD_SOURCE_ID,
                filter: ['==', ['get', 'edgeId'], ''],
                paint: {
                    'line-color': ['case', ['==', ['get', 'status'], 'closed'], '#b42318', '#101828'],
                    'line-width': 10
                }
            });
            map.addLayer({
                id: ROAD_HIT_LAYER_ID,
                type: 'line',
                source: ROAD_SOURCE_ID,
                paint: { 'line-color': 'rgba(0,0,0,0)', 'line-width': 22 }
            });
            const click = event => {
                if (this.pointPicker) return;
                const edgeId = event.features?.[0]?.properties?.edgeId;
                if (edgeId !== undefined && edgeId !== null) this.onEdgeSelected(String(edgeId));
            };
            const enter = () => { map.getCanvas().style.cursor = 'pointer'; };
            const leave = () => { map.getCanvas().style.cursor = ''; };
            map.on('click', ROAD_HIT_LAYER_ID, click);
            map.on('mouseenter', ROAD_HIT_LAYER_ID, enter);
            map.on('mouseleave', ROAD_HIT_LAYER_ID, leave);
            this.nativeRoadHandlers = { click, enter, leave };
        }
        const pick = event => {
            if (!this.pointPicker || !event?.lngLat) return;
            const callback = this.pointPicker;
            const coordinate = [Number(event.lngLat.lng), Number(event.lngLat.lat)];
            this.cancelPointSelection();
            callback(coordinate);
        };
        map.on('click', pick);
        this.nativePickHandler = pick;
        this.nativeRoadsInstalled = true;
        this.container.dataset.roadMode = 'native';
    }

    syncNativeRoads() {
        if (!this.nativeRoadsInstalled) return false;
        const source = this.nativeMap?.getSource?.(ROAD_SOURCE_ID);
        if (!source?.setData) return false;
        source.setData(roadFeatureCollection(this.graph));
        if (this.interactiveEdges && this.nativeMap.getLayer?.(ROAD_SELECTED_LAYER_ID)) {
            this.nativeMap.setFilter(ROAD_SELECTED_LAYER_ID, [
                '==', ['get', 'edgeId'], this.selectedEdgeId || ''
            ]);
        }
        return true;
    }

    render() {
        if (!this.svg || !this.config) return;
        this.svg.replaceChildren();
        if (this.syncNativeRoads()) return;
        const extent = extentFromConfig(this.config);
        const project = projection(extent);
        const nodes = new Map(this.graph.nodes.map(node => [String(node.nodeId), nodeCoordinate(node)]));

        if (!this.sharedReady) {
            for (const item of this.heatmap) {
                if (!Array.isArray(item.lnglat)) continue;
                const [cx, cy] = project(item.lnglat);
                const circle = document.createElementNS(SVG_NS, 'circle');
                circle.setAttribute('cx', cx);
                circle.setAttribute('cy', cy);
                circle.setAttribute('r', 24 + (Number(item.ci) || 0) * 30);
                circle.setAttribute('class', `ops-map__heat ops-map__heat--${item.level || 'unknown'}`);
                this.svg.append(circle);
                const label = document.createElementNS(SVG_NS, 'text');
                label.setAttribute('x', cx);
                label.setAttribute('y', cy - 44 - (Number(item.ci) || 0) * 15);
                label.setAttribute('class', 'ops-map__heat-label');
                label.setAttribute('text-anchor', 'middle');
                label.textContent = `${item.name || item.poiId || ''} ${Number(item.ci || 0).toFixed(2)}`;
                this.svg.append(label);
            }
        }

        for (const edge of this.graph.edges) {
            if (!edge?.edgeId || edge.status === 'candidate') continue;
            for (const coordinates of coordinatePartsOf(edge, nodes)) {
                if (!Array.isArray(coordinates) || coordinates.length < 2) continue;
                const points = coordinates.map(project).map(point => point.join(',')).join(' ');
                const hit = document.createElementNS(SVG_NS, 'polyline');
                hit.setAttribute('points', points);
                hit.setAttribute('class', 'ops-map__edge-hit');
                hit.setAttribute('tabindex', '0');
                hit.setAttribute('role', 'button');
                hit.setAttribute('aria-label', `选择路段 ${edge.name || edge.edgeId}`);
                const choose = () => this.onEdgeSelected(String(edge.edgeId));
                hit.addEventListener('click', choose);
                hit.addEventListener('keydown', event => {
                    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); choose(); }
                });
                const line = document.createElementNS(SVG_NS, 'polyline');
                line.setAttribute('points', points);
                line.setAttribute('class', [
                    'ops-map__edge',
                    `ops-map__edge--${edge.status || 'open'}`,
                    `ops-map__edge--${edge.congestion || 'smooth'}`,
                    String(edge.edgeId) === this.selectedEdgeId ? 'is-selected' : ''
                ].join(' '));
                this.svg.append(line, hit);
            }
        }
    }

    destroy() {
        if (this.nativeMap && this.nativeRoadHandlers) {
            const { click, enter, leave } = this.nativeRoadHandlers;
            this.nativeMap.off?.('click', ROAD_HIT_LAYER_ID, click);
            this.nativeMap.off?.('mouseenter', ROAD_HIT_LAYER_ID, enter);
            this.nativeMap.off?.('mouseleave', ROAD_HIT_LAYER_ID, leave);
        }
        if (this.nativeMap && this.nativePickHandler) this.nativeMap.off?.('click', this.nativePickHandler);
        this.cancelPointSelection();
        this.sharedMap?.destroy?.();
        this.sharedMap = null;
        this.nativeMap = null;
        this.nativeRoadsInstalled = false;
        this.nativeRoadHandlers = null;
        this.nativePickHandler = null;
        this.svg?.replaceChildren();
    }
}
