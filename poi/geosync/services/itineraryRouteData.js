'use strict';

const { encodePolyline } = require('../lib/geo');

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
        startDistanceM: Number.isFinite(snap.startDistanceM) ? snap.startDistanceM : null,
        endDistanceM: Number.isFinite(snap.endDistanceM) ? snap.endDistanceM : null
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

function aggregateRouteFromStops(stops, preferences, fallback = null) {
    const legs = (stops || [])
        .filter(stop => !['skipped', 'rerouted'].includes(stop.state))
        .map(serializedRouteFields)
        .filter(route => route.geometry
            && Number.isFinite(route.distanceM)
            && Number.isFinite(route.durationSec));
    if (!legs.length) return fallback ? serializedRouteFields(fallback) : null;

    const coordinates = [];
    const segments = [];
    for (const leg of legs) {
        for (const position of leg.geometry.coordinates) {
            const previous = coordinates[coordinates.length - 1];
            if (!previous || previous[0] !== position[0] || previous[1] !== position[1]) {
                coordinates.push([...position]);
            }
        }
        segments.push(...leg.segments);
    }
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
    return {
        geometry: { type: 'LineString', coordinates },
        distanceM: legs.reduce((sum, leg) => sum + leg.distanceM, 0),
        durationSec: legs.reduce((sum, leg) => sum + leg.durationSec, 0),
        gis: firstGis ? {
            ...firstGis,
            source,
            mode: routeMode(preferences),
            degraded: gisEntries.some(gis => gis.degraded || gis.source !== 'iserver'),
            durationMs: gisEntries.reduce((sum, gis) => sum + gis.durationMs, 0),
            dataVersion: versions.length === 1 ? versions[0] : null
        } : null,
        segments,
        snap: firstSnap || lastSnap ? {
            startDistanceM: firstSnap?.startDistanceM ?? null,
            endDistanceM: lastSnap?.endDistanceM ?? null
        } : null,
        verifiedAccessible,
        pathGeometry: encodePolyline(coordinates)
    };
}

module.exports = {
    routeMode,
    serializedRouteFields,
    aggregateRouteFromStops
};
