import {
    emptyFeatureCollection,
    installSourcesAndLayers
} from './layers.js';
import {
    CATEGORY_STYLES,
    CROWD_COLORS,
    MAP_LAYER_STYLES,
    categoryIconId,
    categoryStyle,
    crowdLabel,
    routePresentation
} from './styles.js';
import { MapFacadeError } from '../shared/errors.js';
import { dispatchDetail, MAP_EVENT_NAMES } from '../shared/events.js';

export { MapFacadeError } from '../shared/errors.js';

const DEFAULT_MAP_TIMEOUT_MS = 12000;

function isFiniteNumber(value) {
    return Number.isFinite(Number(value));
}

function validPosition(position) {
    if (!Array.isArray(position) || position.length < 2) return false;
    const lng = Number(position[0]);
    const lat = Number(position[1]);
    return Number.isFinite(lng) && Number.isFinite(lat)
        && lng >= -180 && lng <= 180
        && lat >= -90 && lat <= 90;
}

function normalizePosition(position) {
    return [Number(position[0]), Number(position[1])];
}

function validateConfig(config) {
    const validCenter = Array.isArray(config?.center)
        && config.center.length === 2
        && validPosition(config.center);
    const validExtent = Array.isArray(config?.extent)
        && config.extent.length === 4
        && config.extent.every(isFiniteNumber)
        && validPosition([config.extent[0], config.extent[1]])
        && validPosition([config.extent[2], config.extent[3]])
        && Number(config.extent[0]) < Number(config.extent[2])
        && Number(config.extent[1]) < Number(config.extent[3]);
    if (!config || (!config.demo && (typeof config.mapUrl !== 'string' || !config.mapUrl.trim()))
        || !validCenter || !validExtent || config.crs !== 'EPSG:4326') {
        throw new MapFacadeError('MAP_CONFIG_INVALID', '地图配置不完整或坐标系不是 EPSG:4326');
    }
    for (const key of ['zoom', 'minZoom', 'maxZoom']) {
        if (!isFiniteNumber(config[key])) {
            throw new MapFacadeError('MAP_CONFIG_INVALID', `地图配置 ${key} 无效`);
        }
    }
    const zoom = Number(config.zoom);
    const minZoom = Number(config.minZoom);
    const maxZoom = Number(config.maxZoom);
    if (minZoom > maxZoom || zoom < minZoom || zoom > maxZoom) {
        throw new MapFacadeError('MAP_CONFIG_INVALID', '地图缩放范围无效');
    }
}

function geometryFeature(geometry, properties = {}) {
    return geometry ? { type: 'Feature', geometry, properties } : null;
}

function featureCollection(value) {
    if (!value) return emptyFeatureCollection();
    if (value.type === 'FeatureCollection' && Array.isArray(value.features)) return value;
    if (value.type === 'Feature') return { type: 'FeatureCollection', features: [value] };
    if (value.type && value.coordinates) {
        return { type: 'FeatureCollection', features: [geometryFeature(value)] };
    }
    throw new MapFacadeError('MAP_GEOMETRY_INVALID', 'GeoJSON 数据格式无效');
}

function poiFeatureCollection(value) {
    if (!Array.isArray(value)) return featureCollection(value);
    return {
        type: 'FeatureCollection',
        features: value.map(item => {
            if (item?.type === 'Feature') return item;
            const poiId = item?.poiId ?? item?.id ?? item?._id;
            const lng = Number(item?.lng ?? item?.longitude ?? item?.location?.lng ?? item?.location?.longitude);
            const lat = Number(item?.lat ?? item?.latitude ?? item?.location?.lat ?? item?.location?.latitude);
            if (poiId === null || poiId === undefined || String(poiId) === '' || !validPosition([lng, lat])) {
                return null;
            }
            return geometryFeature({ type: 'Point', coordinates: [lng, lat] }, {
                poiId: String(poiId),
                name: item?.poiName || item?.name || '',
                category: item?.category || 'default',
                status: item?.status || 'approved'
            });
        }).filter(Boolean)
    };
}

function routeMetricDelta(beforeValue, afterValue) {
    if (beforeValue === null || beforeValue === undefined
        || afterValue === null || afterValue === undefined) {
        return undefined;
    }
    if ((typeof beforeValue === 'string' && !beforeValue.trim())
        || (typeof afterValue === 'string' && !afterValue.trim())) {
        return undefined;
    }
    const before = Number(beforeValue);
    const after = Number(afterValue);
    return Number.isFinite(before) && before >= 0 && Number.isFinite(after) && after >= 0
        ? after - before
        : undefined;
}

function decodePolyline(encoded) {
    if (typeof encoded !== 'string' || !encoded) {
        throw new MapFacadeError('MAP_GEOMETRY_INVALID', '路线几何为空');
    }
    let index = 0;
    let lat = 0;
    let lng = 0;
    const coordinates = [];
    const decodeValue = () => {
        let result = 0;
        let shift = 0;
        let byte;
        do {
            if (index >= encoded.length || shift > 30) {
                throw new MapFacadeError('MAP_GEOMETRY_INVALID', '路线编码无效');
            }
            byte = encoded.charCodeAt(index++) - 63;
            if (byte < 0) throw new MapFacadeError('MAP_GEOMETRY_INVALID', '路线编码无效');
            result |= (byte & 0x1f) << shift;
            shift += 5;
        } while (byte >= 0x20);
        return (result & 1) ? ~(result >> 1) : result >> 1;
    };
    while (index < encoded.length) {
        lat += decodeValue();
        lng += decodeValue();
        coordinates.push([lng / 1e5, lat / 1e5]);
    }
    return { type: 'LineString', coordinates };
}

function normalizedLineString(value) {
    let geometry = value;
    if (typeof geometry === 'string') geometry = decodePolyline(geometry);
    if (geometry?.type === 'Feature') geometry = geometry.geometry;
    if (geometry?.type !== 'LineString' || !Array.isArray(geometry.coordinates)
        || geometry.coordinates.length < 2 || !geometry.coordinates.every(validPosition)) {
        throw new MapFacadeError('MAP_GEOMETRY_INVALID', '路线必须是有效的 EPSG:4326 LineString');
    }
    return {
        type: 'LineString',
        coordinates: geometry.coordinates.map(normalizePosition)
    };
}

export function routeGeometry(route) {
    if (route === null || route === undefined) return null;
    if (route.geometry !== null && route.geometry !== undefined) {
        return normalizedLineString(route.geometry);
    }
    if (route.pathGeometry !== null && route.pathGeometry !== undefined && route.pathGeometry !== '') {
        return normalizedLineString(route.pathGeometry);
    }
    throw new MapFacadeError('MAP_GEOMETRY_INVALID', '路线缺少可绘制几何');
}

function boundsOf(input) {
    const bounds = [Infinity, Infinity, -Infinity, -Infinity];
    const visit = value => {
        if (!Array.isArray(value)) return;
        if (validPosition(value)) {
            const [lng, lat] = normalizePosition(value);
            bounds[0] = Math.min(bounds[0], lng);
            bounds[1] = Math.min(bounds[1], lat);
            bounds[2] = Math.max(bounds[2], lng);
            bounds[3] = Math.max(bounds[3], lat);
            return;
        }
        value.forEach(visit);
    };
    const collect = item => {
        if (!item) return;
        if (item.type === 'FeatureCollection') item.features?.forEach(collect);
        else if (item.type === 'Feature') collect(item.geometry);
        else if (item.coordinates) visit(item.coordinates);
    };
    collect(input);
    return bounds.every(Number.isFinite) ? bounds : null;
}

function iconImage(documentRef, style) {
    const size = 48;
    const canvas = documentRef.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext('2d');
    if (!context) throw new MapFacadeError('MAP_SDK_LOAD_FAILED', '浏览器不支持地图图标绘制');
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
    constructor({
        adapter = null,
        maplibregl = null,
        Map: MapClass = null,
        ResizeObserver: ResizeObserverClass = null,
        clock = globalThis,
        timeoutMs = DEFAULT_MAP_TIMEOUT_MS
    } = {}) {
        super();
        this.adapter = adapter;
        this.injectedMapLibre = maplibregl;
        this.MapClass = MapClass;
        this.ResizeObserverClass = ResizeObserverClass;
        this.clock = clock;
        this.timeoutMs = Number(timeoutMs) > 0 ? Number(timeoutMs) : DEFAULT_MAP_TIMEOUT_MS;
        this._map = null;
        this._layerAccess = null;
        this._container = null;
        this._config = null;
        this._rawPois = emptyFeatureCollection();
        this._displayPois = emptyFeatureCollection();
        this._crowd = new Map();
        this._crowdLowConfidence = false;
        this._closedEdges = emptyFeatureCollection();
        this._mapListeners = [];
        this._pendingCleanups = new Set();
        this._resizeObserver = null;
        this._timers = new Set();
        this._generation = 0;
        this._cleanupIssueCount = 0;
    }

    isReady() {
        return Boolean(this._map && this._layerAccess);
    }

    requireReady(method) {
        if (!this.isReady()) {
            throw new MapFacadeError('MAP_NOT_INITIALIZED', `${method} 必须在地图初始化完成后调用`);
        }
        return this._map;
    }

    emitMapError(error) {
        const mapError = error instanceof MapFacadeError
            ? error
            : new MapFacadeError('MAP_SERVICE_UNAVAILABLE', '景区地图服务不可用', error);
        dispatchDetail(this, MAP_EVENT_NAMES.MAP_ERROR, {
            code: mapError.code,
            message: mapError.message
        });
        return mapError;
    }

    async init(container, config) {
        let generation = this._generation;
        try {
            if (!container || typeof container !== 'object' || !container.ownerDocument) {
                throw new MapFacadeError('MAP_CONFIG_INVALID', '地图容器无效');
            }
            validateConfig(config);
            this.destroy();
            generation = this._generation;
            this._container = container;
            this._config = { ...config };

            const sdk = this.injectedMapLibre || globalThis.maplibregl || globalThis.window?.maplibregl;
            let mapPromise;
            if (typeof this.adapter?.init === 'function') {
                mapPromise = this.adapter.init(container, config, { maplibregl: sdk, Map: this.MapClass });
            } else if (config.demo) {
                const Constructor = this.MapClass || sdk?.Map;
                if (typeof Constructor !== 'function') {
                    throw new MapFacadeError('MAP_SDK_LOAD_FAILED', 'MapLibreGL 未加载');
                }
                mapPromise = Promise.resolve(new Constructor({
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
                }));
            } else {
                const initMap = this.adapter?.initSuperMap || sdk?.supermap?.initMap;
                if (typeof initMap !== 'function') {
                    throw new MapFacadeError('MAP_SDK_LOAD_FAILED', 'SuperMap iClient 未加载');
                }
                mapPromise = initMap(config.mapUrl, {
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

            const result = await this.withTimeout(
                Promise.resolve(mapPromise),
                value => this.removeMapInstance(value?.map || value)
            );
            if (generation !== this._generation) {
                this.removeMapInstance(result?.map || result);
                throw new MapFacadeError('MAP_SERVICE_UNAVAILABLE', '地图初始化已取消');
            }
            this._map = result?.map || result;
            if (!this._map) throw new Error('map instance unavailable');
            await this.withTimeout(this.waitForLoad(this._map));
            if (generation !== this._generation) {
                throw new MapFacadeError('MAP_SERVICE_UNAVAILABLE', '地图初始化已取消');
            }
            this.installIcons(container.ownerDocument);
            this._layerAccess = installSourcesAndLayers(this._map);
            const NavigationControl = sdk?.NavigationControl;
            if (typeof NavigationControl === 'function' && typeof this._map.addControl === 'function') {
                this._map.addControl(new NavigationControl({ showCompass: true }), 'bottom-right');
            }
            this.bindMapEvents();
            const Observer = this.ResizeObserverClass || globalThis.ResizeObserver;
            if (typeof Observer === 'function') {
                this._resizeObserver = new Observer(() => this._map?.resize?.());
                this._resizeObserver.observe(container);
            }
            return this;
        } catch (error) {
            const mapError = error instanceof MapFacadeError
                ? error
                : new MapFacadeError('MAP_SERVICE_UNAVAILABLE', '景区地图服务不可用', error);
            if (generation === this._generation) {
                this.destroy();
                this.emitMapError(mapError);
            }
            throw mapError;
        }
    }

    withTimeout(promise, onLateResolve = null) {
        return new Promise((resolve, reject) => {
            let settled = false;
            let timer = null;
            const cancel = () => {
                if (settled) return;
                settled = true;
                this.clock.clearTimeout(timer);
                this._timers.delete(timer);
                this._pendingCleanups.delete(cancel);
                reject(new Error('map initialization cancelled'));
            };
            timer = this.clock.setTimeout(() => {
                if (settled) return;
                settled = true;
                this._timers.delete(timer);
                this._pendingCleanups.delete(cancel);
                reject(new Error('map service timeout'));
            }, this.timeoutMs);
            this._timers.add(timer);
            this._pendingCleanups.add(cancel);
            Promise.resolve(promise).then(
                value => {
                    if (settled) {
                        onLateResolve?.(value);
                        return;
                    }
                    settled = true;
                    this.clock.clearTimeout(timer);
                    this._timers.delete(timer);
                    this._pendingCleanups.delete(cancel);
                    resolve(value);
                },
                error => {
                    if (settled) return;
                    settled = true;
                    this.clock.clearTimeout(timer);
                    this._timers.delete(timer);
                    this._pendingCleanups.delete(cancel);
                    reject(error);
                }
            );
        });
    }

    waitForLoad(map) {
        if (typeof map.loaded !== 'function' || map.loaded()) return Promise.resolve();
        return new Promise((resolve, reject) => {
            const detach = () => {
                map.off?.('load', onLoad);
                map.off?.('error', onError);
                this._pendingCleanups.delete(cancel);
            };
            const cancel = () => { detach(); reject(new Error('map initialization cancelled')); };
            const onLoad = () => { detach(); resolve(); };
            const onError = event => { detach(); reject(event?.error || new Error('map load failed')); };
            this._pendingCleanups.add(cancel);
            map.once?.('load', onLoad);
            map.once?.('error', onError);
        });
    }

    removeMapInstance(map) {
        if (!map) return;
        try {
            map.remove?.();
        } catch (error) {
            this._cleanupIssueCount += 1;
            void error;
        }
    }

    installIcons(documentRef) {
        const installed = new Set();
        for (const [category, style] of Object.entries(CATEGORY_STYLES)) {
            const id = categoryIconId(category);
            if (!installed.has(id) && !this._map.hasImage?.(id)) {
                this._map.addImage?.(id, iconImage(documentRef, style), { pixelRatio: 2 });
            }
            installed.add(id);
        }
    }

    listen(event, handler, layer = null) {
        if (layer) this._layerAccess.onLayer(event, layer, handler);
        else this._map.on(event, handler);
        this._mapListeners.push({ event, handler, layer });
    }

    bindMapEvents() {
        const onClick = event => {
            const feature = event.features?.[0];
            const poiId = feature?.properties?.poiId;
            if (!poiId) return;
            dispatchDetail(this, MAP_EVENT_NAMES.POI_SELECTED, { poiId, feature });
        };
        const onEnter = () => { this._map.getCanvas().style.cursor = 'pointer'; };
        const onLeave = () => { this._map.getCanvas().style.cursor = ''; };
        const onRuntimeError = event => this.emitMapError(new MapFacadeError(
            'MAP_SERVICE_UNAVAILABLE',
            '景区地图服务不可用',
            event?.error
        ));
        this.listen('click', onClick, 'poiCrowd');
        this.listen('mouseenter', onEnter, 'poiCrowd');
        this.listen('mouseleave', onLeave, 'poiCrowd');
        this.listen('error', onRuntimeError);
    }

    setData(sourceKey, data, method) {
        this.requireReady(method);
        const source = this._layerAccess?.getSource(sourceKey);
        if (!source || typeof source.setData !== 'function') {
            const error = new MapFacadeError('MAP_SOURCE_UNAVAILABLE', `${method} 所需地图数据源不可用`);
            this.emitMapError(error);
            throw error;
        }
        source.setData(data || emptyFeatureCollection());
    }

    setBoundary(collection) {
        this.setData('boundary', featureCollection(collection), 'setBoundary');
    }

    renderPois() {
        this._displayPois = {
            type: 'FeatureCollection',
            features: this._rawPois.features.map(feature => {
                const category = feature.properties.category || 'default';
                const crowd = this._crowd.get(String(feature.properties.poiId));
                const lowConfidence = crowd?.lowConfidence ?? this._crowdLowConfidence;
                return {
                    ...feature,
                    properties: {
                        ...feature.properties,
                        iconId: categoryIconId(category),
                        crowdLevel: crowd?.level || 'unknown',
                        crowdLabel: crowdLabel(crowd?.level, lowConfidence),
                        crowdColor: CROWD_COLORS[crowd?.level] || CROWD_COLORS.unknown,
                        lowConfidence: Boolean(lowConfidence)
                    }
                };
            })
        };
        this.setData('pois', this._displayPois, 'setPois');
    }

    setPois(collection) {
        this.requireReady('setPois');
        const incoming = poiFeatureCollection(collection);
        this._rawPois = {
            type: 'FeatureCollection',
            features: incoming.features.filter(feature =>
                feature?.geometry?.type === 'Point'
                && validPosition(feature.geometry.coordinates)
                && feature.properties?.poiId)
        };
        this.renderPois();
    }

    setCrowd(input = []) {
        this.requireReady('setCrowd');
        if (input && !Array.isArray(input) && input.poiId && !Array.isArray(input.items)) {
            this._crowd.set(String(input.poiId), { ...input });
        } else {
            const items = Array.isArray(input) ? input : Array.isArray(input?.items) ? input.items : [];
            this._crowd.clear();
            this._crowdLowConfidence = Array.isArray(input) ? false : Boolean(input?.lowConfidence);
            for (const item of items) {
                if (item?.poiId) this._crowd.set(String(item.poiId), { ...item });
            }
        }
        this.renderPois();
    }

    invalidRoute(error) {
        this.setData('route', emptyFeatureCollection(), 'setRoute');
        const mapError = error instanceof MapFacadeError
            ? error
            : new MapFacadeError('MAP_GEOMETRY_INVALID', '路线几何无效', error);
        this.emitMapError(mapError);
        throw mapError;
    }

    setRoute(route, options = {}) {
        this.requireReady('setRoute');
        if (route === null || route === undefined) {
            this.setData('route', emptyFeatureCollection(), 'setRoute');
            return routePresentation();
        }
        let geometry;
        try {
            geometry = routeGeometry(route);
        } catch (error) {
            return this.invalidRoute(error);
        }
        const presentation = routePresentation(route);
        if (this._layerAccess.getLayer('route')) {
            this._layerAccess.setPaintProperty(
                'route',
                'line-dasharray',
                presentation.dash
            );
        }
        const feature = geometryFeature(geometry, {
            color: options.color || presentation.color,
            fallback: presentation.source === 'local-fallback',
            source: presentation.source,
            mode: presentation.mode
        });
        this.setData('route', featureCollection(feature), 'setRoute');
        if (options.fit !== false) this.fitToGeometry(geometry, options.fitOptions);
        return presentation;
    }

    _setMainRouteVisible(visible) {
        if (this._layerAccess?.getLayer('route')) {
            this._layerAccess.setPaintProperty(
                'route',
                'line-opacity',
                visible ? MAP_LAYER_STYLES.route.opacity : 0
            );
        }
    }

    compareRoutes(beforeRoute, afterRoute) {
        this.requireReady('compareRoutes');
        let beforeGeometry;
        let afterGeometry;
        try {
            beforeGeometry = routeGeometry(beforeRoute);
            afterGeometry = routeGeometry(afterRoute);
        } catch (error) {
            this._setMainRouteVisible(true);
            this.setData('routeOld', emptyFeatureCollection(), 'compareRoutes');
            this.setData('routeNew', emptyFeatureCollection(), 'compareRoutes');
            const mapError = error instanceof MapFacadeError
                ? error
                : new MapFacadeError('MAP_GEOMETRY_INVALID', '路线比较几何无效', error);
            this.emitMapError(mapError);
            throw mapError;
        }
        const beforePresentation = routePresentation(beforeRoute);
        const afterPresentation = routePresentation(afterRoute);
        try {
            this.setData(
                'routeOld',
                featureCollection(geometryFeature(beforeGeometry, { source: beforePresentation.source })),
                'compareRoutes'
            );
            this.setData(
                'routeNew',
                featureCollection(geometryFeature(afterGeometry, {
                    source: afterPresentation.source,
                    color: afterPresentation.color
                })),
                'compareRoutes'
            );
            this.fitToGeometry({
                type: 'FeatureCollection',
                features: [geometryFeature(beforeGeometry), geometryFeature(afterGeometry)]
            }, { padding: 54 });
            this._setMainRouteVisible(false);
        } catch (error) {
            try { this._setMainRouteVisible(true); } catch { /* preserve the comparison error */ }
            for (const sourceKey of ['routeOld', 'routeNew']) {
                try { this.setData(sourceKey, emptyFeatureCollection(), 'compareRoutes'); } catch { /* best effort */ }
            }
            const mapError = error instanceof MapFacadeError
                ? error
                : new MapFacadeError('MAP_SERVICE_UNAVAILABLE', '路线比较无法显示', error);
            this.emitMapError(mapError);
            throw mapError;
        }
        const distanceDeltaM = routeMetricDelta(beforeRoute?.distanceM, afterRoute?.distanceM);
        const durationDeltaSec = routeMetricDelta(beforeRoute?.durationSec, afterRoute?.durationSec);
        const detail = {
            distanceDeltaM: distanceDeltaM ?? null,
            durationDeltaSec: durationDeltaSec ?? null,
            reason: afterRoute?.reason || afterRoute?.diff?.reason || ''
        };
        dispatchDetail(this, MAP_EVENT_NAMES.ROUTE_COMPARED, detail);
        return detail;
    }

    clearRouteComparison() {
        this.requireReady('clearRouteComparison');
        this._setMainRouteVisible(true);
        this.setData('routeOld', emptyFeatureCollection(), 'clearRouteComparison');
        this.setData('routeNew', emptyFeatureCollection(), 'clearRouteComparison');
    }

    setUserLocation(location) {
        this.requireReady('setUserLocation');
        const lng = Number(location?.lng ?? location?.longitude);
        const lat = Number(location?.lat ?? location?.latitude);
        if (!validPosition([lng, lat])) {
            this.setData('user', emptyFeatureCollection(), 'setUserLocation');
            return;
        }
        this.setData('user', featureCollection(geometryFeature({
            type: 'Point', coordinates: [lng, lat]
        }, { accuracy: Number(location?.accuracy) || null })), 'setUserLocation');
    }

    setClosedEdges(input = []) {
        this.requireReady('setClosedEdges');
        const items = Array.isArray(input)
            ? input
            : input?.type === 'FeatureCollection'
                ? input.features
                : Array.isArray(input?.items) ? input.items : [];
        const features = [];
        for (const item of items) {
            const rawGeometry = item?.type === 'Feature' ? item.geometry : item?.geometry;
            if (!rawGeometry) continue;
            try {
                const geometry = normalizedLineString(rawGeometry);
                const properties = item?.type === 'Feature' ? item.properties || {} : item;
                features.push(geometryFeature(geometry, {
                    ...properties,
                    edgeId: properties.edgeId || properties.id,
                    selected: false
                }));
            } catch (error) {
                // One malformed operational edge must not hide other valid closures.
                void error;
                continue;
            }
        }
        this._closedEdges = { type: 'FeatureCollection', features };
        this.setData('closedEdges', this._closedEdges, 'setClosedEdges');
    }

    selectEdge(edgeId) {
        this.requireReady('selectEdge');
        this._closedEdges = {
            ...this._closedEdges,
            features: this._closedEdges.features.map(feature => ({
                ...feature,
                properties: {
                    ...feature.properties,
                    selected: String(feature.properties?.edgeId) === String(edgeId)
                }
            }))
        };
        this.setData('closedEdges', this._closedEdges, 'selectEdge');
    }

    fitToGeometry(geometry, options = {}) {
        const map = this.requireReady('fitToGeometry');
        const bounds = boundsOf(geometry);
        if (!bounds) throw new MapFacadeError('MAP_GEOMETRY_INVALID', '无法计算几何范围');
        if (bounds[0] === bounds[2] && bounds[1] === bounds[3]) {
            map.easeTo({ center: [bounds[0], bounds[1]], zoom: Math.max(map.getZoom(), 16) });
            return;
        }
        map.fitBounds([[bounds[0], bounds[1]], [bounds[2], bounds[3]]], {
            padding: options.padding ?? 48,
            duration: options.duration ?? 350,
            maxZoom: options.maxZoom ?? 18
        });
    }

    setConnectionState(state) {
        this.requireReady('setConnectionState');
        this._container.dataset.connectionState = state || 'unknown';
    }

    destroy() {
        this._generation += 1;
        for (const timer of this._timers) this.clock.clearTimeout(timer);
        this._timers.clear();
        for (const cleanup of [...this._pendingCleanups]) cleanup();
        this._pendingCleanups.clear();
        this._resizeObserver?.disconnect();
        this._resizeObserver = null;
        if (this._map) {
            for (const { event, handler, layer } of this._mapListeners) {
                try {
                    if (layer) this._layerAccess?.offLayer(event, layer, handler);
                    else this._map.off?.(event, handler);
                } catch (error) {
                    // The SDK can reject off() after its map instance has already closed.
                    this._cleanupIssueCount += 1;
                    void error;
                }
            }
            this.removeMapInstance(this._map);
        }
        this._mapListeners = [];
        this._map = null;
        this._layerAccess = null;
        this._container = null;
        this._config = null;
        this._rawPois = emptyFeatureCollection();
        this._displayPois = emptyFeatureCollection();
        this._crowd.clear();
        this._crowdLowConfidence = false;
        this._closedEdges = emptyFeatureCollection();
    }
}

export { MAP_LAYER_STYLES } from './styles.js';
