'use strict';
// 07文档 §1.1 / 08文档 §5：一键清除仿真数据（sim_ 前缀 openId 的全部关联数据）。

require('dotenv').config();
const mongoose = require('mongoose');
const { registerModels } = require('../models');

async function main() {
    const uri = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/poi';
    await mongoose.connect(uri);
    const M = registerModels(mongoose);
    const simRe = /^sim_/;

    const report = {};
    report.users = (await M.ExternalUser.deleteMany({ openId: simRe })).deletedCount;
    report.itineraries = (await M.Itinerary.deleteMany({ openId: simRe })).deletedCount;
    report.checkins = (await M.Checkin.deleteMany({ openId: simRe })).deletedCount;
    report.userPoints = (await M.UserPoints.deleteMany({ openId: simRe })).deletedCount;
    report.pairings = (await M.Pairing.deleteMany({ 'users.openId': simRe })).deletedCount;
    report.pairingProfiles = (await M.PairingProfile.deleteMany({ openId: simRe })).deletedCount;
    report.trackEvents = (await M.TrackEvent.deleteMany({ openId: simRe })).deletedCount;
    // staysamples 的 userIdHash 无法反查 openId（日轮换 HMAC）→ 只能全清当日或靠 TTL；
    // 仿真通常单独库/演示库，提供 --purge-samples 全清开关
    if (process.argv.includes('--purge-samples')) {
        report.staySamples = (await M.StaySample.deleteMany({})).deletedCount;
        report.crowdSnapshots = (await M.CrowdSnapshot.deleteMany({})).deletedCount;
        report.capacityTokens = (await M.CapacityToken.deleteMany({})).deletedCount;
    }
    console.log('[clean-sim]', JSON.stringify(report, null, 2));
    await mongoose.disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
