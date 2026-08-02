'use strict';
// 02文档 §13：pois 补 geo(2dsphere 冗余) + visitMeta 默认值。P1 上线前一次，幂等。

require('dotenv').config();
const mongoose = require('mongoose');
const { registerModels } = require('../models');

const DEFAULT_VISIT_META = {
    suggestedStayMin: 20,
    baselineStayMin: 20,
    comfortCapacity: 50,
    tags: [],
    sheltered: false,
    openHours: []
};

async function main() {
    const uri = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/poi';
    await mongoose.connect(uri);
    const { ExternalPoi } = registerModels(mongoose);

    const pois = await ExternalPoi.find({}).lean();
    let geoFixed = 0, metaFixed = 0;
    for (const p of pois) {
        const patch = {};
        if (!p.geo?.coordinates && p.location?.lng != null && p.location?.lat != null) {
            patch.geo = { type: 'Point', coordinates: [p.location.lng, p.location.lat] };
            geoFixed++;
        }
        if (!p.visitMeta) {
            patch.visitMeta = DEFAULT_VISIT_META;
            metaFixed++;
        } else {
            const vm = {};
            for (const [k, v] of Object.entries(DEFAULT_VISIT_META)) {
                if (p.visitMeta[k] === undefined) vm[`visitMeta.${k}`] = v;
            }
            if (Object.keys(vm).length) { Object.assign(patch, vm); metaFixed++; }
        }
        if (Object.keys(patch).length) {
            await ExternalPoi.updateOne({ _id: p._id }, { $set: patch });
        }
    }
    // geo 字段 2dsphere 索引（幂等）
    try {
        await ExternalPoi.collection.createIndex({ geo: '2dsphere' }, { sparse: true });
    } catch (e) {
        console.warn('[migrate-poi-geo] 2dsphere index:', e.message);
    }
    console.log(`[migrate-poi-geo] total=${pois.length} geoFixed=${geoFixed} metaFixed=${metaFixed}`);
    await mongoose.disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
