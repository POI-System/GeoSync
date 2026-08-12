'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_ISERVER_BASE = 'http://127.0.0.1:8090';
const DATA_VERSION = '2026.08.08-p1';
const SCENIC_ID = 'whu_core';
const SCENIC_CENTER = Object.freeze([114.359509, 30.540869]);
const SCENIC_EXTENT = Object.freeze([114.346871, 30.533214, 114.372146, 30.548524]);
const WALK_EDGE_FIELDS = Object.freeze([
    'SmID', 'name', 'highway', 'edge_id', 'from_node', 'to_node',
    'length_m', 'walk_sec', 'slope_pct', 'stairs', 'shade',
    'accessible', 'status', 'direction', 'data_ver'
]);
const MAX_WALK_EDGES = 2000;

function trimmedBase(value = DEFAULT_ISERVER_BASE) {
    return String(value || DEFAULT_ISERVER_BASE).trim().replace(/\/+$/, '');
}

function serviceUrls(baseUrl = DEFAULT_ISERVER_BASE) {
    const base = trimmedBase(baseUrl);
    return Object.freeze({
        map: `${base}/iserver/services/scenic-map/rest/maps/ScenicMap`,
        data: `${base}/iserver/services/scenic-data/rest/data`,
        network: `${base}/iserver/services/scenic-network/rest/networkanalyst/WalkNetwork@GeoSync`,
        terrain: `${base}/iserver/services/scenic-terrain/rest/realspace`,
        scene: `${base}/iserver/services/scenic-scene/rest/realspace/scenes/ScenicScene`
    });
}

function fieldObject(feature) {
    const names = Array.isArray(feature?.fieldNames) ? feature.fieldNames : [];
    const values = Array.isArray(feature?.fieldValues) ? feature.fieldValues : [];
    return Object.fromEntries(names.map((name, index) => [String(name).toLowerCase(), values[index]]));
}

function finiteNumber(value) {
    if (value === null || value === undefined || String(value).trim() === '') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

function booleanValue(value) {
    return ['true', '1', 'yes'].includes(String(value ?? '').trim().toLowerCase());
}

function optionalBoolean(value) {
    const text = String(value ?? '').trim().toLowerCase();
    if (['true', '1', 'yes'].includes(text)) return true;
    if (['false', '0', 'no'].includes(text)) return false;
    return null;
}

function coordinate(point) {
    const lng = Number(point?.x);
    const lat = Number(point?.y);
    if (!Number.isFinite(lng) || !Number.isFinite(lat)
        || lng < -180 || lng > 180 || lat < -90 || lat > 90) return null;
    return [lng, lat];
}

function geometryParts(geometry) {
    const points = Array.isArray(geometry?.points) ? geometry.points.map(coordinate).filter(Boolean) : [];
    if (points.length < 2) return [];
    const sizes = Array.isArray(geometry?.parts) ? geometry.parts.map(Number) : [];
    if (!sizes.length || sizes.some(size => !Number.isInteger(size) || size < 2)
        || sizes.reduce((sum, size) => sum + size, 0) !== points.length) return [points];
    const parts = [];
    let offset = 0;
    for (const size of sizes) {
        parts.push(points.slice(offset, offset + size));
        offset += size;
    }
    return parts;
}

function normalizeFeature(feature) {
    const fields = fieldObject(feature);
    const edgeId = String(fields.edge_id || '').trim();
    const parts = geometryParts(feature?.geometry);
    if (!edgeId || !parts.length) return null;
    const dataVersion = String(fields.data_ver || DATA_VERSION).trim() || DATA_VERSION;
    return {
        edgeId,
        name: String(fields.name || edgeId).trim(),
        type: String(fields.highway || '步行路').trim(),
        from: String(fields.from_node || '').trim(),
        to: String(fields.to_node || '').trim(),
        geometry: parts.length === 1
            ? { type: 'LineString', coordinates: parts[0] }
            : { type: 'MultiLineString', coordinates: parts },
        distanceM: finiteNumber(fields.length_m),
        walkSec: finiteNumber(fields.walk_sec),
        slope: finiteNumber(fields.slope_pct),
        stairs: booleanValue(fields.stairs),
        shade: finiteNumber(fields.shade),
        accessible: optionalBoolean(fields.accessible),
        status: String(fields.status || 'open').trim().toLowerCase() === 'closed' ? 'closed' : 'open',
        direction: String(fields.direction || 'both').trim(),
        dataVersion,
        sourceRef: {
            datasetName: 'WalkEdge@GeoSync',
            smId: finiteNumber(fields.smid),
            dataVersion
        }
    };
}

function normalizedParts(edge) {
    if (edge.geometry.type === 'MultiLineString') return edge.geometry.coordinates;
    return [edge.geometry.coordinates];
}

function mergeDuplicateEdges(edges) {
    const byId = new Map();
    for (const edge of edges) {
        const existing = byId.get(edge.edgeId);
        if (!existing) {
            byId.set(edge.edgeId, edge);
            continue;
        }
        const parts = [...normalizedParts(existing), ...normalizedParts(edge)];
        const smIds = [
            ...(Array.isArray(existing.sourceRef.smIds)
                ? existing.sourceRef.smIds
                : [existing.sourceRef.smId]),
            edge.sourceRef.smId
        ].filter(Number.isFinite);
        byId.set(edge.edgeId, {
            ...existing,
            geometry: { type: 'MultiLineString', coordinates: parts },
            sourceRef: { ...existing.sourceRef, smIds: [...new Set(smIds)] }
        });
    }
    return [...byId.values()];
}

function normalizeSnapshot(snapshot) {
    if (!snapshot || snapshot.scenicId !== SCENIC_ID || snapshot.dataVersion !== DATA_VERSION
        || !Array.isArray(snapshot.edges) || snapshot.edges.length < 1
        || snapshot.edges.length > MAX_WALK_EDGES) {
        throw new Error('SXR_ROAD_SNAPSHOT_INVALID');
    }
    const edges = mergeDuplicateEdges(snapshot.edges.map(edge => ({ ...edge })));
    if (!edges.length) throw new Error('SXR_ROAD_SNAPSHOT_EMPTY');
    return {
        ...snapshot,
        source: 'local-snapshot',
        readOnly: true,
        loadedAt: new Date().toISOString(),
        nodes: Array.isArray(snapshot.nodes) ? snapshot.nodes : [],
        edges
    };
}

function readSnapshot(snapshotPath) {
    const filePath = path.resolve(snapshotPath);
    return normalizeSnapshot(JSON.parse(fs.readFileSync(filePath, 'utf8')));
}

function normalizeFeatureResult(payload) {
    if (!Array.isArray(payload?.features)) throw new Error('SXR_WALK_EDGE_RESPONSE_INVALID');
    if (payload.features.length > MAX_WALK_EDGES) throw new Error('SXR_WALK_EDGE_LIMIT_EXCEEDED');
    const normalized = payload.features.map(normalizeFeature).filter(Boolean);
    const edges = mergeDuplicateEdges(normalized);
    if (!edges.length) throw new Error('SXR_WALK_EDGE_EMPTY');
    return {
        scenicId: SCENIC_ID,
        dataVersion: DATA_VERSION,
        source: 'iserver',
        readOnly: true,
        fetchedAt: new Date().toISOString(),
        sourceFeatureCount: normalized.length,
        nodes: [],
        edges
    };
}

function walkEdgeQuery() {
    return {
        getFeatureMode: 'SQL',
        datasetNames: ['GeoSync:WalkEdge'],
        maxFeatures: MAX_WALK_EDGES,
        queryParameter: {
            attributeFilter: 'SmID>0',
            fields: [...WALK_EDGE_FIELDS]
        }
    };
}

function createPreviewConfig(baseUrl = DEFAULT_ISERVER_BASE, source = 'iserver') {
    const services = serviceUrls(baseUrl);
    const usesIServerMap = source === 'iserver';
    return {
        scenicId: SCENIC_ID,
        scenicCenter: [...SCENIC_CENTER],
        features: { supermap: true, threeD: true },
        preview: { readOnly: true, source: usesIServerMap ? 'sxr-iserver' : source },
        gis: {
            enabled: true,
            source,
            dataVersion: DATA_VERSION,
            center: [...SCENIC_CENTER],
            extent: [...SCENIC_EXTENT],
            crs: 'EPSG:4326',
            publicServices: usesIServerMap
                ? { map: services.map, terrain: services.terrain, scene: services.scene }
                : {}
        }
    };
}

function createSxrPreview({
    baseUrl = process.env.SXR_ISERVER_BASE || DEFAULT_ISERVER_BASE,
    fetchImpl = globalThis.fetch,
    snapshotPath = process.env.SXR_ROAD_SNAPSHOT || path.resolve(__dirname, '../.cache/sxr-road-snapshot.json'),
    cacheTtlMs = 5 * 60 * 1000,
    timeoutMs = 30000
} = {}) {
    if (typeof fetchImpl !== 'function') throw new TypeError('fetch implementation is required');
    const services = serviceUrls(baseUrl);
    let cachedGraph = null;
    let cacheTime = 0;
    let inFlight = null;

    async function fetchGraph() {
        const response = await fetchImpl(`${services.data}/featureResults.json?returnContent=true`, {
            method: 'POST',
            headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
            body: JSON.stringify(walkEdgeQuery()),
            signal: AbortSignal.timeout(timeoutMs)
        });
        if (response.status !== 200 && response.status !== 201) {
            throw new Error(`SXR_WALK_EDGE_HTTP_${response.status}`);
        }
        return normalizeFeatureResult(await response.json());
    }

    async function getGraph({ force = false } = {}) {
        const now = Date.now();
        if (!force && cachedGraph && now - cacheTime < cacheTtlMs) return cachedGraph;
        if (!force && inFlight) return inFlight;
        inFlight = fetchGraph().catch(error => {
            try {
                const graph = readSnapshot(snapshotPath);
                graph.fallbackReason = String(error?.message || 'SXR_ISERVER_UNAVAILABLE').slice(0, 80);
                return graph;
            } catch (snapshotError) {
                error.snapshotError = String(snapshotError?.message || 'SXR_ROAD_SNAPSHOT_FAILED').slice(0, 80);
                throw error;
            }
        }).then(graph => {
            cachedGraph = graph;
            cacheTime = Date.now();
            return graph;
        }).finally(() => { inFlight = null; });
        return inFlight;
    }

    return Object.freeze({
        config: createPreviewConfig(baseUrl),
        services,
        getGraph,
        async getConfig() {
            const graph = await getGraph();
            return createPreviewConfig(baseUrl, graph.source);
        }
    });
}

module.exports = {
    DATA_VERSION,
    MAX_WALK_EDGES,
    SCENIC_ID,
    SCENIC_CENTER,
    SCENIC_EXTENT,
    WALK_EDGE_FIELDS,
    createPreviewConfig,
    createSxrPreview,
    geometryParts,
    mergeDuplicateEdges,
    normalizeFeature,
    normalizeFeatureResult,
    normalizeSnapshot,
    optionalBoolean,
    readSnapshot,
    serviceUrls,
    walkEdgeQuery
};
