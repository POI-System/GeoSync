'use strict';
// 02文档：全部新集合 Schema + 对已有 pois/users 的兼容读写（strict:false 外部模型）。
// registerModels(mongooseInstance) 幂等；getModels() 各处取用。

const { Schema } = require('mongoose');

let M = null; // 注册结果缓存

const pointSchema = new Schema({
    type: { type: String, enum: ['Point'], default: 'Point' },
    coordinates: { type: [Number], required: true } // [lng, lat]
}, { _id: false });

const lineStringSchema = new Schema({
    type: { type: String, enum: ['LineString'], required: true },
    coordinates: { type: [[Number]], required: true }
}, { _id: false });

const routeSourceRefSchema = new Schema({
    datasetName: String,
    smId: Number
}, { _id: false });

const walkEdgeSourceRefSchema = new Schema({
    datasetName: String,
    smId: Number,
    sourceId: String,
    dataVersion: String
}, { _id: false });

const routeSegmentSchema = new Schema({
    edgeId: String,
    distanceM: { type: Number, min: 0 },
    durationSec: { type: Number, min: 0 },
    sourceRef: { type: routeSourceRefSchema, default: null }
}, { _id: false });

const routeSnapSchema = new Schema({
    startDistanceM: { type: Number, min: 0 },
    endDistanceM: { type: Number, min: 0 }
}, { _id: false });

const routeGisSchema = new Schema({
    source: { type: String, enum: ['iserver', 'cache', 'local-fallback'] },
    mode: { type: String, enum: ['normal', 'accessible', 'shade'] },
    degraded: Boolean,
    requestId: String,
    durationMs: { type: Number, min: 0 },
    dataVersion: String
}, { _id: false });

const routeSchema = new Schema({
    geometry: { type: lineStringSchema, default: null },
    distanceM: { type: Number, min: 0, default: null },
    durationSec: { type: Number, min: 0, default: null },
    gis: { type: routeGisSchema, default: null },
    segments: { type: [routeSegmentSchema], default: [] },
    snap: { type: routeSnapSchema, default: null },
    verifiedAccessible: { type: Boolean, default: null },
    pathGeometry: { type: String, default: '' }
}, { _id: false });

function registerModels(mongoose, injectedModels = {}) {
    if (M) return M;
    const { ObjectId } = Schema.Types;

    // ---- 外部集合（poi 平台已有，strict:false 只读扩展字段，不定义完整结构）----
    const ExternalPoi = injectedModels.POI || mongoose.models.POI || mongoose.model('POI',
        new Schema({}, { strict: false, collection: 'pois' }));
    const ExternalUser = injectedModels.User || mongoose.models.User || mongoose.model('User',
        new Schema({}, { strict: false, collection: 'users' }));

    // ---- photospots ----
    const photoSpotSchema = new Schema({
        scenicId: { type: String, default: 'default', index: true },
        poiId: { type: ObjectId, ref: 'POI', required: true },
        name: { type: String, required: true, trim: true },
        geo: { type: pointSchema, required: true },
        heading: { type: Number, required: true, min: 0, max: 359 },
        elevationHint: { type: String, default: '' },
        horizonProfile: { type: [Number], default: [] },
        horizonBuiltAt: Date,
        goldenWindows: [{
            date: String, start: String, end: String,
            light: { type: String, enum: ['side', 'back', 'front', 'golden'] },
            trueSunset: String
        }],
        score: { type: Number, default: 0 },
        seasonTags: { type: [String], default: [] },
        samplePhotos: [{
            url: String,
            exif: { time: Date, focal: String, iso: String },
            likes: { type: Number, default: 0 },
            adoptRate: { type: Number, default: 0 },
            source: { type: String, enum: ['crowdsource', 'pairing'], default: 'crowdsource' },
            status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' }
        }],
        status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending', index: true },
        contributorOpenId: { type: String, default: '' },
        createTime: { type: Date, default: Date.now }
    });
    photoSpotSchema.index({ geo: '2dsphere' });
    photoSpotSchema.index({ poiId: 1, score: -1 });

    // ---- staysamples（TTL 7天）----
    const staySampleSchema = new Schema({
        scenicId: { type: String, default: 'default' },
        poiId: { type: ObjectId, required: true },
        userIdHash: { type: String, required: true },
        enterAt: { type: Date, required: true },
        lastSeenAt: { type: Date, default: null },
        leaveAt: { type: Date, default: null },
        stayMinutes: Number,
        source: { type: String, enum: ['geofence', 'checkin', 'passive'], required: true },
        expireAt: { type: Date, required: true }
    });
    staySampleSchema.index({ poiId: 1, enterAt: -1 });
    staySampleSchema.index({ poiId: 1, leaveAt: 1 });
    staySampleSchema.index({ poiId: 1, leaveAt: 1, lastSeenAt: 1 });
    staySampleSchema.index({ userIdHash: 1, leaveAt: 1 });
    staySampleSchema.index({ expireAt: 1 }, { expireAfterSeconds: 0 });

    // ---- crowdsnapshots ----
    const crowdSnapshotSchema = new Schema({
        scenicId: String,
        poiId: { type: ObjectId, required: true },
        timeSlot: { type: String, required: true },
        slotStart: { type: Date, required: true },
        presentCount: Number,
        presentEst: Number,
        avgStay: Number,
        checkinRate: Number,
        crowdIndex: { type: Number, min: 0, max: 1 },
        level: { type: String, enum: ['low', 'medium', 'high'] },
        predicted: { p30: Number, p60: Number },
        queueEstMin: Number
    });
    crowdSnapshotSchema.index({ poiId: 1, timeSlot: -1 }, { unique: true });
    crowdSnapshotSchema.index({ scenicId: 1, slotStart: -1 });

    // ---- itineraries ----
    const stopSchema = new Schema({
        poiId: { type: ObjectId, required: true },
        photoSpotId: { type: ObjectId, default: null },
        plannedArrive: { type: Date, required: true },
        plannedLeave: { type: Date, required: true },
        actualArrive: Date,
        actualLeave: Date,
        capacityTokenId: { type: ObjectId, default: null },
        state: {
            type: String,
            enum: ['pending', 'approaching', 'arrived', 'done', 'skipped', 'rerouted'],
            default: 'pending'
        },
        geometry: { type: lineStringSchema, default: null },
        distanceM: { type: Number, min: 0, default: null },
        durationSec: { type: Number, min: 0, default: null },
        gis: { type: routeGisSchema, default: null },
        segments: { type: [routeSegmentSchema], default: [] },
        snap: { type: routeSnapSchema, default: null },
        verifiedAccessible: { type: Boolean, default: null },
        pathGeometry: { type: String, default: '' }
    }); // 保留自动 _id 作为 stopId

    const rerouteLogSchema = new Schema({
        at: Date,
        type: String,
        reason: String,
        fromPoi: ObjectId,
        toPoi: ObjectId,
        savedMin: Number,
        accepted: Boolean,
        proposalId: String,
        eventId: String,
        edgeId: String,
        barrierFingerprint: String,
        status: {
            type: String,
            enum: ['shown', 'accepted', 'rejected', 'expired', 'failed']
        }
    }, { _id: false });

    const itinerarySchema = new Schema({
        scenicId: { type: String, default: 'default' },
        openId: { type: String, required: true, index: true },
        activeOwner: { type: String, default: undefined },
        date: { type: String, required: true },
        preferences: {
            pace: { type: String, enum: ['relaxed', 'normal', 'tight'], default: 'normal' },
            interests: { type: [String], default: [] },
            hours: Number,
            accessible: { type: Boolean, default: false },
            shadeFirst: { type: Boolean, default: false },
            pairingOptIn: { type: Boolean, default: false },
            noDisturb: { type: Boolean, default: false }
        },
        stops: [stopSchema],
        route: { type: routeSchema, default: null },
        startLocation: { type: pointSchema, default: null },
        version: { type: Number, default: 1 },
        state: {
            type: String,
            enum: ['draft', 'active', 'paused', 'completed', 'abandoned'],
            default: 'draft', index: true
        },
        lastPosition: { lng: Number, lat: Number, at: Date },
        rerouteCount: { type: Number, default: 0 },
        pendingProposal: {
            type: new Schema({
                proposalId: String,
                type: {
                    type: String,
                    enum: ['swap', 'replace', 'delay', 'drop', 'rainShift', 'nlEdit', 'barrierReroute']
                },
                payload: Object,
                reason: String,
                gainMin: Number,
                tokenIds: [ObjectId],
                expireAt: Date
            }, { _id: false }),
            default: null
        },
        rerouteLog: { type: [rerouteLogSchema], default: [] },
        savedMinutesTotal: { type: Number, default: 0 },
        createTime: { type: Date, default: Date.now }
    });
    itinerarySchema.index({ openId: 1, date: -1 });
    itinerarySchema.index(
        { activeOwner: 1 },
        {
            name: 'one_open_itinerary_per_user',
            unique: true,
            partialFilterExpression: { activeOwner: { $type: 'string' } }
        }
    );
    itinerarySchema.index({ state: 1, scenicId: 1 });
    itinerarySchema.index({ scenicId: 1, state: 1, 'route.segments.edgeId': 1 });
    itinerarySchema.index({ 'stops.photoSpotId': 1, state: 1 });
    itinerarySchema.index({ 'pendingProposal.expireAt': 1 });

    // ---- checkins ----
    const checkinSchema = new Schema({
        scenicId: { type: String, default: 'default' },
        openId: { type: String, required: true },
        poiId: { type: ObjectId, required: true },
        date: { type: String, required: true },
        at: { type: Date, default: Date.now },
        proof: {
            photoUrl: String, ocrText: String, ocrConfidence: Number,
            matched: Boolean, matchedAlias: String, gpsDistanceM: Number
        },
        status: { type: String, enum: ['verified', 'pending', 'rejected'], default: 'pending', index: true },
        points: { type: Number, default: 0 },
        viaQrCode: { type: Boolean, default: false }
    });
    checkinSchema.index({ openId: 1, poiId: 1, date: 1 }, { unique: true });
    checkinSchema.index({ openId: 1, at: -1 });
    checkinSchema.index({ poiId: 1, at: -1 });

    // ---- capacity_tokens ----
    const capacityTokenSchema = new Schema({
        scenicId: String,
        poiId: { type: ObjectId, required: true },
        timeSlot: { type: String, required: true },
        holderItineraryId: { type: ObjectId, required: true },
        capacitySlot: { type: Number, min: 0 },
        targetAt: Date,
        holdUntil: Date,
        claimId: { type: String, default: null },
        claimUntil: { type: Date, default: null },
        state: { type: String, enum: ['held', 'claiming', 'confirmed'], default: 'held' },
        expireAt: { type: Date, required: true }
    }, { collection: 'capacity_tokens' });
    capacityTokenSchema.index({ poiId: 1, timeSlot: 1, state: 1 });
    capacityTokenSchema.index({ state: 1, holdUntil: 1 });
    capacityTokenSchema.index({ state: 1, claimUntil: 1 });
    capacityTokenSchema.index(
        { scenicId: 1, poiId: 1, timeSlot: 1, capacitySlot: 1 },
        {
            name: 'capacity_slot_active_unique',
            unique: true,
            partialFilterExpression: { capacitySlot: { $type: 'number' } }
        }
    );
    capacityTokenSchema.index({ expireAt: 1 }, { expireAfterSeconds: 0 });

    // ---- pairings + pairing_profiles ----
    const pairingSchema = new Schema({
        scenicId: String,
        spotId: { type: ObjectId, required: true },
        poiId: ObjectId,
        users: [{
            openId: String,
            codename: String,
            itineraryId: ObjectId,
            plannedArrive: Date,
            accepted: { type: Boolean, default: null },
            arrivedAt: Date,
            proofPhotoUrl: String
        }],
        matchScore: Number,
        state: {
            type: String,
            enum: ['proposed', 'confirmed', 'fulfilled', 'expired', 'declined'],
            default: 'proposed', index: true
        },
        quickMessages: [{ from: String, preset: Number, at: Date }],
        ratings: [{ from: String, to: String, stars: Number }],
        pointsAwarded: { type: Boolean, default: false },
        expireAt: { type: Date, required: true }
    });
    pairingSchema.index({ spotId: 1, state: 1 });
    pairingSchema.index({ 'users.openId': 1, state: 1 });
    pairingSchema.index({ expireAt: 1 }, { expireAfterSeconds: 0 });

    const pairingProfileSchema = new Schema({
        openId: { type: String, required: true, unique: true },
        enabled: { type: Boolean, default: false },
        genderFilter: { type: String, enum: ['any', 'female'], default: 'any' },
        gender: { type: String, default: '' },
        fulfillCount: { type: Number, default: 0 },
        noShowCount: { type: Number, default: 0 },
        avgStars: { type: Number, default: 0 },
        banned: { type: Boolean, default: false }
    }, { collection: 'pairing_profiles' });

    // ---- walkgraph ----
    const walkNodeSchema = new Schema({
        scenicId: { type: String, default: 'default' },
        nodeId: { type: String, required: true, unique: true },
        geo: { type: pointSchema, required: true },
        kind: { type: String, enum: ['junction', 'poi-gate', 'facility'], default: 'junction' }
    }, { collection: 'walkgraph_nodes' });
    walkNodeSchema.index({ geo: '2dsphere' });

    const walkEdgeSchema = new Schema({
        scenicId: { type: String, default: 'default' },
        edgeId: { type: String, required: true, unique: true },
        from: { type: String, required: true },
        to: { type: String, required: true },
        geometry: { type: [[Number]], default: [] },
        distanceM: Number,
        walkSec: { type: Number, required: true },
        slope: { type: Number, default: 0 },
        stairs: { type: Boolean, default: false },
        shade: { type: Number, default: 0.5, min: 0, max: 1 },
        covered: { type: Number, default: 0, min: 0, max: 1 },
        accessible: { type: Boolean, default: false },
        accessibleEvidence: { type: Number, default: 0 },
        accessibleVerified: { type: Boolean, default: false },
        status: { type: String, enum: ['open', 'closed', 'candidate'], default: 'open' },
        source: { type: String, enum: ['manual', 'crowd', 'import'], default: 'manual' },
        sourceRef: { type: walkEdgeSourceRefSchema, default: null },
        closedReason: String,
        closedAt: Date
    }, { collection: 'walkgraph_edges' });
    walkEdgeSchema.index({ from: 1 });
    walkEdgeSchema.index({ status: 1 });
    walkEdgeSchema.index({ scenicId: 1, status: 1 });

    const accessibleEvidenceSchema = new Schema({
        edgeId: String, userIdHash: String, date: String,
        direction: Number,
        outcome: { type: String, enum: ['passed', 'turnback'] },
        expireAt: Date
    }, { collection: 'accessible_evidences' });
    accessibleEvidenceSchema.index({ edgeId: 1, userIdHash: 1, date: 1 }, { unique: true });
    accessibleEvidenceSchema.index({ expireAt: 1 }, { expireAfterSeconds: 0 });

    // ---- campaigns / ai_guide_cache / geo_settings ----
    const campaignSchema = new Schema({
        scenicId: { type: String, default: 'default' },
        name: String,
        areaPoiIds: [ObjectId],
        multiplier: { type: Number, default: 2 },
        boostWeight: { type: Number, default: 0.15 },
        startAt: Date, endAt: Date,
        state: { type: String, enum: ['draft', 'active', 'ended'], default: 'draft' },
        stats: {
            exposed: { type: Number, default: 0 },
            adopted: { type: Number, default: 0 },
            checkins: { type: Number, default: 0 }
        }
    });

    const aiGuideCacheSchema = new Schema({
        poiId: ObjectId, season: String, daypart: String,
        weatherKind: { type: String, default: 'any' },
        text: String, ttsUrl: String,
        hits: { type: Number, default: 0 },
        createTime: { type: Date, default: Date.now }
    }, { collection: 'ai_guide_cache' });
    aiGuideCacheSchema.index({ poiId: 1, season: 1, daypart: 1, weatherKind: 1 }, { unique: true });

    const geoSettingSchema = new Schema({
        key: { type: String, required: true, unique: true },
        value: Object,
        updateTime: { type: Date, default: Date.now }
    }, { collection: 'geo_settings' });

    // ---- user_points / badges / track_events / trail_fragments ----
    const userPointsSchema = new Schema({
        openId: { type: String, required: true, unique: true },
        balance: { type: Number, default: 0 },
        ledger: [{ at: Date, delta: Number, reason: String, refId: ObjectId }]
    }, { collection: 'user_points' });

    const badgeSchema = new Schema({
        badgeId: { type: String, unique: true },
        scenicId: { type: String, default: 'default' },
        name: String, icon: String,
        poiIds: [ObjectId],
        active: { type: Boolean, default: true }
    });

    const trackEventSchema = new Schema({
        openId: String, event: String, props: Object,
        at: { type: Date, default: Date.now },
        expireAt: Date
    }, { collection: 'track_events' });
    trackEventSchema.index({ event: 1, at: -1 });
    trackEventSchema.index({ expireAt: 1 }, { expireAfterSeconds: 0 });

    const trailFragmentSchema = new Schema({
        scenicId: String,
        points: [[Number]],
        userIdHash: String, date: String,
        matched: { type: Boolean, default: false },
        expireAt: Date
    }, { collection: 'trail_fragments' });
    trailFragmentSchema.index({ matched: 1 });
    trailFragmentSchema.index({ expireAt: 1 }, { expireAfterSeconds: 0 });

    M = {
        ExternalPoi, ExternalUser,
        PhotoSpot: mongoose.model('PhotoSpot', photoSpotSchema),
        StaySample: mongoose.model('StaySample', staySampleSchema),
        CrowdSnapshot: mongoose.model('CrowdSnapshot', crowdSnapshotSchema),
        Itinerary: mongoose.model('Itinerary', itinerarySchema),
        Checkin: mongoose.model('Checkin', checkinSchema),
        CapacityToken: mongoose.model('CapacityToken', capacityTokenSchema),
        Pairing: mongoose.model('Pairing', pairingSchema),
        PairingProfile: mongoose.model('PairingProfile', pairingProfileSchema),
        WalkNode: mongoose.model('WalkNode', walkNodeSchema),
        WalkEdge: mongoose.model('WalkEdge', walkEdgeSchema),
        AccessibleEvidence: mongoose.model('AccessibleEvidence', accessibleEvidenceSchema),
        Campaign: mongoose.model('Campaign', campaignSchema),
        AiGuideCache: mongoose.model('AiGuideCache', aiGuideCacheSchema),
        GeoSetting: mongoose.model('GeoSetting', geoSettingSchema),
        UserPoints: mongoose.model('UserPoints', userPointsSchema),
        Badge: mongoose.model('Badge', badgeSchema),
        TrackEvent: mongoose.model('TrackEvent', trackEventSchema),
        TrailFragment: mongoose.model('TrailFragment', trailFragmentSchema)
    };
    return M;
}

function getModels() {
    if (!M) throw new Error('models not registered — call registerModels(mongoose) first');
    return M;
}

module.exports = { registerModels, getModels, pointSchema };
