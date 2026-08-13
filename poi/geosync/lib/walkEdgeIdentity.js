'use strict';

const crypto = require('crypto');

const SAFE_GRAPH_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const LEGACY_REVERSE_SUFFIX = '_r';

function normalizedGraphId(value) {
    if (value === undefined || value === null) return null;
    const id = String(value).trim();
    return SAFE_GRAPH_ID.test(id) ? id : null;
}

function explicitGraphId(feature, propertyNames) {
    const properties = feature?.properties || {};
    for (const name of propertyNames) {
        if (properties[name] === undefined || properties[name] === null) continue;
        const id = normalizedGraphId(properties[name]);
        if (!id) throw new TypeError(`${name} must be a stable graph identifier`);
        return id;
    }
    if (feature?.id !== undefined && feature?.id !== null) {
        const id = normalizedGraphId(feature.id);
        if (!id) throw new TypeError('GeoJSON feature.id must be a stable graph identifier');
        return id;
    }
    return null;
}

function stableSourceId(properties) {
    const value = properties?.sourceId ?? properties?.source_id;
    if (value === undefined || value === null) return null;
    const sourceId = String(value).trim();
    if (!sourceId || sourceId.length > 256) {
        throw new TypeError('sourceId must be a non-empty stable identifier');
    }
    return sourceId;
}

function normalizedCoordinateToken(coordinate) {
    return coordinate.map(value => Number(value.toFixed(7)));
}

function stableHash(value) {
    return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24);
}

function stableNodeId(feature, coordinate, namespace = '') {
    const explicit = explicitGraphId(feature, ['nodeId', 'node_id']);
    if (explicit) return explicit;
    return `n_geo_${stableHash([
        String(namespace || '').trim(),
        stableSourceId(feature?.properties || {}),
        normalizedCoordinateToken(coordinate)
    ])}`;
}

function canonicalEdgeIdentity({ from, to, coordinates, sourceId = null }) {
    const forward = coordinates.map(normalizedCoordinateToken);
    const reverse = [...coordinates].reverse().map(normalizedCoordinateToken);
    const forwardToken = JSON.stringify(forward);
    const reverseToken = JSON.stringify(reverse);
    const endpoints = [String(from), String(to)].sort();
    return [sourceId || null, endpoints, forwardToken <= reverseToken ? forward : reverse];
}

function stablePhysicalEdgeId(feature, edge, namespace = '') {
    const explicit = explicitGraphId(feature, ['edgeId', 'edge_id']);
    if (explicit) return explicit;
    const sourceId = stableSourceId(feature?.properties || {});
    return `e_geo_${stableHash([
        String(namespace || '').trim(),
        canonicalEdgeIdentity({ ...edge, sourceId })
    ])}`;
}

function directedEdgeId(physicalEdgeId, traversalDirection) {
    if (!normalizedGraphId(physicalEdgeId)) {
        throw new TypeError('physicalEdgeId must be a stable graph identifier');
    }
    if (traversalDirection === 'forward') return physicalEdgeId;
    if (traversalDirection === 'reverse') return `${physicalEdgeId}${LEGACY_REVERSE_SUFFIX}`;
    throw new TypeError('traversalDirection must be forward or reverse');
}

function physicalEdgeIdOf(edge) {
    return normalizedGraphId(edge?.physicalEdgeId) || normalizedGraphId(edge?.edgeId);
}

function reverseCandidateEdgeId(edgeId) {
    const normalized = normalizedGraphId(edgeId);
    if (!normalized) return null;
    return normalized.endsWith(LEGACY_REVERSE_SUFFIX)
        ? normalized.slice(0, -LEGACY_REVERSE_SUFFIX.length)
        : `${normalized}${LEGACY_REVERSE_SUFFIX}`;
}

function normalizedGeometry(value) {
    if (!Array.isArray(value) || value.length < 2) return null;
    const geometry = [];
    for (const coordinate of value) {
        if (!Array.isArray(coordinate)
            || coordinate.length !== 2
            || !coordinate.every(Number.isFinite)) {
            return null;
        }
        geometry.push(normalizedCoordinateToken(coordinate));
    }
    return geometry;
}

function legacyReversePair(left, right) {
    const leftId = normalizedGraphId(left?.edgeId);
    const rightId = normalizedGraphId(right?.edgeId);
    if (!leftId || !rightId || reverseCandidateEdgeId(leftId) !== rightId) return false;
    if (String(left?.scenicId || '') !== String(right?.scenicId || '')) return false;
    if (left?.from !== right?.to || left?.to !== right?.from) return false;
    const leftGeometry = normalizedGeometry(left?.geometry);
    const rightGeometry = normalizedGeometry(right?.geometry);
    if (!leftGeometry || !rightGeometry || leftGeometry.length !== rightGeometry.length) return false;
    return JSON.stringify(leftGeometry) === JSON.stringify([...rightGeometry].reverse());
}

module.exports = {
    SAFE_GRAPH_ID,
    LEGACY_REVERSE_SUFFIX,
    normalizedGraphId,
    stableNodeId,
    stablePhysicalEdgeId,
    directedEdgeId,
    physicalEdgeIdOf,
    reverseCandidateEdgeId,
    legacyReversePair
};
