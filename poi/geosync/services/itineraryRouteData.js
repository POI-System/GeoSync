'use strict';

const { encodePolyline } = require('../lib/geo');
const { createTopologyProof, validateRouteTopology } = require('../lib/routeTopologyProvenance');

class RouteDataVersionError extends Error {
    constructor(message, details = null) {
        super(message);
        this.name = 'RouteDataVersionError';
        this.code = 'ROUTE_DATA_VERSION_MISMATCH';
        this.details = details;
    }
}

function toPlain(value) {
    return value?.toObject ? value.toObject() : value;
}

function serializedGeometry(value) {
    const geometry = toPlain(value);
    if (geometry?.type !== 'LineString' || !Array.isArray(geometry.coordinates)) return null;
    const coordinates = geometry.coordinates
        .filter(position => Array.isArray(position) && position.length === 2 && position.every(Number.isFinite))
        .map(position => [position[0], position[1]]);
    return coordinates.length >= 2 ? { type: 'LineString', coordinates } : null;
}

function serializedGis(value) {
    const gis = toPlain(value);
    if (!gis || typeof gis !== 'object') return null;
    return {
        source: gis.source || null,
        mode: gis.mode || null,
        degraded: Boolean(gis.degraded),
        requestId: gis.requestId || null,
        durationMs: Number.isFinite(gis.durationMs) ? gis.durationMs : 0,
        dataVersion: gis.dataVersion || null
    };
}

function serializedSegments(value) {
    if (!Array.isArray(value)) return [];
    return value.map(item => {
        const segment = toPlain(item) || {};
        const sourceRef = toPlain(segment.sourceRef);
        return {
            edgeId: segment.edgeId || '',
            ...(segment.physicalEdgeId ? { physicalEdgeId: String(segment.physicalEdgeId) } : {}),
            ...(segment.fromNodeId ? { fromNodeId: String(segment.fromNodeId) } : {}),
            ...(segment.toNodeId ? { toNodeId: String(segment.toNodeId) } : {}),
            distanceM: Number.isFinite(segment.distanceM) ? segment.distanceM : null,
            durationSec: Number.isFinite(segment.durationSec) ? segment.durationSec : null,
            ...(sourceRef ? {
                sourceRef: {
                    datasetName: sourceRef.datasetName || '',
                    smId: Number.isFinite(sourceRef.smId) ? sourceRef.smId : null
                }
            } : {})
        };
    });
}

function serializedSnap(value) {
    const snap = toPlain(value);
    if (!snap || typeof snap !== 'object') return null;
    return {
        ...(snap.startNodeId ? { startNodeId: String(snap.startNodeId) } : {}),
        ...(snap.endNodeId ? { endNodeId: String(snap.endNodeId) } : {}),
        startDistanceM: Number.isFinite(snap.startDistanceM) ? snap.startDistanceM : null,
        endDistanceM: Number.isFinite(snap.endDistanceM) ? snap.endDistanceM : null
    };
}

function serializedStringList(value) {
    return Array.isArray(value)
        ? value.map(item => String(item || '').trim()).filter(Boolean)
        : [];
}

function serializedSourceRefs(value) {
    if (!Array.isArray(value)) return [];
    return value.map(item => {
        const sourceRef = toPlain(item) || {};
        return {
            datasetName: sourceRef.datasetName || '',
            smId: Number.isFinite(sourceRef.smId) ? sourceRef.smId : null
        };
    });
}

function serializedTopologyProof(value) {
    const proof = toPlain(value);
    if (!proof || typeof proof !== 'object') return null;
    return {
        schema: proof.schema || '',
        authority: proof.authority || '',
        dataVersion: proof.dataVersion || '',
        kind: proof.kind || '',
        geometryDigest: proof.geometryDigest || '',
        nodeIds: serializedStringList(proof.nodeIds),
        edgeIds: serializedStringList(proof.edgeIds),
        sourceRefs: serializedSourceRefs(proof.sourceRefs),
        segmentCount: Number.isSafeInteger(proof.segmentCount) && proof.segmentCount >= 0
            ? proof.segmentCount
            : null,
        distanceM: Number.isFinite(proof.distanceM) ? proof.distanceM : null,
        durationSec: Number.isFinite(proof.durationSec) ? proof.durationSec : null,
        segments: serializedSegments(proof.segments),
        digest: proof.digest || ''
    };
}

function serializedRouteFields(value) {
    const route = toPlain(value) || {};
    const verifiedAccessible = route.verifiedAccessible === true || route.accessibleVerified === true
        ? true
        : route.verifiedAccessible === false || route.accessibleVerified === false
            ? false
            : null;
    return {
        geometry: serializedGeometry(route.geometry),
        distanceM: Number.isFinite(route.distanceM) ? route.distanceM : null,
        durationSec: Number.isFinite(route.durationSec) ? route.durationSec : null,
        gis: serializedGis(route.gis),
        segments: serializedSegments(route.segments),
        nodeIds: serializedStringList(route.nodeIds),
        edgeIds: serializedStringList(route.edgeIds),
        topologyProof: serializedTopologyProof(route.topologyProof),
        snap: serializedSnap(route.snap),
        verifiedAccessible,
        pathGeometry: typeof route.pathGeometry === 'string' ? route.pathGeometry : ''
    };
}

function routeMode(preferences = {}) {
    if (preferences?.accessible) return 'accessible';
    if (preferences?.shadeFirst) return 'shade';
    return 'normal';
}

function aggregateRouteFromStops(stops, preferences, fallback = null, options = {}) {
    const expectedDataVersion = normalizedDataVersion(options?.expectedDataVersion);
    const legs = (stops || [])
        .filter(stop => !['skipped', 'rerouted'].includes(stop.state))
        .map(serializedRouteFields)
        .filter(route => route.geometry
            && Number.isFinite(route.distanceM)
            && Number.isFinite(route.durationSec));
    if (!legs.length) {
        const serializedFallback = fallback ? serializedRouteFields(fallback) : null;
        if (serializedFallback && expectedDataVersion) {
            requireExpectedDataVersion(serializedFallback, expectedDataVersion, 'fallback route');
        }
        return serializedFallback;
    }
    if (expectedDataVersion) {
        legs.forEach((leg, index) =>
            requireExpectedDataVersion(leg, expectedDataVersion, `route leg ${index}`));
    }

    const coordinates = [];
    const segments = [];
    const nodeIds = [];
    for (const leg of legs) {
        for (const position of leg.geometry.coordinates) {
            const previous = coordinates[coordinates.length - 1];
            if (!previous || previous[0] !== position[0] || previous[1] !== position[1]) {
                coordinates.push([...position]);
            }
        }
        segments.push(...leg.segments);
        for (const nodeId of leg.nodeIds) {
            if (!nodeIds.length || nodeIds[nodeIds.length - 1] !== nodeId) nodeIds.push(nodeId);
        }
    }
    if (coordinates.length === 1) coordinates.push([...coordinates[0]]);
    const gisEntries = legs.map(leg => leg.gis).filter(Boolean);
    const firstGis = gisEntries[0];
    const source = gisEntries.some(gis => gis.source === 'local-fallback')
        ? 'local-fallback'
        : gisEntries.some(gis => gis.source === 'cache')
            ? 'cache'
            : firstGis?.source || null;
    const versions = [...new Set(gisEntries.map(gis => gis.dataVersion).filter(Boolean))];
    const firstSnap = legs[0].snap;
    const lastSnap = legs[legs.length - 1].snap;
    const verificationValues = legs.map(leg => leg.verifiedAccessible);
    const verifiedAccessible = verificationValues.every(value => value === true)
        ? true
        : verificationValues.some(value => value === false)
            ? false
            : null;
    const geometry = { type: 'LineString', coordinates };
    const distanceM = legs.reduce((sum, leg) => sum + leg.distanceM, 0);
    const durationSec = legs.reduce((sum, leg) => sum + leg.durationSec, 0);
    const dataVersion = expectedDataVersion || (versions.length === 1 ? versions[0] : null);
    const snap = firstSnap || lastSnap ? {
        ...(firstSnap?.startNodeId ? { startNodeId: firstSnap.startNodeId } : {}),
        ...(lastSnap?.endNodeId ? { endNodeId: lastSnap.endNodeId } : {}),
        startDistanceM: firstSnap?.startDistanceM ?? null,
        endDistanceM: lastSnap?.endDistanceM ?? null
    } : null;
    const allLegsHaveValidProof = Boolean(dataVersion) && legs.every(leg => {
        if (!leg.topologyProof) return false;
        return validateRouteTopology(leg, {
            authority: leg.topologyProof.authority,
            expectedDataVersion: dataVersion
        }).valid;
    });
    let topologyProof = null;
    if (allLegsHaveValidProof && nodeIds.length === segments.length + 1) {
        const aggregateTopology = validateRouteTopology({
            geometry,
            distanceM,
            durationSec,
            gis: { dataVersion },
            segments,
            nodeIds,
            edgeIds: segments.map(segment => segment.edgeId),
            snap
        }, {
            authority: 'planner-aggregate',
            expectedDataVersion: dataVersion
        });
        if (aggregateTopology.valid) {
            topologyProof = createTopologyProof({
                authority: 'planner-aggregate',
                dataVersion,
                geometry,
                nodeIds: aggregateTopology.nodeIds,
                segments: aggregateTopology.segments,
                distanceM,
                durationSec
            });
        }
    }
    return {
        geometry,
        distanceM,
        durationSec,
        gis: firstGis ? {
            ...firstGis,
            source,
            mode: routeMode(preferences),
            degraded: gisEntries.some(gis => gis.degraded || gis.source !== 'iserver'),
            durationMs: gisEntries.reduce((sum, gis) => sum + gis.durationMs, 0),
            dataVersion
        } : null,
        segments,
        nodeIds,
        edgeIds: segments.map(segment => segment.edgeId),
        topologyProof,
        snap,
        verifiedAccessible,
        pathGeometry: encodePolyline(coordinates)
    };
}

function normalizedDataVersion(value) {
    return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function requireExpectedDataVersion(route, expectedDataVersion, label) {
    const actualDataVersion = normalizedDataVersion(route?.gis?.dataVersion);
    if (actualDataVersion !== expectedDataVersion) {
        throw new RouteDataVersionError(`${label} dataVersion does not match the routing snapshot`, {
            expectedDataVersion,
            actualDataVersion: actualDataVersion || null
        });
    }
}

module.exports = {
    RouteDataVersionError,
    routeMode,
    serializedRouteFields,
    aggregateRouteFromStops,
    serializedTopologyProof
};
