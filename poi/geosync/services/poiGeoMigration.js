'use strict';

const {
    DEFAULT_SCENIC_ID,
    isValidGeoPoint,
    pointFromLocation,
    visitMetaDefaults
} = require('./hostPoiSchema');

const NUMERIC_VISIT_FIELDS = new Set([
    'capacity', 'dwellMin', 'suggestedStayMin', 'baselineStayMin', 'comfortCapacity'
]);
const BOOLEAN_VISIT_FIELDS = new Set([
    'accessible', 'ticketRequired', 'sheltered'
]);

function toPlain(value) {
    return value?.toObject ? value.toObject() : value;
}

function clone(value) {
    if (value === undefined) return undefined;
    return JSON.parse(JSON.stringify(value));
}

function safePoiId(value, index) {
    const text = String(value ?? '').trim();
    return text ? text.slice(0, 128) : `index:${index}`;
}

function migrationError(index, poiId, code, message) {
    return {
        ...(Number.isInteger(index) ? { index } : {}),
        poiId,
        code,
        message
    };
}

function validSuperMapRef(value) {
    return Boolean(value
        && typeof value === 'object'
        && !Array.isArray(value)
        && typeof value.datasetName === 'string'
        && value.datasetName.trim()
        && Number.isSafeInteger(Number(value.smId))
        && Number(value.smId) >= 0
        && typeof value.dataVersion === 'string'
        && value.dataVersion.trim());
}

function deferredFields(poi) {
    const deferred = [];
    if (typeof poi?.gateNodeId !== 'string' || !poi.gateNodeId.trim()) {
        deferred.push('gateNodeId');
    }
    if (!validSuperMapRef(poi?.superMapRef)) deferred.push('superMapRef');
    return deferred;
}

function validClockText(value) {
    if (typeof value !== 'string' || !/^\d{2}:\d{2}$/.test(value)) return false;
    const [hours, minutes] = value.split(':').map(Number);
    return hours >= 0 && hours <= 23 && minutes >= 0 && minutes <= 59;
}

function visitMetaError(visitMeta, index, poiId) {
    if (visitMeta === undefined || visitMeta === null) return null;
    if (typeof visitMeta !== 'object' || Array.isArray(visitMeta)) {
        return migrationError(index, poiId, 'INVALID_VISIT_META', 'visitMeta must be an object');
    }

    for (const field of NUMERIC_VISIT_FIELDS) {
        if (visitMeta[field] === undefined) continue;
        const value = Number(visitMeta[field]);
        if (!Number.isFinite(value) || value < 0) {
            return migrationError(
                index,
                poiId,
                'INVALID_VISIT_META_NUMBER',
                `visitMeta.${field} must be a non-negative number`
            );
        }
    }
    for (const field of BOOLEAN_VISIT_FIELDS) {
        if (visitMeta[field] !== undefined && typeof visitMeta[field] !== 'boolean') {
            return migrationError(
                index,
                poiId,
                'INVALID_VISIT_META_BOOLEAN',
                `visitMeta.${field} must be a boolean`
            );
        }
    }
    if (visitMeta.category !== undefined && typeof visitMeta.category !== 'string') {
        return migrationError(index, poiId, 'INVALID_VISIT_META_CATEGORY',
            'visitMeta.category must be a string');
    }
    if (visitMeta.scenicId !== undefined
        && (typeof visitMeta.scenicId !== 'string' || !visitMeta.scenicId.trim())) {
        return migrationError(index, poiId, 'INVALID_VISIT_META_SCENIC_ID',
            'visitMeta.scenicId must be a non-empty string');
    }
    if (visitMeta.tags !== undefined
        && (!Array.isArray(visitMeta.tags) || visitMeta.tags.some(tag => typeof tag !== 'string'))) {
        return migrationError(index, poiId, 'INVALID_VISIT_META_TAGS',
            'visitMeta.tags must be an array of strings');
    }
    if (visitMeta.openHours !== undefined) {
        const valid = Array.isArray(visitMeta.openHours) && visitMeta.openHours.every(window =>
            window && typeof window === 'object'
            && validClockText(window.start)
            && validClockText(window.end));
        if (!valid) {
            return migrationError(index, poiId, 'INVALID_VISIT_META_OPEN_HOURS',
                'visitMeta.openHours must be an array of HH:mm start/end windows');
        }
    }
    return null;
}

function planPoi(poiValue, index, scenicId) {
    const poi = toPlain(poiValue);
    const poiId = safePoiId(poi?._id, index);
    if (!poi || typeof poi !== 'object' || Array.isArray(poi)) {
        return {
            status: 'failed',
            error: migrationError(index, poiId, 'INVALID_POI', 'POI must be an object')
        };
    }

    const deferred = deferredFields(poi);
    const metaError = visitMetaError(poi.visitMeta, index, poiId);
    if (metaError) return { status: 'failed', error: metaError, deferred };

    const patch = {};
    if (!isValidGeoPoint(poi.geo)) {
        const point = pointFromLocation(poi.location);
        if (!point) {
            return {
                status: 'failed',
                deferred,
                error: migrationError(
                    index,
                    poiId,
                    'INVALID_LOCATION',
                    'POI requires a valid WGS84 location or geo point'
                )
            };
        }
        patch.geo = point;
    }

    const visitMeta = poi.visitMeta && typeof poi.visitMeta === 'object'
        ? poi.visitMeta
        : null;
    const defaults = visitMetaDefaults({
        category: poi.category,
        scenicId,
        existing: visitMeta || {}
    });
    if (!visitMeta) {
        patch.visitMeta = defaults;
    } else {
        for (const [field, value] of Object.entries(defaults)) {
            if (visitMeta[field] === undefined) {
                patch[`visitMeta.${field}`] = clone(value);
            }
        }
    }

    if (!Object.keys(patch).length) return { status: 'skipped', poiId, deferred };

    const snapshotKeys = new Set(Object.keys(patch).map(key => key.split('.')[0]));
    if (snapshotKeys.has('geo')) snapshotKeys.add('location');
    if (snapshotKeys.has('visitMeta')) snapshotKeys.add('category');
    return {
        status: 'planned',
        poiId,
        deferred,
        operation: {
            poiId,
            documentId: poi._id,
            patch,
            snapshot: Object.fromEntries([...snapshotKeys].map(key => [key, clone(poi[key])]))
        }
    };
}

function planPoiGeoMigration({ pois, scenicId = DEFAULT_SCENIC_ID }) {
    if (!Array.isArray(pois)) throw new TypeError('pois must be an array');
    const normalizedScenicId = String(scenicId || DEFAULT_SCENIC_ID).trim() || DEFAULT_SCENIC_ID;
    const operations = [];
    const items = [];
    const errors = [];
    let skipped = 0;
    let gateNodeIdDeferred = 0;
    let superMapRefDeferred = 0;

    for (let index = 0; index < pois.length; index++) {
        const planned = planPoi(pois[index], index, normalizedScenicId);
        if (planned.deferred?.includes('gateNodeId')) gateNodeIdDeferred++;
        if (planned.deferred?.includes('superMapRef')) superMapRefDeferred++;
        if (planned.status === 'failed') {
            errors.push(planned.error);
            items.push({
                poiId: planned.error.poiId,
                status: 'failed',
                deferred: planned.deferred,
                error: planned.error
            });
        } else if (planned.status === 'skipped') {
            skipped++;
            items.push({ poiId: planned.poiId, status: 'skipped', deferred: planned.deferred });
        } else {
            operations.push(planned.operation);
            items.push({ poiId: planned.poiId, status: 'planned', deferred: planned.deferred });
        }
    }

    return {
        operations,
        items,
        errors,
        summary: {
            total: pois.length,
            success: operations.length,
            skipped,
            failed: errors.length,
            gateNodeIdDeferred,
            superMapRefDeferred
        }
    };
}

function conditionalFilter(operation) {
    const filter = { _id: operation.documentId };
    for (const [field, value] of Object.entries(operation.snapshot)) {
        filter[field] = value === undefined ? { $exists: false } : value;
    }
    return filter;
}

function matchedCount(result) {
    const value = result?.matchedCount ?? result?.n ?? result?.result?.n ?? 0;
    return Number.isFinite(Number(value)) ? Number(value) : 0;
}

async function leanResult(query) {
    if (query && typeof query.lean === 'function') return query.lean();
    return query;
}

async function findOneLean(POI, documentId) {
    if (typeof POI.findOne !== 'function') return null;
    return leanResult(POI.findOne(
        { _id: documentId },
        {
            _id: 1,
            category: 1,
            location: 1,
            geo: 1,
            visitMeta: 1,
            gateNodeId: 1,
            superMapRef: 1
        }
    ));
}

async function runPoiGeoMigration({
    POI,
    apply = false,
    scenicId = DEFAULT_SCENIC_ID
}) {
    if (!POI || typeof POI.find !== 'function' || typeof POI.updateOne !== 'function') {
        throw new TypeError('POI model with find and updateOne is required');
    }
    const pois = await leanResult(POI.find(
        {},
        {
            _id: 1,
            category: 1,
            location: 1,
            geo: 1,
            visitMeta: 1,
            gateNodeId: 1,
            superMapRef: 1
        }
    ));
    const plan = planPoiGeoMigration({ pois, scenicId });
    if (!apply) return { mode: 'dry-run', ...plan };

    const errors = [...plan.errors];
    const items = plan.items.filter(item => item.status !== 'planned');
    let success = 0;
    let skipped = plan.summary.skipped;

    for (const operation of plan.operations) {
        try {
            const result = await POI.updateOne(
                conditionalFilter(operation),
                { $set: operation.patch }
            );
            if (matchedCount(result) > 0) {
                success++;
                items.push({ poiId: operation.poiId, status: 'updated' });
                continue;
            }

            const current = await findOneLean(POI, operation.documentId);
            if (current) {
                const currentPlan = planPoi(current, 0, scenicId);
                if (currentPlan.status === 'skipped') {
                    skipped++;
                    items.push({ poiId: operation.poiId, status: 'skipped' });
                    continue;
                }
            }
            const error = migrationError(
                null,
                operation.poiId,
                current ? 'CONCURRENT_CHANGE' : 'POI_NOT_FOUND',
                current
                    ? 'POI changed after migration planning'
                    : 'POI was removed after migration planning'
            );
            errors.push(error);
            items.push({ poiId: operation.poiId, status: 'failed', error });
        } catch (_error) {
            const error = migrationError(
                null,
                operation.poiId,
                'WRITE_FAILED',
                'Conditional POI update failed'
            );
            errors.push(error);
            items.push({ poiId: operation.poiId, status: 'failed', error });
        }
    }

    return {
        mode: 'apply',
        operations: plan.operations,
        items,
        errors,
        summary: {
            total: plan.summary.total,
            success,
            skipped,
            failed: errors.length,
            gateNodeIdDeferred: plan.summary.gateNodeIdDeferred,
            superMapRefDeferred: plan.summary.superMapRefDeferred
        }
    };
}

module.exports = {
    planPoiGeoMigration,
    runPoiGeoMigration
};
