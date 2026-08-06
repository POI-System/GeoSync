'use strict';

function finiteCoordinate(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

function finiteNonNegative(value) {
    if (typeof value !== 'number' && typeof value !== 'string') {
        return null;
    }
    if (typeof value === 'string' && value.trim() === '') {
        return null;
    }
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : null;
}

function serializePublicPoi(item = {}) {
    const rawLocation = item.location && typeof item.location === 'object'
        ? item.location
        : {};
    const rawVisitMeta = item.visitMeta && typeof item.visitMeta === 'object'
        ? item.visitMeta
        : {};
    const lng = finiteCoordinate(rawLocation.lng);
    const lat = finiteCoordinate(rawLocation.lat);
    const suggestedStayMin = finiteNonNegative(rawVisitMeta.suggestedStayMin)
        ?? finiteNonNegative(rawVisitMeta.dwellMin)
        ?? 20;
    return {
        id: String(item._id),
        _id: String(item._id),
        poiName: item.poiName || '',
        name: item.poiName || '',
        category: item.category || '',
        description: item.description || '',
        imageUrl: item.imageUrl || '',
        lng,
        lat,
        location: { lng, lat },
        suggestedStayMin,
        status: 'approved',
        createTime: item.createTime
    };
}

module.exports = { serializePublicPoi };
