'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const modelModule = require('../../models');
const checkinService = require('../../services/checkinService');

function query(value) {
    return {
        sort() { return this; },
        lean: async () => value
    };
}

test('checkin upload ownership transfers immediately after Checkin.create', async () => {
    const events = [];
    const frozenFailure = Object.freeze(new Error('post-persist points failure'));
    const ExternalPoi = {
        findById() {
            return query({ _id: 'poi-1', status: 'approved' });
        }
    };
    const models = modelModule.registerModels(new mongoose.Mongoose(), { POI: ExternalPoi });
    const originals = {
        checkinFindOne: models.Checkin.findOne,
        checkinCountDocuments: models.Checkin.countDocuments,
        checkinCreate: models.Checkin.create,
        campaignFindOne: models.Campaign.findOne,
        userPointsFindOne: models.UserPoints.findOne,
        userPointsFindOneAndUpdate: models.UserPoints.findOneAndUpdate
    };

    try {
        models.Checkin.findOne = () => query(null);
        models.Checkin.countDocuments = async () => 0;
        models.Campaign.findOne = () => query(null);
        models.Checkin.create = async () => {
            events.push('persisted');
            return { _id: 'checkin-1' };
        };
        models.UserPoints.findOne = () => query(null);
        models.UserPoints.findOneAndUpdate = async () => {
            events.push('post-persist-failure');
            throw frozenFailure;
        };

        await assert.rejects(checkinService.verify({
            openId: 'user-1',
            poiId: 'poi-1',
            lng: 0,
            lat: 0,
            photoUrl: '/uploads/proof.jpg',
            viaQrCode: true,
            onUploadReferencePersisted: () => { events.push('ownership-transferred'); }
        }), error => error === frozenFailure);
        assert.deepEqual(events, [
            'persisted',
            'ownership-transferred',
            'post-persist-failure'
        ]);
    } finally {
        models.Checkin.findOne = originals.checkinFindOne;
        models.Checkin.countDocuments = originals.checkinCountDocuments;
        models.Checkin.create = originals.checkinCreate;
        models.Campaign.findOne = originals.campaignFindOne;
        models.UserPoints.findOne = originals.userPointsFindOne;
        models.UserPoints.findOneAndUpdate = originals.userPointsFindOneAndUpdate;
    }
});
