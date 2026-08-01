'use strict';
// README 方式A：独立运行入口（开发/联调）。Express + Socket.io + Mongo，:3100。
// 上线形态改为在 poi/server.js 中 require('./geosync').attach(...)。

require('dotenv').config();

const http = require('http');
const express = require('express');
const mongoose = require('mongoose');
const { Server } = require('socket.io');
const geosync = require('./index');

const PORT = Number(process.env.PORT) || 3100;
const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/poi';

async function main() {
    await mongoose.connect(MONGO_URI);
    console.log('[GeoSync] [DB] connected', MONGO_URI.replace(/\/\/[^@]*@/, '//***@'));

    const app = express();
    app.use(express.json({ limit: '1mb' }));
    const server = http.createServer(app);
    const io = new Server(server, { cors: { origin: '*' } });

    geosync.attach({ app, io, mongoose });

    server.listen(PORT, () => console.log(`[GeoSync] standalone listening on :${PORT}`));

    const shutdown = async sig => {
        console.log(`[GeoSync] ${sig} — shutting down`);
        server.close();
        await mongoose.disconnect().catch(() => {});
        process.exit(0);
    };
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch(e => {
    console.error('[GeoSync] boot failed:', e);
    process.exit(1);
});
