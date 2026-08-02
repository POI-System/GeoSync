'use strict';

const ALLOWED_MAPPING_FIELDS = new Set([
    'edgeId', 'datasetName', 'smId', 'sourceId', 'dataVersion'
]);
const SOURCE_REF_FIELDS = ['datasetName', 'smId', 'sourceId', 'dataVersion'];
const MAX_STRING_LENGTH = 256;

class SuperMapRefMappingError extends Error {
    constructor(errors, total = 0) {
        super('SuperMap sourceRef mapping is invalid');
        this.name = 'SuperMapRefMappingError';
        this.code = 'INVALID_SUPERMAP_REF_MAPPING';
        this.errors = errors;
        this.summary = {
            total,
            success: 0,
            skipped: 0,
            failed: errors.length
        };
    }
}

function normalizeMappingArray(value) {
    if (!Array.isArray(value) || value.length === 0) {
        throw new SuperMapRefMappingError([mappingError(
            null,
            '',
            'MAPPING_ARRAY_REQUIRED',
            'mapping must be a non-empty JSON array'
        )], Array.isArray(value) ? value.length : 0);
    }

    const errors = [];
    const normalized = [];
    for (let index = 0; index < value.length; index++) {
        try {
            normalized.push(normalizeMapping(value[index], index));
        } catch (error) {
            errors.push(error);
        }
    }

    const firstByEdgeId = new Map();
    for (const mapping of normalized) {
        const previous = firstByEdgeId.get(mapping.edgeId);
        if (!previous) {
            firstByEdgeId.set(mapping.edgeId, mapping);
            continue;
        }
        const sameTarget = sourceRefsEqual(sourceRefOf(previous), sourceRefOf(mapping));
        errors.push(mappingError(
            mapping.index,
            mapping.edgeId,
            sameTarget ? 'DUPLICATE_EDGE_ID' : 'CONFLICTING_EDGE_ID',
            sameTarget
                ? 'edgeId is mapped more than once'
                : 'edgeId has conflicting sourceRef mappings'
        ));
    }

    if (errors.length) throw new SuperMapRefMappingError(errors, value.length);
    return normalized;
}

function normalizeMapping(value, index) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw mappingError(index, '', 'INVALID_MAPPING_ENTRY', 'mapping entry must be an object');
    }
    if (Object.keys(value).some(key => !ALLOWED_MAPPING_FIELDS.has(key))) {
        throw mappingError(index, safeEdgeId(value.edgeId), 'UNKNOWN_MAPPING_FIELD',
            'mapping entry contains unsupported fields');
    }

    const edgeId = requiredString(value.edgeId, 'edgeId', index, '');
    const datasetName = requiredString(value.datasetName, 'datasetName', index, edgeId);
    if (!Number.isSafeInteger(value.smId) || value.smId < 0) {
        throw mappingError(index, edgeId, 'INVALID_SM_ID', 'smId must be a non-negative integer');
    }
    const dataVersion = requiredString(value.dataVersion, 'dataVersion', index, edgeId);
    const sourceId = Object.prototype.hasOwnProperty.call(value, 'sourceId')
        ? requiredString(value.sourceId, 'sourceId', index, edgeId)
        : null;

    return {
        index,
        edgeId,
        datasetName,
        smId: value.smId,
        ...(sourceId ? { sourceId } : {}),
        dataVersion
    };
}

function requiredString(value, field, index, edgeId) {
    if (typeof value !== 'string') {
        throw mappingError(index, edgeId, `INVALID_${field.toUpperCase()}`,
            `${field} must be a non-empty string`);
    }
    const normalized = value.trim();
    if (!normalized || normalized.length > MAX_STRING_LENGTH) {
        throw mappingError(index, edgeId, `INVALID_${field.toUpperCase()}`,
            `${field} must be a non-empty string of at most ${MAX_STRING_LENGTH} characters`);
    }
    return normalized;
}

function mappingError(index, edgeId, code, message) {
    return {
        ...(Number.isInteger(index) ? { index } : {}),
        ...(edgeId ? { edgeId } : {}),
        code,
        message
    };
}

function safeEdgeId(value) {
    return typeof value === 'string' ? value.trim().slice(0, MAX_STRING_LENGTH) : '';
}

function sourceRefOf(mapping) {
    return {
        datasetName: mapping.datasetName,
        smId: mapping.smId,
        ...(mapping.sourceId ? { sourceId: mapping.sourceId } : {}),
        dataVersion: mapping.dataVersion
    };
}

function toPlain(value) {
    return value?.toObject ? value.toObject() : value;
}

function snapshotSourceRef(value) {
    const plain = toPlain(value);
    if (!plain || typeof plain !== 'object' || Array.isArray(plain)) return null;
    const snapshot = {};
    for (const field of SOURCE_REF_FIELDS) {
        if (plain[field] !== undefined) snapshot[field] = plain[field];
    }
    return Object.keys(snapshot).length ? snapshot : null;
}

function canonicalExistingSourceRef(value) {
    const plain = snapshotSourceRef(value);
    if (!plain) return null;
    const datasetName = typeof plain.datasetName === 'string' ? plain.datasetName.trim() : '';
    const dataVersion = typeof plain.dataVersion === 'string' ? plain.dataVersion.trim() : '';
    const sourceId = typeof plain.sourceId === 'string' ? plain.sourceId.trim() : '';
    if (!datasetName || !Number.isSafeInteger(plain.smId) || plain.smId < 0 || !dataVersion) {
        return null;
    }
    return {
        datasetName,
        smId: plain.smId,
        ...(sourceId ? { sourceId } : {}),
        dataVersion
    };
}

function sourceRefsEqual(left, right) {
    const normalizedLeft = canonicalExistingSourceRef(left);
    const normalizedRight = canonicalExistingSourceRef(right);
    if (!normalizedLeft || !normalizedRight) return false;
    return SOURCE_REF_FIELDS.every(field =>
        (normalizedLeft[field] ?? null) === (normalizedRight[field] ?? null));
}

function planSuperMapRefMigration({ mappings, existingEdges }) {
    const normalizedMappings = normalizeMappingArray(mappings);
    if (!Array.isArray(existingEdges)) {
        throw new TypeError('existingEdges must be an array');
    }

    const existingByEdgeId = new Map();
    for (const value of existingEdges) {
        const edge = toPlain(value);
        const edgeId = safeEdgeId(edge?.edgeId);
        if (edgeId && !existingByEdgeId.has(edgeId)) existingByEdgeId.set(edgeId, edge);
    }

    const operations = [];
    const errors = [];
    const items = [];
    let skipped = 0;

    for (const mapping of normalizedMappings) {
        const edge = existingByEdgeId.get(mapping.edgeId);
        if (!edge) {
            const error = mappingError(
                mapping.index,
                mapping.edgeId,
                'EDGE_NOT_FOUND',
                'WalkEdge was not found'
            );
            errors.push(error);
            items.push({ edgeId: mapping.edgeId, status: 'failed', error });
            continue;
        }

        const targetSourceRef = sourceRefOf(mapping);
        if (sourceRefsEqual(edge.sourceRef, targetSourceRef)) {
            skipped++;
            items.push({ edgeId: mapping.edgeId, status: 'skipped' });
            continue;
        }

        const operation = {
            edgeId: mapping.edgeId,
            documentId: edge._id,
            currentSourceRef: snapshotSourceRef(edge.sourceRef),
            targetSourceRef
        };
        operations.push(operation);
        items.push({ edgeId: mapping.edgeId, status: 'planned' });
    }

    return {
        mappings: normalizedMappings,
        operations,
        items,
        errors,
        summary: {
            total: normalizedMappings.length,
            success: operations.length,
            skipped,
            failed: errors.length
        }
    };
}

async function runSuperMapRefMigration({ WalkEdge, mappings, apply = false }) {
    if (!WalkEdge || typeof WalkEdge.find !== 'function' || typeof WalkEdge.updateOne !== 'function') {
        throw new TypeError('WalkEdge model with find and updateOne is required');
    }
    const normalizedMappings = normalizeMappingArray(mappings);
    const edgeIds = normalizedMappings.map(mapping => mapping.edgeId);
    const existingEdges = await leanResult(WalkEdge.find(
        { edgeId: { $in: edgeIds } },
        { _id: 1, edgeId: 1, sourceRef: 1 }
    ));
    const plan = buildPlanFromNormalized(normalizedMappings, existingEdges);

    if (!apply) return { mode: 'dry-run', ...plan };

    const errors = [...plan.errors];
    const items = plan.items.filter(item => item.status !== 'planned');
    let success = 0;
    let skipped = plan.summary.skipped;

    for (const operation of plan.operations) {
        try {
            const result = await WalkEdge.updateOne(
                conditionalFilter(operation),
                { $set: { sourceRef: operation.targetSourceRef } }
            );
            if (matchedCount(result) > 0) {
                success++;
                items.push({ edgeId: operation.edgeId, status: 'updated' });
                continue;
            }

            const current = await findOneLean(WalkEdge, operation.edgeId);
            if (current && sourceRefsEqual(current.sourceRef, operation.targetSourceRef)) {
                skipped++;
                items.push({ edgeId: operation.edgeId, status: 'skipped' });
                continue;
            }
            const error = mappingError(
                null,
                operation.edgeId,
                current ? 'CONCURRENT_CHANGE' : 'EDGE_NOT_FOUND',
                current
                    ? 'WalkEdge sourceRef changed after planning'
                    : 'WalkEdge was removed after planning'
            );
            errors.push(error);
            items.push({ edgeId: operation.edgeId, status: 'failed', error });
        } catch (_error) {
            const error = mappingError(
                null,
                operation.edgeId,
                'WRITE_FAILED',
                'Conditional sourceRef update failed'
            );
            errors.push(error);
            items.push({ edgeId: operation.edgeId, status: 'failed', error });
        }
    }

    return {
        mode: 'apply',
        mappings: plan.mappings,
        operations: plan.operations,
        items,
        errors,
        summary: {
            total: plan.summary.total,
            success,
            skipped,
            failed: errors.length
        }
    };
}

function buildPlanFromNormalized(normalizedMappings, existingEdges) {
    const mappings = normalizedMappings.map(mapping => ({
        edgeId: mapping.edgeId,
        datasetName: mapping.datasetName,
        smId: mapping.smId,
        ...(mapping.sourceId ? { sourceId: mapping.sourceId } : {}),
        dataVersion: mapping.dataVersion
    }));
    return planSuperMapRefMigration({ mappings, existingEdges });
}

function conditionalFilter(operation) {
    return {
        ...(operation.documentId != null ? { _id: operation.documentId } : {}),
        edgeId: operation.edgeId,
        sourceRef: operation.currentSourceRef
    };
}

function matchedCount(result) {
    const value = result?.matchedCount ?? result?.n ?? result?.result?.n ?? 0;
    return Number.isFinite(Number(value)) ? Number(value) : 0;
}

async function findOneLean(WalkEdge, edgeId) {
    if (typeof WalkEdge.findOne !== 'function') return null;
    return leanResult(WalkEdge.findOne(
        { edgeId },
        { _id: 1, edgeId: 1, sourceRef: 1 }
    ));
}

async function leanResult(query) {
    if (query && typeof query.lean === 'function') return query.lean();
    return query;
}

module.exports = {
    SuperMapRefMappingError,
    normalizeMappingArray,
    planSuperMapRefMigration,
    runSuperMapRefMigration,
    sourceRefsEqual
};
