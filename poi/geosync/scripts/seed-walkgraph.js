'use strict';

require('dotenv').config();
const fs = require('fs');
const mongoose = require('mongoose');
const { registerModels } = require('../models');
const geo = require('../lib/geo');
const {
    normalizeBoolean,
    normalizeCoordinate,
    normalizeLineCoordinates,
    normalizeWalkEdgeMetrics,
    polylineDistanceM
} = require('../lib/walkEdgeContract');
const { expandWalkEdgeDirections } = require('../lib/walkEdgeDirection');
const {
    directedEdgeId,
    legacyReversePair,
    normalizedGraphId,
    stableNodeId,
    stablePhysicalEdgeId
} = require('../lib/walkEdgeIdentity');

const SCENIC_ID = process.env.SCENIC_ID || 'default';

async function resolveLeanQuery(query) {
    return query && typeof query.lean === 'function' ? query.lean() : query;
}

async function findLean(Model, filter, session = null) {
    let query = Model.find(filter);
    if (session && query && typeof query.session === 'function') query = query.session(session);
    const rows = await resolveLeanQuery(query);
    return Array.isArray(rows) ? rows : [];
}

function operationOptions(session, options = {}) {
    return session ? { ...options, session } : options;
}

function plainDocument(value) {
    const source = value?.toObject ? value.toObject() : value;
    const result = { ...(source || {}) };
    delete result._id;
    delete result.__v;
    return result;
}

function withoutKeys(value, keys) {
    const result = plainDocument(value);
    for (const key of keys) delete result[key];
    return result;
}

function documentSignature(value) {
    return JSON.stringify(value);
}

function prepareImportPlan(features, scenicId) {
    const nodePlans = new Map();
    for (const [featureIndex, feature] of features.entries()) {
        if (feature.geometry?.type !== 'Point') continue;
        const coordinates = normalizeCoordinate(feature.geometry.coordinates, { coerce: true });
        if (!coordinates) {
            throw new TypeError(`Point feature at index ${featureIndex} has invalid coordinates`);
        }
        const nodeId = stableNodeId(feature, coordinates, scenicId);
        const node = {
            nodeId,
            scenicId,
            geo: { type: 'Point', coordinates },
            kind: feature.properties?.kind || 'junction'
        };
        const existing = nodePlans.get(nodeId);
        if (existing && documentSignature(existing) !== documentSignature(node)) {
            throw new TypeError(`nodeId ${nodeId} maps to conflicting imported nodes`);
        }
        if (!existing) nodePlans.set(nodeId, node);
    }

    const snapNodes = [...nodePlans.values()]
        .map(node => ({ nodeId: node.nodeId, coordinates: node.geo.coordinates }))
        .sort((left, right) => left.nodeId.localeCompare(right.nodeId));
    const snap = point => {
        let best = null;
        let bestDistanceM = Infinity;
        for (const node of snapNodes) {
            const distanceM = geo.haversine(point, node.coordinates);
            if (distanceM < bestDistanceM) {
                best = node;
                bestDistanceM = distanceM;
            }
        }
        return bestDistanceM < 5 ? best.nodeId : null;
    };
    const endpointId = (value, fallbackCoordinate, field) => {
        if (value === undefined || value === null || value === '') return snap(fallbackCoordinate);
        const id = normalizedGraphId(value);
        if (!id) throw new TypeError(`${field} must be a stable graph identifier`);
        return id;
    };

    const physicalEdgeSignatures = new Map();
    const edgePlans = new Map();
    for (const [featureIndex, feature] of features.entries()) {
        if (feature.geometry?.type !== 'LineString') continue;
        const coordinates = normalizeLineCoordinates(feature.geometry.coordinates, { coerce: true });
        if (!coordinates) {
            throw new TypeError(`LineString feature at index ${featureIndex} has invalid coordinates`);
        }
        const properties = feature.properties || {};
        const from = endpointId(properties.from ?? properties.from_node, coordinates[0], 'from');
        const to = endpointId(
            properties.to ?? properties.to_node,
            coordinates[coordinates.length - 1],
            'to'
        );
        if (!from || !to || from === to) {
            throw new TypeError(
                `LineString feature at index ${featureIndex} has unresolved or identical endpoints`
            );
        }
        const directionalEdges = expandWalkEdgeDirections({
            from,
            to,
            coordinates,
            direction: properties.direction
        });
        if (!directionalEdges) {
            throw new TypeError(`LineString feature at index ${featureIndex} has invalid direction`);
        }

        const stairs = normalizeBoolean(properties.stairs, { coerce: true, defaultValue: false });
        const accessible = normalizeBoolean(properties.accessible, { coerce: true, defaultValue: false });
        const rawDistanceM = polylineDistanceM(coordinates);
        if (stairs === null || accessible === null || rawDistanceM === null) {
            throw new TypeError(`LineString feature at index ${featureIndex} has invalid attributes`);
        }
        const distanceM = Math.round(rawDistanceM);
        const walkSec = Math.round(distanceM / 1.4 * (stairs ? 1.6 : 1));
        const metrics = normalizeWalkEdgeMetrics({
            distanceM,
            walkSec,
            slope: properties.slopePct ?? properties.slope_pct ?? properties.slope,
            shade: properties.shade,
            covered: properties.covered
        }, { geometryDistanceM: distanceM, coerce: true });
        if (!metrics) {
            throw new TypeError(`LineString feature at index ${featureIndex} has invalid metrics`);
        }

        const physicalEdgeId = stablePhysicalEdgeId(feature, { from, to, coordinates }, scenicId);
        const common = {
            scenicId,
            physicalEdgeId,
            distanceM: metrics.distanceM,
            walkSec: metrics.walkSec,
            slope: metrics.slope,
            stairs,
            shade: metrics.shade,
            covered: metrics.covered,
            accessible,
            source: 'import'
        };
        const directedPlans = directionalEdges
            .map(directedEdge => ({
                edgeId: directedEdgeId(physicalEdgeId, directedEdge.traversalDirection),
                ...common,
                traversalDirection: directedEdge.traversalDirection,
                from: directedEdge.from,
                to: directedEdge.to,
                geometry: directedEdge.geometry
            }))
            .sort((left, right) => left.edgeId.localeCompare(right.edgeId));
        const physicalSignature = documentSignature(directedPlans);
        const previousPhysicalSignature = physicalEdgeSignatures.get(physicalEdgeId);
        if (previousPhysicalSignature !== undefined) {
            if (previousPhysicalSignature !== physicalSignature) {
                throw new TypeError(`physicalEdgeId ${physicalEdgeId} maps to conflicting imported edges`);
            }
            continue;
        }

        for (const plan of directedPlans) {
            const previous = edgePlans.get(plan.edgeId);
            if (previous && documentSignature(previous) !== documentSignature(plan)) {
                throw new TypeError(`edgeId ${plan.edgeId} maps to conflicting directed edges`);
            }
        }
        physicalEdgeSignatures.set(physicalEdgeId, physicalSignature);
        for (const plan of directedPlans) edgePlans.set(plan.edgeId, plan);
    }

    return {
        nodePlans: [...nodePlans.values()].sort((left, right) => left.nodeId.localeCompare(right.nodeId)),
        edgePlans: [...edgePlans.values()].sort((left, right) => left.edgeId.localeCompare(right.edgeId)),
        skippedLines: 0
    };
}

function existingPhysicalEdgeId(edge, byEdgeId) {
    const explicit = normalizedGraphId(edge?.physicalEdgeId);
    if (explicit) return explicit;
    const edgeId = normalizedGraphId(edge?.edgeId);
    if (!edgeId) return null;
    if (edgeId.endsWith('_r')) {
        const baseId = edgeId.slice(0, -2);
        const base = byEdgeId.get(baseId);
        if (base && legacyReversePair(base, edge)) return baseId;
    }
    return edgeId;
}

function validDate(value) {
    if (value === undefined || value === null || value === '') return null;
    const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
    return Number.isFinite(date.getTime()) ? date : null;
}

function closedStateByPhysicalEdge(existingEdges) {
    const byEdgeId = new Map(existingEdges.map(edge => [String(edge.edgeId), edge]));
    const grouped = new Map();
    for (const edge of existingEdges) {
        const physicalEdgeId = existingPhysicalEdgeId(edge, byEdgeId);
        if (!physicalEdgeId) continue;
        if (!grouped.has(physicalEdgeId)) grouped.set(physicalEdgeId, []);
        grouped.get(physicalEdgeId).push(edge);
    }

    const result = new Map();
    for (const [physicalEdgeId, edges] of grouped) {
        const closed = edges.filter(edge => edge.status === 'closed');
        if (!closed.length) continue;
        closed.sort((left, right) => {
            const leftTime = validDate(left.closedAt)?.getTime() ?? -Infinity;
            const rightTime = validDate(right.closedAt)?.getTime() ?? -Infinity;
            return rightTime - leftTime || String(left.edgeId).localeCompare(String(right.edgeId));
        });
        const source = closed[0];
        const reasonSource = closed.find(edge =>
            typeof edge.closedReason === 'string' && edge.closedReason.length > 0);
        result.set(physicalEdgeId, {
            status: 'closed',
            closedReason: reasonSource?.closedReason,
            closedAt: validDate(source.closedAt)
        });
    }
    return result;
}

function transactionUnsupported(error) {
    const candidates = [error, error?.cause, error?.errorResponse].filter(Boolean);
    return candidates.some(candidate => {
        const code = Number(candidate?.code);
        const codeName = String(candidate?.codeName || '').trim();
        const message = String(candidate?.message || '');
        const unsupportedMessage = /transaction numbers are only allowed on a replica set member or mongos/i
            .test(message)
            || /transactions? (?:are|is) not supported (?:by|on|for) this (?:deployment|topology|server)/i
                .test(message);
        return unsupportedMessage && (code === 20
            || codeName === 'IllegalOperation'
            || !Number.isFinite(code));
    });
}

function edgeUpdate(plan, inheritedClosedState) {
    const update = {
        $set: withoutKeys(plan, ['edgeId'])
    };
    if (!inheritedClosedState) {
        update.$setOnInsert = { status: 'open' };
        return update;
    }

    update.$set.status = 'closed';
    const unset = {};
    if (inheritedClosedState.closedReason !== undefined) {
        update.$set.closedReason = inheritedClosedState.closedReason;
    } else {
        unset.closedReason = 1;
    }
    if (inheritedClosedState.closedAt) {
        update.$set.closedAt = inheritedClosedState.closedAt;
    } else {
        unset.closedAt = 1;
    }
    if (Object.keys(unset).length) update.$unset = unset;
    return update;
}

async function applyImportPlan({
    WalkNode,
    WalkEdge,
    scenicId,
    wipe,
    plan,
    closedStates,
    session = null
}) {
    if (wipe) {
        await WalkNode.deleteMany({ scenicId }, operationOptions(session));
        await WalkEdge.deleteMany({ scenicId }, operationOptions(session));
    }

    for (const node of plan.nodePlans) {
        await WalkNode.updateOne(
            { nodeId: node.nodeId },
            { $set: withoutKeys(node, ['nodeId']) },
            operationOptions(session, { upsert: true, runValidators: true })
        );
    }
    for (const edge of plan.edgePlans) {
        await WalkEdge.updateOne(
            { edgeId: edge.edgeId },
            edgeUpdate(edge, wipe ? null : closedStates.get(edge.physicalEdgeId)),
            operationOptions(session, { upsert: true, runValidators: true })
        );
    }
    if (!wipe) {
        await WalkEdge.deleteMany({
            scenicId,
            source: 'import',
            edgeId: { $nin: plan.edgePlans.map(edge => edge.edgeId) }
        }, operationOptions(session));
    }
}

async function restoreDocuments(Model, key, documents) {
    for (const document of documents) {
        const plain = plainDocument(document);
        const id = plain[key];
        await Model.updateOne(
            { [key]: id },
            { $set: withoutKeys(plain, [key]) },
            { upsert: true, runValidators: true }
        );
    }
}

async function rollbackImport({
    WalkNode,
    WalkEdge,
    affectedNodeIds,
    affectedEdgeIds,
    nodeSnapshot,
    edgeSnapshot
}) {
    if (affectedEdgeIds.length) await WalkEdge.deleteMany({ edgeId: { $in: affectedEdgeIds } });
    await restoreDocuments(WalkEdge, 'edgeId', edgeSnapshot);
    if (affectedNodeIds.length) await WalkNode.deleteMany({ nodeId: { $in: affectedNodeIds } });
    await restoreDocuments(WalkNode, 'nodeId', nodeSnapshot);
}

async function applyWithBestAvailableAtomicity(input) {
    const connection = [input.WalkEdge?.db, input.WalkNode?.db]
        .find(candidate => candidate && typeof candidate.startSession === 'function');
    if (connection) {
        let session;
        try {
            session = await connection.startSession();
            if (session && typeof session.withTransaction === 'function') {
                await session.withTransaction(() => applyImportPlan({ ...input, session }));
                return;
            }
        } catch (error) {
            if (!transactionUnsupported(error)) throw error;
        } finally {
            await session?.endSession?.();
        }
    }

    try {
        await applyImportPlan(input);
    } catch (error) {
        try {
            await rollbackImport(input);
        } catch (rollbackError) {
            error.rollbackError = rollbackError;
        }
        throw error;
    }
}

async function seedWalkGraphFeatures({
    features,
    WalkNode,
    WalkEdge,
    scenicId = SCENIC_ID,
    wipe = false,
    logger = console
}) {
    if (!Array.isArray(features)) throw new TypeError('GeoJSON features must be an array');
    if (!WalkNode || !WalkEdge) throw new TypeError('WalkNode and WalkEdge models are required');
    if (typeof WalkNode.find !== 'function' || typeof WalkEdge.find !== 'function') {
        throw new TypeError('WalkNode and WalkEdge must support find for atomic graph synchronization');
    }

    // Compile and validate the complete delivery before the first database write.
    const plan = prepareImportPlan(features, scenicId);
    const expectedNodeIds = plan.nodePlans.map(node => node.nodeId);
    const expectedEdgeIds = plan.edgePlans.map(edge => edge.edgeId);
    const plannedNodeIds = new Set(expectedNodeIds);
    const requiredNodeIds = [...new Set(plan.edgePlans.flatMap(edge => [edge.from, edge.to]))];
    const inspectedNodeIds = [...new Set([...expectedNodeIds, ...requiredNodeIds])];
    const inspectedNodes = inspectedNodeIds.length
        ? await findLean(WalkNode, { nodeId: { $in: inspectedNodeIds } })
        : [];
    const inspectedNodesById = new Map(
        inspectedNodes.map(node => [String(node.nodeId), node])
    );
    const existingExpectedNodes = expectedNodeIds
        .map(nodeId => inspectedNodesById.get(nodeId))
        .filter(Boolean);
    const conflictingNode = existingExpectedNodes.find(node =>
        String(node.scenicId || '') !== String(scenicId));
    if (conflictingNode) {
        throw new TypeError(`nodeId ${conflictingNode.nodeId} is already owned by another scenic graph`);
    }
    for (const nodeId of requiredNodeIds) {
        if (plannedNodeIds.has(nodeId)) continue;
        const existingNode = inspectedNodesById.get(nodeId);
        if (wipe || !existingNode) {
            throw new TypeError(`edge endpoint ${nodeId} is missing from the imported scenic graph`);
        }
        if (String(existingNode.scenicId || '') !== String(scenicId)) {
            throw new TypeError(`edge endpoint ${nodeId} is owned by another scenic graph`);
        }
    }
    const existingExpectedEdges = expectedEdgeIds.length
        ? await findLean(WalkEdge, { edgeId: { $in: expectedEdgeIds } })
        : [];
    const conflictingEdge = existingExpectedEdges.find(edge =>
        String(edge.scenicId || '') !== String(scenicId)
        || (!wipe && edge.source !== 'import'));
    if (conflictingEdge) {
        throw new TypeError(`edgeId ${conflictingEdge.edgeId} is already owned by another graph source`);
    }

    const existingImportEdges = await findLean(WalkEdge, { scenicId, source: 'import' });
    const edgeSnapshot = wipe
        ? await findLean(WalkEdge, { scenicId })
        : existingImportEdges;
    const nodeSnapshot = wipe
        ? await findLean(WalkNode, { scenicId })
        : existingExpectedNodes;
    const affectedEdgeIds = [...new Set([
        ...edgeSnapshot.map(edge => String(edge.edgeId)),
        ...expectedEdgeIds
    ])];
    const affectedNodeIds = [...new Set([
        ...nodeSnapshot.map(node => String(node.nodeId)),
        ...expectedNodeIds
    ])];

    await applyWithBestAvailableAtomicity({
        WalkNode,
        WalkEdge,
        scenicId,
        wipe,
        plan,
        closedStates: closedStateByPhysicalEdge(existingImportEdges),
        affectedNodeIds,
        affectedEdgeIds,
        nodeSnapshot,
        edgeSnapshot
    });
    if (wipe) logger.log('[seed-walkgraph] wiped existing graph');

    const result = {
        nodes: plan.nodePlans.length,
        edges: plan.edgePlans.length,
        skippedLines: plan.skippedLines
    };
    logger.log(`[seed-walkgraph] nodes=${result.nodes} edges=${result.edges} skippedLines=${result.skippedLines}`);
    return result;
}

async function main(argv = process.argv.slice(2)) {
    const file = argv.find(argument => argument !== '--wipe');
    if (!file) throw new TypeError('Usage: node scripts/seed-walkgraph.js <walkgraph.geojson> [--wipe]');
    const geoJson = JSON.parse(fs.readFileSync(file, 'utf8'));
    const uri = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/poi';
    await mongoose.connect(uri);
    try {
        const { WalkNode, WalkEdge } = registerModels(mongoose);
        return await seedWalkGraphFeatures({
            features: geoJson.features || [],
            WalkNode,
            WalkEdge,
            wipe: argv.includes('--wipe')
        });
    } finally {
        await mongoose.disconnect();
    }
}

if (require.main === module) {
    main().catch(error => {
        console.error(error);
        process.exitCode = 1;
    });
}

module.exports = { seedWalkGraphFeatures, main };
