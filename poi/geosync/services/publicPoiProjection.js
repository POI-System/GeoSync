'use strict';

function finiteCoordinate(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

function serializePublicPoi(item = {}) {
    const rawLocation = item.location && typeof item.location === 'object'
        ? item.location
        : {};
    const lng = finiteCoordinate(rawLocation.lng);
    const lat = finiteCoordinate(rawLocation.lat);
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
        status: 'approved',
        createTime: item.createTime
    };
}

module.exports = { serializePublicPoi };
