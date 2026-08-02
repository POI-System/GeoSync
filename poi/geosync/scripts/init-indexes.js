'use strict';
// 02文档 §13：幂等创建全部索引（含 TTL）。每次部署跑。

require('dotenv').config();
const mongoose = require('mongoose');
const { registerModels } = require('../models');

async function main() {
    const uri = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/poi';
    mongoose.set('autoIndex', false);
    await mongoose.connect(uri);
    const M = registerModels(mongoose);
    for (const [name, model] of Object.entries(M)) {
        if (name.startsWith('External')) continue; // 已有集合不动索引
        try {
            if (name === 'CapacityToken') {
                const indexes = await model.collection.indexes().catch(e => {
                    if (e.codeName === 'NamespaceNotFound') return [];
                    throw e;
                });
                const legacy = indexes.find(index =>
                    index.name !== 'capacity_slot_active_unique' &&
                    JSON.stringify(index.key) === JSON.stringify({
                        scenicId: 1, poiId: 1, timeSlot: 1, capacitySlot: 1
                    }));
                if (legacy) {
                    await model.collection.dropIndex(legacy.name);
                    console.log(`[init-indexes] dropped legacy index ${legacy.name}`);
                }
            }
            await model.createIndexes();
            console.log(`[init-indexes] ${model.collection.name} ok`);
        } catch (e) {
            console.error(`[init-indexes] ${model.collection.name} FAILED:`, e.message);
            process.exitCode = 1;
        }
    }
    await mongoose.disconnect();
    console.log('[init-indexes] done');
}

main().catch(e => { console.error(e); process.exit(1); });
