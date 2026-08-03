'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const SuperMapGateway = require('../geosync/integrations/supermap/gateway');
const MockHttpClient = require('../geosync/integrations/supermap/mockHttpClient');
const {
    validateManifest,
    createPublicConfig
} = require('../geosync/integrations/supermap/manifest');
const { createRouteBetween } = require('../geosync/services/gisRouting');
const {
    createBarrierRerouteCoordinator
} = require('../geosync/services/barrierReroute');
const timelineModule = require('../geosync/services/itineraryTimeline');
const {
    aggregateRouteFromStops
} = require('../geosync/services/itineraryRouteData');
const { addHostPoiGeoSyncFields } = require('../geosync/services/hostPoiSchema');
const { serializePublicPoi } = require('../geosync/services/publicPoiProjection');

const NOW = new Date('2026-08-02T06:00:00.000Z');
const SCENIC_ID = 'workflow-scenic';
const DATA_VERSION = 'workflow-v1';
const WALK_EDGE_DATASET = 'WalkEdge@Workflow';

function manifestResult() {
    const manifest = validateManifest({
        contractVersion: '1.0.0',
        dataVersion: DATA_VERSION,
        scenicId: SCENIC_ID,
        crs: 'EPSG:4326',
        center: [120, 30],
        extent: [119.8, 29.8, 120.2, 30.2],
        services: {
            map: {
                enabled: true,
                path: '/map',
                operations: { status: { method: 'GET', path: '/status' } }
            },
            data: {
                enabled: true,
                path: '/data',
                operations: {
                    status: { method: 'GET', path: '/status' },
                    queryFeatures: { method: 'POST', path: '/query' }
                }
            },
            network: {
                enabled: true,
                path: '/network',
                operations: {
                    status: { method: 'GET', path: '/status' },
                    findPath: { method: 'POST', path: '/route' },
                    findPathWithBarriers: { method: 'POST', path: '/route/barriers' }
                }
            },
            terrain: { enabled: false, operations: {} },
            scene: { enabled: false, operations: {} }
        },
        datasets: {
            poi: {
                service: 'data',
                name: 'Poi@Workflow',
                fields: ['SmID', 'poi_id', 'name'],
                propertyMap: { poi_id: 'poiId', name: 'name' }
            },
            walkEdge: {
                service: 'data',
                name: WALK_EDGE_DATASET,
                fields: ['SmID', 'edge_id'],
                propertyMap: { edge_id: 'edgeId' }
            }
        },
        limits: { maxFeatures: 100 },
        public: {
            features: { supermap: true, threeD: false },
            services: { map: '/public/map' }
        }
    });
    return {
        ok: true,
        state: 'online',
        manifest,
        publicConfig: createPublicConfig(manifest),
        error: null
    };
}

function routeData(start, end, options = {}) {
    const distanceM = options.distanceM ?? 600;
    const durationSec = options.durationSec ?? 300;
    return {
        dataVersion: DATA_VERSION,
        routeFound: true,
        distanceM,
        durationSec,
        geometry: {
            type: 'LineString',
            coordinates: [start, end]
        },
        segments: [{
            edgeId: options.edgeId || 'EDGE_ROUTE',
            distanceM,
            durationSec,
            sourceRef: {
                datasetName: WALK_EDGE_DATASET,
                smId: options.smId ?? 90
            }
        }],
        snap: {
            startDistanceM: 1,
            endDistanceM: 2,
            startNodeId: options.startNodeId || 'NODE_START',
            endNodeId: options.endNodeId || 'NODE_END'
        },
        verifiedAccessible: options.verifiedAccessible ?? false
    };
}

function routeResponse(request, options = {}) {
    return {
        status: 200,
        data: routeData(request.data.start, request.data.end, options),
        headers: {}
    };
}

function connectionFailure() {
    const error = new Error('connection unavailable');
    error.code = 'ECONNREFUSED';
    error.request = { sent: true };
    return error;
}

function noOpLogger() {
    return { info() {}, warn() {}, error() {} };
}

function createGateway({ fixtures, localPathSource, clock = () => NOW } = {}) {
    const client = new MockHttpClient({ fixtures: fixtures || {} });
    let requestSequence = 0;
    const gateway = new SuperMapGateway({
        manifestPath: 'not-read-by-workflow-tests.json',
        manifestLoader: manifestResult,
        httpClient: client,
        localPathSource,
        fallbackEnabled: true,
        clock,
        routeCacheClock: clock,
        routeCacheTtlMs: 60000,
        maxSnapDistanceM: 50,
        requestIdFactory: () => `workflow-route-${++requestSequence}`,
        logger: noOpLogger()
    });
    return { gateway, client };
}

function leanQuery(value) {
    return { lean: async () => value };
}

function responseHarness() {
    return {
        statusCode: 200,
        body: null,
        status(code) {
            this.statusCode = code;
            return this;
        },
        json(body) {
            this.body = body;
            return this;
        }
    };
}

function fakeIo(activeSockets = [{}]) {
    const emitted = [];
    const handlers = new Map();
    return {
        emitted,
        handlers,
        on(event, handler) {
            handlers.set(event, handler);
        },
        to(room) {
            return {
                emit(event, payload) {
                    emitted.push({ room, event, payload });
                }
            };
        },
        in() {
            return {
                async fetchSockets() {
                    return activeSockets;
                }
            };
        }
    };
}

test('GeoSync Phase 5 cross-module workflows', { concurrency: false }, async t => {
    await t.test('Gateway Mock routing, cache invalidation, and outage policies share one adapter', async () => {
        let online = true;
        const localRequests = [];
        const { gateway, client } = createGateway({
            fixtures: {
                findPath: request => online
                    ? routeResponse(request, { edgeId: 'EDGE_ISERVER', verifiedAccessible: true })
                    : connectionFailure()
            },
            localPathSource: async request => {
                localRequests.push(request);
                return routeData(request.start, request.end, {
                    edgeId: 'EDGE_LOCAL',
                    smId: 91,
                    verifiedAccessible: false
                });
            }
        });
        const routeBetween = createRouteBetween(gateway, {
            scenicId: SCENIC_ID,
            closedBarrierProvider: async () => ({ barriers: [] })
        });
        const start = { gateNodeId: 'GATE_A', geo: { coordinates: [120, 30] } };
        const firstEnd = { gateNodeId: 'GATE_B', geo: { coordinates: [120.01, 30.01] } };

        const onlineRoute = await routeBetween(start, firstEnd, 'normal', {
            requestId: 'mock-online'
        });
        assert.equal(onlineRoute.gis.source, 'iserver');
        assert.equal(onlineRoute.gis.degraded, false);
        assert.deepEqual(onlineRoute.geometry.coordinates, [[120, 30], [120.01, 30.01]]);
        assert.equal(gateway.getDiagnostics().routeCacheSize, 1);

        const invalidation = await gateway.invalidateRouteCache('workflow-road-transition');
        assert.equal(invalidation.cleared, 1);
        assert.equal(gateway.getDiagnostics().routeCacheSize, 0);
        assert.equal(gateway.getDiagnostics().lastInvalidationReason, 'workflow-road-transition');

        online = false;
        const normalFallback = await routeBetween(
            start,
            { gateNodeId: 'GATE_C', geo: { coordinates: [120.02, 30.015] } },
            'normal',
            { requestId: 'mock-normal-outage' }
        );
        assert.equal(normalFallback.gis.source, 'local-fallback');
        assert.equal(normalFallback.gis.degraded, true);
        assert.equal(normalFallback.gis.requestId, 'mock-normal-outage');

        await assert.rejects(
            routeBetween(
                start,
                { gateNodeId: 'GATE_D', geo: { coordinates: [120.03, 30.02] } },
                'accessible',
                { requestId: 'mock-accessible-outage' }
            ),
            error => error.code === 8204
                && error.httpStatus === 422
                && error.category === 'no-route'
        );
        assert.equal(localRequests.length, 2);
        assert.deepEqual(client.history.map(request => request.operation), [
            'findPath', 'findPath', 'findPath'
        ]);
    });

    await t.test('barrier event invalidates cache and rebuilds every mutable leg with all closed edges', async () => {
        const barrierRequests = [];
        let alternateEdge = 100;
        const { gateway } = createGateway({
            fixtures: {
                findPath: request => routeResponse(request, {
                    edgeId: 'EDGE_PRIMED',
                    smId: 95
                }),
                findPathWithBarriers: request => {
                    barrierRequests.push(request);
                    alternateEdge++;
                    return routeResponse(request, {
                        edgeId: `EDGE_ALT_${alternateEdge}`,
                        smId: alternateEdge,
                        distanceM: 240,
                        durationSec: 180
                    });
                }
            }
        });
        const routeBetween = createRouteBetween(gateway, {
            scenicId: SCENIC_ID,
            closedBarrierProvider: async () => ({ barriers: [] })
        });
        const poiRows = [{
            _id: 'poi-one',
            geo: { type: 'Point', coordinates: [120.005, 30.005] },
            visitMeta: { suggestedStayMin: 10 }
        }, {
            _id: 'poi-two',
            geo: { type: 'Point', coordinates: [120.01, 30.01] },
            visitMeta: { suggestedStayMin: 15 }
        }];
        const itinerary = {
            _id: 'itinerary-barrier',
            openId: 'socket-user-barrier',
            scenicId: SCENIC_ID,
            version: 3,
            state: 'active',
            pendingProposal: null,
            preferences: { pace: 'normal' },
            lastPosition: { lng: 120, lat: 30, at: NOW },
            route: { segments: [{ edgeId: 'EDGE_CLOSED' }] },
            stops: [{
                _id: 'stop-one',
                poiId: 'poi-one',
                state: 'approaching',
                plannedArrive: new Date(NOW.getTime() + 5 * 60000),
                plannedLeave: new Date(NOW.getTime() + 15 * 60000),
                segments: [{ edgeId: 'EDGE_CLOSED' }]
            }, {
                _id: 'stop-two',
                poiId: 'poi-two',
                state: 'pending',
                plannedArrive: new Date(NOW.getTime() + 20 * 60000),
                plannedLeave: new Date(NOW.getTime() + 35 * 60000),
                segments: [{ edgeId: 'EDGE_OPEN_OLD' }]
            }]
        };
        const updates = [];
        const proposals = [];
        let reloads = 0;
        const models = {
            WalkEdge: {
                find(filter) {
                    assert.deepEqual(filter, { scenicId: SCENIC_ID, status: 'closed' });
                    return leanQuery([
                        {
                            scenicId: SCENIC_ID,
                            status: 'closed',
                            edgeId: 'EDGE_Z',
                            sourceRef: { datasetName: WALK_EDGE_DATASET, smId: 9 }
                        },
                        {
                            scenicId: SCENIC_ID,
                            status: 'closed',
                            edgeId: 'EDGE_CLOSED',
                            sourceRef: { datasetName: WALK_EDGE_DATASET, smId: 7 }
                        },
                        {
                            scenicId: SCENIC_ID,
                            status: 'closed',
                            edgeId: 'EDGE_Z',
                            sourceRef: { datasetName: WALK_EDGE_DATASET, smId: 9 }
                        }
                    ]);
                }
            },
            Itinerary: {
                find(filter) {
                    assert.deepEqual(filter, { scenicId: SCENIC_ID, state: 'active' });
                    return leanQuery([itinerary]);
                },
                async findOneAndUpdate(filter, update, options) {
                    updates.push({ filter, update, options });
                    return {
                        ...itinerary,
                        ...update.$set,
                        version: itinerary.version + 1
                    };
                }
            }
        };

        await routeBetween(
            { geo: { coordinates: [120, 30] } },
            poiRows[0],
            'normal',
            { requestId: 'prime-before-barrier' }
        );
        assert.equal(gateway.getDiagnostics().routeCacheSize, 1);

        const originalInvalidate = gateway.invalidateRouteCache.bind(gateway);
        let invalidationObservation;
        gateway.invalidateRouteCache = async reason => {
            const before = gateway.getDiagnostics().routeCacheSize;
            const result = await originalInvalidate(reason);
            invalidationObservation = { before, result };
            return result;
        };

        const coordinator = createBarrierRerouteCoordinator({
            models,
            gateway,
            walkGraph: {
                async loadIntoMemory() {
                    reloads++;
                }
            },
            rebuildTimeline: input => timelineModule.rebuildTimeline({
                ...input,
                loadPois: async poiIds => poiRows.filter(poi => poiIds.includes(String(poi._id)))
            }),
            routeBetween,
            aggregateRouteFromStops,
            emitRerouteProposed: async payload => proposals.push(payload),
            emitRerouteDecided: async () => {},
            releaseProposalTokens: async () => {},
            emitOpsImpact: async () => {},
            clock: () => NOW,
            idFactory: () => 'proposal-full-barrier-set'
        });

        const result = await coordinator.processGraphEvent({
            eventId: 'event-full-barrier-set',
            scenicId: SCENIC_ID,
            edgeId: 'EDGE_CLOSED',
            operation: 'close'
        });

        assert.equal(invalidationObservation.before, 1);
        assert.equal(invalidationObservation.result.cleared, 1);
        assert.equal(
            gateway.getDiagnostics().lastInvalidationReason,
            'barrier-close:workflow-scenic:event-full-barrier-set'
        );
        assert.equal(reloads, 1);
        assert.equal(result.proposedCount, 1);
        assert.deepEqual(result.barrierEdgeIds, ['EDGE_CLOSED', 'EDGE_Z']);
        assert.equal(barrierRequests.length, 2, 'both mutable legs must be rebuilt');
        for (const request of barrierRequests) {
            assert.deepEqual(request.data.barriers.map(item => item.edgeId), [
                'EDGE_CLOSED', 'EDGE_Z'
            ]);
        }
        assert.equal(updates.length, 1);
        const proposal = updates[0].update.$set.pendingProposal;
        assert.equal(proposal.proposalId, 'proposal-full-barrier-set');
        assert.deepEqual(proposal.payload.barrierEdgeIds, ['EDGE_CLOSED', 'EDGE_Z']);
        assert.equal(proposal.payload.stops.length, 2);
        assert.ok(proposal.payload.stops.every(stop => stop.durationSec === 180));
        assert.ok(proposal.payload.stops[0].plannedLeave < proposal.payload.stops[1].plannedArrive);
        assert.strictEqual(proposals[0].proposal, proposal);
    });

    await t.test('accepting a proposal commits one consistent route, ETA, timetable, and version', async () => {
        const modelModule = require('../geosync/models');
        const antiHerding = require('../geosync/services/antiHerding');
        const forecast = require('../geosync/services/forecastService');
        const bus = require('../geosync/lib/eventBus');
        const timelinePath = require.resolve('../geosync/services/itineraryTimeline');
        const routePath = require.resolve('../geosync/routes/itinerary');
        const originals = {
            getModels: modelModule.getModels,
            claimTokens: antiHerding.claimTokens,
            claimedTokensActive: antiHerding.claimedTokensActive,
            rollbackClaimedTokens: antiHerding.rollbackClaimedTokens,
            finalizeClaimedTokens: antiHerding.finalizeClaimedTokens,
            releaseTokens: antiHerding.releaseTokens,
            rebuildArrivalIndex: forecast.rebuildArrivalIndex,
            busEmit: bus.emit
        };

        const startAt = new Date();
        const oldPoi = {
            _id: 'poi-old',
            poiName: 'Old stop',
            geo: { type: 'Point', coordinates: [120.005, 30.005] },
            visitMeta: { suggestedStayMin: 10 }
        };
        const newPoi = {
            _id: 'poi-new',
            poiName: 'New stop',
            geo: { type: 'Point', coordinates: [120.015, 30.012] },
            visitMeta: { suggestedStayMin: 15 }
        };
        let currentItinerary = {
            _id: 'itinerary-accept',
            openId: 'owner-accept',
            scenicId: SCENIC_ID,
            version: 4,
            state: 'active',
            rerouteCount: 0,
            savedMinutesTotal: 0,
            preferences: { pace: 'normal' },
            lastPosition: { lng: 120, lat: 30, at: startAt },
            pendingProposal: {
                proposalId: 'proposal-accept',
                type: 'replace',
                payload: {
                    stopId: 'stop-accept',
                    newPoiId: 'poi-new',
                    capacityTokenId: 'token-new'
                },
                reason: 'Use the available stop',
                gainMin: 7,
                tokenIds: ['token-new'],
                expireAt: new Date(startAt.getTime() + 10 * 60000)
            },
            stops: [{
                _id: 'stop-accept',
                poiId: 'poi-old',
                capacityTokenId: 'token-old',
                state: 'approaching',
                plannedArrive: new Date(startAt.getTime() + 5 * 60000),
                plannedLeave: new Date(startAt.getTime() + 15 * 60000),
                pathGeometry: ''
            }]
        };
        let committed;
        const released = [];
        const finalized = [];
        const events = [];
        const fakeModels = {
            Itinerary: {
                async findOne(filter) {
                    assert.deepEqual(filter, {
                        _id: 'itinerary-accept',
                        openId: 'owner-accept'
                    });
                    return currentItinerary;
                },
                async findOneAndUpdate(filter, update, options) {
                    assert.equal(filter.version, 4);
                    assert.equal(filter['pendingProposal.proposalId'], 'proposal-accept');
                    assert.deepEqual(options, { new: true });
                    committed = { filter, update };
                    currentItinerary = {
                        ...currentItinerary,
                        ...update.$set,
                        version: currentItinerary.version + update.$inc.version,
                        rerouteCount: currentItinerary.rerouteCount + update.$inc.rerouteCount,
                        savedMinutesTotal: currentItinerary.savedMinutesTotal
                            + update.$inc.savedMinutesTotal
                    };
                    return currentItinerary;
                }
            },
            WalkEdge: {},
            ExternalPoi: {
                find() {
                    return leanQuery([oldPoi, newPoi]);
                }
            },
            PhotoSpot: {}
        };
        const { gateway } = createGateway({
            fixtures: {
                findPath: request => routeResponse(request, {
                    edgeId: 'EDGE_ACCEPTED',
                    smId: 110,
                    distanceM: 750,
                    durationSec: 420,
                    verifiedAccessible: true
                })
            },
            clock: () => new Date()
        });
        const routeBetween = createRouteBetween(gateway, {
            scenicId: SCENIC_ID,
            closedBarrierProvider: async () => ({ barriers: [] })
        });

        try {
            modelModule.getModels = () => fakeModels;
            antiHerding.claimTokens = async () => true;
            antiHerding.claimedTokensActive = async () => true;
            antiHerding.rollbackClaimedTokens = async () => {
                throw new Error('rollback must not run on the successful workflow');
            };
            antiHerding.finalizeClaimedTokens = async tokenIds => finalized.push(...tokenIds);
            antiHerding.releaseTokens = async tokenIds => released.push(...tokenIds.map(String));
            forecast.rebuildArrivalIndex = async () => {};
            bus.emit = (event, payload) => events.push({ event, payload });

            delete require.cache[timelinePath];
            delete require.cache[routePath];
            const router = require(routePath);
            const decisionLayer = router.stack.find(layer =>
                layer.route?.path === '/:id/proposal/:proposalId/:decision(accept|reject)');
            assert.ok(decisionLayer);
            const handler = decisionLayer.route.stack[0].handle;
            const req = {
                method: 'POST',
                originalUrl: '/api/itinerary/itinerary-accept/proposal/proposal-accept/accept',
                openId: 'owner-accept',
                params: {
                    id: 'itinerary-accept',
                    proposalId: 'proposal-accept',
                    decision: 'accept'
                },
                body: { version: 4 },
                app: { locals: { geosync: { routeBetween } } }
            };
            const res = responseHarness();
            let nextError;
            await handler(req, res, error => { nextError = error; });
            if (nextError) throw nextError;

            assert.equal(res.statusCode, 200);
            assert.equal(res.body.success, true);
            assert.equal(res.body.data.version, 5);
            assert.equal(currentItinerary.version, 5);
            assert.equal(currentItinerary.rerouteCount, 1);
            assert.equal(currentItinerary.savedMinutesTotal, 7);
            assert.equal(currentItinerary.pendingProposal, null);
            assert.equal(currentItinerary.stops[0].poiId, 'poi-new');
            assert.equal(currentItinerary.stops[0].durationSec, 420);
            assert.equal(currentItinerary.stops[0].distanceM, 750);
            assert.equal(currentItinerary.route.durationSec, 420);
            assert.equal(currentItinerary.route.distanceM, 750);
            assert.deepEqual(
                currentItinerary.route.geometry.coordinates,
                currentItinerary.stops[0].geometry.coordinates
            );
            assert.equal(
                new Date(currentItinerary.stops[0].plannedLeave)
                    - new Date(currentItinerary.stops[0].plannedArrive),
                15 * 60000
            );
            assert.deepEqual(res.body.data.route.geometry, currentItinerary.route.geometry);
            assert.equal(res.body.data.stops[0].plannedArrive,
                currentItinerary.stops[0].plannedArrive);
            assert.equal(res.body.data.stops[0].plannedLeave,
                currentItinerary.stops[0].plannedLeave);
            assert.deepEqual(committed.update.$set.route, currentItinerary.route);
            assert.deepEqual(finalized, ['token-new']);
            assert.deepEqual(released, ['token-old']);

            const decided = events.find(item =>
                item.event === bus.EVENTS.REROUTE_DECIDED)?.payload;
            const progress = events.find(item =>
                item.event === bus.EVENTS.ITINERARY_PROGRESS)?.payload;
            assert.equal(decided.version, 5);
            assert.equal(progress.version, 5);
            assert.equal(progress.stops[0].poiId, 'poi-new');
        } finally {
            modelModule.getModels = originals.getModels;
            antiHerding.claimTokens = originals.claimTokens;
            antiHerding.claimedTokensActive = originals.claimedTokensActive;
            antiHerding.rollbackClaimedTokens = originals.rollbackClaimedTokens;
            antiHerding.finalizeClaimedTokens = originals.finalizeClaimedTokens;
            antiHerding.releaseTokens = originals.releaseTokens;
            forecast.rebuildArrivalIndex = originals.rebuildArrivalIndex;
            bus.emit = originals.busEmit;
            delete require.cache[routePath];
            delete require.cache[timelinePath];
        }
    });

    await t.test('legacy POI data retains its collection and review lifecycle under the host extension', async () => {
        const isolated = new mongoose.Mongoose();
        const schema = new isolated.Schema({
            poiName: { type: String, required: true, trim: true },
            category: { type: String, default: 'pending', trim: true },
            description: { type: String, default: '', trim: true },
            imageUrl: { type: String, required: true },
            userOpenId: { type: String, required: true, trim: true },
            reviewerId: { type: String, default: '' },
            location: { lng: Number, lat: Number },
            status: {
                type: String,
                default: 'pending',
                enum: ['pending', 'approved', 'rejected']
            },
            rejectReason: { type: String, default: '' },
            createTime: { type: Date, default: Date.now }
        });
        addHostPoiGeoSyncFields(schema);
        const POI = isolated.model('POI', schema);
        assert.equal(POI.collection.collectionName, 'pois');

        const legacy = POI.hydrate({
            _id: new isolated.Types.ObjectId(),
            poiName: 'Legacy Gate',
            category: 'history',
            description: 'Existing host record',
            imageUrl: '/uploads/legacy.jpg',
            userOpenId: 'private-collector-id',
            location: { lng: 120.001, lat: 30.002 },
            status: 'pending',
            createTime: NOW
        });
        await legacy.validate();
        assert.deepEqual(legacy.geo.coordinates, [120.001, 30.002]);
        assert.equal(legacy.visitMeta.category, 'history');

        legacy.status = 'approved';
        legacy.reviewerId = 'private-reviewer-id';
        legacy.superMapRef = {
            datasetName: 'Poi@Private',
            smId: 17,
            dataVersion: DATA_VERSION
        };
        await legacy.validate();
        assert.equal(legacy.status, 'approved');
        assert.equal(legacy.superMapRef.smId, 17);

        const publicPoi = serializePublicPoi(legacy.toObject());
        assert.equal(publicPoi.status, 'approved');
        assert.equal(publicPoi.poiName, 'Legacy Gate');
        assert.deepEqual(publicPoi.location, { lng: 120.001, lat: 30.002 });
        assert.equal(Object.hasOwn(publicPoi, 'userOpenId'), false);
        assert.equal(Object.hasOwn(publicPoi, 'reviewerId'), false);
        assert.equal(Object.hasOwn(publicPoi, 'superMapRef'), false);
    });

    await t.test('attached event bridge emits public proposal and progress Socket contracts', async () => {
        const isolated = new mongoose.Mongoose();
        isolated.set('autoCreate', false);
        isolated.set('autoIndex', false);
        const POI = isolated.model('POI', new isolated.Schema({}, {
            strict: false,
            collection: 'pois'
        }));
        const User = isolated.model('User', new isolated.Schema({}, {
            strict: false,
            collection: 'users'
        }));
        isolated.connection.asPromise = async () => {
            isolated.connection.readyState = 1;
            return isolated.connection;
        };
        const io = fakeIo([{}]);
        const app = {
            locals: {},
            use() {},
            get() {},
            post() {}
        };
        const gateway = {
            async getStatus() {
                return {
                    state: 'online',
                    manifest: {
                        contractVersion: '1.0.0',
                        dataVersion: DATA_VERSION
                    }
                };
            },
            getDiagnostics() {
                return {
                    routeCacheSize: 0,
                    lastInvalidationReason: null,
                    lastSuccessAt: NOW.toISOString()
                };
            },
            getPublicConfig() {
                return { enabled: true, state: 'online', features: { supermap: true } };
            },
            async findPath() {
                return routeData([120, 30], [120.01, 30.01]);
            },
            async findPathWithBarriers() {
                return routeData([120, 30], [120.01, 30.01]);
            },
            async invalidateRouteCache() {
                return { cleared: 0 };
            }
        };
        const walkGraph = require('../geosync/services/walkGraph');
        const crowdService = require('../geosync/services/crowdService');
        const readinessOriginals = {
            loadIntoMemory: walkGraph.loadIntoMemory,
            isReady: walkGraph.isReady,
            refreshPoiIndex: crowdService.refreshPoiIndex,
            getPoiIndex: crowdService.getPoiIndex
        };
        walkGraph.loadIntoMemory = async () => true;
        walkGraph.isReady = () => true;
        crowdService.refreshPoiIndex = async () => {};
        crowdService.getPoiIndex = () => [{ _id: 'poi-ready' }];

        try {
            const geosync = require('../geosync');
            const bus = require('../geosync/lib/eventBus');
            const attachment = geosync.attach({
                app,
                io,
                mongoose: isolated,
                models: { POI, User },
                helpers: {
                    getSocketIdentity: async () => null
                },
                options: {
                    startBackground: false,
                    mountUploads: false,
                    superMapGateway: gateway,
                    routeBetween: async () => routeData([120, 30], [120.01, 30.01])
                }
            });
            await attachment.readiness;

            const secretOpenId = 'full-openid-must-not-be-in-payload';
            const itinerary = {
                _id: 'itinerary-socket',
                openId: secretOpenId,
                version: 6,
                stops: [{
                    _id: 'stop-socket',
                    poiId: 'poi-old',
                    state: 'approaching',
                    plannedArrive: NOW,
                    plannedLeave: new Date(NOW.getTime() + 10 * 60000)
                }]
            };
            bus.emit(bus.EVENTS.REROUTE_PROPOSED, {
                itinerary,
                proposal: {
                    proposalId: 'proposal-socket',
                    type: 'replace',
                    payload: {
                        stopId: 'stop-socket',
                        newPoiId: 'poi-new',
                        ownerOpenId: secretOpenId
                    },
                    reason: 'Use the alternate stop',
                    gainMin: 11,
                    tokenIds: ['internal-token'],
                    expireAt: new Date(NOW.getTime() + 10 * 60000)
                }
            });
            bus.emit(bus.EVENTS.ITINERARY_PROGRESS, {
                openId: secretOpenId,
                itineraryId: 'itinerary-socket',
                version: 7,
                state: 'active',
                internal: secretOpenId,
                stops: [{
                    stopId: 'stop-socket',
                    poiId: 'poi-new',
                    state: 'approaching',
                    actualArrive: null,
                    actualLeave: null,
                    openId: secretOpenId
                }]
            });
            await new Promise(resolve => setImmediate(resolve));

            const proposalEvent = io.emitted.find(item => item.event === 'itinerary:proposal');
            const progressEvent = io.emitted.find(item => item.event === 'itinerary:progress');
            assert.ok(proposalEvent);
            assert.equal(proposalEvent.room, `user:${secretOpenId}`);
            assert.equal(proposalEvent.payload.itineraryId, 'itinerary-socket');
            assert.equal(proposalEvent.payload.version, 6);
            assert.equal(proposalEvent.payload.proposalId, 'proposal-socket');
            assert.deepEqual(proposalEvent.payload.proposal, {
                proposalId: 'proposal-socket',
                itineraryId: 'itinerary-socket',
                version: 6,
                type: 'replace',
                reason: 'Use the alternate stop',
                gainMin: 11,
                expireAt: new Date(NOW.getTime() + 10 * 60000),
                diff: { before: ['poi-old'], after: ['poi-new'] }
            });
            assert.equal(JSON.stringify(proposalEvent.payload).includes(secretOpenId), false);
            assert.equal(Object.hasOwn(proposalEvent.payload, 'tokenIds'), false);
            assert.equal(Object.hasOwn(proposalEvent.payload, 'payload'), false);

            assert.ok(progressEvent);
            assert.deepEqual(progressEvent.payload, {
                itineraryId: 'itinerary-socket',
                version: 7,
                state: 'active',
                stops: [{
                    stopId: 'stop-socket',
                    poiId: 'poi-new',
                    state: 'approaching',
                    actualArrive: null,
                    actualLeave: null
                }]
            });
            assert.equal(JSON.stringify(progressEvent.payload).includes(secretOpenId), false);
        } finally {
            walkGraph.loadIntoMemory = readinessOriginals.loadIntoMemory;
            walkGraph.isReady = readinessOriginals.isReady;
            crowdService.refreshPoiIndex = readinessOriginals.refreshPoiIndex;
            crowdService.getPoiIndex = readinessOriginals.getPoiIndex;
        }
    });
});
