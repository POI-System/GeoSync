'use strict';

const EXTENSION_MARK = Symbol.for('poi.geosync.hostPoiSchema');
const DEFAULT_SCENIC_ID = 'default';
const CLOCK_TEXT_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

function finiteNumber(value) {
    if (value === '' || value === null || value === undefined) return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

function pointFromLocation(location) {
    if (!location || typeof location !== 'object') return null;
    const lng = finiteNumber(location.lng);
    const lat = finiteNumber(location.lat);
    if (lng === null || lat === null || lng < -180 || lng > 180 || lat < -90 || lat > 90) {
        return null;
    }
    return { type: 'Point', coordinates: [lng, lat] };
}

function isValidGeoPoint(value) {
    if (!value || value.type !== 'Point') return false;
    const coordinates = Array.isArray(value.coordinates)
        ? value.coordinates
        : Array.from(value.coordinates || []);
    if (coordinates.length !== 2) return false;
    const lng = finiteNumber(coordinates[0]);
    const lat = finiteNumber(coordinates[1]);
    return lng !== null && lat !== null
        && lng >= -180 && lng <= 180
        && lat >= -90 && lat <= 90;
}

function positiveNumber(value, fallback) {
    const number = finiteNumber(value);
    return number !== null && number > 0 ? number : fallback;
}

function nonNegativeNumber(value, fallback) {
    const number = finiteNumber(value);
    return number !== null && number >= 0 ? number : fallback;
}

function validClockText(value) {
    return typeof value === 'string' && CLOCK_TEXT_PATTERN.test(value);
}

function visitMetaDefaults({ category = '', scenicId = DEFAULT_SCENIC_ID, existing = {} } = {}) {
    const source = existing && typeof existing === 'object' && !Array.isArray(existing)
        ? existing
        : {};
    const dwellMin = positiveNumber(source.dwellMin ?? source.suggestedStayMin, 20);
    const capacity = nonNegativeNumber(source.capacity ?? source.comfortCapacity, 50);
    return {
        category: String(source.category ?? category ?? '').trim(),
        capacity,
        dwellMin,
        openHours: [],
        accessible: false,
        scenicId: String(source.scenicId ?? scenicId ?? DEFAULT_SCENIC_ID).trim() || DEFAULT_SCENIC_ID,
        suggestedStayMin: dwellMin,
        baselineStayMin: 0,
        comfortCapacity: capacity,
        ticketRequired: false,
        sheltered: false,
        tags: []
    };
}

function addHostPoiGeoSyncFields(schema) {
    if (!schema || typeof schema.add !== 'function' || typeof schema.pre !== 'function') {
        throw new TypeError('A Mongoose POI schema is required');
    }
    if (schema[EXTENSION_MARK]) return schema;

    const Schema = schema.base?.Schema;
    if (!Schema) throw new TypeError('The POI schema must belong to a Mongoose instance');

    const openHourSchema = new Schema({
        start: {
            type: String,
            required: true,
            trim: true,
            match: [CLOCK_TEXT_PATTERN, 'visitMeta.openHours.start must use 24-hour HH:mm']
        },
        end: {
            type: String,
            required: true,
            trim: true,
            match: [CLOCK_TEXT_PATTERN, 'visitMeta.openHours.end must use 24-hour HH:mm']
        }
    }, { _id: false });
    const pointSchema = new Schema({
        type: { type: String, enum: ['Point'], default: 'Point' },
        coordinates: {
            type: [Number],
            required: true,
            validate: {
                validator: coordinates => isValidGeoPoint({ type: 'Point', coordinates }),
                message: 'geo.coordinates must be a WGS84 [lng, lat] pair'
            }
        }
    }, { _id: false });
    const visitMetaSchema = new Schema({
        category: { type: String, default: '', trim: true },
        capacity: { type: Number, default: 50, min: 0 },
        dwellMin: { type: Number, default: 20, min: 0 },
        openHours: {
            type: [openHourSchema],
            default: [],
            validate: {
                validator: windows => Array.isArray(windows) && windows.every(window =>
                    window && validClockText(window.start) && validClockText(window.end)),
                message: 'visitMeta.openHours entries must contain 24-hour HH:mm start/end values'
            }
        },
        accessible: { type: Boolean, default: false },
        scenicId: { type: String, default: DEFAULT_SCENIC_ID, trim: true },
        suggestedStayMin: { type: Number, default: 20, min: 0 },
        baselineStayMin: { type: Number, default: 0, min: 0 },
        comfortCapacity: { type: Number, default: 50, min: 0 },
        ticketRequired: { type: Boolean, default: false },
        sheltered: { type: Boolean, default: false },
        tags: { type: [String], default: [] }
    }, { _id: false });
    const superMapRefSchema = new Schema({
        datasetName: { type: String, trim: true },
        smId: { type: Number, min: 0 },
        dataVersion: { type: String, trim: true }
    }, { _id: false });

    schema.add({
        geo: { type: pointSchema, default: undefined },
        visitMeta: { type: visitMetaSchema, default: () => ({}) },
        gateNodeId: { type: String, default: '', trim: true },
        superMapRef: { type: superMapRefSchema, default: undefined }
    });
    schema.index({ geo: '2dsphere' }, { sparse: true });
    schema.index({ status: 1, 'visitMeta.tags': 1 });

    schema.pre('validate', function syncGeoSyncPoiFields() {
        const point = pointFromLocation(this.location);
        if (point && (this.isNew || this.isModified('location') || !isValidGeoPoint(this.geo))) {
            this.geo = point;
        }
        if (this.visitMeta && !String(this.visitMeta.category || '').trim() && this.category) {
            this.visitMeta.category = String(this.category).trim();
        }
    });

    Object.defineProperty(schema, EXTENSION_MARK, { value: true });
    return schema;
}

module.exports = {
    DEFAULT_SCENIC_ID,
    addHostPoiGeoSyncFields,
    isValidGeoPoint,
    pointFromLocation,
    visitMetaDefaults
};
