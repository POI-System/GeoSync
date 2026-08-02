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

const NOW = new Date('2026-08-02T06:00:00.000Z');

function leanQuery(value) {
    return { lean: async () => value };
}

function edge(edgeId, datasetName = 'walk_edges_test', smId = 1) {
    return {
        scenicId: 'scenic-test',
        status: 'closed',
        edgeId,
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
        updates: []
    };
    const edges = options.edges || [];
    const itineraries = options.itineraries || [];
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
        }
    };
    const routeBetween = options.routeBetween || (async () => null);
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
        clock: () => NOW,
        idFactory: options.idFactory || (({ event, itinerary }) =>
            `proposal-${event.eventId}-${String(itinerary._id)}`),
        proposalTtlMs: 10 * 60000,
        eventDedupeLimit: 32
    });
    return { coordinator, state, routeBetween };
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
        { edgeId: 'edge-a', sourceRef: { datasetName: 'walk_edges_test', smId: 2 } },
        { edgeId: 'edge-m', sourceRef: { datasetName: 'walk_edges_secondary', smId: 4 } },
        { edgeId: 'edge-z', sourceRef: { datasetName: 'walk_edges_test', smId: 9 } }
    ]);
    assert.equal(snapshot.fingerprint, barrierFingerprint(snapshot.barriers));
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

    assert.deepEqual(harness.state.itineraryFilters, [{ scenicId: 'scenic-test', state: 'active' }]);
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
        assert.deepEqual(context.barriers.map(item => item.edgeId), ['edge-closed', 'edge-z']);
    }

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
