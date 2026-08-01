// ===================================================
// 初始化默认管理员账号
// 用法: node init-admin.js
//   或: npm run init-admin
// 管理员账号优先从 .env 的 ADMIN_USERNAME / ADMIN_PASSWORD 读取
// ===================================================

require('dotenv').config();
const mongoose = require('mongoose');

const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/poi_db';
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';

const adminUserSchema = new mongoose.Schema({
    username: { type: String, unique: true },
    password: String
});
const AdminUser = mongoose.model('AdminUser', adminUserSchema);

(async () => {
    try {
        await mongoose.connect(MONGO_URI);
        if (!ADMIN_USERNAME || !ADMIN_PASSWORD) {
            throw new Error('请先在 .env 配置 ADMIN_USERNAME 和 ADMIN_PASSWORD');
        }
        const exist = await AdminUser.findOne({ username: ADMIN_USERNAME });
        if (exist) {
            await AdminUser.updateOne({ username: ADMIN_USERNAME }, { password: ADMIN_PASSWORD });
            console.log('[init] 管理员已更新');
        } else {
            await AdminUser.create({ username: ADMIN_USERNAME, password: ADMIN_PASSWORD });
            console.log('[init] 管理员已创建');
        }
        await mongoose.disconnect();
        process.exit(0);
    } catch (e) {
        console.error('[init] 失败:', e.message);
        process.exit(1);
    }
})();
