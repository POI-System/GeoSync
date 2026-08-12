'use strict';

const fs = require('fs');
const path = require('path');

const CONGESTION_VALUES = new Set(['smooth', 'busy', 'congested']);
const EDGE_STATUS_VALUES = new Set(['open', 'closed']);
const PHOTO_PATTERN = /^data:image\/(?:jpeg|png|webp);base64,[a-z0-9+/=]+$/i;
const MAX_PHOTO_LENGTH = 3 * 1024 * 1024;

function cleanText(value, maxLength) {
    return String(value ?? '').trim().slice(0, maxLength);
}

function validCoordinate(lng, lat) {
    return Number.isFinite(lng) && Number.isFinite(lat)
        && lng >= -180 && lng <= 180 && lat >= -90 && lat <= 90;
}

function normalizePhoto(value, { optional = true } = {}) {
    if (value === undefined && optional) return undefined;
    const photo = String(value || '');
    if (!photo) return '';
    if (photo.length > MAX_PHOTO_LENGTH || !PHOTO_PATTERN.test(photo)) {
        throw new Error('POI_PHOTO_INVALID');
    }
    return photo;
}

function normalizePoi(input, existing = null) {
    const name = cleanText(input?.name, 80);
    const lng = Number(input?.lng);
    const lat = Number(input?.lat);
    if (!name) throw new Error('POI_NAME_REQUIRED');
    if (!validCoordinate(lng, lat)) throw new Error('POI_COORDINATE_INVALID');
    const photo = normalizePhoto(input?.photo);
    return {
        poiId: existing?.poiId || `poi_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
        name,
        lng,
        lat,
        note: cleanText(input?.note, 500),
        photo: photo === undefined ? existing?.photo || '' : photo,
        category: cleanText(input?.category, 40) || existing?.category || '旅游景点',
        createdAt: existing?.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString()
    };
}

function normalizeEdgePatch(input) {
    const patch = {};
    if (input && Object.prototype.hasOwnProperty.call(input, 'status')) {
        const status = String(input.status || '');
        if (!EDGE_STATUS_VALUES.has(status)) throw new Error('EDGE_STATUS_INVALID');
        patch.status = status;
    }
    if (input && Object.prototype.hasOwnProperty.call(input, 'congestion')) {
        const congestion = String(input.congestion || '');
        if (!CONGESTION_VALUES.has(congestion)) throw new Error('EDGE_CONGESTION_INVALID');
        patch.congestion = congestion;
    }
    if (input && Object.prototype.hasOwnProperty.call(input, 'warning')) {
        patch.warning = cleanText(input.warning, 200);
    }
    if (!Object.keys(patch).length) throw new Error('EDGE_PATCH_EMPTY');
    patch.updatedAt = new Date().toISOString();
    return patch;
}

function safeState(value) {
    const pois = Array.isArray(value?.pois) ? value.pois.filter(item => item?.poiId && item?.name) : [];
    const edgeOverrides = value?.edgeOverrides && typeof value.edgeOverrides === 'object'
        && !Array.isArray(value.edgeOverrides) ? value.edgeOverrides : {};
    return { pois, edgeOverrides };
}

function createManagementStore({ filePath = path.resolve(__dirname, '../.cache/sjp-ops-state.json') } = {}) {
    let state = { pois: [], edgeOverrides: {} };
    try {
        if (fs.existsSync(filePath)) state = safeState(JSON.parse(fs.readFileSync(filePath, 'utf8')));
    } catch {
        state = { pois: [], edgeOverrides: {} };
    }

    function persist() {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    }

    return {
        listPois() {
            return state.pois.map(item => ({ ...item }));
        },
        createPoi(input) {
            const poi = normalizePoi(input);
            state.pois = [poi, ...state.pois];
            persist();
            return { ...poi };
        },
        updatePoi(poiId, input) {
            const index = state.pois.findIndex(item => item.poiId === String(poiId));
            if (index < 0) throw new Error('POI_NOT_FOUND');
            const poi = normalizePoi(input, state.pois[index]);
            state.pois[index] = poi;
            persist();
            return { ...poi };
        },
        deletePoi(poiId) {
            const before = state.pois.length;
            state.pois = state.pois.filter(item => item.poiId !== String(poiId));
            if (state.pois.length === before) throw new Error('POI_NOT_FOUND');
            persist();
            return { poiId: String(poiId), deleted: true };
        },
        updateEdge(edgeId, input) {
            const id = String(edgeId || '').trim();
            if (!id) throw new Error('EDGE_ID_REQUIRED');
            const patch = normalizeEdgePatch(input);
            state.edgeOverrides[id] = { ...(state.edgeOverrides[id] || {}), ...patch };
            persist();
            return { edgeId: id, ...state.edgeOverrides[id] };
        },
        applyGraph(graph) {
            return {
                ...graph,
                readOnly: false,
                sourceReadOnly: true,
                localManagement: true,
                edges: (graph?.edges || []).map(edge => ({
                    ...edge,
                    congestion: 'smooth',
                    warning: '',
                    ...(state.edgeOverrides[String(edge.edgeId)] || {})
                }))
            };
        }
    };
}

module.exports = {
    CONGESTION_VALUES,
    EDGE_STATUS_VALUES,
    MAX_PHOTO_LENGTH,
    createManagementStore,
    normalizeEdgePatch,
    normalizePoi
};
