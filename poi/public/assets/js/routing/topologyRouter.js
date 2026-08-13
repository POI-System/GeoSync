const MODES = new Set(['normal', 'shade', 'accessible']);
const DIRECTIONS = new Set(['both', 'forward', 'reverse']);
const POSITION_EPSILON = 1e-7;
const COST_EPSILON = 1e-9;

export class TopologyNetworkError extends Error {
    constructor(message, details = null) {
        super(message);
        this.name = 'TopologyNetworkError';
        this.details = details;
    }
}

function finiteNumber(value, label, { min = -Infinity, max = Infinity } = {}) {
    const number = Number(value);
    if (!Number.isFinite(number) || number < min || number > max) {
        throw new TopologyNetworkError(`${label} must be a finite number between ${min} and ${max}`);
    }
    return number;
}

function position(value, label) {
    if (!Array.isArray(value) || value.length < 2) {
        throw new TopologyNetworkError(`${label} must be an EPSG:4326 position`);
    }
    return [
        finiteNumber(value[0], `${label}[0]`, { min: -180, max: 180 }),
        finiteNumber(value[1], `${label}[1]`, { min: -90, max: 90 })
    ];
}

function samePosition(left, right) {
    return Math.abs(left[0] - right[0]) <= POSITION_EPSILON
        && Math.abs(left[1] - right[1]) <= POSITION_EPSILON;
}

function geometry(value, label) {
    const coordinates = value?.type === 'LineString' ? value.coordinates : value;
    if (!Array.isArray(coordinates) || coordinates.length < 2) {
        throw new TopologyNetworkError(`${label} must contain at least two positions`);
    }
    return coordinates.map((coordinate, index) => position(coordinate, `${label}[${index}]`));
}

function normalizedId(value, label) {
    const id = String(value ?? '').trim();
    if (!id) throw new TopologyNetworkError(`${label} is required`);
    return id;
}

function normalizedDirection(value) {
    const direction = String(value || 'both').trim().toLowerCase();
    if (!DIRECTIONS.has(direction)) {
        throw new TopologyNetworkError(`unsupported edge direction: ${direction}`);
    }
    return direction;
}

function normalizedBoolean(value, label) {
    if (typeof value !== 'boolean') throw new TopologyNetworkError(`${label} must be boolean`);
    return value;
}

function appendCoordinates(target, incoming) {
    if (!target.length) {
        target.push(...incoming.map(coordinate => [...coordinate]));
        return;
    }
    if (!samePosition(target[target.length - 1], incoming[0])) {
        throw new TopologyNetworkError('route segments are not geometrically continuous');
    }
    for (const coordinate of incoming.slice(1)) {
        if (!samePosition(target[target.length - 1], coordinate)) target.push([...coordinate]);
    }
}

function edgeWeight(edge, mode) {
    if (mode === 'accessible' && (edge.stairs || edge.accessible !== true)) return null;
    if (mode === 'shade') return edge.walkSec * (1.5 - edge.shade);
    return edge.walkSec;
}

function compareQueueItems(left, right) {
    const costDelta = left.cost - right.cost;
    if (Math.abs(costDelta) > COST_EPSILON) return costDelta;
    const pathOrder = left.pathKey.localeCompare(right.pathKey);
    if (pathOrder) return pathOrder;
    return left.nodeId.localeCompare(right.nodeId);
}

function betterCandidate(candidate, current) {
    if (!current) return true;
    const costDelta = candidate.cost - current.cost;
    if (costDelta < -COST_EPSILON) return true;
    if (Math.abs(costDelta) <= COST_EPSILON) return candidate.pathKey.localeCompare(current.pathKey) < 0;
    return false;
}

function reverseGeometry(coordinates) {
    return coordinates.slice().reverse().map(coordinate => [...coordinate]);
}

function normalizeNetwork(input) {
    if (!input || typeof input !== 'object') throw new TopologyNetworkError('network is required');
    if (!Array.isArray(input.nodes) || !Array.isArray(input.edges)) {
        throw new TopologyNetworkError('network nodes and edges must be arrays');
    }

    const nodes = new Map();
    for (const item of input.nodes) {
        const id = normalizedId(item?.id, 'node.id');
        if (nodes.has(id)) throw new TopologyNetworkError(`duplicate node id: ${id}`);
        nodes.set(id, { id, coordinate: position(item.coordinate, `node ${id} coordinate`) });
    }

    const edges = new Map();
    const adjacency = new Map([...nodes.keys()].map(id => [id, []]));
    for (const item of input.edges) {
        const id = normalizedId(item?.id, 'edge.id');
        if (edges.has(id)) throw new TopologyNetworkError(`duplicate edge id: ${id}`);
        const from = normalizedId(item.from, `edge ${id}.from`);
        const to = normalizedId(item.to, `edge ${id}.to`);
        if (!nodes.has(from) || !nodes.has(to)) {
            throw new TopologyNetworkError(`edge ${id} references a missing node`);
        }
        const coordinates = geometry(item.geometry, `edge ${id}.geometry`);
        if (!samePosition(coordinates[0], nodes.get(from).coordinate)
            || !samePosition(coordinates[coordinates.length - 1], nodes.get(to).coordinate)) {
            throw new TopologyNetworkError(`edge ${id} geometry endpoints do not match its topology nodes`);
        }
        const direction = normalizedDirection(item.direction);
        const sourceEdgeIds = Array.isArray(item.sourceEdgeIds) && item.sourceEdgeIds.length
            ? item.sourceEdgeIds.map((sourceId, index) => normalizedId(sourceId, `edge ${id}.sourceEdgeIds[${index}]`))
            : [id];
        const edge = {
            id,
            from,
            to,
            direction,
            distanceM: finiteNumber(item.distanceM, `edge ${id}.distanceM`, { min: 0 }),
            walkSec: finiteNumber(item.walkSec, `edge ${id}.walkSec`, { min: 0 }),
            shade: finiteNumber(item.shade ?? 0.5, `edge ${id}.shade`, { min: 0, max: 1 }),
            accessible: normalizedBoolean(item.accessible, `edge ${id}.accessible`),
            stairs: normalizedBoolean(item.stairs, `edge ${id}.stairs`),
            coordinates,
            sourceEdgeIds
        };
        edges.set(id, edge);

        const addArc = (arcFrom, arcTo, reversed) => adjacency.get(arcFrom).push({
            edge,
            from: arcFrom,
            to: arcTo,
            coordinates: reversed ? reverseGeometry(coordinates) : coordinates.map(coordinate => [...coordinate])
        });
        if (direction === 'both' || direction === 'forward') addArc(from, to, false);
        if (direction === 'both' || direction === 'reverse') addArc(to, from, true);
    }

    for (const arcs of adjacency.values()) {
        arcs.sort((left, right) => left.edge.id.localeCompare(right.edge.id) || left.to.localeCompare(right.to));
    }
    return { nodes, edges, adjacency };
}

function blockedSet(values) {
    if (values === undefined || values === null) return new Set();
    if (!Array.isArray(values) && !(values instanceof Set)) {
        throw new TopologyNetworkError('blockedEdgeIds must be an array or Set');
    }
    return new Set([...values].map(value => normalizedId(value, 'blocked edge id')));
}

function isBlocked(edge, blocked) {
    return blocked.has(edge.id) || edge.sourceEdgeIds.some(sourceId => blocked.has(sourceId));
}

function routeFailure({ mode, fromNodeId, toNodeId, failedLegIndex = 0 }) {
    return {
        found: false,
        reason: 'unreachable',
        code: 'NO_PATH',
        mode,
        fromNodeId,
        toNodeId,
        failedLegIndex,
        geometry: null,
        distanceM: null,
        durationSec: null,
        cost: null,
        nodeIds: [],
        edgeIds: [],
        sourceEdgeIds: [],
        segments: [],
        legs: []
    };
}

function reconstructRoute({ nodes, previous, fromNodeId, toNodeId, mode, cost }) {
    const arcs = [];
    let cursor = toNodeId;
    while (cursor !== fromNodeId) {
        const step = previous.get(cursor);
        if (!step) return routeFailure({ mode, fromNodeId, toNodeId });
        arcs.push(step.arc);
        cursor = step.previousNodeId;
    }
    arcs.reverse();

    const coordinates = [];
    const nodeIds = [fromNodeId];
    const edgeIds = [];
    const sourceEdgeIds = [];
    const segments = [];
    let distanceM = 0;
    let durationSec = 0;
    for (const arc of arcs) {
        appendCoordinates(coordinates, arc.coordinates);
        nodeIds.push(arc.to);
        edgeIds.push(arc.edge.id);
        sourceEdgeIds.push(...arc.edge.sourceEdgeIds);
        distanceM += arc.edge.distanceM;
        durationSec += arc.edge.walkSec;
        segments.push({
            edgeId: arc.edge.id,
            sourceEdgeIds: [...arc.edge.sourceEdgeIds],
            fromNodeId: arc.from,
            toNodeId: arc.to,
            distanceM: arc.edge.distanceM,
            durationSec: arc.edge.walkSec,
            geometry: { type: 'LineString', coordinates: arc.coordinates.map(coordinate => [...coordinate]) }
        });
    }
    if (!coordinates.length) {
        const coordinate = nodes.get(fromNodeId).coordinate;
        coordinates.push([...coordinate], [...coordinate]);
    }
    return {
        found: true,
        reason: null,
        code: null,
        mode,
        fromNodeId,
        toNodeId,
        geometry: { type: 'LineString', coordinates },
        distanceM,
        durationSec,
        cost,
        nodeIds,
        edgeIds,
        sourceEdgeIds,
        segments,
        accessibleVerified: mode === 'accessible'
            ? arcs.every(arc => arc.edge.accessible === true && arc.edge.stairs === false)
            : null
    };
}

function haversineMeters(left, right) {
    const radians = degrees => degrees * Math.PI / 180;
    const deltaLat = radians(right[1] - left[1]);
    const deltaLng = radians(right[0] - left[0]);
    const lat1 = radians(left[1]);
    const lat2 = radians(right[1]);
    const value = Math.sin(deltaLat / 2) ** 2
        + Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLng / 2) ** 2;
    return 6371000 * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
}

export function createTopologyRouter(network) {
    const normalized = normalizeNetwork(network);

    const routeBetween = (fromValue, toValue, { mode = 'normal', blockedEdgeIds = [] } = {}) => {
        const fromNodeId = normalizedId(fromValue, 'fromNodeId');
        const toNodeId = normalizedId(toValue, 'toNodeId');
        if (!normalized.nodes.has(fromNodeId) || !normalized.nodes.has(toNodeId)) {
            throw new TopologyNetworkError('route endpoint is not present in the graph');
        }
        if (!MODES.has(mode)) throw new TopologyNetworkError(`unsupported route mode: ${mode}`);
        const blocked = blockedSet(blockedEdgeIds);
        const best = new Map([[fromNodeId, { cost: 0, pathKey: '' }]]);
        const previous = new Map();
        const queue = [{ nodeId: fromNodeId, cost: 0, pathKey: '' }];

        while (queue.length) {
            queue.sort(compareQueueItems);
            const current = queue.shift();
            const known = best.get(current.nodeId);
            if (!known || Math.abs(known.cost - current.cost) > COST_EPSILON || known.pathKey !== current.pathKey) continue;
            if (current.nodeId === toNodeId) {
                return reconstructRoute({
                    nodes: normalized.nodes,
                    previous,
                    fromNodeId,
                    toNodeId,
                    mode,
                    cost: current.cost
                });
            }
            for (const arc of normalized.adjacency.get(current.nodeId)) {
                if (isBlocked(arc.edge, blocked)) continue;
                const weight = edgeWeight(arc.edge, mode);
                if (weight === null) continue;
                const candidate = {
                    nodeId: arc.to,
                    cost: current.cost + weight,
                    pathKey: `${current.pathKey}\u0000${arc.edge.id}`
                };
                if (!betterCandidate(candidate, best.get(arc.to))) continue;
                best.set(arc.to, { cost: candidate.cost, pathKey: candidate.pathKey });
                previous.set(arc.to, { previousNodeId: current.nodeId, arc });
                queue.push(candidate);
            }
        }
        return routeFailure({ mode, fromNodeId, toNodeId });
    };

    const routeThrough = (nodeValues, options = {}) => {
        if (!Array.isArray(nodeValues) || nodeValues.length < 2) {
            throw new TopologyNetworkError('routeThrough requires at least two node ids');
        }
        const waypointNodeIds = nodeValues.map((value, index) => normalizedId(value, `nodeValues[${index}]`));
        const legs = [];
        for (let index = 0; index < waypointNodeIds.length - 1; index++) {
            const leg = routeBetween(waypointNodeIds[index], waypointNodeIds[index + 1], options);
            if (!leg.found) {
                return routeFailure({
                    mode: options.mode || 'normal',
                    fromNodeId: waypointNodeIds[0],
                    toNodeId: waypointNodeIds[waypointNodeIds.length - 1],
                    failedLegIndex: index
                });
            }
            legs.push(leg);
        }

        const coordinates = [];
        const nodeIds = [];
        const edgeIds = [];
        const sourceEdgeIds = [];
        const segments = [];
        let distanceM = 0;
        let durationSec = 0;
        let cost = 0;
        for (const leg of legs) {
            appendCoordinates(coordinates, leg.geometry.coordinates);
            nodeIds.push(...(nodeIds.length ? leg.nodeIds.slice(1) : leg.nodeIds));
            edgeIds.push(...leg.edgeIds);
            sourceEdgeIds.push(...leg.sourceEdgeIds);
            segments.push(...leg.segments);
            distanceM += leg.distanceM;
            durationSec += leg.durationSec;
            cost += leg.cost;
        }
        return {
            found: true,
            reason: null,
            code: null,
            mode: options.mode || 'normal',
            fromNodeId: waypointNodeIds[0],
            toNodeId: waypointNodeIds[waypointNodeIds.length - 1],
            waypointNodeIds,
            geometry: { type: 'LineString', coordinates },
            distanceM,
            durationSec,
            cost,
            nodeIds,
            edgeIds,
            sourceEdgeIds,
            segments,
            legs,
            accessibleVerified: (options.mode || 'normal') === 'accessible'
                ? legs.every(leg => leg.accessibleVerified === true)
                : null
        };
    };

    const nearestNode = coordinateValue => {
        const coordinate = position(coordinateValue, 'coordinate');
        let nearest = null;
        for (const node of normalized.nodes.values()) {
            const distanceM = haversineMeters(coordinate, node.coordinate);
            if (!nearest || distanceM < nearest.distanceM - COST_EPSILON
                || (Math.abs(distanceM - nearest.distanceM) <= COST_EPSILON && node.id.localeCompare(nearest.nodeId) < 0)) {
                nearest = { nodeId: node.id, coordinate: [...node.coordinate], distanceM };
            }
        }
        return nearest;
    };

    return Object.freeze({
        routeBetween,
        routeThrough,
        nearestNode,
        nodeCoordinate(nodeId) {
            const node = normalized.nodes.get(normalizedId(nodeId, 'nodeId'));
            return node ? [...node.coordinate] : null;
        }
    });
}
