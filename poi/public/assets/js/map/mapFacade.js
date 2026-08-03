import { emptyFeatureCollection, installSourcesAndLayers, LAYER_IDS, SOURCE_IDS } from './layers.js';
import { CATEGORY_STYLES, CROWD_COLORS, crowdLabel, routePresentation } from './styles.js';

const MAP_TIMEOUT_MS = 12000;

export class MapFacadeError extends Error {
    constructor(code, message, cause) {
        super(message, cause ? { cause } : undefined);
        this.name = 'MapFacadeError';
        this.code = code;
    }
}

function validateConfig(config) {
    const finite = value => Number.isFinite(Number(value));
    const validCenter = Array.isArray(config?.center) && config.center.length === 2 && config.center.every(finite);
    const validExtent = Array.isArray(config?.extent) && config.extent.length === 4 && config.extent.every(finite)
        && Number(config.extent[0]) < Number(config.extent[2])
        && Number(config.extent[1]) < Number(config.extent[3]);
    if (!config || (!config.demo && !config.mapUrl) || !validCenter || !validExtent || config.crs !== 'EPSG:4326') {
        throw new MapFacadeError('MAP_CONFIG_INVALID', '地图配置不完整或坐标系不是 EPSG:4326');
    }
    for (const key of ['zoom', 'minZoom', 'maxZoom']) {
        if (!finite(config[key])) throw new MapFacadeError('MAP_CONFIG_INVALID', `地图配置 ${key} 无效`);
    }
    if (Number(config.minZoom) > Number(config.maxZoom)) {
        throw new MapFacadeError('MAP_CONFIG_INVALID', '地图缩放范围无效');
    }
}

function geometryFeature(geometry, properties = {}) {
    return geometry ? { type: 'Feature', geometry, properties } : null;
}

function featureCollection(value) {
    if (value?.type === 'FeatureCollection') return value;
    if (value?.type === 'Feature') return { type: 'FeatureCollection', features: [value] };
    if (value?.type && value.coordinates) return { type: 'FeatureCollection', features: [geometryFeature(value)] };
    return emptyFeatureCollection();
}

function boundsOf(input) {
    const bounds = [Infinity, Infinity, -Infinity, -Infinity];
    const visit = value => {
        if (!Array.isArray(value)) return;
        if (value.length >= 2 && Number.isFinite(value[0]) && Number.isFinite(value[1])) {
            bounds[0] = Math.min(bounds[0], value[0]);
            bounds[1] = Math.min(bounds[1], value[1]);
            bounds[2] = Math.max(bounds[2], value[0]);
            bounds[3] = Math.max(bounds[3], value[1]);
            return;
        }
        value.forEach(visit);
    };
    const collect = item => {
        if (!item) return;
        if (item.type === 'FeatureCollection') item.features.forEach(collect);
        else if (item.type === 'Feature') collect(item.geometry);
        else if (item.coordinates) visit(item.coordinates);
    };
    collect(input);
    return bounds.every(Number.isFinite) ? bounds : null;
}

function iconImage(style) {
    const size = 48;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext('2d');
    context.clearRect(0, 0, size, size);
    context.beginPath();
    context.arc(size / 2, size / 2, 17, 0, Math.PI * 2);
    context.fillStyle = '#ffffff';
    context.fill();
    context.beginPath();
    context.arc(size / 2, size / 2, 14, 0, Math.PI * 2);
    context.fillStyle = style.color;
    context.fill();
    context.fillStyle = '#ffffff';
    context.font = '700 16px sans-serif';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText(style.glyph, size / 2, size / 2 + 1);
    return context.getImageData(0, 0, size, size);
}

export class MapFacade extends EventTarget {
    constructor() {
        super();
        this.map = null;
        this.container = null;
        this.config = null;
        this.pois = emptyFeatureCollection();
        this.crowd = new Map();
        this.closedEdges = emptyFeatureCollection();
        this.listeners = [];
        this.resizeObserver = null;
        this.timers = new Set();
    }

    async init(container, config) {
        try {
            if (!(container instanceof HTMLElement)) {
                throw new MapFacadeError('MAP_CONFIG_INVALID', '地图容器无效');
            }
            validateConfig(config);
            this.destroy();
            this.container = container;
            this.config = { ...config };

            if (!window.maplibregl) {
                throw new MapFacadeError('MAP_SDK_LOAD_FAILED', 'MapLibreGL 未加载');
            }

            const mapPromise = config.demo
                ? Promise.resolve({ map: new window.maplibregl.Map({
                    container,
                    style: {
                        version: 8,
                        sources: {},
                        layers: [{ id: 'demo-background', type: 'background', paint: { 'background-color': '#dbe6e1' } }]
                    },
                    center: config.center,
                    zoom: config.zoom,
                    minZoom: config.minZoom,
                    maxZoom: config.maxZoom,
                    attributionControl: false
                }) })
                : this.initSuperMap(container, config);
            const { map } = await this.withTimeout(mapPromise);
            this.map = map;
            await this.withTimeout(this.waitForLoad(map));
            this.installIcons();
            installSourcesAndLayers(map);
            map.addControl(new window.maplibregl.NavigationControl({ showCompass: true }), 'bottom-right');
            this.bindMapEvents();
            this.resizeObserver = new ResizeObserver(() => map.resize());
            this.resizeObserver.observe(container);
            return this;
        } catch (error) {
            const mapError = error instanceof MapFacadeError
                ? error
                : new MapFacadeError('MAP_SERVICE_UNAVAILABLE', '景区地图服务不可用', error);
            this.destroy();
            this.dispatchEvent(new CustomEvent('map:error', {
                detail: { code: mapError.code, message: mapError.message }
            }));
            throw mapError;
        }
    }

    withTimeout(promise) {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.timers.delete(timer);
                reject(new Error('map service timeout'));
            }, MAP_TIMEOUT_MS);
            this.timers.add(timer);
            Promise.resolve(promise).then(
                value => {
                    clearTimeout(timer);
                    this.timers.delete(timer);
                    resolve(value);
                },
                error => {
                    clearTimeout(timer);
                    this.timers.delete(timer);
                    reject(error);
                }
            );
        });
    }

    async initSuperMap(container, config) {
        const initMap = window.maplibregl?.supermap?.initMap;
        if (typeof initMap !== 'function') {
            throw new MapFacadeError('MAP_SDK_LOAD_FAILED', 'SuperMap iClient 未加载');
        }
        return initMap(config.mapUrl, {
            type: config.mapType || 'raster',
            mapOptions: {
                container,
                center: config.center,
                zoom: config.zoom,
                minZoom: config.minZoom,
                maxZoom: config.maxZoom,
                attributionControl: false
            },
            withCredentials: false,
            crossOrigin: true
        });
    }

    waitForLoad(map) {
        if (map.loaded()) return Promise.resolve();
        return new Promise((resolve, reject) => {
            const onLoad = () => { cleanup(); resolve(); };
            const onError = event => { cleanup(); reject(event?.error || new Error('map load failed')); };
            const cleanup = () => {
                map.off('load', onLoad);
                map.off('error', onError);
            };
            map.once('load', onLoad);
            map.once('error', onError);
        });
    }

    installIcons() {
        const installed = new Set();
        for (const [category, style] of Object.entries(CATEGORY_STYLES)) {
            const safeName = category === 'default' ? 'default' : btoa(unescape(encodeURIComponent(category))).replace(/[^a-z0-9]/gi, '').slice(0, 18);
            const id = `geosync-poi-${safeName || 'default'}`;
            if (!installed.has(id) && !this.map.hasImage(id)) this.map.addImage(id, iconImage(style), { pixelRatio: 2 });
            style.iconId = id;
            installed.add(id);
        }
    }

    bindMapEvents() {
        const onClick = event => {
            const feature = event.features?.[0];
            const poiId = feature?.properties?.poiId;
            if (!poiId) return;
            this.dispatchEvent(new CustomEvent('poi:selected', { detail: { poiId, feature } }));
        };
        const onEnter = () => { this.map.getCanvas().style.cursor = 'pointer'; };
        const onLeave = () => { this.map.getCanvas().style.cursor = ''; };
        this.map.on('click', LAYER_IDS.poiCrowd, onClick);
        this.map.on('mouseenter', LAYER_IDS.poiCrowd, onEnter);
        this.map.on('mouseleave', LAYER_IDS.poiCrowd, onLeave);
        this.listeners.push(
            ['click', LAYER_IDS.poiCrowd, onClick],
            ['mouseenter', LAYER_IDS.poiCrowd, onEnter],
            ['mouseleave', LAYER_IDS.poiCrowd, onLeave]
        );
    }

    setData(sourceId, data) {
        const source = this.map?.getSource(sourceId);
        if (source) source.setData(data || emptyFeatureCollection());
    }

    setBoundary(collection) {
        this.setData(SOURCE_IDS.boundary, featureCollection(collection));
    }

    setPois(collection) {
        const incoming = featureCollection(collection);
        this.pois = {
            type: 'FeatureCollection',
            features: incoming.features
                .filter(feature => feature?.geometry?.type === 'Point' && feature.properties?.poiId)
                .map(feature => {
                    const category = feature.properties.category || 'default';
                    const style = CATEGORY_STYLES[category] || CATEGORY_STYLES.default;
                    const crowd = this.crowd.get(String(feature.properties.poiId));
                    return {
                        ...feature,
                        properties: {
                            ...feature.properties,
                            iconId: style.iconId || CATEGORY_STYLES.default.iconId,
                            crowdLevel: crowd?.level || 'unknown',
                            crowdLabel: crowd?.lowConfidence
                                ? `参考人流 · ${crowdLabel(crowd?.level)}`
                                : crowdLabel(crowd?.level),
                            crowdColor: CROWD_COLORS[crowd?.level] || CROWD_COLORS.unknown,
                            lowConfidence: Boolean(crowd?.lowConfidence)
                        }
                    };
                })
        };
        this.setData(SOURCE_IDS.pois, this.pois);
    }

    setCrowd(items = []) {
        this.crowd.clear();
        for (const item of items) {
            if (item?.poiId) this.crowd.set(String(item.poiId), { ...item });
        }
        this.setPois(this.pois);
    }

    setRoute(route, options = {}) {
        const presentation = routePresentation(route);
        if (this.map?.getLayer(LAYER_IDS.route)) {
            this.map.setPaintProperty(
                LAYER_IDS.route,
                'line-dasharray',
                presentation.source === 'local-fallback' ? [2, 2] : [1, 0]
            );
        }
        const feature = geometryFeature(route?.geometry, {
            color: options.color || presentation.color,
            fallback: presentation.source === 'local-fallback',
            source: presentation.source,
            mode: presentation.mode
        });
        this.setData(SOURCE_IDS.route, featureCollection(feature));
        if (feature && options.fit !== false) this.fitToGeometry(feature.geometry, options.fitOptions);
        return presentation;
    }

    compareRoutes(beforeRoute, afterRoute) {
        this.setData(SOURCE_IDS.routeOld, featureCollection(geometryFeature(beforeRoute?.geometry)));
        this.setData(SOURCE_IDS.routeNew, featureCollection(geometryFeature(afterRoute?.geometry)));
        const combined = {
            type: 'FeatureCollection',
            features: [geometryFeature(beforeRoute?.geometry), geometryFeature(afterRoute?.geometry)].filter(Boolean)
        };
        this.fitToGeometry(combined, { padding: 54 });
        const detail = {
            distanceDeltaM: Number(afterRoute?.distanceM || 0) - Number(beforeRoute?.distanceM || 0),
            durationDeltaSec: Number(afterRoute?.durationSec || 0) - Number(beforeRoute?.durationSec || 0),
            reason: afterRoute?.reason || afterRoute?.diff?.reason || ''
        };
        this.dispatchEvent(new CustomEvent('route:compared', { detail }));
        return detail;
    }

    clearRouteComparison() {
        this.setData(SOURCE_IDS.routeOld, emptyFeatureCollection());
        this.setData(SOURCE_IDS.routeNew, emptyFeatureCollection());
    }

    setUserLocation(location) {
        const lng = Number(location?.lng ?? location?.longitude);
        const lat = Number(location?.lat ?? location?.latitude);
        if (!Number.isFinite(lng) || !Number.isFinite(lat)) {
            this.setData(SOURCE_IDS.user, emptyFeatureCollection());
            return;
        }
        this.setData(SOURCE_IDS.user, featureCollection(geometryFeature({ type: 'Point', coordinates: [lng, lat] }, {
            accuracy: Number(location?.accuracy) || null
        })));
    }

    setClosedEdges(items = []) {
        const features = items.map(item => {
            if (item?.type === 'Feature') return item;
            if (!item?.geometry) return null;
            return geometryFeature(item.geometry, { ...item, edgeId: item.edgeId || item.id, selected: false });
        }).filter(Boolean);
        this.closedEdges = { type: 'FeatureCollection', features };
        this.setData(SOURCE_IDS.closedEdges, this.closedEdges);
    }

    selectEdge(edgeId) {
        this.closedEdges = {
            ...this.closedEdges,
            features: this.closedEdges.features.map(feature => ({
                ...feature,
                properties: { ...feature.properties, selected: String(feature.properties?.edgeId) === String(edgeId) }
            }))
        };
        this.setData(SOURCE_IDS.closedEdges, this.closedEdges);
    }

    fitToGeometry(geometry, options = {}) {
        const bounds = boundsOf(geometry);
        if (!bounds || !this.map) return;
        if (bounds[0] === bounds[2] && bounds[1] === bounds[3]) {
            this.map.easeTo({ center: [bounds[0], bounds[1]], zoom: Math.max(this.map.getZoom(), 16) });
            return;
        }
        this.map.fitBounds([[bounds[0], bounds[1]], [bounds[2], bounds[3]]], {
            padding: options.padding ?? 48,
            duration: options.duration ?? 350,
            maxZoom: options.maxZoom ?? 18
        });
    }

    setConnectionState(state) {
        if (this.container) this.container.dataset.connectionState = state || 'unknown';
    }

    destroy() {
        for (const timer of this.timers) clearTimeout(timer);
        this.timers.clear();
        this.resizeObserver?.disconnect();
        this.resizeObserver = null;
        if (this.map) {
            for (const [event, layer, handler] of this.listeners) {
                try { this.map.off(event, layer, handler); } catch { /* map may already be removed */ }
            }
            try { this.map.remove(); } catch { /* best-effort cleanup */ }
        }
        this.listeners = [];
        this.map = null;
        this.container = null;
        this.config = null;
        this.pois = emptyFeatureCollection();
        this.crowd.clear();
        this.closedEdges = emptyFeatureCollection();
    }
}
