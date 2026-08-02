require('dotenv').config();

const express = require('express');
const mongoose = require('mongoose');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const http = require('http');
const multer = require('multer');
const nodemailer = require('nodemailer');
const { Server } = require('socket.io');
const geosync = require('./geosync');

const Ocr20191230 = require('@alicloud/ocr20191230');
const OcrApi20210707 = require('@alicloud/ocr-api20210707');
const OpenApi = require('@alicloud/openapi-client');
const { RuntimeOptions } = require('@alicloud/tea-util');

const CONFIG = {
    port: Number(process.env.PORT) || 3000,
    host: process.env.HOST || '127.0.0.1',
    publicHost: process.env.PUBLIC_HOST || 'http://localhost:3000',
    mongoUri: process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/poi_db',
    adminToken: String(process.env.ADMIN_TOKEN || '').trim(),
    admin: {
        username: process.env.ADMIN_USERNAME || '',
        password: process.env.ADMIN_PASSWORD || ''
    },
    corsOrigin: process.env.CORS_ORIGIN || process.env.PUBLIC_HOST || 'http://localhost:3000',

    aliyun: {
        accessKeyId: process.env.ALIYUN_AK || '',
        accessKeySecret: process.env.ALIYUN_SK || '',
        endpoint: process.env.ALIYUN_ENDPOINT || 'ocr.cn-shanghai.aliyuncs.com',
        ocrApiEndpoint: process.env.ALIYUN_OCR_API_ENDPOINT || 'ocr-api.cn-hangzhou.aliyuncs.com'
    },

    wechat: {
        appId: process.env.WX_APPID || '',
        appSecret: process.env.WX_SECRET || '',
        templates: {
            auditResult: process.env.TPL_AUDIT_RESULT || '',
            newPoiWait:  process.env.TPL_NEW_POI_WAIT || '',
            adminNotice: process.env.TPL_ADMIN_NOTICE || ''
        }
    },

    amap: {
        key: process.env.AMAP_KEY || '',
        securityCode: process.env.AMAP_SEC || ''
    },

    smtp: {
        host: process.env.SMTP_HOST || '',
        port: Number(process.env.SMTP_PORT) || 465,
        secure: String(process.env.SMTP_SECURE || 'true').toLowerCase() !== 'false',
        user: process.env.SMTP_USER || '',
        pass: process.env.SMTP_PASS || '',
        from: process.env.MAIL_FROM || process.env.SMTP_USER || '',
        defaultTestEmail: process.env.DEFAULT_TEST_EMAIL || ''
    }
};

const ocrEnabled = Boolean(CONFIG.aliyun.accessKeyId && CONFIG.aliyun.accessKeySecret);
const ocrClient = ocrEnabled
    ? new Ocr20191230.default(new OpenApi.Config(CONFIG.aliyun))
    : null;
const ocrApiClient = ocrEnabled
    ? new OcrApi20210707.default(new OpenApi.Config({
        accessKeyId: CONFIG.aliyun.accessKeyId,
        accessKeySecret: CONFIG.aliyun.accessKeySecret,
        endpoint: CONFIG.aliyun.ocrApiEndpoint
    }))
    : null;
const ocrRuntime = new RuntimeOptions({
    readTimeout: Number(process.env.OCR_READ_TIMEOUT) || 15000,
    connectTimeout: Number(process.env.OCR_CONNECT_TIMEOUT) || 5000
});
if (!ocrEnabled) console.warn('[OCR] 未配置阿里云 AK/SK,自动分类将跳过');

mongoose.set('bufferCommands', false);

mongoose.connect(CONFIG.mongoUri, {
    serverSelectionTimeoutMS: 5000
})
    .then(() => console.log('[DB] MongoDB connected'))
    .catch(e => console.error('[DB] connect failed:', e.message));

const userSchema = new mongoose.Schema({
    openId: { type: String, required: true, unique: true, index: true, trim: true },
    nickname: { type: String, default: '' },
    role: { type: String, enum: ['collector', 'reviewer', 'thirdParty'], default: 'collector' },
    reviewerSubscribed: { type: Boolean, default: false }
});
const User = mongoose.model('User', userSchema);

const adminUserSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true, trim: true },
    password: { type: String, required: true }
});
const AdminUser = mongoose.model('AdminUser', adminUserSchema);

const poiSchema = new mongoose.Schema({
    poiName: { type: String, required: true, trim: true },
    category: { type: String, default: '待分类', trim: true },
    description: { type: String, default: '', trim: true },
    imageUrl: { type: String, required: true },
    userOpenId: { type: String, required: true, index: true, trim: true },
    reviewerId: { type: String, default: '' },
    location: { lng: Number, lat: Number },
    status: { type: String, default: 'pending', enum: ['pending', 'approved', 'rejected'], index: true },
    rejectReason: { type: String, default: '' },
    createTime: { type: Date, default: Date.now }
});
const POI = mongoose.model('POI', poiSchema);

const notificationSchema = new mongoose.Schema({
    recipientOpenId: { type: String, required: true, index: true, trim: true },
    type: { type: String, enum: ['audit', 'system', 'task'], default: 'system', index: true },
    title: { type: String, required: true, trim: true },
    content: { type: String, default: '', trim: true },
    poiId: { type: mongoose.Schema.Types.ObjectId, ref: 'POI' },
    poiName: { type: String, default: '', trim: true },
    status: { type: String, default: '' },
    read: { type: Boolean, default: false, index: true },
    createTime: { type: Date, default: Date.now, index: true }
});
const Notification = mongoose.model('Notification', notificationSchema);

const chatMessageSchema = new mongoose.Schema({
    roomId: { type: String, required: true, index: true, trim: true },
    fromOpenId: { type: String, required: true, index: true, trim: true },
    user: { type: String, default: '匿名', trim: true },
    text: { type: String, required: true, trim: true },
    createTime: { type: Date, default: Date.now, index: true }
});
const ChatMessage = mongoose.model('ChatMessage', chatMessageSchema);

const chatRoomSchema = new mongoose.Schema({
    roomId: { type: String, required: true, unique: true, index: true, trim: true },
    type: { type: String, enum: ['audit'], default: 'audit', index: true },
    poiId: { type: mongoose.Schema.Types.ObjectId, ref: 'POI', index: true },
    poiName: { type: String, default: '', trim: true },
    collectorOpenId: { type: String, required: true, index: true, trim: true },
    reviewerOpenId: { type: String, required: true, index: true, trim: true },
    collectorName: { type: String, default: '', trim: true },
    reviewerName: { type: String, default: '', trim: true },
    status: { type: String, default: '' },
    lastMessage: { type: String, default: '', trim: true },
    lastTime: { type: Date, default: Date.now, index: true },
    createTime: { type: Date, default: Date.now, index: true }
});
const ChatRoom = mongoose.model('ChatRoom', chatRoomSchema);

const systemSettingSchema = new mongoose.Schema({
    key: { type: String, required: true, unique: true, index: true, trim: true },
    collectionPaused: { type: Boolean, default: false },
    thirdPartyEmail: { type: String, default: '', trim: true },
    updateTime: { type: Date, default: Date.now }
});
const SystemSetting = mongoose.model('SystemSetting', systemSettingSchema);

const disputeSchema = new mongoose.Schema({
    poiId: { type: mongoose.Schema.Types.ObjectId, ref: 'POI', required: true, index: true },
    collectorOpenId: { type: String, required: true, index: true, trim: true },
    reviewerOpenId: { type: String, default: '', trim: true },
    reason: { type: String, default: '', trim: true },
    thirdPartyEmail: { type: String, default: '', trim: true },
    tokenHash: { type: String, required: true, unique: true, index: true },
    status: { type: String, enum: ['pending', 'resolved'], default: 'pending', index: true },
    finalAction: { type: String, enum: ['', 'approved', 'rejected'], default: '' },
    finalOpinion: { type: String, default: '', trim: true },
    createTime: { type: Date, default: Date.now, index: true },
    resolveTime: { type: Date }
});
const Dispute = mongoose.model('Dispute', disputeSchema);

let cachedToken = { token: null, expireAt: 0 };

async function getAccessToken() {
    if (Date.now() < cachedToken.expireAt && cachedToken.token) {
        return cachedToken.token;
    }
    const r = await axios.get('https://api.weixin.qq.com/cgi-bin/token', {
        params: {
            grant_type: 'client_credential',
            appid: CONFIG.wechat.appId,
            secret: CONFIG.wechat.appSecret
        },
        timeout: 8000
    });
    if (!r.data.access_token) {
        throw new Error('access_token error: ' + JSON.stringify(r.data));
    }
    cachedToken = {
        token: r.data.access_token,
        expireAt: Date.now() + (r.data.expires_in - 300) * 1000
    };
    return cachedToken.token;
}

async function sendTemplate(openId, templateId, data = {}) {
    if (!templateId || !openId) return;
    try {
        const token = await getAccessToken();
        const r = await axios.post(
            `https://api.weixin.qq.com/cgi-bin/message/template/send?access_token=${token}`,
            { touser: openId, template_id: templateId, data },
            { timeout: 8000 }
        );
        if (r.data.errcode !== 0) {
            console.warn('[Template Fail]', openId, r.data);
        }
        return r.data;
    } catch (e) {
        console.error('[Template Error]', e.message);
    }
}

const app = express();
const server = http.createServer(app);

app.set('trust proxy', true);
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

app.get('/api/client-config', (_req, res) => {
    res.json({
        success: true,
        amap: {
            key: CONFIG.amap.key,
            securityCode: CONFIG.amap.securityCode
        }
    });
});

const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
const uploadStorage = multer.diskStorage({
    destination: uploadDir,
    filename: (_req, file, cb) => {
        const ext = file.mimetype === 'image/png' ? '.png' : '.jpg';
        cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`);
    }
});
const upload = multer({
    storage: uploadStorage,
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
        if (['image/jpeg', 'image/png'].includes(file.mimetype)) return cb(null, true);
        cb(new Error('仅支持 jpeg/png 图片'));
    }
});

function uploadPoiImage(req, res, next) {
    upload.single('poiImage')(req, res, (err) => {
        if (!err) return next();
        const message = err.code === 'LIMIT_FILE_SIZE' ? '图片不能超过 10MB' : (err.message || '图片上传失败');
        return res.status(400).json({ success: false, message });
    });
}

function cleanupUploadedFile(file) {
    if (!file || !file.path) return;
    fs.unlink(file.path, (err) => {
        if (err && err.code !== 'ENOENT') console.warn('[Upload Cleanup]', err.message);
    });
}

const VALID_ROLES = new Set(['collector', 'reviewer', 'thirdParty']);
const DEFAULT_CATEGORY = '待分类';
const CATEGORY_RULES = [
    { name: '农贸生鲜', pattern: /农贸|菜场|菜市场|水产|肉铺|鲜肉|海鲜|粮油|生鲜市场/ },
    { name: '文体娱乐', pattern: /影院|电影院|影城|KTV|酒吧|网吧|电竞|健身|瑜伽|游泳|台球|棋牌|剧本杀|密室|体育馆|球馆|运动|游乐|电玩城|音乐|舞蹈/ },
    { name: '餐饮', pattern: /餐|饭|面|粉|菜|馆|饭店|餐厅|酒楼|火锅|烧烤|咖啡|奶茶|茶饮|甜品|食堂|小吃|快餐|早餐|烘焙|蛋糕|海底捞|肯德基|麦当劳|必胜客|星巴克|瑞幸/ },
    { name: '购物零售', pattern: /超市|便利店|便利|商场|百货|购物中心|商业广场|生鲜|水果|蔬果|粮油|副食|烟酒|母婴|服装|鞋|箱包|眼镜|珠宝|金店|花店|书店|文具|电器|手机|数码|电脑|家居|家具|建材|五金|市场|卖场|小卖部/ },
    { name: '医疗健康', pattern: /医院|诊所|药房|药店|门诊|口腔|牙科|体检|中医|妇幼|疾控|卫生院|卫生室|护理|康复|眼科|宠物医院/ },
    { name: '教育培训', pattern: /学校|教育|学院|幼儿园|托育|早教|培训|大学|中学|小学|驾校|琴行|画室|自习室|图书馆|实验室|研究所|研究院|科研|校区/ },
    { name: '酒店住宿', pattern: /酒店|宾馆|旅馆|旅店|客栈|民宿|青旅|招待所|公寓|住宿|度假村/ },
    { name: '交通出行', pattern: /公交|地铁|轻轨|火车站|高铁站|客运站|汽车站|机场|码头|停车场|停车|加油站|加油|充电站|充电桩|修车|汽修|洗车|轮胎|4S店|汽车服务/ },
    { name: '金融服务', pattern: /银行|信用社|农商行|证券|保险|基金|期货|担保|典当|ATM|自助银行/ },
    { name: '生活服务', pattern: /快递|邮政|菜鸟|顺丰|中通|圆通|韵达|申通|维修|家政|开锁|干洗|洗衣|理发|美发|美容|美甲|摄影|照相|打印|复印|广告|婚庆|搬家|回收/ },
    { name: '旅游景点', pattern: /景区|景点|公园|博物馆|纪念馆|展览馆|美术馆|文化馆|动物园|植物园|广场|古镇|寺|庙|山庄|游客中心/ },
    { name: '政务公共', pattern: /政府|政务|公安|派出所|交警|法院|检察院|税务|社保|医保|公积金|居委会|社区服务|办事处|消防|邮局/ },
    { name: '商务办公', pattern: /公司|企业|集团|办公楼|写字楼|产业园|科技园|孵化器|众创|商务中心|会议中心|园区/ },
    { name: '住宅房产', pattern: /小区|社区|花园|家园|公馆|府邸|苑|别墅|售楼|房产|地产|物业|公寓/ },
    { name: '宗教场所', pattern: /教堂|清真寺|寺庙|道观|佛堂|基督|天主|礼拜/ },
    { name: '零售门店', pattern: /门店|店铺|专卖店|体验店|旗舰店|连锁店|店/ }
];
const VALID_CATEGORY_NAMES = new Set([...CATEGORY_RULES.map(item => item.name), '其他']);

function extractManualCategory(description) {
    const lines = String(description || '').split(/\r?\n/);
    for (const line of lines) {
        const match = line.match(/^人工分类[:：]\s*(.+)$/);
        if (match && VALID_CATEGORY_NAMES.has(match[1].trim())) return match[1].trim();
    }
    return '';
}

function classifyPoiCategory(text) {
    const content = String(text || '').trim();
    if (!content) return DEFAULT_CATEGORY;
    const rule = CATEGORY_RULES.find(item => item.pattern.test(content));
    return rule ? rule.name : '其他';
}

function extractOcrText(resp) {
    const data = resp && resp.body && resp.body.data;
    if (!data) return '';
    if (typeof data.content === 'string') return data.content;
    if (typeof data === 'string') {
        try {
            const parsed = JSON.parse(data);
            if (Array.isArray(parsed.prism_wordsInfo)) {
                return parsed.prism_wordsInfo
                    .map(item => item && item.word)
                    .filter(Boolean)
                    .join('\n');
            }
            if (Array.isArray(parsed.wordsInfo)) {
                return parsed.wordsInfo
                    .map(item => item && (item.word || item.text))
                    .filter(Boolean)
                    .join('\n');
            }
        } catch (_e) {
            return data;
        }
    }
    if (Array.isArray(data.results)) {
        return data.results
            .map(item => item && item.text)
            .filter(Boolean)
            .join('\n');
    }
    if (Array.isArray(data.signboards)) {
        return data.signboards
            .flatMap(board => Array.isArray(board.texts) ? board.texts : [])
            .map(item => item && item.text)
            .filter(Boolean)
            .join('\n');
    }
    return '';
}

async function recognizeUploadedImageText(file) {
    const publicHost = CONFIG.publicHost.replace(/\/+$/, '');
    const publicImageUrl = `${publicHost}/uploads/${file.filename}`;
    if (ocrApiClient) {
        try {
            const request = new OcrApi20210707.RecognizeAllTextRequest({
                body: fs.createReadStream(file.path),
                type: 'General'
            });
            const resp = await ocrApiClient.recognizeAllTextWithOptions(request, ocrRuntime);
            const text = extractOcrText(resp);
            if (text) return text;
        } catch (e) {
            console.warn('[OCR RecognizeAllText Skip]', e.message);
        }
    }
    const request = new Ocr20191230.RecognizeCharacterRequest({
        imageURL: publicImageUrl
    });
    const resp = await ocrClient.recognizeCharacter(request, ocrRuntime);
    return extractOcrText(resp);
}

async function recognizeGeoSyncPhoto(photoUrl) {
    if (!ocrEnabled || typeof photoUrl !== 'string') return '';
    const match = /^\/uploads\/([A-Za-z0-9._-]+)$/.exec(photoUrl);
    if (!match) return '';
    const filename = path.basename(match[1]);
    const filePath = path.join(uploadDir, filename);
    if (!fs.existsSync(filePath)) return '';
    return recognizeUploadedImageText({ filename, path: filePath });
}

function parseCoordinate(value) {
    const n = Number.parseFloat(value);
    return Number.isFinite(n) ? n : null;
}

async function classifyPoiFromUpload(file, poiName, description) {
    const manualCategory = extractManualCategory(description);
    if (manualCategory) return manualCategory;
    const result = await classifyPoiFromImage(file, poiName, description);
    return result.category;
}

async function classifyPoiFromImage(file, poiName, description) {
    let ocrText = '';
    let ocrError = '';
    if (file && ocrEnabled) {
        try {
            ocrText = await recognizeUploadedImageText(file);
        } catch (e) {
            ocrError = e.message || 'OCR failed';
            console.warn('[OCR Skip]', e.message);
        }
    }
    return {
        category: classifyPoiCategory(`${ocrText}\n${poiName}\n${description || ''}`),
        ocrText,
        ocrUsed: Boolean(ocrText),
        ocrError
    };
}

function cleanupLocalImageUrl(imageUrl) {
    if (!imageUrl || !imageUrl.startsWith('/uploads/')) return;
    const filename = path.basename(imageUrl);
    if (!filename) return;
    const uploadRoot = path.resolve(uploadDir);
    const target = path.resolve(uploadRoot, filename);
    if (!target.startsWith(uploadRoot + path.sep)) return;
    fs.unlink(target, (err) => {
        if (err && err.code !== 'ENOENT') console.warn('[Image Cleanup]', err.message);
    });
}

function formatTime(date = new Date()) {
    return new Date(date).toLocaleTimeString('zh-CN', { hour12: false });
}

function formatDateTime(date = new Date()) {
    const value = new Date(date);
    const safeDate = Number.isNaN(value.getTime()) ? new Date() : value;
    return safeDate.toLocaleString('zh-CN', { hour12: false });
}

function buildTemplateData(fields) {
    return Object.fromEntries(
        Object.entries(fields).map(([key, value]) => [
            key,
            { value: String(value ?? '').slice(0, 200) }
        ])
    );
}

function isLikelyWechatOpenId(openId) {
    return /^o[A-Za-z0-9_-]{20,}$/.test(String(openId || '').trim());
}

async function getReviewerTemplateOpenIds() {
    const reviewers = await User.find(
        { $or: [{ role: 'reviewer' }, { reviewerSubscribed: true }] },
        { openId: 1 }
    ).lean();
    const openIds = [...new Set(
        reviewers
            .map(user => String(user.openId || '').trim())
            .filter(isLikelyWechatOpenId)
    )];
    const skipped = reviewers.length - openIds.length;
    if (skipped > 0) {
        console.warn(`[Template Skip] skipped ${skipped} invalid reviewer openId(s)`);
    }
    if (openIds.length === 0) {
        console.warn('[Template Skip] no valid reviewer openId; open the reviewer menu once to subscribe a real WeChat user');
    }
    return openIds;
}

function serializePoi(item) {
    return {
        id: String(item._id),
        _id: String(item._id),
        poiName: item.poiName || '',
        name: item.poiName || '',
        category: item.category || '',
        description: item.description || '',
        imageUrl: item.imageUrl || '',
        userOpenId: item.userOpenId || '',
        reviewerId: item.reviewerId || '',
        lng: item.location && Number.isFinite(Number(item.location.lng)) ? Number(item.location.lng) : null,
        lat: item.location && Number.isFinite(Number(item.location.lat)) ? Number(item.location.lat) : null,
        location: item.location || {},
        status: item.status || '',
        rejectReason: item.rejectReason || '',
        createTime: item.createTime
    };
}

function getAdminToken(req) {
    const auth = String(req.headers.authorization || '').trim();
    if (auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
    return String(req.query.adminToken || req.body?.adminToken || '').trim();
}

function requireAdmin(req, res, next) {
    if (!CONFIG.adminToken || getAdminToken(req) !== CONFIG.adminToken) {
        return res.status(403).json({ success: false, message: '管理员权限无效' });
    }
    next();
}

async function getSystemSetting() {
    return SystemSetting.findOneAndUpdate(
        { key: 'global' },
        { $setOnInsert: { key: 'global', collectionPaused: false, thirdPartyEmail: '' }, $set: { updateTime: new Date() } },
        { upsert: true, new: true, setDefaultsOnInsert: true }
    );
}

async function isCollectionPaused() {
    const setting = await getSystemSetting();
    return Boolean(setting.collectionPaused);
}

function isRoleGroupRoom(roomId) {
    return roomId === 'collector_group' || roomId === 'reviewer_group';
}

function groupRoomForRole(role) {
    return role === 'reviewer' ? 'reviewer_group' : 'collector_group';
}

function socketRoomForGroup(roomId) {
    return `chat_${roomId}`;
}

function canAccessRoom(role, roomId) {
    if (!isRoleGroupRoom(roomId)) return false;
    return groupRoomForRole(role) === roomId;
}

function mailerReady() {
    return Boolean(CONFIG.smtp.host && CONFIG.smtp.user && CONFIG.smtp.pass && CONFIG.smtp.from);
}

function createMailer() {
    if (!mailerReady()) return null;
    return nodemailer.createTransport({
        host: CONFIG.smtp.host,
        port: CONFIG.smtp.port,
        secure: CONFIG.smtp.secure,
        auth: { user: CONFIG.smtp.user, pass: CONFIG.smtp.pass }
    });
}

async function sendGeoSyncMail(to, subject, body) {
    if (!isEmail(to)) return;
    const mailer = createMailer();
    if (!mailer) return;
    return mailer.sendMail({
        from: CONFIG.smtp.from,
        to,
        subject: String(subject || '').slice(0, 160),
        text: String(body || '')
    });
}

function isEmail(value) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim());
}

function hashDisputeToken(token) {
    return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function generateDisputeToken() {
    return crypto.randomBytes(24).toString('hex');
}

function portalUrlWithDisputeToken(token) {
    const base = CONFIG.publicHost.replace(/\/+$/, '');
    return `${base}/portal.html?disputeToken=${encodeURIComponent(token)}`;
}

function buildPoiEmail(poi) {
    const data = serializePoi(poi);
    return [
        '提醒: 该点存在问题，请重新采集并核验。',
        '',
        `点位名称: ${data.poiName}`,
        `状态: ${data.status}`,
        `分类: ${data.category || '未分类'}`,
        `坐标: ${data.lat ?? ''}, ${data.lng ?? ''}`,
        `采集者: ${data.userOpenId}`,
        `审核者: ${data.reviewerId || '无'}`,
        `审核意见: ${data.rejectReason || '无'}`,
        `图片: ${data.imageUrl ? CONFIG.publicHost.replace(/\/+$/, '') + data.imageUrl : '无'}`,
        `创建时间: ${data.createTime ? new Date(data.createTime).toLocaleString('zh-CN', { hour12: false }) : ''}`,
        '',
        '描述:',
        data.description || '无'
    ].join('\n');
}

function buildDisputeEmail(poi, dispute, token) {
    const data = serializePoi(poi);
    return [
        '该点存在问题，请重新采集并核验。',
        '',
        `点位名称: ${data.poiName}`,
        `状态: ${data.status}`,
        `分类: ${data.category || '未分类'}`,
        `坐标: ${data.lat ?? ''}, ${data.lng ?? ''}`,
        `采集者: ${data.userOpenId}`,
        `审核者: ${data.reviewerId || dispute.reviewerOpenId || '无'}`,
        `原审核意见: ${data.rejectReason || '无'}`,
        `异议说明: ${dispute.reason || '无'}`,
        `图片: ${data.imageUrl ? CONFIG.publicHost.replace(/\/+$/, '') + data.imageUrl : '无'}`,
        '',
        '采集说明:',
        data.description || '无',
        '',
        `处理链接: ${portalUrlWithDisputeToken(token)}`
    ].join('\n');
}

function serializeDispute(dispute, poi) {
    return {
        id: String(dispute._id),
        poiId: dispute.poiId ? String(dispute.poiId) : '',
        collectorOpenId: dispute.collectorOpenId || '',
        reviewerOpenId: dispute.reviewerOpenId || '',
        reason: dispute.reason || '',
        thirdPartyEmail: dispute.thirdPartyEmail || '',
        status: dispute.status || '',
        finalAction: dispute.finalAction || '',
        finalOpinion: dispute.finalOpinion || '',
        createTime: dispute.createTime,
        resolveTime: dispute.resolveTime,
        poi: poi ? serializePoi(poi) : null
    };
}

async function getThirdPartyEmail() {
    const setting = await getSystemSetting();
    return String(setting.thirdPartyEmail || CONFIG.smtp.defaultTestEmail || '').trim();
}

function serializeNotification(item) {
    return {
        id: String(item._id),
        recipientOpenId: item.recipientOpenId,
        type: item.type,
        title: item.title,
        content: item.content,
        poiId: item.poiId ? String(item.poiId) : '',
        poiName: item.poiName || '',
        status: item.status || '',
        read: Boolean(item.read),
        createTime: item.createTime,
        time: item.createTime ? new Date(item.createTime).toLocaleString('zh-CN', { hour12: false }) : ''
    };
}

function serializeChatMessage(item) {
    return {
        id: String(item._id),
        roomId: item.roomId,
        user: item.user || '匿名',
        text: item.text,
        openId: item.fromOpenId,
        createTime: item.createTime,
        time: formatTime(item.createTime)
    };
}

function serializeChatRoom(item) {
    return {
        id: item.roomId,
        roomId: item.roomId,
        type: item.type,
        poiId: item.poiId ? String(item.poiId) : '',
        poiName: item.poiName || '',
        collectorOpenId: item.collectorOpenId,
        reviewerOpenId: item.reviewerOpenId,
        collectorName: item.collectorName || '',
        reviewerName: item.reviewerName || '',
        status: item.status || '',
        lastMessage: item.lastMessage || '',
        lastTime: item.lastTime,
        time: item.lastTime ? formatTime(item.lastTime) : ''
    };
}

function makeAuditRoomId(poiId, collectorOpenId, reviewerOpenId) {
    return `audit_${poiId}_${crypto.createHash('sha1').update(`${collectorOpenId}|${reviewerOpenId}`).digest('hex').slice(0, 12)}`;
}

async function userLabel(openId, fallback) {
    if (!openId) return fallback;
    const user = await User.findOne({ openId }, { nickname: 1, role: 1 }).lean();
    if (user && user.nickname) return user.nickname;
    return fallback;
}

async function getOrCreateAuditRoom(poi, reviewerOpenId) {
    const roomId = makeAuditRoomId(poi._id, poi.userOpenId, reviewerOpenId || 'unknown_reviewer');
    const collectorName = await userLabel(poi.userOpenId, `采集者-${String(poi.userOpenId).slice(-4)}`);
    const reviewerName = await userLabel(reviewerOpenId, `核验者-${String(reviewerOpenId || '').slice(-4) || '未知'}`);
    const room = await ChatRoom.findOneAndUpdate(
        { roomId },
        {
            roomId,
            type: 'audit',
            poiId: poi._id,
            poiName: poi.poiName,
            collectorOpenId: poi.userOpenId,
            reviewerOpenId: reviewerOpenId || '',
            collectorName,
            reviewerName,
            status: poi.status || ''
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    return room;
}

async function saveChatMessage({ roomId, fromOpenId, user, text }) {
    const msg = await ChatMessage.create({ roomId, fromOpenId, user, text });
    const update = { lastMessage: text, lastTime: msg.createTime };
    if (!isRoleGroupRoom(roomId)) {
        await ChatRoom.updateOne({ roomId }, update);
    }
    return msg;
}

async function createNotification(payload) {
    const item = await Notification.create(payload);
    const data = serializeNotification(item);
    if (io) io.to(`user_${data.recipientOpenId || payload.recipientOpenId}`).emit('notification', data);
    return data;
}

async function broadcastNotification({ audience = 'all', title, content, type = 'system' }) {
    const allowedAudiences = new Set(['all', 'collector', 'reviewer']);
    const targetAudience = allowedAudiences.has(audience) ? audience : 'all';
    const query = targetAudience === 'all' ? {} : { role: targetAudience };
    const users = await User.find(query, { openId: 1 }).lean();
    const uniqueOpenIds = [...new Set(users.map(u => String(u.openId || '').trim()).filter(Boolean))];
    const docs = uniqueOpenIds.map(openId => ({
        recipientOpenId: openId,
        type,
        title,
        content
    }));
    if (!docs.length) {
        return { audience: targetAudience, count: 0, notifications: [] };
    }
    const created = await Notification.insertMany(docs, { ordered: false });
    const notifications = created.map(serializeNotification);
    if (io) {
        notifications.forEach(item => io.to(`user_${item.recipientOpenId}`).emit('notification', item));
        io.emit('announcement', { audience: targetAudience, title, content });
    }
    await Promise.allSettled(uniqueOpenIds.map(openId =>
        sendTemplate(openId, CONFIG.wechat.templates.adminNotice, buildTemplateData({
            title: title || '管理员公告',
            content,
            time: formatDateTime(new Date())
        }))
    ));
    return { audience: targetAudience, count: notifications.length, notifications };
}

app.post('/api/user/bind-role', async (req, res) => {
    try {
        const { openId, role } = req.body;
        if (!openId || !role || !VALID_ROLES.has(role)) {
            return res.status(400).json({ success: false, message: '参数不足' });
        }
        const update = { role };
        if (role === 'reviewer') update.reviewerSubscribed = true;
        await User.findOneAndUpdate(
            { openId },
            { $set: update },
            { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true }
        );
        res.json({ success: true, message: '绑定成功' });
    } catch (e) {
        console.error('[bind-role]', e.message);
        res.status(500).json({ success: false, message: '服务器错误' });
    }
});

app.post('/api/admin/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        if (!username || !password) {
            return res.status(400).json({ success: false, message: '参数不足' });
        }
        if (!CONFIG.admin.username || !CONFIG.admin.password || !CONFIG.adminToken) {
            return res.status(500).json({ success: false, message: '管理员账号未配置' });
        }
        const envAdminMatched = username === CONFIG.admin.username && password === CONFIG.admin.password;
        if (envAdminMatched) {
            res.json({ success: true, token: CONFIG.adminToken });
        } else {
            res.json({ success: false, message: '账号密码错误' });
        }
    } catch (e) {
        res.status(500).json({ success: false, message: '服务器错误' });
    }
});

app.post('/api/ocr/classify', uploadPoiImage, async (req, res) => {
    try {
        const { poiName, description } = req.body;
        if (!req.file) {
            return res.status(400).json({ success: false, message: '请上传图片' });
        }
        const result = await classifyPoiFromImage(req.file, poiName || '', description || '');
        cleanupUploadedFile(req.file);
        res.json({ success: true, ...result });
    } catch (e) {
        cleanupUploadedFile(req.file);
        console.error('[ocr-classify]', e.message);
        res.status(500).json({ success: false, message: 'OCR 识别失败' });
    }
});

app.post('/api/submit-poi', uploadPoiImage, async (req, res) => {
    try {
        if (await isCollectionPaused()) {
            cleanupUploadedFile(req.file);
            return res.status(423).json({ success: false, message: '采集已暂停，请等待管理员开放采集' });
        }
        const { poiName, description, lng, lat, userOpenId } = req.body;
        const parsedLng = parseCoordinate(lng);
        const parsedLat = parseCoordinate(lat);
        if (!poiName || !lng || !lat || !userOpenId || !req.file) {
            cleanupUploadedFile(req.file);
            return res.status(400).json({ success: false, message: '参数不足' });
        }
        if (parsedLng === null || parsedLat === null) {
            cleanupUploadedFile(req.file);
            return res.status(400).json({ success: false, message: '经纬度格式错误' });
        }

        const aiCat = await classifyPoiFromUpload(req.file, poiName, description);

        const poi = new POI({
            poiName,
            description,
            userOpenId,
            category: aiCat,
            location: { lng: parsedLng, lat: parsedLat },
            imageUrl: req.file ? `/uploads/${req.file.filename}` : ''
        });
        await poi.save();

        
        const reviewerOpenIds = await getReviewerTemplateOpenIds();
        for (const reviewerOpenId of reviewerOpenIds) {
            sendTemplate(reviewerOpenId, CONFIG.wechat.templates.newPoiWait, buildTemplateData({
                poi: poi.poiName,
                user: userOpenId,
                time: formatDateTime(poi.createTime)
            }));
        }

        
        if (io) {
            io.to('reviewer_group').emit('newPoi', { poiId: poi._id, poiName });
            io.to(socketRoomForGroup('reviewer_group')).emit('newPoi', { poiId: poi._id, poiName });
        }

        res.json({ success: true, aiCategory: aiCat, id: poi._id });
    } catch (e) {
        console.error('[submit-poi]', e.message);
        res.status(500).json({ success: false, message: '提交失败' });
    }
});

app.post('/api/poi/update', uploadPoiImage, async (req, res) => {
    try {
        if (await isCollectionPaused()) {
            cleanupUploadedFile(req.file);
            return res.status(423).json({ success: false, message: '采集已暂停，请等待管理员开放采集' });
        }
        const { id, poiName, description, lng, lat, userOpenId } = req.body;
        const parsedLng = parseCoordinate(lng);
        const parsedLat = parseCoordinate(lat);
        if (!id || !mongoose.isValidObjectId(id) || !poiName || lng === undefined || lat === undefined || !userOpenId) {
            cleanupUploadedFile(req.file);
            return res.status(400).json({ success: false, message: '参数不足' });
        }
        if (parsedLng === null || parsedLat === null) {
            cleanupUploadedFile(req.file);
            return res.status(400).json({ success: false, message: '经纬度格式错误' });
        }

        const poi = await POI.findOne({ _id: id, userOpenId, status: 'rejected' });
        if (!poi) {
            cleanupUploadedFile(req.file);
            const existing = await POI.findById(id);
            const message = existing ? '只有被驳回且属于自己的点位可以修改更新' : '点位不存在';
            return res.status(existing ? 400 : 404).json({ success: false, message });
        }

        const oldImageUrl = poi.imageUrl;
        const aiCat = await classifyPoiFromUpload(req.file, poiName, description);
        poi.poiName = poiName;
        poi.description = description || '';
        poi.category = aiCat;
        poi.location = { lng: parsedLng, lat: parsedLat };
        poi.status = 'pending';
        poi.rejectReason = '';
        poi.reviewerId = '';
        if (req.file) poi.imageUrl = `/uploads/${req.file.filename}`;
        await poi.save();

        if (req.file && oldImageUrl !== poi.imageUrl) cleanupLocalImageUrl(oldImageUrl);

        const reviewerOpenIds = await getReviewerTemplateOpenIds();
        for (const reviewerOpenId of reviewerOpenIds) {
            sendTemplate(reviewerOpenId, CONFIG.wechat.templates.newPoiWait, buildTemplateData({
                poi: poi.poiName,
                user: userOpenId,
                time: formatDateTime(poi.createTime)
            }));
        }

        if (io) {
            io.to('reviewer_group').emit('newPoi', { poiId: poi._id, poiName: poi.poiName, updated: true });
            io.to(socketRoomForGroup('reviewer_group')).emit('newPoi', { poiId: poi._id, poiName: poi.poiName, updated: true });
            io.to(`user_${poi.userOpenId}`).emit('poiStatusChanged', {
                poiId: poi._id,
                poiName: poi.poiName,
                status: 'pending',
                rejectReason: ''
            });
        }

        res.json({ success: true, aiCategory: aiCat, id: poi._id });
    } catch (e) {
        cleanupUploadedFile(req.file);
        console.error('[update-poi]', e.message);
        res.status(500).json({ success: false, message: '更新提交失败' });
    }
});

app.post('/api/admin/approve-poi', async (req, res) => {
    try {
        const { id, action, rejectReason, openId } = req.body;
        if (!id || !mongoose.isValidObjectId(id) || !['approved', 'rejected'].includes(action)) {
            return res.status(400).json({ success: false, message: '参数错误' });
        }
        if (action === 'rejected' && !String(rejectReason || '').trim()) {
            return res.status(400).json({ success: false, message: '驳回原因不能为空' });
        }

        const poi = await POI.findOneAndUpdate(
            { _id: id, status: 'pending' },
            { status: action, rejectReason: rejectReason || '', reviewerId: openId || '' },
            { new: true, runValidators: true }
        );
        if (!poi) {
            const existing = await POI.findById(id);
            const message = existing ? '点位已审核' : '点位不存在';
            return res.status(existing ? 400 : 404).json({ success: false, message });
        }

        const statusText = action === 'approved' ? '已通过' : '被拒绝';
        const notificationTitle = action === 'approved' ? '审核已通过' : '审核被驳回';
        const notificationContent = action === 'approved'
            ? `你提交的「${poi.poiName}」已通过核验。`
            : `你提交的「${poi.poiName}」被驳回。原因：${rejectReason || '无'}`;
        await createNotification({
            recipientOpenId: poi.userOpenId,
            type: 'audit',
            title: notificationTitle,
            content: notificationContent,
            poiId: poi._id,
            poiName: poi.poiName,
            status: action
        });

        const auditRoom = await getOrCreateAuditRoom(poi, openId || 'unknown_reviewer');
        auditRoom.status = action;
        auditRoom.poiName = poi.poiName;
        await auditRoom.save();
        const auditChatText = action === 'approved'
            ? `审核完毕：你提交的「${poi.poiName}」已通过核验。`
            : `审核完毕：你提交的「${poi.poiName}」已被驳回。审批意见：${rejectReason || '无'}`;
        const auditChat = await saveChatMessage({
            roomId: auditRoom.roomId,
            fromOpenId: openId || 'system_reviewer',
            user: auditRoom.reviewerName || '核验者',
            text: auditChatText
        });

        await sendTemplate(poi.userOpenId, CONFIG.wechat.templates.auditResult, buildTemplateData({
            result: statusText,
            time: formatDateTime(new Date()),
            remark: action === 'approved' ? `点位「${poi.poiName}」已通过审核` : (rejectReason || '无')
        }));

        if (io) {
            io.to(`chat_${auditRoom.roomId}`).emit('chatMessage', serializeChatMessage(auditChat));
            io.to(`user_${poi.userOpenId}`).emit('chatRoomUpdated', serializeChatRoom(auditRoom));
            if (openId) io.to(`user_${openId}`).emit('chatRoomUpdated', serializeChatRoom(auditRoom));
            io.to(`user_${poi.userOpenId}`).emit('poiStatusChanged', {
                poiId: poi._id,
                poiName: poi.poiName,
                status: action,
                rejectReason: rejectReason || ''
            });
            if (action === 'approved') {
                io.emit('poiStatusChanged', {
                    poiId: poi._id,
                    poiName: poi.poiName,
                    status: action,
                    public: true
                });
            }
        }

        res.json({ success: true });
    } catch (e) {
        console.error('[approve-poi]', e.message);
        res.status(500).json({ success: false, message: '操作失败' });
    }
});

app.get('/api/poi/all', async (_req, res) => {
    try {
        const data = await POI.find({ status: 'approved' }).sort({ createTime: -1 });
        res.json({ success: true, data });
    } catch (e) {
        res.status(500).json({ success: false, message: '查询失败' });
    }
});

app.get('/api/poi/my', async (req, res) => {
    try {
        const openId = String(req.query.openId || req.query.openid || '').trim();
        if (!openId) {
            return res.status(400).json({ success: false, message: '缺少 openId' });
        }
        const page = Math.max(Number.parseInt(req.query.page, 10) || 1, 1);
        const size = Math.min(Math.max(Number.parseInt(req.query.size, 10) || 50, 1), 100);
        const data = await POI.find({ userOpenId: openId })
            .sort({ createTime: -1 })
            .skip((page - 1) * size)
            .limit(size);
        res.json({ success: true, data });
    } catch (e) {
        res.status(500).json({ success: false, message: '查询失败' });
    }
});

app.post('/api/poi/dispute', async (req, res) => {
    try {
        const id = String(req.body?.id || '').trim();
        const openId = String(req.body?.openId || req.body?.openid || '').trim();
        const reason = String(req.body?.reason || '').trim().slice(0, 800);
        if (!id || !mongoose.isValidObjectId(id) || !openId || !reason) {
            return res.status(400).json({ success: false, message: '异议说明不能为空' });
        }
        const poi = await POI.findOne({ _id: id, userOpenId: openId, status: 'rejected' });
        if (!poi) {
            const existing = mongoose.isValidObjectId(id) ? await POI.findById(id) : null;
            const message = existing ? '只能对自己的被驳回点位提交异议' : '点位不存在';
            return res.status(existing ? 403 : 404).json({ success: false, message });
        }
        const targetEmail = await getThirdPartyEmail();
        if (!targetEmail || !isEmail(targetEmail)) {
            return res.status(400).json({ success: false, message: '第三方处理邮箱未配置' });
        }
        const mailer = createMailer();
        if (!mailer) {
            return res.status(500).json({ success: false, message: 'SMTP 未配置，无法发送异议邮件' });
        }
        const token = generateDisputeToken();
        const tokenHash = hashDisputeToken(token);
        const dispute = await Dispute.findOneAndUpdate(
            { poiId: poi._id, status: 'pending' },
            {
                poiId: poi._id,
                collectorOpenId: poi.userOpenId,
                reviewerOpenId: poi.reviewerId || '',
                reason,
                thirdPartyEmail: targetEmail,
                tokenHash,
                status: 'pending',
                finalAction: '',
                finalOpinion: ''
            },
            { upsert: true, new: true, setDefaultsOnInsert: true }
        );
        await mailer.sendMail({
            from: CONFIG.smtp.from,
            to: targetEmail,
            subject: `POI 异议处理 - ${poi.poiName}`,
            text: buildDisputeEmail(poi, dispute, token)
        });
        await createNotification({
            recipientOpenId: poi.userOpenId,
            type: 'system',
            title: '异议已提交',
            content: `点位“${poi.poiName}”的异议已发送给第三方工作人员处理。`,
            poiId: poi._id,
            poiName: poi.poiName,
            status: 'dispute'
        });
        if (poi.reviewerId) {
            await createNotification({
                recipientOpenId: poi.reviewerId,
                type: 'system',
                title: '采集者已提交异议',
                content: `点位“${poi.poiName}”已由采集者提交异议，等待第三方最终处理。`,
                poiId: poi._id,
                poiName: poi.poiName,
                status: 'dispute'
            });
            const auditRoom = await getOrCreateAuditRoom(poi, poi.reviewerId);
            const auditChat = await saveChatMessage({
                roomId: auditRoom.roomId,
                fromOpenId: 'system_dispute',
                user: '系统',
                text: `采集者已提交异议：${reason}`
            });
            if (io) {
                io.to(`chat_${auditRoom.roomId}`).emit('chatMessage', serializeChatMessage(auditChat));
                io.to(`user_${poi.userOpenId}`).emit('chatRoomUpdated', serializeChatRoom(auditRoom));
                io.to(`user_${poi.reviewerId}`).emit('chatRoomUpdated', serializeChatRoom(auditRoom));
            }
        }
        res.json({ success: true });
    } catch (e) {
        console.error('[poi-dispute]', e.message);
        res.status(500).json({ success: false, message: '异议提交失败' });
    }
});

app.get('/api/admin/list', async (_req, res) => {
    try {
        const page = Math.max(Number.parseInt(_req.query.page, 10) || 1, 1);
        const size = Math.min(Math.max(Number.parseInt(_req.query.size, 10) || 50, 1), 100);
        const data = await POI.find({ status: 'pending' })
            .sort({ createTime: -1 })
            .skip((page - 1) * size)
            .limit(size);
        res.json({ success: true, data });
    } catch (e) {
        res.status(500).json({ success: false, message: '查询失败' });
    }
});

app.get('/api/admin/reviewed-pois', requireAdmin, async (req, res) => {
    try {
        const page = Math.max(Number.parseInt(req.query.page, 10) || 1, 1);
        const size = Math.min(Math.max(Number.parseInt(req.query.size, 10) || 80, 1), 200);
        const data = await POI.find({ status: { $in: ['approved', 'rejected'] } })
            .sort({ createTime: -1 })
            .skip((page - 1) * size)
            .limit(size);
        res.json({ success: true, data: data.map(serializePoi) });
    } catch (e) {
        console.error('[admin-reviewed-pois]', e.message);
        res.status(500).json({ success: false, message: '查询失败' });
    }
});

app.delete('/api/admin/poi/:id', requireAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        if (!mongoose.isValidObjectId(id)) {
            return res.status(400).json({ success: false, message: '点位 ID 错误' });
        }
        const poi = await POI.findOneAndDelete({ _id: id, status: { $in: ['approved', 'rejected'] } });
        if (!poi) {
            const existing = await POI.findById(id);
            return res.status(existing ? 400 : 404).json({
                success: false,
                message: existing ? '只能删除已审核点位' : '点位不存在'
            });
        }
        cleanupLocalImageUrl(poi.imageUrl);
        if (io) io.emit('poiStatusChanged', { poiId: poi._id, deleted: true, public: true });
        res.json({ success: true });
    } catch (e) {
        console.error('[admin-delete-poi]', e.message);
        res.status(500).json({ success: false, message: '删除失败' });
    }
});

app.post('/api/admin/email-poi', requireAdmin, async (req, res) => {
    try {
        const { id } = req.body;
        const targetEmail = await getThirdPartyEmail();
        if (!id || !mongoose.isValidObjectId(id)) {
            return res.status(400).json({ success: false, message: '点位 ID 错误' });
        }
        if (!targetEmail || !isEmail(targetEmail)) {
            return res.status(400).json({ success: false, message: '第三方邮箱未配置' });
        }
        const mailer = createMailer();
        if (!mailer) {
            return res.status(500).json({ success: false, message: 'SMTP 未配置，无法发送邮件' });
        }
        const poi = await POI.findById(id);
        if (!poi) return res.status(404).json({ success: false, message: '点位不存在' });
        await mailer.sendMail({
            from: CONFIG.smtp.from,
            to: targetEmail,
            subject: `POI 点位信息 - ${poi.poiName}`,
            text: buildPoiEmail(poi)
        });
        res.json({ success: true, email: targetEmail });
    } catch (e) {
        console.error('[admin-email-poi]', e.message);
        res.status(500).json({ success: false, message: '邮件发送失败' });
    }
});

app.get('/api/admin/dispute-settings', requireAdmin, async (_req, res) => {
    try {
        const setting = await getSystemSetting();
        res.json({
            success: true,
            thirdPartyEmail: setting.thirdPartyEmail || CONFIG.smtp.defaultTestEmail || ''
        });
    } catch (e) {
        console.error('[admin-dispute-settings]', e.message);
        res.status(500).json({ success: false, message: '查询失败' });
    }
});

app.post('/api/admin/dispute-settings', requireAdmin, async (req, res) => {
    try {
        const thirdPartyEmail = String(req.body?.thirdPartyEmail || '').trim();
        if (thirdPartyEmail && !isEmail(thirdPartyEmail)) {
            return res.status(400).json({ success: false, message: '邮箱格式错误' });
        }
        const setting = await SystemSetting.findOneAndUpdate(
            { key: 'global' },
            { key: 'global', thirdPartyEmail, updateTime: new Date() },
            { upsert: true, new: true, setDefaultsOnInsert: true }
        );
        res.json({ success: true, thirdPartyEmail: setting.thirdPartyEmail || CONFIG.smtp.defaultTestEmail || '' });
    } catch (e) {
        console.error('[admin-save-dispute-settings]', e.message);
        res.status(500).json({ success: false, message: '保存失败' });
    }
});

app.get('/api/admin/collection-status', requireAdmin, async (_req, res) => {
    try {
        const setting = await getSystemSetting();
        res.json({ success: true, collectionPaused: Boolean(setting.collectionPaused) });
    } catch (e) {
        console.error('[admin-collection-status]', e.message);
        res.status(500).json({ success: false, message: '查询失败' });
    }
});

app.post('/api/admin/collection-status', requireAdmin, async (req, res) => {
    try {
        const paused = Boolean(req.body && req.body.collectionPaused);
        const setting = await SystemSetting.findOneAndUpdate(
            { key: 'global' },
            { key: 'global', collectionPaused: paused, updateTime: new Date() },
            { upsert: true, new: true, setDefaultsOnInsert: true }
        );
        if (io) io.emit('collectionStatusChanged', { collectionPaused: Boolean(setting.collectionPaused) });
        res.json({ success: true, collectionPaused: Boolean(setting.collectionPaused) });
    } catch (e) {
        console.error('[admin-set-collection-status]', e.message);
        res.status(500).json({ success: false, message: '操作失败' });
    }
});

app.post('/api/admin/broadcast', requireAdmin, async (req, res) => {
    try {
        const audience = String(req.body?.audience || 'all').trim();
        const title = String(req.body?.title || '系统公告').trim().slice(0, 80) || '系统公告';
        const content = String(req.body?.content || '').trim().slice(0, 500);
        if (!content) {
            return res.status(400).json({ success: false, message: '公告内容不能为空' });
        }
        if (!['all', 'collector', 'reviewer'].includes(audience)) {
            return res.status(400).json({ success: false, message: '公告对象错误' });
        }
        const result = await broadcastNotification({ audience, title, content, type: 'system' });
        res.json({ success: true, ...result });
    } catch (e) {
        console.error('[admin-broadcast]', e.message);
        res.status(500).json({ success: false, message: '公告发送失败' });
    }
});

app.get('/api/dispute/:token', async (req, res) => {
    try {
        const token = String(req.params.token || '').trim();
        if (!token) return res.status(400).json({ success: false, message: '处理链接无效' });
        const dispute = await Dispute.findOne({ tokenHash: hashDisputeToken(token), status: 'pending' });
        if (!dispute) return res.status(404).json({ success: false, message: '处理链接无效或已处理' });
        const poi = await POI.findById(dispute.poiId);
        if (!poi) return res.status(404).json({ success: false, message: '点位不存在' });
        res.json({ success: true, data: serializeDispute(dispute, poi) });
    } catch (e) {
        console.error('[dispute-detail]', e.message);
        res.status(500).json({ success: false, message: '查询失败' });
    }
});

app.post('/api/dispute/:token/resolve', async (req, res) => {
    try {
        const token = String(req.params.token || '').trim();
        const finalAction = String(req.body?.finalAction || '').trim();
        const finalOpinion = String(req.body?.finalOpinion || '').trim().slice(0, 800);
        if (!token || !['approved', 'rejected'].includes(finalAction)) {
            return res.status(400).json({ success: false, message: '处理结果无效' });
        }
        if (finalAction === 'rejected' && !finalOpinion) {
            return res.status(400).json({ success: false, message: '最终意见不能为空' });
        }
        const dispute = await Dispute.findOne({ tokenHash: hashDisputeToken(token), status: 'pending' });
        if (!dispute) return res.status(404).json({ success: false, message: '处理链接无效或已处理' });
        const poi = await POI.findById(dispute.poiId);
        if (!poi) return res.status(404).json({ success: false, message: '点位不存在' });

        poi.status = finalAction;
        poi.rejectReason = finalAction === 'rejected' ? finalOpinion : '';
        if (dispute.reviewerOpenId && !poi.reviewerId) poi.reviewerId = dispute.reviewerOpenId;
        await poi.save();

        dispute.status = 'resolved';
        dispute.finalAction = finalAction;
        dispute.finalOpinion = finalOpinion;
        dispute.resolveTime = new Date();
        await dispute.save();

        const actionText = finalAction === 'approved' ? '最终通过' : '最终驳回';
        await createNotification({
            recipientOpenId: poi.userOpenId,
            type: 'system',
            title: '异议处理完成',
            content: `点位“${poi.poiName}”第三方处理结果：${actionText}。${finalOpinion || ''}`,
            poiId: poi._id,
            poiName: poi.poiName,
            status: finalAction
        });
        if (poi.reviewerId) {
            await createNotification({
                recipientOpenId: poi.reviewerId,
                type: 'system',
                title: '异议最终处理完成',
                content: `点位“${poi.poiName}”第三方处理结果：${actionText}。${finalOpinion || ''}`,
                poiId: poi._id,
                poiName: poi.poiName,
                status: finalAction
            });
            const auditRoom = await getOrCreateAuditRoom(poi, poi.reviewerId);
            auditRoom.status = finalAction;
            await auditRoom.save();
            const auditChat = await saveChatMessage({
                roomId: auditRoom.roomId,
                fromOpenId: 'system_dispute',
                user: '系统',
                text: `第三方异议处理完成：${actionText}。${finalOpinion || ''}`.trim()
            });
            if (io) {
                io.to(`chat_${auditRoom.roomId}`).emit('chatMessage', serializeChatMessage(auditChat));
                io.to(`user_${poi.userOpenId}`).emit('chatRoomUpdated', serializeChatRoom(auditRoom));
                io.to(`user_${poi.reviewerId}`).emit('chatRoomUpdated', serializeChatRoom(auditRoom));
            }
        }
        if (io) {
            io.to(`user_${poi.userOpenId}`).emit('poiStatusChanged', {
                poiId: poi._id,
                poiName: poi.poiName,
                status: finalAction,
                rejectReason: poi.rejectReason || ''
            });
            if (poi.reviewerId) {
                io.to(`user_${poi.reviewerId}`).emit('poiStatusChanged', {
                    poiId: poi._id,
                    poiName: poi.poiName,
                    status: finalAction,
                    rejectReason: poi.rejectReason || ''
                });
            }
            if (finalAction === 'approved') {
                io.emit('poiStatusChanged', {
                    poiId: poi._id,
                    poiName: poi.poiName,
                    status: finalAction,
                    public: true
                });
            }
        }
        res.json({ success: true, status: finalAction });
    } catch (e) {
        console.error('[dispute-resolve]', e.message);
        res.status(500).json({ success: false, message: '处理失败' });
    }
});

app.get('/api/notifications', async (req, res) => {
    try {
        const openId = String(req.query.openId || req.query.openid || '').trim();
        if (!openId) {
            return res.status(400).json({ success: false, message: '缺少 openId' });
        }
        const page = Math.max(Number.parseInt(req.query.page, 10) || 1, 1);
        const size = Math.min(Math.max(Number.parseInt(req.query.size, 10) || 50, 1), 100);
        const data = await Notification.find({ recipientOpenId: openId })
            .sort({ createTime: -1 })
            .skip((page - 1) * size)
            .limit(size);
        const unreadCount = await Notification.countDocuments({ recipientOpenId: openId, read: false });
        res.json({ success: true, unreadCount, data: data.map(serializeNotification) });
    } catch (e) {
        console.error('[notifications]', e.message);
        res.status(500).json({ success: false, message: '查询失败' });
    }
});

app.post('/api/notifications/read', async (req, res) => {
    try {
        const { openId, id } = req.body;
        if (!openId) {
            return res.status(400).json({ success: false, message: '缺少 openId' });
        }
        const query = { recipientOpenId: openId };
        if (id) {
            if (!mongoose.isValidObjectId(id)) {
                return res.status(400).json({ success: false, message: '通知 ID 错误' });
            }
            query._id = id;
        }
        await Notification.updateMany(query, { read: true });
        res.json({ success: true });
    } catch (e) {
        console.error('[notifications-read]', e.message);
        res.status(500).json({ success: false, message: '操作失败' });
    }
});

app.get('/api/chat/rooms', async (req, res) => {
    try {
        const openId = String(req.query.openId || req.query.openid || '').trim();
        if (!openId) {
            return res.status(400).json({ success: false, message: '缺少 openId' });
        }
        const data = await ChatRoom.find({
            $or: [{ collectorOpenId: openId }, { reviewerOpenId: openId }]
        }).sort({ lastTime: -1 }).limit(100);
        res.json({ success: true, data: data.map(serializeChatRoom) });
    } catch (e) {
        console.error('[chat-rooms]', e.message);
        res.status(500).json({ success: false, message: '查询失败' });
    }
});

app.get('/api/chat/history', async (req, res) => {
    try {
        const roomId = String(req.query.roomId || 'private').trim();
        const openId = String(req.query.openId || req.query.openid || '').trim();
        if (!roomId || roomId.length > 160) {
            return res.status(400).json({ success: false, message: 'Invalid chat room' });
        }
        if (!openId) {
            return res.status(400).json({ success: false, message: 'Missing openId' });
        }
        if (isRoleGroupRoom(roomId)) {
            const user = await User.findOne({ openId }, { role: 1 }).lean();
            const role = user ? user.role : 'collector';
            if (!canAccessRoom(role, roomId)) {
                return res.status(403).json({ success: false, message: 'Forbidden group chat' });
            }
        } else {
            const room = await ChatRoom.findOne({ roomId }).lean();
            if (!room || ![room.collectorOpenId, room.reviewerOpenId].includes(openId)) {
                return res.status(403).json({ success: false, message: 'Forbidden private chat' });
            }
        }
        const size = Math.min(Math.max(Number.parseInt(req.query.size, 10) || 80, 1), 200);
        const data = await ChatMessage.find({ roomId }).sort({ createTime: -1 }).limit(size);
        res.json({ success: true, data: data.reverse().map(serializeChatMessage) });
    } catch (e) {
        console.error('[chat-history]', e.message);
        res.status(500).json({ success: false, message: 'Query failed' });
    }
});

const qrSessions = new Map(); 
const QR_TTL_MS = 5 * 60 * 1000;
const PORTAL_VERSION = process.env.PORTAL_VERSION || 'ui-i18n-chat-20260512-1131';

function appendPortalVersion(target) {
    const rawTarget = String(target || '/portal.html');
    try {
        const url = new URL(rawTarget, CONFIG.publicHost);
        if (url.pathname.endsWith('/portal.html') && !url.searchParams.has('v')) {
            url.searchParams.set('v', PORTAL_VERSION);
        }
        return url.pathname + url.search + url.hash;
    } catch (_e) {
        const separator = rawTarget.includes('?') ? '&' : '?';
        return rawTarget.includes('v=') ? rawTarget : `${rawTarget}${separator}v=${PORTAL_VERSION}`;
    }
}

setInterval(() => {
    const now = Date.now();
    for (const [sid, sess] of qrSessions) {
        if (now - sess.ts > QR_TTL_MS) qrSessions.delete(sid);
    }
}, 60 * 1000).unref();

app.get('/auth/wechat', (req, res) => {
    const redirect = appendPortalVersion(req.query.redirect || '/portal.html');
    const callbackUrl = encodeURIComponent(
        `${CONFIG.publicHost}/auth/wechat/callback?redirect=${encodeURIComponent(redirect)}`
    );
    const url = `https://open.weixin.qq.com/connect/oauth2/authorize` +
        `?appid=${CONFIG.wechat.appId}` +
        `&redirect_uri=${callbackUrl}` +
        `&response_type=code&scope=snsapi_base&state=STATE#wechat_redirect`;
    res.redirect(url);
});

app.get('/auth/wechat/callback', async (req, res) => {
    try {
        const { code, sid, redirect = '/portal.html' } = req.query;
        if (!code) return res.status(400).send('缺少 code');

        const r = await axios.get('https://api.weixin.qq.com/sns/oauth2/access_token', {
            params: {
                appid: CONFIG.wechat.appId,
                secret: CONFIG.wechat.appSecret,
                code,
                grant_type: 'authorization_code'
            },
            timeout: 8000
        });

        const openid = r.data.openid;
        if (!openid) {
            return res.status(500).send('授权失败:' + JSON.stringify(r.data));
        }

        
        if (sid && qrSessions.has(sid)) {
            const sess = qrSessions.get(sid);
            sess.openid = openid;
            sess.status = 'ok';
            sess.ts = Date.now();
            return res.send(`
                <html><head><meta charset="UTF-8"><title>授权成功</title>
                <style>body{font-family:sans-serif;text-align:center;padding-top:80px;color:#07c160}</style>
                </head><body>
                <h2>✅ 授权成功</h2>
                <p>请回到电脑端继续操作</p>
                </body></html>
            `);
        }

        
        const redirectTarget = appendPortalVersion(redirect);
        const separator = redirectTarget.includes('?') ? '&' : '?';
        res.redirect(`${redirectTarget}${separator}openid=${encodeURIComponent(openid)}`);
    } catch (e) {
        console.error('[wechat callback]', e.message);
        res.status(500).send('回调处理失败');
    }
});

app.get('/auth/wechat/qr', (_req, res) => {
    const sid = crypto.randomBytes(8).toString('hex');
    qrSessions.set(sid, { status: 'pending', openid: null, ts: Date.now() });

    const callbackUrl = encodeURIComponent(`${CONFIG.publicHost}/auth/wechat/callback?sid=${sid}`);
    const qrUrl = `https://open.weixin.qq.com/connect/oauth2/authorize` +
        `?appid=${CONFIG.wechat.appId}` +
        `&redirect_uri=${callbackUrl}` +
        `&response_type=code&scope=snsapi_base&state=qr#wechat_redirect`;

    res.json({ sid, qrUrl });
});

app.get('/auth/status', (req, res) => {
    const { sid } = req.query;
    if (!sid || !qrSessions.has(sid)) {
        return res.json({ status: 'expired' });
    }
    const sess = qrSessions.get(sid);
    if (Date.now() - sess.ts > QR_TTL_MS) {
        qrSessions.delete(sid);
        return res.json({ status: 'expired' });
    }
    res.json({
        status: sess.status,
        openid: sess.status === 'ok' ? sess.openid : undefined
    });
});

function normalizeSocketString(value, maxLength) {
    const raw = Array.isArray(value) ? value[0] : value;
    if (typeof raw !== 'string') return '';
    return raw.trim().slice(0, maxLength);
}

function getSocketOpenId(socket) {
    return normalizeSocketString(
        socket.handshake.query.openId || socket.handshake.query.openid,
        128
    );
}

const socketCorsOrigins = CONFIG.corsOrigin
    .split(',')
    .map(origin => origin.trim())
    .filter(Boolean);

const io = new Server(server, {
    cors: socketCorsOrigins.includes('*')
        ? { origin: '*' }
        : { origin: socketCorsOrigins, credentials: true },
    transports: ['websocket', 'polling'],
    pingInterval: 20000,
    pingTimeout: 30000
});

io.on('connection', async (socket) => {
    const openId = getSocketOpenId(socket);
    if (!openId) return socket.disconnect(true);

    socket.openId = openId;
    socket.nickname = '匿名';
    socket.join(`user_${openId}`);

    try {
        const u = await User.findOne({ openId });
        socket.role = u ? u.role : 'collector';
        socket.join(socketRoomForGroup(groupRoomForRole(socket.role)));
        if (socket.role === 'reviewer') socket.join('reviewer_group');
        const rooms = await ChatRoom.find({
            $or: [{ collectorOpenId: openId }, { reviewerOpenId: openId }]
        }, { roomId: 1 }).lean();
        rooms.forEach(room => socket.join(`chat_${room.roomId}`));
    } catch (e) {
        console.warn('[socket auth]', e.message);
    }

    
    socket.on('setNickname', d => {
        if (!socket.openId) return;
        const nickname = normalizeSocketString(d && d.nickname, 20);
        if (nickname) socket.nickname = nickname;
    });

    socket.on('joinChatRoom', async d => {
        if (!socket.openId) return;
        const roomId = normalizeSocketString(d && d.roomId, 160);
        if (!roomId) return;
        if (isRoleGroupRoom(roomId)) {
            if (canAccessRoom(socket.role, roomId)) socket.join(socketRoomForGroup(roomId));
            return;
        }
        try {
            const room = await ChatRoom.findOne({ roomId }).lean();
            if (room && [room.collectorOpenId, room.reviewerOpenId].includes(socket.openId)) {
                socket.join(`chat_${roomId}`);
            }
        } catch (e) {
            console.warn('[joinChatRoom]', e.message);
        }
    });

    
    socket.on('chatMessage', async d => {
        if (!socket.openId) return;
        const text = normalizeSocketString(d && d.text, 500);
        const roomId = normalizeSocketString(d && d.roomId, 160) || groupRoomForRole(socket.role);
        if (!text) return;
        try {
            if (isRoleGroupRoom(roomId)) {
                if (!canAccessRoom(socket.role, roomId)) return;
                socket.join(socketRoomForGroup(roomId));
            } else {
                const room = await ChatRoom.findOne({ roomId }).lean();
                if (!room || ![room.collectorOpenId, room.reviewerOpenId].includes(socket.openId)) return;
            }
            const msg = await saveChatMessage({
                roomId,
                fromOpenId: socket.openId,
                user: socket.nickname,
                text
            });
            if (!isRoleGroupRoom(roomId)) {
                const updatedRoom = await ChatRoom.findOne({ roomId }).lean();
                if (updatedRoom) {
                    io.to(`chat_${roomId}`).emit('chatRoomUpdated', serializeChatRoom(updatedRoom));
                }
            }
            io.to(`chat_${roomId}`).emit('chatMessage', serializeChatMessage(msg));
        } catch (e) {
            console.error('[chatMessage]', e.message);
        }
    });

    
    socket.on('super_publish_notice', async (d) => {
        if (!CONFIG.adminToken || !socket.openId || !d || d.adminToken !== CONFIG.adminToken) return;
        const text = normalizeSocketString(d.text, 500);
        if (!text) return;

        try {
            await broadcastNotification({
                audience: normalizeSocketString(d.audience, 20) || 'all',
                title: normalizeSocketString(d.title, 80) || '系统公告',
                content: text,
                type: 'system'
            });
        } catch (e) {
            console.error('[notice broadcast]', e.message);
        }
    });
});

geosync.attach({
    app,
    io,
    mongoose,
    models: { POI, User },
    helpers: {
        sendTemplate,
        sendMail: sendGeoSyncMail,
        ocr: recognizeGeoSyncPhoto,
        uploadDir
    },
    options: {
        startBackground: String(process.env.GEOSYNC_BACKGROUND_ENABLED || 'true').toLowerCase() !== 'false',
        mountUploads: false
    }
});

app.use('/uploads', express.static(uploadDir));
app.use((req, res, next) => {
    if (req.path === '/' || req.path.endsWith('.html')) {
        res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
        res.set('Pragma', 'no-cache');
        res.set('Expires', '0');
        res.set('Surrogate-Control', 'no-store');
    }
    next();
});
const publicStaticExtensions = new Set([
    '.html', '.css', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp',
    '.ico', '.woff', '.woff2', '.ttf', '.webmanifest'
]);
app.use((req, res, next) => {
    if (req.path === '/' || publicStaticExtensions.has(path.extname(req.path).toLowerCase())) {
        return next();
    }
    return res.status(404).end();
});
app.use(express.static(__dirname, {
    etag: false,
    lastModified: false
}));

server.listen(CONFIG.port, CONFIG.host, () => {
    console.log(`[Server] http://${CONFIG.host}:${CONFIG.port}`);
    console.log(`[Public] ${CONFIG.publicHost}`);
});
