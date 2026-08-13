'use strict';

const crypto = require('node:crypto');

const PROOF_SCHEMA = 'geosync.topology/v1';
const PROOF_AUTHORITIES = new Set([
    'iserver-network-analysis',
    'local-walk-graph',
    'planner-aggregate'
]);
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_SEGMENTS = 5000;
const DISTANCE_ABSOLUTE_TOLERANCE_M = 5;
const DISTANCE_RELATIVE_TOLERANCE = 0.02;
const DURATION_ABSOLUTE_TOLERANCE_SEC = 5;
const DURATION_RELATIVE_TOLERANCE = 0.02;
const MIN_CONNECTOR_SPEED_MPS = 0.7;

function isObject(value) {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function fail(message) {
    throw new TypeError(message);
}

function finiteNonNegative(value, field) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        fail(`${field} must be a non-negative finite number`);
    }
    return value;
}

function nonEmptyText(value, field, maxLength = 256) {
    const text = value === undefined || value === null ? '' : String(value).trim();
    if (!text || text.length > maxLength || /[\u0000-\u001f\u007f]/.test(text)) {
        fail(`${field} must be a non-empty safe string`);
    }
    return text;
}

function identifier(value, field) {
    const text = nonEmptyText(value, field, 128);
    if (!SAFE_IDENTIFIER.test(text)) fail(`${field} must be a safe identifier`);
    return text;
}

function sourceRefOf(value, field) {
    if (!isObject(value)) fail(`${field} must be an object`);
    const datasetName = nonEmptyText(value.datasetName, `${field}.datasetName`);
    const smId = Number(value.smId);
    if (!Number.isSafeInteger(smId) || smId < 0) {
        fail(`${field}.smId must be a non-negative safe integer`);
    }
    return { datasetName, smId };
}

function coordinateOf(value, field) {
    if (!Array.isArray(value) || value.length !== 2 || !value.every(Number.isFinite)) {
        fail(`${field} must be a finite [lng, lat] coordinate`);
    }
    if (value[0] < -180 || value[0] > 180 || value[1] < -90 || value[1] > 90) {
        fail(`${field} must be within EPSG:4326 ranges`);
    }
    return [value[0], value[1]];
}

function sameCoordinate(left, right) {
    return left[0] === right[0] && left[1] === right[1];
}

function routeCoordinates(route) {
    const coordinates = route?.geometry?.type === 'LineString'
        ? route.geometry.coordinates
        : route?.coords;
    if (!Array.isArray(coordinates) || coordinates.length < 2) {
        fail('route geometry must contain at least two coordinates');
    }
    return coordinates.map((coordinate, index) => coordinateOf(coordinate, `geometry.coordinates[${index}]`));
}

function hasGeometryMovement(coordinates) {
    return coordinates.slice(1).some(coordinate => !sameCoordinate(coordinates[0], coordinate));
}

function optionalNodeId(value, field) {
    if (value === undefined || value === null || value === '') return null;
    return identifier(value, field);
}

function segmentOf(value, index, nodePair) {
    const field = `segments[${index}]`;
    if (!isObject(value)) fail(`${field} must be an object`);
    const fromNodeId = optionalNodeId(value.fromNodeId, `${field}.fromNodeId`)
        || nodePair?.[0]
        || null;
    const toNodeId = optionalNodeId(value.toNodeId, `${field}.toNodeId`)
        || nodePair?.[1]
        || null;
    const physicalEdgeId = optionalNodeId(value.physicalEdgeId, `${field}.physicalEdgeId`);
    return {
        edgeId: identifier(value.edgeId, `${field}.edgeId`),
        ...(physicalEdgeId ? { physicalEdgeId } : {}),
        fromNodeId,
        toNodeId,
        distanceM: finiteNonNegative(value.distanceM, `${field}.distanceM`),
        durationSec: finiteNonNegative(value.durationSec, `${field}.durationSec`),
        sourceRef: sourceRefOf(value.sourceRef, `${field}.sourceRef`)
    };
}

function nodeIdsOf(value, field = 'nodeIds') {
    if (!Array.isArray(value) || value.length < 1 || value.length > MAX_SEGMENTS + 1) {
        fail(`${field} must contain between 1 and ${MAX_SEGMENTS + 1} node identifiers`);
    }
    return value.map((nodeId, index) => identifier(nodeId, `${field}[${index}]`));
}

function edgeIdsOf(value, field = 'edgeIds') {
    if (!Array.isArray(value) || value.length > MAX_SEGMENTS) {
        fail(`${field} must be an array with at most ${MAX_SEGMENTS} entries`);
    }
    return value.map((edgeId, index) => identifier(edgeId, `${field}[${index}]`));
}

function sourceRefsOf(value, field = 'sourceRefs') {
    if (!Array.isArray(value) || value.length > MAX_SEGMENTS) {
        fail(`${field} must be an array with at most ${MAX_SEGMENTS} entries`);
    }
    return value.map((sourceRef, index) => sourceRefOf(sourceRef, `${field}[${index}]`));
}

function equalJson(left, right) {
    return JSON.stringify(left) === JSON.stringify(right);
}

function connectorDistance(route) {
    const start = Number(route?.snap?.startDistanceM);
    const end = Number(route?.snap?.endDistanceM);
    return (Number.isFinite(start) && start >= 0 ? start : 0)
        + (Number.isFinite(end) && end >= 0 ? end : 0);
}

function withinSummaryTolerance(actual, segmentTotal, absoluteTolerance, relativeTolerance, extra = 0) {
    const scale = Math.max(actual, segmentTotal, 1);
    const tolerance = absoluteTolerance + relativeTolerance * scale + extra;
    return Math.abs(actual - segmentTotal) <= tolerance;
}

function assertSummary(route, segments) {
    const segmentDistanceM = segments.reduce((sum, segment) => sum + segment.distanceM, 0);
    const segmentDurationSec = segments.reduce((sum, segment) => sum + segment.durationSec, 0);
    const connectorsM = connectorDistance(route);
    if (!withinSummaryTolerance(
        route.distanceM,
        segmentDistanceM,
        DISTANCE_ABSOLUTE_TOLERANCE_M,
        DISTANCE_RELATIVE_TOLERANCE,
        connectorsM
    )) {
        fail('route distanceM is inconsistent with canonical segment totals');
    }
    if (!withinSummaryTolerance(
        route.durationSec,
        segmentDurationSec,
        DURATION_ABSOLUTE_TOLERANCE_SEC,
        DURATION_RELATIVE_TOLERANCE,
        connectorsM / MIN_CONNECTOR_SPEED_MPS
    )) {
        fail('route durationSec is inconsistent with canonical segment totals');
    }
}

function dataVersionOf(route, expectedDataVersion, requireDataVersion = true) {
    const expected = expectedDataVersion === undefined || expectedDataVersion === null
        ? ''
        : String(expectedDataVersion).trim();
    const declared = typeof route?.gis?.dataVersion === 'string'
        ? route.gis.dataVersion.trim()
        : typeof route?.dataVersion === 'string'
            ? route.dataVersion.trim()
            : '';
    const edgeVersions = Array.isArray(route?.edgeDataVersions)
        ? [...new Set(route.edgeDataVersions.map(value => String(value || '').trim()).filter(Boolean))]
        : [];
    const inferred = edgeVersions.length === 1 ? edgeVersions[0] : '';
    const dataVersion = expected || declared || inferred;
    if (!dataVersion && requireDataVersion) fail('route topology provenance requires a dataVersion');
    if (expected && declared && expected !== declared) fail('route dataVersion does not match the expected snapshot');
    if (edgeVersions.length > 1 || (edgeVersions.length === 1 && edgeVersions[0] !== dataVersion)) {
        fail('route edge data versions are inconsistent');
    }
    return dataVersion;
}

function geometryDigest(coordinates) {
    return `sha256:${crypto.createHash('sha256').update(JSON.stringify(coordinates)).digest('hex')}`;
}

function proofPayload({
    authority,
    dataVersion,
    kind,
    geometryHash,
    nodeIds,
    segments,
    distanceM,
    durationSec
}) {
    return {
        schema: PROOF_SCHEMA,
        authority,
        dataVersion,
        kind,
        geometryDigest: geometryHash,
        nodeIds,
        edgeIds: segments.map(segment => segment.edgeId),
        sourceRefs: segments.map(segment => ({ ...segment.sourceRef })),
        segmentCount: segments.length,
        distanceM,
        durationSec,
        segments: segments.map(segment => ({
            edgeId: segment.edgeId,
            ...(segment.physicalEdgeId ? { physicalEdgeId: segment.physicalEdgeId } : {}),
            fromNodeId: segment.fromNodeId,
            toNodeId: segment.toNodeId,
            distanceM: segment.distanceM,
            durationSec: segment.durationSec,
            sourceRef: { ...segment.sourceRef }
        }))
    };
}

function proofDigest(payload) {
    return `sha256:${crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex')}`;
}

function createTopologyProof(input = {}) {
    const authority = nonEmptyText(input.authority, 'topologyProof.authority');
    if (!PROOF_AUTHORITIES.has(authority)) fail('topologyProof.authority is not recognized');
    const dataVersion = nonEmptyText(input.dataVersion, 'topologyProof.dataVersion');
    const distanceM = finiteNonNegative(input.distanceM, 'topologyProof.distanceM');
    const durationSec = finiteNonNegative(input.durationSec, 'topologyProof.durationSec');
    const coordinates = routeCoordinates({
        geometry: input.geometry?.type === 'LineString'
            ? input.geometry
            : { type: 'LineString', coordinates: input.coordinates }
    });
    const nodeIds = nodeIdsOf(input.nodeIds, 'topologyProof.nodeIds');
    if (!Array.isArray(input.segments) || input.segments.length > MAX_SEGMENTS) {
        fail('topologyProof.segments is invalid');
    }
    if (nodeIds.length !== input.segments.length + 1) {
        fail('topologyProof node and segment counts are inconsistent');
    }
    const segments = input.segments.map((segment, index) => segmentOf(
        segment,
        index,
        [nodeIds[index], nodeIds[index + 1]]
    ));
    for (let index = 0; index < segments.length; index++) {
        if (segments[index].fromNodeId !== nodeIds[index]
            || segments[index].toNodeId !== nodeIds[index + 1]) {
            fail(`topologyProof segment ${index} is not continuous with nodeIds`);
        }
    }
    const kind = segments.length ? 'node-edge-chain' : 'same-node-zero-leg';
    if (!segments.length) {
        if (nodeIds.length !== 1) fail('zero-leg proof must contain exactly one node');
        if (distanceM !== 0 || durationSec !== 0 || hasGeometryMovement(coordinates)) {
            fail('zero-leg proof requires zero metrics and a non-moving geometry');
        }
    } else if (!hasGeometryMovement(coordinates)) {
        fail('node-edge-chain proof requires a moving geometry');
    }
    const payload = proofPayload({
        authority,
        dataVersion,
        kind,
        geometryHash: geometryDigest(coordinates),
        nodeIds,
        segments,
        distanceM,
        durationSec
    });
    return { ...payload, digest: proofDigest(payload) };
}

function normalizedProof(value, coordinates) {
    if (!isObject(value)) fail('topologyProof must be an object');
    if (value.schema !== PROOF_SCHEMA) fail('topologyProof schema is not recognized');
    const proof = createTopologyProof({
        authority: value.authority,
        dataVersion: value.dataVersion,
        nodeIds: value.nodeIds,
        segments: value.segments,
        distanceM: value.distanceM,
        durationSec: value.durationSec,
        coordinates
    });
    if (value.kind !== proof.kind
        || value.geometryDigest !== proof.geometryDigest
        || value.segmentCount !== proof.segmentCount
        || !equalJson(edgeIdsOf(value.edgeIds), proof.edgeIds)
        || !equalJson(sourceRefsOf(value.sourceRefs), proof.sourceRefs)
        || value.digest !== proof.digest) {
        fail('topologyProof is internally inconsistent or has an invalid digest');
    }
    return proof;
}

function explicitRouteNodeIds(route, segments) {
    if (Array.isArray(route?.nodeIds)) return nodeIdsOf(route.nodeIds);
    if (segments.length && segments.every(segment => segment.fromNodeId && segment.toNodeId)) {
        return [segments[0].fromNodeId, ...segments.map(segment => segment.toNodeId)];
    }
    return null;
}

function normalizeRouteSegments(route, nodeIds) {
    const rawSegments = route?.segments === undefined || route?.segments === null
        ? []
        : route.segments;
    if (!Array.isArray(rawSegments) || rawSegments.length > MAX_SEGMENTS) {
        fail('route segments are invalid');
    }
    return rawSegments.map((segment, index) => segmentOf(
        segment,
        index,
        nodeIds ? [nodeIds[index], nodeIds[index + 1]] : null
    ));
}

function assertChain(route, nodeIds, segments, startNodeId, endNodeId) {
    if (nodeIds.length !== segments.length + 1) fail('route node and segment counts are inconsistent');
    for (let index = 0; index < segments.length; index++) {
        const segment = segments[index];
        if (!segment.fromNodeId || !segment.toNodeId) {
            fail(`segments[${index}] lacks canonical endpoint node identifiers`);
        }
        if (segment.fromNodeId !== nodeIds[index] || segment.toNodeId !== nodeIds[index + 1]) {
            fail(`segments[${index}] breaks route topology continuity`);
        }
    }
    if (Array.isArray(route?.edgeIds)
        && !equalJson(edgeIdsOf(route.edgeIds), segments.map(segment => segment.edgeId))) {
        fail('route edgeIds do not match canonical segments');
    }
    if (startNodeId && nodeIds[0] !== startNodeId) fail('route topology does not start at the snapped start node');
    if (endNodeId && nodeIds[nodeIds.length - 1] !== endNodeId) {
        fail('route topology does not end at the snapped end node');
    }
}

function zeroSnapIsExact(route) {
    return Number(route?.snap?.startDistanceM) === 0 && Number(route?.snap?.endDistanceM) === 0;
}

function validateRouteTopology(route, options = {}) {
    try {
        if (!isObject(route)) fail('route must be an object');
        const distanceM = finiteNonNegative(route.distanceM, 'route.distanceM');
        const durationSec = finiteNonNegative(
            route.durationSec === undefined ? route.walkSec : route.durationSec,
            'route.durationSec'
        );
        const coordinates = routeCoordinates(route);
        const geometryMoves = hasGeometryMovement(coordinates);
        const metricsAreZero = distanceM === 0 && durationSec === 0;
        if (metricsAreZero !== !geometryMoves) {
            fail('route metrics and geometry disagree about whether the leg has length');
        }

        const dataVersion = dataVersionOf(
            route,
            options.expectedDataVersion,
            options.requireDataVersion !== false
        );
        const startNodeId = optionalNodeId(
            options.startNodeId ?? route.snap?.startNodeId,
            'startNodeId'
        );
        const endNodeId = optionalNodeId(
            options.endNodeId ?? route.snap?.endNodeId,
            'endNodeId'
        );
        const expectedAuthority = options.authority === undefined || options.authority === null
            ? null
            : nonEmptyText(options.authority, 'authority');
        if (expectedAuthority && !PROOF_AUTHORITIES.has(expectedAuthority)) {
            fail('authority is not recognized');
        }
        let proof = route.topologyProof ? normalizedProof(route.topologyProof, coordinates) : null;
        if (proof && proof.dataVersion !== dataVersion) fail('topologyProof dataVersion does not match the route');
        if (proof && expectedAuthority && proof.authority !== expectedAuthority) {
            fail('topologyProof authority does not match the route source');
        }

        const routeNodeIds = Array.isArray(route.nodeIds) ? nodeIdsOf(route.nodeIds) : null;
        let nodeIds = routeNodeIds || proof?.nodeIds || null;
        let segments = proof?.segments || null;
        const rawRouteSegments = route.segments === undefined || route.segments === null
            ? []
            : route.segments;
        if (!Array.isArray(rawRouteSegments)) fail('route segments must be an array');

        if (proof) {
            if (rawRouteSegments.length) {
                const routeSegments = normalizeRouteSegments(route, nodeIds);
                if (!equalJson(routeSegments, proof.segments)) {
                    fail('route segments do not match topologyProof');
                }
            }
            if (routeNodeIds && !equalJson(routeNodeIds, proof.nodeIds)) {
                fail('route nodeIds do not match topologyProof');
            }
            if (proof.distanceM !== distanceM || proof.durationSec !== durationSec) {
                fail('topologyProof totals do not match route totals');
            }
        } else {
            const preliminarySegments = normalizeRouteSegments(route, null);
            nodeIds = routeNodeIds || explicitRouteNodeIds(route, preliminarySegments);
            if (!nodeIds) fail('route lacks a verifiable canonical topology chain');
            segments = normalizeRouteSegments(route, nodeIds);
        }

        if (metricsAreZero) {
            if (segments.length || nodeIds.length !== 1) {
                fail('same-node zero leg must not contain traversed segments');
            }
            if (Array.isArray(route.edgeIds) && edgeIdsOf(route.edgeIds).length) {
                fail('same-node zero leg must not declare traversed edgeIds');
            }
            const zeroNodeId = startNodeId || endNodeId || nodeIds[0];
            if (!zeroNodeId || nodeIds[0] !== zeroNodeId
                || (startNodeId && endNodeId && startNodeId !== endNodeId)) {
                fail('same-node zero leg must use one identical snapped node');
            }
            if (!zeroSnapIsExact(route)) fail('same-node zero leg requires exact zero snap distances');
            if (options.startCoordinate || options.endCoordinate) {
                const startCoordinate = coordinateOf(options.startCoordinate, 'startCoordinate');
                const endCoordinate = coordinateOf(options.endCoordinate, 'endCoordinate');
                if (!sameCoordinate(startCoordinate, endCoordinate)
                    || !coordinates.every(coordinate => sameCoordinate(coordinate, startCoordinate))) {
                    fail('same-node zero leg coordinates must be identical');
                }
            }
        } else {
            if (!segments.length) fail('non-zero route requires canonical topology segments');
            assertChain(route, nodeIds, segments, startNodeId, endNodeId);
            assertSummary({ ...route, distanceM, durationSec }, segments);
        }

        if (!proof && !dataVersion) {
            return {
                valid: true,
                zeroLeg: metricsAreZero,
                proof: null,
                nodeIds: [...nodeIds],
                segments: segments.map(segment => ({
                    ...segment,
                    sourceRef: { ...segment.sourceRef }
                }))
            };
        }
        if (!proof) {
            proof = createTopologyProof({
                authority: expectedAuthority,
                dataVersion,
                nodeIds,
                segments,
                distanceM,
                durationSec,
                coordinates
            });
        }
        return {
            valid: true,
            zeroLeg: metricsAreZero,
            proof,
            nodeIds: [...proof.nodeIds],
            segments: proof.segments.map(segment => ({
                ...segment,
                sourceRef: { ...segment.sourceRef }
            }))
        };
    } catch (error) {
        return {
            valid: false,
            reason: error instanceof Error ? error.message : 'invalid route topology provenance'
        };
    }
}

module.exports = {
    PROOF_SCHEMA,
    createTopologyProof,
    validateRouteTopology
};
