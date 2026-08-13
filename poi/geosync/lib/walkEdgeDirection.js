'use strict';

const WALK_EDGE_DIRECTIONS = new Set(['forward', 'reverse', 'both']);

function normalizeWalkEdgeDirection(value) {
    if (value === undefined || value === null) return 'both';
    if (typeof value !== 'string') return null;

    const direction = value.trim().toLowerCase();
    if (!direction) return 'both';
    return WALK_EDGE_DIRECTIONS.has(direction) ? direction : null;
}

function expandWalkEdgeDirections({ from, to, coordinates, direction }) {
    const normalizedDirection = normalizeWalkEdgeDirection(direction);
    if (!normalizedDirection || !Array.isArray(coordinates)) return null;

    const forwardGeometry = coordinates.map(coordinate => [...coordinate]);
    const reverseGeometry = [...forwardGeometry].reverse();
    const forward = {
        from,
        to,
        geometry: forwardGeometry,
        edgeIdSuffix: '',
        traversalDirection: 'forward'
    };
    const reverse = {
        from: to,
        to: from,
        geometry: reverseGeometry,
        edgeIdSuffix: '_r',
        traversalDirection: 'reverse'
    };

    if (normalizedDirection === 'forward') return [forward];
    if (normalizedDirection === 'reverse') return [reverse];
    return [forward, reverse];
}

module.exports = {
    normalizeWalkEdgeDirection,
    expandWalkEdgeDirections
};
