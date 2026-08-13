'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    normalizeClosedBarrier,
    loadClosedBarrierSnapshot,
    barrierFingerprint,
    routeAvoidsBarriers,
    remainingRouteUsesEdge,
    createBarrierRerouteCoordinator
} = require('../../services/barrierReroute');
const { rebuildTimeline } = require('../../services/itineraryTimeline');

const NOW = new Date('2026-08-02T06:00:00.000Z');

function leanQuery(value) {
    return { lean: async () => value };
}

function eventRecordMatches(record, filter) {
    if (!record) return false;
    for (const [key, expected] of Object.entries(filter || {})) {
        if (key === '$or') {
            if (!expected.some(condition => eventRecordMatches(record, condition))) return false;
            continue;
        }
        if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
            if ('$lte' in expected) {
                if (new Date(record[key] || 0).getTime() > new Date(expected.$lte).getTime()) return false;
                continue;
            }
        }
        if (record[key] !== expected) return false;
    }
    return true;
}

function createBarrierEventModel(records = new Map()) {
    return {
        records,
        findOne(filter) {
            const record = records.get(filter.eventId);
            return leanQuery(record ? structuredClone(record) : null);
        },
        async findOneAndUpdate(filter, update, options = {}) {
            let record = records.get(filter.eventId) || null;
            const matched = eventRecordMatches(record, filter);
            if (!matched) {
                if (!options.upsert) return null;
                if (record) {
                    const error = new Error('duplicate eventId');
                    error.code = 11000;
                    error.codeName = 'DuplicateKey';
                    throw error;
                }
                record = {
                    eventId: filter.eventId,
                    payloadHash: filter.payloadHash,
                    ...(update.$setOnInsert || {})
                };
            }
            if (update.$set) Object.assign(record, structuredClone(update.$set));
            for (const [key, value] of Object.entries(update.$inc || {})) {
                record[key] = Number(record[key] || 0) + Number(value);
            }
            records.set(record.eventId, record);
            return structuredClone(record);
        }
    };
}

function edge(edgeId, datasetName = 'walk_edges_test', smId = 1, physicalEdgeId = edgeId) {
    return {
        scenicId: 'scenic-test',
        status: 'closed',
        edgeId,
        physicalEdgeId,
        sourceRef: { datasetName, smId }
    };
}

function mutableStop(id, edgeId = 'edge-open', sourceRef = null) {
    return {
        _id: `stop-${id}`,
        poiId: `poi-${id}`,
        state: 'pending',
        segments: [{
            edgeId,
            ...(sourceRef ? { sourceRef } : {})
        }]
    };
}

function makeHarness(options = {}) {
    const state = {
        invalidations: options.initialInvalidations || 0,
        reloads: 0,
        impacts: [],
        published: [],
        decided: [],
        released: [],
        walkEdgeFilters: [],
        itineraryFilters: [],
        updates: [],
        dataVersionReads: []
    };
    const edges = options.edges || [];
    const itineraries = options.itineraries || [];
    const barrierEventModel = options.barrierEventModel || createBarrierEventModel();
    const models = {
        WalkEdge: {
            find(filter) {
                state.walkEdgeFilters.push(filter);
                return leanQuery(typeof edges === 'function' ? edges(filter) : edges);
            }
        },
        Itinerary: {
            find(filter) {
                state.itineraryFilters.push(filter);
                return leanQuery(typeof itineraries === 'function' ? itineraries(filter) : itineraries);
            },
            async findOneAndUpdate(filter, update, queryOptions) {
                state.updates.push({ filter, update, options: queryOptions });
                if (options.updateImpl) return options.updateImpl(filter, update, queryOptions);
                return { _id: filter._id, version: Number(filter.version) + 1 };
            }
        },
        BarrierEventRecord: barrierEventModel
    };
    const routeBetween = options.routeBetween || (async () => null);
    const dataVersionSource = options.dataVersion === undefined
        ? () => 'graph-v1'
        : options.dataVersion;
    const coordinator = createBarrierRerouteCoordinator({
        models,
        gateway: {
            async invalidateRouteCache(reason) {
                state.invalidations++;
                if (options.onInvalidate) await options.onInvalidate(reason);
                return { cleared: 1 };
            }
        },
        walkGraph: {
            async loadIntoMemory() {
                state.reloads++;
                if (options.onReload) await options.onReload();
            }
        },
        rebuildTimeline: options.rebuildTimeline || (async ({ proposedStops }) => proposedStops),
        routeBetween,
        dataVersion: async () => {
            const value = typeof dataVersionSource === 'function'
                ? await dataVersionSource()
                : dataVersionSource;
            state.dataVersionReads.push(value);
            return value;
        },
        aggregateRouteFromStops: options.aggregateRouteFromStops,
        emitRerouteProposed: async payload => {
            state.published.push(payload);
            if (options.onProposal) await options.onProposal(payload);
        },
        emitRerouteDecided: async payload => {
            state.decided.push(payload);
            if (options.onDecision) await options.onDecision(payload);
        },
        releaseProposalTokens: async (tokenIds, itineraryId) => {
            state.released.push({ tokenIds, itineraryId });
            if (options.onRelease) await options.onRelease(tokenIds, itineraryId);
        },
        emitOpsImpact: async impact => {
            state.impacts.push(impact);
            if (options.onImpact) await options.onImpact(impact);
        },
        clock: options.clock || (() => NOW),
        idFactory: options.idFactory || (({ event, itinerary }) =>
            `proposal-${event.eventId}-${String(itinerary._id)}`),
        proposalTtlMs: 10 * 60000,
        eventOwnerId: options.eventOwnerId || 'barrier-test-worker',
        eventLeaseMs: options.eventLeaseMs || 60 * 1000,
        eventHeartbeatMs: options.eventHeartbeatMs || 20 * 1000,
        eventRetentionMs: options.eventRetentionMs || 7 * 24 * 60 * 60 * 1000,
        itineraryConcurrency: options.itineraryConcurrency
    });
    return { coordinator, state, routeBetween, barrierEventModel };
}

test('closed barrier snapshot queries the scenic set, validates, deduplicates, and sorts it', async () => {
    const filters = [];
    const WalkEdge = {
        find(filter) {
            filters.push(filter);
            return leanQuery([
                edge('edge-z', 'walk_edges_test', 9),
                edge('edge-a', 'walk_edges_test', 2),
                edge('edge-a', 'walk_edges_test', 2),
                edge('edge-m', 'walk_edges_secondary', 4)
            ]);
        }
    };

    const snapshot = await loadClosedBarrierSnapshot({ WalkEdge, scenicId: ' scenic-test ' });

    assert.deepEqual(filters, [{ scenicId: 'scenic-test', status: 'closed' }]);
    assert.deepEqual(snapshot.edgeIds, ['edge-a', 'edge-m', 'edge-z']);
    assert.deepEqual(snapshot.barriers, [
        {
            edgeId: 'edge-a', physicalEdgeId: 'edge-a',
            sourceRef: { datasetName: 'walk_edges_test', smId: 2 }
        },
        {
            edgeId: 'edge-m', physicalEdgeId: 'edge-m',
            sourceRef: { datasetName: 'walk_edges_secondary', smId: 4 }
        },
        {
            edgeId: 'edge-z', physicalEdgeId: 'edge-z',
            sourceRef: { datasetName: 'walk_edges_test', smId: 9 }
        }
    ]);
    assert.equal(snapshot.fingerprint, barrierFingerprint(snapshot.barriers));
    assert.deepEqual(snapshot.physicalEdgeIds, ['edge-a', 'edge-m', 'edge-z']);
});

test('barrier snapshots and route checks treat both directions as one physical edge', async () => {
    const snapshot = await loadClosedBarrierSnapshot({
        WalkEdge: {
            find: () => leanQuery([
                edge('road', 'walk_edges_test', 10, 'road'),
                edge('road_r', 'walk_edges_test', 11, 'road')
            ])
        },
        scenicId: 'scenic-test'
    });

    assert.deepEqual(snapshot.physicalEdgeIds, ['road']);
    assert.equal(remainingRouteUsesEdge({
        stops: [mutableStop('reverse', 'road_r')]
    }, {
        edgeId: 'road',
        physicalEdgeId: 'road',
        edgeIds: ['road', 'road_r']
    }), true);
    assert.equal(routeAvoidsBarriers({
        stops: [{
            state: 'pending',
            segments: [{ edgeId: 'unrelated-id', physicalEdgeId: 'road' }]
        }]
    }, snapshot.barriers), false);
});

test('missing, invalid, or conflicting canonical mappings fail the whole snapshot', async () => {
    for (const invalid of [
        { edgeId: '', sourceRef: { datasetName: 'walk_edges_test', smId: 1 } },
        { edgeId: 'edge-a', sourceRef: null },
        { edgeId: 'edge-a', sourceRef: { datasetName: '', smId: 1 } },
        { edgeId: 'edge-a', sourceRef: { datasetName: 'walk_edges_test', smId: -1 } },
        { edgeId: 'edge-a', sourceRef: { datasetName: 'walk_edges_test', smId: 1.5 } }
    ]) {
        const WalkEdge = { find: () => leanQuery([edge('valid'), invalid]) };
        await assert.rejects(
            loadClosedBarrierSnapshot({ WalkEdge, scenicId: 'scenic-test' }),
            error => error.code === 'INVALID_BARRIER_MAPPING'
        );
    }

    const conflict = {
        find: () => leanQuery([
            edge('edge-a', 'walk_edges_test', 1),
            edge('edge-a', 'walk_edges_test', 2)
        ])
    };
    await assert.rejects(
        loadClosedBarrierSnapshot({ WalkEdge: conflict, scenicId: 'scenic-test' }),
        error => error.code === 'CONFLICTING_BARRIER_MAPPING'
    );
    assert.throws(
        () => normalizeClosedBarrier({ edgeId: 'unsafe edge', sourceRef: { datasetName: 'x', smId: 1 } }),
        error => error.code === 'INVALID_BARRIER_MAPPING'
    );
});

test('barrier fingerprints are stable across ordering and duplicates but include GIS mappings', () => {
    const first = barrierFingerprint([
        edge('edge-b', 'walk_edges_test', 2),
        edge('edge-a', 'walk_edges_test', 1)
    ]);
    const reordered = barrierFingerprint([
        edge('edge-a', 'walk_edges_test', 1),
        edge('edge-b', 'walk_edges_test', 2),
        edge('edge-a', 'walk_edges_test', 1)
    ]);
    const remapped = barrierFingerprint([
        edge('edge-a', 'walk_edges_test', 1),
        edge('edge-b', 'walk_edges_test', 3)
    ]);

    assert.match(first, /^sha256:[a-f0-9]{64}$/);
    assert.equal(first, reordered);
    assert.notEqual(first, remapped);
});

test('route barrier checks reject matching edge IDs and matching canonical GIS references', () => {
    const barriers = [edge('edge-closed', 'walk_edges_test', 7)];

    assert.equal(routeAvoidsBarriers({
        stops: [{ segments: [{ edgeId: 'edge-closed' }] }]
    }, barriers), false);
    assert.equal(routeAvoidsBarriers({
        route: {
            segments: [{
                edgeId: 'different-local-id',
                sourceRef: { datasetName: 'walk_edges_test', smId: 7 }
            }]
        }
    }, barriers), false);
    assert.equal(routeAvoidsBarriers({
        segments: [{
            edgeId: 'edge-open',
            sourceRef: { datasetName: 'walk_edges_test', smId: 8 }
        }]
    }, barriers), true);
    assert.equal(routeAvoidsBarriers({
        stops: [{ state: 'pending', segments: [] }]
    }, barriers), false);
    assert.equal(routeAvoidsBarriers({
        stops: [
            mutableStop('complete', 'edge-open'),
            { _id: 'stop-missing', poiId: 'poi-missing', state: 'pending' }
        ]
    }, barriers), false);
});

test('remaining route provenance distinguishes used, explicitly unused, and legacy unknown edges', () => {
    assert.equal(remainingRouteUsesEdge({
        stops: [mutableStop('used', 'edge-closed')]
    }, 'edge-closed'), true);
    assert.equal(remainingRouteUsesEdge({
        stops: [mutableStop('unused', 'edge-open')]
    }, 'edge-closed'), false);
    assert.equal(remainingRouteUsesEdge({
        stops: [{ _id: 'legacy-stop', poiId: 'legacy-poi', state: 'pending' }]
    }, 'edge-closed'), null);
    assert.equal(remainingRouteUsesEdge({
        stops: [{ _id: 'legacy-stop', poiId: 'legacy-poi', state: 'pending' }],
        route: { segments: [{ edgeId: 'edge-closed' }] }
    }, 'edge-closed'), true);
});

test('accepted direct events invalidate and reload once while pre-invalidated admin events never invalidate twice', async () => {
    const direct = makeHarness();
    const directResult = await direct.coordinator.processGraphEvent({
        eventId: 'event-direct-close',
        scenicId: 'scenic-test',
        edgeId: 'edge-a',
        operation: 'close'
    });

    assert.equal(direct.state.invalidations, 1);
    assert.equal(direct.state.reloads, 1);
    assert.equal(direct.state.impacts.length, 1);
    assert.deepEqual(direct.state.impacts[0], {
        eventId: 'event-direct-close',
        edgeId: 'edge-a',
        affectedItineraries: 0,
        proposalsCreated: 0,
        failed: 0,
        completedAt: '2026-08-02T06:00:00.000Z'
    });
    assert.equal(directResult.operation, 'close');
    assert.equal(directResult.cacheInvalidationAttempts, 1);

    const admin = makeHarness({ initialInvalidations: 1 });
    const adminResult = await admin.coordinator.processGraphEvent({
        eventId: 'event-admin-open',
        scenicId: 'scenic-test',
        edgeId: 'edge-a',
        operation: 'open',
        cacheInvalidated: true
    });

    assert.equal(admin.state.invalidations, 1, 'the admin invalidation must not be repeated');
    assert.equal(admin.state.reloads, 1);
    assert.equal(admin.state.impacts.length, 1);
    assert.equal(adminResult.operation, 'open');
    assert.equal(adminResult.cacheInvalidationAttempts, 0);
    assert.equal(adminResult.cacheInvalidatedBeforeEnqueue, true);
});

test('cache invalidation settles before graph reload and operational failures reach impact.failed', async () => {
    let releaseInvalidation;
    let markInvalidationStarted;
    const invalidationStarted = new Promise(resolve => { markInvalidationStarted = resolve; });
    const sequential = makeHarness({
        onInvalidate: () => {
            markInvalidationStarted();
            return new Promise(resolve => { releaseInvalidation = resolve; });
        }
    });

    const processing = sequential.coordinator.processGraphEvent({
        eventId: 'event-sequential',
        scenicId: 'scenic-test',
        edgeId: 'edge-a',
        operation: 'close'
    });
    await invalidationStarted;
    assert.equal(sequential.state.reloads, 0, 'reload must wait for invalidation to settle');
    releaseInvalidation();
    await processing;
    assert.equal(sequential.state.reloads, 1);

    const failedInvalidation = makeHarness({
        onInvalidate: () => { throw new Error('cache unavailable'); }
    });
    const failedResult = await failedInvalidation.coordinator.processGraphEvent({
        eventId: 'event-invalidation-failed',
        scenicId: 'scenic-test',
        edgeId: 'edge-a',
        operation: 'open'
    });
    assert.equal(failedInvalidation.state.reloads, 1, 'reload still runs after invalidation failure');
    assert.equal(failedResult.operationalFailureCount, 1);
    assert.equal(failedInvalidation.state.impacts[0].failed, 1);
});

test('coordinator rebuilds with the complete barrier context, rejects unsafe candidates, and reports partial failures once', async () => {
    const itineraries = [
        {
            _id: 'it-ok', version: 3, state: 'active', pendingProposal: null,
            stops: [mutableStop('ok', 'edge-closed')]
        },
        {
            _id: 'it-error', version: 4, state: 'active', pendingProposal: null,
            stops: [mutableStop('error', 'edge-closed')]
        },
        {
            _id: 'it-blocked', version: 5, state: 'active', pendingProposal: null,
            stops: [mutableStop('blocked', 'edge-closed')]
        },
        {
            _id: 'it-cas', version: 6, state: 'active', pendingProposal: null,
            stops: [mutableStop('cas', 'edge-closed')]
        }
    ];
    const routeContexts = [];
    let settledRebuilds = 0;
    const harness = makeHarness({
        edges: [
            edge('edge-z', 'walk_edges_test', 9),
            edge('edge-closed', 'walk_edges_test', 7)
        ],
        itineraries,
        rebuildTimeline: async input => {
            routeContexts.push({
                itineraryId: String(input.itinerary._id),
                context: input.routeContext,
                routeBetween: input.routeBetween
            });
            try {
                if (String(input.itinerary._id) === 'it-error') throw new Error('route service failed');
                if (String(input.itinerary._id) === 'it-blocked') {
                    return {
                        stops: [mutableStop('blocked-new', 'edge-open')],
                        route: { segments: [{ edgeId: 'edge-closed' }] }
                    };
                }
                return [mutableStop('ok-new', 'edge-open', {
                    datasetName: 'walk_edges_test', smId: 8
                })];
            } finally {
                settledRebuilds++;
            }
        },
        aggregateRouteFromStops: stops => ({
            segments: stops.flatMap(stop => stop.segments || []),
                durationSec: 90
        }),
        updateImpl: filter => filter._id === 'it-cas'
            ? null
            : { _id: filter._id, version: Number(filter.version) + 1, openId: `user-${filter._id}` },
        onImpact: () => {
            assert.equal(settledRebuilds, 4, 'impact must be emitted after all rebuilds settle');
        }
    });

    const result = await harness.coordinator.processGraphEvent({
        eventId: 'event-partial',
        scenicId: 'scenic-test',
        edgeId: 'edge-closed',
        type: 'graph:edgeClosed'
    });

    assert.deepEqual(harness.state.itineraryFilters, [{
        scenicId: 'scenic-test',
        state: { $in: ['draft', 'active', 'paused'] }
    }]);
    assert.equal(harness.state.invalidations, 1);
    assert.equal(harness.state.reloads, 1);
    assert.equal(harness.state.updates.length, 2);
    const successfulUpdate = harness.state.updates.find(call => call.filter._id === 'it-ok');
    assert.deepEqual(successfulUpdate.filter, {
        _id: 'it-ok',
        version: 3,
        state: 'active',
        pendingProposal: null
    });
    assert.deepEqual(successfulUpdate.options, { new: true });

    const proposal = successfulUpdate.update.$set.pendingProposal;
    assert.equal(proposal.type, 'barrierReroute');
    assert.equal(proposal.proposalId, 'proposal-event-partial-it-ok');
    assert.equal(proposal.expireAt.toISOString(), '2026-08-02T06:10:00.000Z');
    assert.deepEqual(proposal.payload.barrierEdgeIds, ['edge-closed', 'edge-z']);
    assert.deepEqual(proposal.payload.route, {
        segments: [{
            edgeId: 'edge-open',
            sourceRef: { datasetName: 'walk_edges_test', smId: 8 }
        }],
        durationSec: 90
    });

    assert.equal(routeContexts.length, 4);
    for (const { context, routeBetween } of routeContexts) {
        assert.strictEqual(routeBetween, harness.routeBetween);
        assert.equal(context.requestId, 'event-partial');
        assert.equal(context.eventId, 'event-partial');
        assert.equal(context.barrierFingerprint, result.barrierFingerprint);
        assert.equal(context.dataVersion, 'graph-v1');
        assert.deepEqual(context.barriers.map(item => item.edgeId), ['edge-closed', 'edge-z']);
    }
    assert.equal(proposal.payload.dataVersion, 'graph-v1');

    assert.equal(harness.state.published.length, 1);
    assert.strictEqual(harness.state.published[0].proposal, proposal);
    assert.deepEqual(harness.state.published[0].itinerary, {
        _id: 'it-ok', version: 4, openId: 'user-it-ok'
    });
    assert.equal(result.itineraryCount, 4);
    assert.equal(result.affectedItineraryCount, 4);
    assert.equal(result.attemptedCount, 4);
    assert.equal(result.proposedCount, 1);
    assert.equal(result.failedCount, 3);
    assert.equal(result.skippedCount, 0);
    assert.equal(result.operationalFailureCount, 0);
    assert.equal(result.partialFailure, true);
    assert.equal(result.outcome, 'partial');
    assert.equal(harness.state.impacts.length, 1);
    assert.deepEqual(harness.state.impacts[0], {
        eventId: 'event-partial',
        edgeId: 'edge-closed',
        affectedItineraries: 4,
        proposalsCreated: 1,
        failed: 3,
        completedAt: '2026-08-02T06:00:00.000Z'
    });
    assert.deepEqual(
        result.outcomes.map(item => [item.itineraryId, item.status, item.code || null]),
        [
            ['it-ok', 'proposed', null],
            ['it-error', 'failed', 'UNEXPECTED_ERROR'],
            ['it-blocked', 'failed', 'BARRIER_ROUTE_CONFLICT'],
            ['it-cas', 'failed', 'ITINERARY_CAS_CONFLICT']
        ]
    );
});

test('paused itineraries receive barrier proposals without being resumed', async () => {
    const paused = {
        _id: 'it-paused',
        openId: 'user-paused',
        version: 2,
        state: 'paused',
        pendingProposal: null,
        preferences: { pace: 'normal' },
        route: { segments: [{ edgeId: 'edge-closed' }] },
        stops: [mutableStop('paused', 'edge-closed')]
    };
    const harness = makeHarness({
        edges: [edge('edge-closed', 'walk_edges_test', 7)],
        itineraries: [paused],
        rebuildTimeline: async () => [mutableStop('paused-new', 'edge-open')],
        aggregateRouteFromStops: stops => ({
            segments: stops.flatMap(stop => stop.segments || []),
            durationSec: 90
        }),
        updateImpl: (filter, update) => ({
            ...paused,
            ...update.$set,
            version: paused.version + 1
        })
    });

    const result = await harness.coordinator.processGraphEvent({
        eventId: 'event-paused-close',
        scenicId: 'scenic-test',
        edgeId: 'edge-closed',
        operation: 'close'
    });

    assert.equal(result.proposedCount, 1);
    assert.equal(harness.state.updates.length, 1);
    assert.deepEqual(harness.state.updates[0].filter, {
        _id: 'it-paused',
        version: 2,
        state: 'paused',
        pendingProposal: null
    });
    assert.equal(harness.state.published.length, 1);
    assert.equal(harness.state.published[0].itinerary.state, 'paused');
    assert.equal(harness.state.published[0].proposal.type, 'barrierReroute');
});

test('barrier reroutes pin one dataVersion for every leg and aggregate the same version', async () => {
    const aggregateCalls = [];
    const routeContexts = [];
    const harness = makeHarness({
        itineraries: [{
            _id: 'it-versioned', version: 2, state: 'active', pendingProposal: null,
            stops: [mutableStop('versioned', 'edge-old')]
        }],
        rebuildTimeline: async input => {
            routeContexts.push(input.routeContext);
            return [mutableStop('versioned-safe', 'edge-safe')];
        },
        aggregateRouteFromStops: (stops, preferences, fallback, options) => {
            aggregateCalls.push(options);
            return {
                segments: stops.flatMap(stop => stop.segments || []),
                durationSec: 60,
                gis: { dataVersion: options.expectedDataVersion }
            };
        }
    });

    const result = await harness.coordinator.processGraphEvent({
        eventId: 'event-version-pin',
        scenicId: 'scenic-test',
        edgeId: 'edge-old',
        operation: 'open'
    });

    assert.equal(result.dataVersion, 'graph-v1');
    assert.deepEqual(routeContexts.map(context => context.dataVersion), ['graph-v1']);
    assert.ok(aggregateCalls.length >= 1);
    assert.ok(aggregateCalls.every(options => options.expectedDataVersion === 'graph-v1'));
    assert.equal(harness.state.updates[0].update.$set.pendingProposal.payload.dataVersion, 'graph-v1');
    assert.deepEqual(harness.state.dataVersionReads, ['graph-v1', 'graph-v1']);
});

test('a dataVersion change before proposal persistence fails closed without publishing', async () => {
    const versions = ['graph-v1', 'graph-v2'];
    const harness = makeHarness({
        dataVersion: () => versions.shift(),
        itineraries: [{
            _id: 'it-version-race', version: 1, state: 'active', pendingProposal: null,
            stops: [mutableStop('version-race', 'edge-closed')]
        }],
        rebuildTimeline: async input => {
            assert.equal(input.routeContext.dataVersion, 'graph-v1');
            return [mutableStop('version-race-safe', 'edge-safe')];
        }
    });

    const result = await harness.coordinator.processGraphEvent({
        eventId: 'event-version-race',
        scenicId: 'scenic-test',
        edgeId: 'edge-closed',
        operation: 'close'
    });

    assert.equal(result.failedCount, 1);
    assert.equal(result.outcomes[0].code, 'BARRIER_ROUTING_SNAPSHOT_CHANGED');
    assert.equal(harness.state.updates.length, 0);
    assert.equal(harness.state.published.length, 0);
    assert.deepEqual(harness.state.dataVersionReads, ['graph-v1', 'graph-v2']);
});

test('mixed route leg versions are rejected before aggregation or persistence', async () => {
    const itinerary = {
        _id: 'it-mixed-version', version: 1, state: 'active', pendingProposal: null,
        startLocation: { type: 'Point', coordinates: [114.35, 30.54] },
        preferences: {},
        stops: [mutableStop('mixed-version', 'edge-closed')]
    };
    const routeBetween = async () => ({
        durationSec: 60,
        distanceM: 80,
        available: true,
        routeFound: true,
        authoritative: true,
        routeKind: 'topology',
        topology: true,
        geometry: { type: 'LineString', coordinates: [[114.35, 30.54], [114.351, 30.541]] },
        segments: [{ edgeId: 'edge-safe' }],
        gis: { source: 'iserver', mode: 'normal', topology: true, dataVersion: 'graph-v2' }
    });
    const harness = makeHarness({
        itineraries: [itinerary],
        routeBetween,
        rebuildTimeline: input => rebuildTimeline({
            ...input,
            loadPois: async poiIds => poiIds.map(id => ({
                _id: id,
                geo: { type: 'Point', coordinates: [114.351, 30.541] },
                visitMeta: { suggestedStayMin: 20 }
            }))
        })
    });

    const result = await harness.coordinator.processGraphEvent({
        eventId: 'event-mixed-version',
        scenicId: 'scenic-test',
        edgeId: 'edge-closed',
        operation: 'close'
    });

    assert.equal(result.failedCount, 1);
    assert.equal(result.outcomes[0].code, 8205);
    assert.equal(harness.state.updates.length, 0);
    assert.equal(harness.state.published.length, 0);
});

test('draft itineraries are atomically abandoned before deduplicated token release', async () => {
    const draft = {
        _id: 'draft-stale', version: 4, state: 'draft', activeOwner: 'user-draft',
        planningSnapshot: {
            barrierFingerprint: 'sha256:old',
            barrierEdgeIds: ['edge-old'],
            dataVersion: 'graph-v0',
            capturedAt: new Date('2026-08-01T00:00:00.000Z'),
            invalidatedAt: null,
            invalidationReason: null
        },
        pendingProposal: { proposalId: 'proposal-old', tokenIds: ['token-b', 'token-a'] },
        stops: [
            { ...mutableStop('draft-a'), capacityTokenId: 'token-a' },
            { ...mutableStop('draft-c'), capacityTokenId: 'token-c' }
        ]
    };
    let casCompleted = false;
    const harness = makeHarness({
        itineraries: [draft],
        updateImpl(filter, update) {
            assert.deepEqual(filter, { _id: 'draft-stale', version: 4, state: 'draft' });
            assert.equal(update.$set.state, 'abandoned');
            assert.equal(update.$set.pendingProposal, null);
            assert.ok(update.$set.stops.every(stop => stop.capacityTokenId === null));
            assert.equal(update.$set.planningSnapshot.dataVersion, 'graph-v0');
            assert.equal(update.$set.planningSnapshot.invalidatedAt.toISOString(), NOW.toISOString());
            assert.equal(update.$unset.activeOwner, 1);
            casCompleted = true;
            return { _id: filter._id, version: 5, state: 'abandoned' };
        },
        onRelease(tokenIds, itineraryId) {
            assert.equal(casCompleted, true);
            assert.equal(itineraryId, 'draft-stale');
            assert.deepEqual(tokenIds, ['token-b', 'token-a', 'token-c']);
        }
    });

    const result = await harness.coordinator.processGraphEvent({
        eventId: 'event-draft-invalidate',
        scenicId: 'scenic-test',
        edgeId: 'edge-closed',
        operation: 'close'
    });

    assert.equal(result.invalidatedDraftCount, 1);
    assert.equal(result.failedCount, 0);
    assert.equal(result.proposedCount, 0);
    assert.equal(result.outcomes[0].status, 'invalidated');
    assert.equal(harness.state.released.length, 1);
});

test('draft CAS loss never releases tokens', async () => {
    const harness = makeHarness({
        itineraries: [{
            _id: 'draft-cas-loss', version: 3, state: 'draft',
            pendingProposal: { tokenIds: ['token-proposal'] },
            stops: [{ ...mutableStop('draft-cas'), capacityTokenId: 'token-stop' }]
        }],
        updateImpl: () => null
    });

    const result = await harness.coordinator.processGraphEvent({
        eventId: 'event-draft-cas-loss',
        scenicId: 'scenic-test',
        edgeId: 'edge-closed',
        operation: 'close'
    });

    assert.equal(result.failedCount, 1);
    assert.equal(result.outcomes[0].code, 'ITINERARY_CAS_CONFLICT');
    assert.equal(harness.state.released.length, 0);
});

test('draft token release failures remain observable after successful abandonment', async () => {
    const harness = makeHarness({
        itineraries: [{
            _id: 'draft-release-failure', version: 1, state: 'draft',
            pendingProposal: { tokenIds: ['token-release'] },
            stops: []
        }],
        updateImpl: filter => ({ _id: filter._id, version: 2, state: 'abandoned' }),
        onRelease: () => { throw new Error('token store unavailable'); }
    });

    const result = await harness.coordinator.processGraphEvent({
        eventId: 'event-draft-release-failure',
        scenicId: 'scenic-test',
        edgeId: 'edge-closed',
        operation: 'close'
    });

    assert.equal(result.invalidatedDraftCount, 1);
    assert.equal(result.failedCount, 0);
    assert.equal(result.operationalFailureCount, 1);
    assert.equal(result.outcomes[0].operationalFailureCount, 1);
    assert.equal(result.failures[0].scope, 'invalidated-draft-token-release');
    assert.equal(result.proposedCount, 0);
});

test('close events atomically supersede pending proposals before cleanup and publication', async () => {
    const order = [];
    const previousProposal = {
        proposalId: 'proposal-old',
        type: 'swap',
        reason: 'old crowd proposal',
        tokenIds: ['token-1'],
        payload: {
            eventId: 'event-old',
            edgeId: 'edge-old',
            barrierFingerprint: 'sha256:old'
        }
    };
    const harness = makeHarness({
        edges: [edge('edge-closed', 'walk_edges_test', 7)],
        itineraries: [{
            _id: 'it-supersede',
            openId: 'user-supersede',
            version: 8,
            state: 'active',
            pendingProposal: previousProposal,
            stops: [mutableStop('supersede', 'edge-closed')]
        }],
        rebuildTimeline: async () => [mutableStop('safe', 'edge-open')],
        updateImpl: filter => ({
            _id: filter._id,
            openId: 'user-supersede',
            version: 9
        }),
        onRelease: () => { order.push('release'); },
        onDecision: () => { order.push('decision'); },
        onProposal: () => { order.push('proposal'); }
    });

    const result = await harness.coordinator.processGraphEvent({
        eventId: 'event-close-new',
        scenicId: 'scenic-test',
        edgeId: 'edge-closed',
        operation: 'close'
    });

    assert.equal(harness.state.updates.length, 1);
    const update = harness.state.updates[0];
    assert.deepEqual(update.filter, {
        _id: 'it-supersede',
        version: 8,
        state: 'active',
        'pendingProposal.proposalId': 'proposal-old'
    });
    assert.deepEqual(update.update.$push.rerouteLog, {
        at: NOW,
        type: 'swap',
        reason: 'old crowd proposal',
        savedMin: 0,
        accepted: false,
        status: 'failed',
        proposalId: 'proposal-old',
        eventId: 'event-old',
        edgeId: 'edge-old',
        barrierFingerprint: 'sha256:old'
    });
    assert.deepEqual(order, ['release', 'decision', 'proposal']);
    assert.deepEqual(harness.state.released, [{
        tokenIds: ['token-1'],
        itineraryId: 'it-supersede'
    }]);
    assert.deepEqual(harness.state.decided, [{
        openId: 'user-supersede',
        itineraryId: 'it-supersede',
        proposalId: 'proposal-old',
        status: 'failed',
        accepted: false,
        version: 9,
        at: NOW.toISOString(),
        eventId: 'event-old'
    }]);
    assert.equal(harness.state.published.length, 1);
    assert.equal(result.proposedCount, 1);
    assert.equal(result.outcomes[0].supersededProposalId, 'proposal-old');

    const casLoss = makeHarness({
        edges: [edge('edge-closed', 'walk_edges_test', 7)],
        itineraries: [{
            _id: 'it-cas-loss',
            version: 3,
            state: 'active',
            pendingProposal: previousProposal,
            stops: [mutableStop('cas-loss', 'edge-closed')]
        }],
        rebuildTimeline: async () => [mutableStop('safe-after-cas', 'edge-open')],
        updateImpl: () => null
    });
    const lost = await casLoss.coordinator.processGraphEvent({
        eventId: 'event-close-cas-loss',
        scenicId: 'scenic-test',
        edgeId: 'edge-closed',
        operation: 'close'
    });
    assert.equal(lost.failedCount, 1);
    assert.equal(casLoss.state.released.length, 0);
    assert.equal(casLoss.state.decided.length, 0);
    assert.equal(casLoss.state.published.length, 0);
});

test('post-CAS supersession failures remain observable without dropping the barrier proposal', async () => {
    const harness = makeHarness({
        edges: [edge('edge-closed', 'walk_edges_test', 7)],
        itineraries: [{
            _id: 'it-cleanup-failure',
            version: 2,
            state: 'active',
            pendingProposal: {
                proposalId: 'proposal-old',
                type: 'drop',
                tokenIds: ['token-2'],
                payload: {}
            },
            stops: [mutableStop('cleanup-failure', 'edge-closed')]
        }],
        rebuildTimeline: async () => [mutableStop('cleanup-safe', 'edge-open')],
        updateImpl: filter => ({ _id: filter._id, version: 3, openId: 'user-cleanup' }),
        onRelease: () => { throw new Error('release unavailable'); },
        onDecision: () => { throw new Error('status unavailable'); }
    });

    const result = await harness.coordinator.processGraphEvent({
        eventId: 'event-cleanup-failure',
        scenicId: 'scenic-test',
        edgeId: 'edge-closed',
        operation: 'close'
    });

    assert.equal(result.proposedCount, 1);
    assert.equal(result.operationalFailureCount, 2);
    assert.equal(result.outcomes[0].operationalFailureCount, 2);
    assert.deepEqual(result.failures.map(item => item.scope), [
        'superseded-proposal-token-release',
        'superseded-proposal-status'
    ]);
    assert.equal(harness.state.published.length, 1);
    assert.equal(harness.state.impacts[0].failed, 2);
});

test('close events skip routes proven unaffected while conservatively rebuilding legacy routes', async () => {
    const legacyStop = { _id: 'stop-legacy', poiId: 'poi-legacy', state: 'pending' };
    let rebuilds = 0;
    const harness = makeHarness({
        edges: [edge('edge-closed', 'walk_edges_test', 7)],
        itineraries: [
            {
                _id: 'it-unaffected', version: 1, state: 'active', pendingProposal: null,
                stops: [mutableStop('unaffected', 'edge-open')]
            },
            {
                _id: 'it-legacy', version: 2, state: 'active', pendingProposal: null,
                stops: [legacyStop]
            }
        ],
        rebuildTimeline: async input => {
            rebuilds++;
            return [mutableStop('legacy-new', 'edge-open')];
        }
    });

    const result = await harness.coordinator.processGraphEvent({
        eventId: 'event-close-relevance',
        scenicId: 'scenic-test',
        edgeId: 'edge-closed',
        operation: 'close'
    });

    assert.equal(rebuilds, 1);
    assert.deepEqual(harness.state.updates.map(call => call.filter._id), ['it-legacy']);
    assert.equal(harness.state.published.length, 1);
    assert.equal(result.affectedItineraryCount, 1);
    assert.equal(result.attemptedCount, 1);
    assert.equal(result.proposedCount, 1);
    assert.equal(result.failedCount, 0);
    assert.deepEqual(
        result.outcomes.map(item => [item.itineraryId, item.status, item.code || null]),
        [
            ['it-unaffected', 'skipped', 'CLOSED_EDGE_NOT_USED'],
            ['it-legacy', 'proposed', null]
        ]
    );
    assert.equal(harness.state.impacts[0].affectedItineraries, 1);
});

test('open events do not create proposals when the rebuilt mutable route is materially unchanged', async () => {
    const harness = makeHarness({
        itineraries: [{
            _id: 'it-unchanged', version: 1, state: 'active', pendingProposal: null,
            stops: [mutableStop('current', 'edge-same')]
        }],
        rebuildTimeline: async () => [mutableStop('candidate', 'edge-same')]
    });

    const result = await harness.coordinator.processGraphEvent({
        eventId: 'event-open-unchanged',
        scenicId: 'scenic-test',
        edgeId: 'edge-same',
        operation: 'open'
    });

    assert.equal(result.attemptedCount, 1);
    assert.equal(result.affectedItineraryCount, 0);
    assert.equal(result.proposedCount, 0);
    assert.equal(result.skippedCount, 1);
    assert.equal(result.failedCount, 0);
    assert.equal(result.success, true);
    assert.deepEqual(result.outcomes[0], {
        itineraryId: 'it-unchanged',
        status: 'skipped',
        code: 'ROUTE_UNCHANGED',
        affected: false,
        attempted: true
    });
    assert.equal(harness.state.updates.length, 0);
    assert.equal(harness.state.published.length, 0);
    assert.deepEqual(harness.state.impacts[0], {
        eventId: 'event-open-unchanged',
        edgeId: 'edge-same',
        affectedItineraries: 0,
        proposalsCreated: 0,
        failed: 0,
        completedAt: '2026-08-02T06:00:00.000Z'
    });
});

test('duplicate event IDs share the first execution and produce no repeated side effects', async () => {
    const harness = makeHarness({
        onReload: () => new Promise(resolve => setImmediate(resolve))
    });
    const event = {
        eventId: 'event-duplicate',
        scenicId: 'scenic-test',
        edgeId: 'edge-a',
        operation: 'close'
    };

    const [first, second] = await Promise.all([
        harness.coordinator.processGraphEvent(event),
        harness.coordinator.processGraphEvent(event)
    ]);

    assert.equal(first.accepted, true);
    assert.equal(first.duplicate, false);
    assert.equal(second.accepted, false);
    assert.equal(second.duplicate, true);
    assert.equal(harness.state.invalidations, 1);
    assert.equal(harness.state.reloads, 1);
    assert.equal(harness.state.walkEdgeFilters.length, 1);
    assert.equal(harness.state.itineraryFilters.length, 1);
    assert.equal(harness.state.impacts.length, 1);
});

test('concurrent in-memory dedupe rejects conflicting payload reuse', async () => {
    let releaseReload;
    let markReloadStarted;
    const reloadStarted = new Promise(resolve => { markReloadStarted = resolve; });
    const harness = makeHarness({
        onReload: () => {
            markReloadStarted();
            return new Promise(resolve => { releaseReload = resolve; });
        }
    });
    const first = harness.coordinator.processGraphEvent({
        eventId: 'event-concurrent-conflict',
        scenicId: 'scenic-test',
        edgeId: 'edge-a',
        operation: 'close'
    });
    await reloadStarted;

    await assert.rejects(
        harness.coordinator.processGraphEvent({
            eventId: 'event-concurrent-conflict',
            scenicId: 'scenic-test',
            edgeId: 'edge-b',
            operation: 'close'
        }),
        error => error?.code === 'BARRIER_EVENT_ID_CONFLICT'
    );

    releaseReload();
    const result = await first;
    assert.equal(result.accepted, true);
    assert.equal(harness.state.invalidations, 1);
    assert.equal(harness.state.reloads, 1);
});

test('Mongo event leases dedupe concurrent coordinators and retain completed replays', async () => {
    const barrierEventModel = createBarrierEventModel();
    let releaseReload;
    let markReloadStarted;
    const reloadStarted = new Promise(resolve => { markReloadStarted = resolve; });
    const first = makeHarness({
        barrierEventModel,
        eventOwnerId: 'worker-a',
        onReload: () => {
            markReloadStarted();
            return new Promise(resolve => { releaseReload = resolve; });
        }
    });
    const second = makeHarness({
        barrierEventModel,
        eventOwnerId: 'worker-b'
    });
    const event = {
        eventId: 'event-cross-instance',
        scenicId: 'scenic-test',
        edgeId: 'edge-a',
        operation: 'close'
    };

    const acceptedTask = first.coordinator.processGraphEvent(event);
    await reloadStarted;
    const inProgressDuplicate = await second.coordinator.processGraphEvent(event);

    assert.equal(inProgressDuplicate.accepted, false);
    assert.equal(inProgressDuplicate.duplicate, true);
    assert.equal(inProgressDuplicate.persisted, true);
    assert.equal(inProgressDuplicate.inProgress, true);
    assert.equal(second.state.invalidations, 0);
    assert.equal(second.state.reloads, 0);

    releaseReload();
    const accepted = await acceptedTask;
    assert.equal(accepted.accepted, true);
    const completedDuplicate = await second.coordinator.processGraphEvent(event);
    assert.equal(completedDuplicate.duplicate, true);
    assert.equal(completedDuplicate.completed, true);
    assert.equal(second.state.invalidations, 0);

    const record = barrierEventModel.records.get(event.eventId);
    assert.equal(record.state, 'completed');
    assert.equal(record.attempts, 1);
    assert.equal(record.ownerId, null);
    assert.ok(record.completedAt instanceof Date);
    assert.ok(record.expireAt > record.completedAt);
});

test('failed persistent events are reclaimable without repeating itinerary proposal side effects', async () => {
    const barrierEventModel = createBarrierEventModel();
    let currentItinerary = {
        _id: 'it-recovery',
        version: 1,
        state: 'active',
        pendingProposal: null,
        rerouteLog: [],
        stops: [mutableStop('recovery', 'edge-closed')]
    };
    const shared = {
        barrierEventModel,
        edges: [edge('edge-closed', 'walk_edges_test', 91)],
        itineraries: () => [structuredClone(currentItinerary)],
        rebuildTimeline: async () => [mutableStop('recovery-safe', 'edge-safe')],
        updateImpl(filter, update) {
            currentItinerary = {
                ...currentItinerary,
                pendingProposal: structuredClone(update.$set.pendingProposal),
                version: currentItinerary.version + 1
            };
            return structuredClone(currentItinerary);
        }
    };
    const first = makeHarness({
        ...shared,
        eventOwnerId: 'worker-failing',
        onImpact: async () => { throw new Error('impact transport unavailable'); }
    });
    const event = {
        eventId: 'event-recovery',
        scenicId: 'scenic-test',
        edgeId: 'edge-closed',
        operation: 'close'
    };

    await assert.rejects(first.coordinator.processGraphEvent(event), /impact transport unavailable/);
    const failedRecord = barrierEventModel.records.get(event.eventId);
    assert.equal(failedRecord.state, 'failed');
    assert.equal(failedRecord.attempts, 1);
    assert.equal(first.state.updates.length, 1);
    assert.equal(first.state.published.length, 1);

    const second = makeHarness({
        ...shared,
        eventOwnerId: 'worker-recovery'
    });
    const recovered = await second.coordinator.processGraphEvent(event);

    assert.equal(recovered.accepted, true);
    assert.equal(recovered.proposedCount, 1);
    assert.equal(recovered.outcomes[0].code, 'EVENT_ALREADY_APPLIED');
    assert.equal(recovered.outcomes[0].replayed, true);
    assert.equal(second.state.updates.length, 0);
    assert.equal(second.state.published.length, 0);
    assert.equal(second.state.impacts.length, 1);
    const completedRecord = barrierEventModel.records.get(event.eventId);
    assert.equal(completedRecord.state, 'completed');
    assert.equal(completedRecord.attempts, 2);
    assert.equal(completedRecord.lastErrorCode, null);
});

test('an expired Mongo event lease can be reclaimed after an owner stops renewing', async () => {
    const barrierEventModel = createBarrierEventModel();
    const event = {
        eventId: 'event-expired-lease',
        scenicId: 'scenic-test',
        edgeId: 'edge-expired',
        operation: 'open'
    };
    const initial = makeHarness({ barrierEventModel, eventOwnerId: 'worker-initial' });
    await initial.coordinator.processGraphEvent(event);
    const record = barrierEventModel.records.get(event.eventId);
    record.state = 'processing';
    record.ownerId = 'worker-dead';
    record.leaseUntil = new Date(NOW.getTime() - 1);
    record.completedAt = null;
    record.outcome = null;

    const recovery = makeHarness({ barrierEventModel, eventOwnerId: 'worker-takeover' });
    const result = await recovery.coordinator.processGraphEvent(event);

    assert.equal(result.accepted, true);
    assert.equal(recovery.state.invalidations, 1);
    assert.equal(record.attempts, 2);
    assert.equal(record.state, 'completed');
    assert.equal(record.ownerId, null);
});

test('lease renewal loss fails closed before itinerary queries or writes continue', async () => {
    const barrierEventModel = createBarrierEventModel();
    const updateRecord = barrierEventModel.findOneAndUpdate.bind(barrierEventModel);
    let renewalCalls = 0;
    barrierEventModel.findOneAndUpdate = async (filter, update, options) => {
        const isRenewal = filter.ownerId
            && filter.state === 'processing'
            && update.$set?.leaseUntil
            && update.$set?.state === undefined;
        if (isRenewal) {
            renewalCalls++;
            return null;
        }
        return updateRecord(filter, update, options);
    };
    const harness = makeHarness({
        barrierEventModel,
        eventOwnerId: 'worker-lease-loss',
        eventLeaseMs: 3000,
        eventHeartbeatMs: 10,
        onReload: () => new Promise(resolve => setTimeout(resolve, 35))
    });

    await assert.rejects(
        harness.coordinator.processGraphEvent({
            eventId: 'event-lease-loss',
            scenicId: 'scenic-test',
            edgeId: 'edge-a',
            operation: 'close'
        }),
        error => error?.code === 'BARRIER_EVENT_LEASE_LOST'
    );

    assert.ok(renewalCalls >= 1);
    assert.equal(harness.state.itineraryFilters.length, 0);
    assert.equal(harness.state.updates.length, 0);
    const record = barrierEventModel.records.get('event-lease-loss');
    assert.equal(record.state, 'failed');
    assert.equal(record.lastErrorCode, 'BARRIER_EVENT_LEASE_LOST');
});

test('persistent dedupe rejects conflicting payload reuse for the same eventId', async () => {
    const harness = makeHarness({ eventOwnerId: 'worker-conflict' });
    await harness.coordinator.processGraphEvent({
        eventId: 'event-conflict',
        scenicId: 'scenic-test',
        edgeId: 'edge-a',
        operation: 'close'
    });

    await assert.rejects(
        harness.coordinator.processGraphEvent({
            eventId: 'event-conflict',
            scenicId: 'scenic-test',
            edgeId: 'edge-b',
            operation: 'close'
        }),
        error => error?.code === 'BARRIER_EVENT_ID_CONFLICT'
    );
    assert.equal(harness.state.invalidations, 1);
    assert.equal(harness.state.reloads, 1);
    assert.equal(harness.state.impacts.length, 1);
});

test('barrier reroutes bound itinerary concurrency while preserving result order', async () => {
    const itineraries = Array.from({ length: 7 }, (_, index) => ({
        _id: `it-window-${index}`,
        version: index + 1,
        state: 'active',
        pendingProposal: null,
        stops: [mutableStop(`window-${index}`, 'edge-closed')]
    }));
    let active = 0;
    let maxActive = 0;
    const harness = makeHarness({
        edges: [edge('edge-closed', 'walk_edges_test', 7)],
        itineraries,
        itineraryConcurrency: 2,
        rebuildTimeline: async ({ itinerary }) => {
            active++;
            maxActive = Math.max(maxActive, active);
            await new Promise(resolve => setImmediate(resolve));
            active--;
            return [mutableStop(`safe-${itinerary._id}`, 'edge-open')];
        }
    });

    const result = await harness.coordinator.processGraphEvent({
        eventId: 'event-concurrency-window',
        scenicId: 'scenic-test',
        edgeId: 'edge-closed',
        operation: 'close'
    });

    assert.equal(maxActive, 2);
    assert.equal(result.proposedCount, itineraries.length);
    assert.deepEqual(
        result.outcomes.map(outcome => outcome.itineraryId),
        itineraries.map(itinerary => itinerary._id)
    );
});

test('barrier reroute concurrency must be a positive integer', () => {
    assert.throws(
        () => makeHarness({ itineraryConcurrency: 0 }),
        /itineraryConcurrency must be a positive integer/
    );
    assert.throws(
        () => makeHarness({ itineraryConcurrency: 1.5 }),
        /itineraryConcurrency must be a positive integer/
    );
});

test('enqueueGraphEvent serializes events for the same scenic area', async () => {
    let releaseFirst;
    let markFirstStarted;
    const firstStarted = new Promise(resolve => { markFirstStarted = resolve; });
    const invalidationOrder = [];
    const rebuildOrder = [];
    const impactOrder = [];
    const harness = makeHarness({
        itineraries: [{
            _id: 'it-queue', version: 1, state: 'active', pendingProposal: null,
            stops: [mutableStop('queue', 'edge-a')]
        }],
        onInvalidate: reason => {
            invalidationOrder.push(reason.endsWith('queue-1') ? 'queue-1' : 'queue-2');
        },
        rebuildTimeline: ({ proposedStops, routeContext }) => {
            rebuildOrder.push(routeContext.eventId);
            if (routeContext.eventId === 'queue-1') {
                markFirstStarted();
                return new Promise(resolve => {
                    releaseFirst = () => resolve(proposedStops);
                });
            }
            return proposedStops;
        },
        onImpact: impact => {
            impactOrder.push(impact.eventId);
        }
    });

    const first = harness.coordinator.enqueueGraphEvent({
        eventId: 'queue-1', scenicId: 'scenic-test', edgeId: 'edge-a', operation: 'close'
    });
    const second = harness.coordinator.enqueueGraphEvent({
        eventId: 'queue-2', scenicId: 'scenic-test', edgeId: 'edge-a', operation: 'open'
    });

    await firstStarted;
    assert.deepEqual(invalidationOrder, ['queue-1']);
    assert.deepEqual(rebuildOrder, ['queue-1']);
    assert.deepEqual(impactOrder, []);

    releaseFirst();
    await Promise.all([first, second]);

    assert.deepEqual(invalidationOrder, ['queue-1', 'queue-2']);
    assert.deepEqual(rebuildOrder, ['queue-1', 'queue-2']);
    assert.deepEqual(impactOrder, ['queue-1', 'queue-2']);
    assert.equal(harness.state.invalidations, 2);
    assert.equal(harness.state.reloads, 2);
});
