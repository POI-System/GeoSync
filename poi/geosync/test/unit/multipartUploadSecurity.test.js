'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { mkdtemp, readdir, rm } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const mongoose = require('mongoose');

const modelModule = require('../../models');
const { CONFIG } = require('../../config');
const { classifyImageUploadError } = require('../../lib/imageUpload');
const {
    SESSION_KINDS,
    DEFAULT_HEADER_NAMES,
    createSessionToken
} = require('../../lib/sessionAuth');

const SESSION_SECRET = 'multipart-route-secret-V9x7sQ2pL4mN8cR6tY1uI5oP3aS0';

function multipartBody(boundary, fields, options = {}) {
    const chunks = [];
    for (const [name, value] of Object.entries(fields)) {
        chunks.push(Buffer.from(
            `--${boundary}\r\n`
            + `Content-Disposition: form-data; name="${name}"\r\n\r\n`
            + `${value}\r\n`
        ));
    }
    chunks.push(Buffer.from(
        `--${boundary}\r\n`
        + `Content-Disposition: form-data; name="photo"; filename="${options.fileName || 'sample.jpg'}"\r\n`
        + `Content-Type: ${options.mimeType || 'image/jpeg'}\r\n\r\n`
    ));
    chunks.push(options.fileBuffer
        || Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x43, 0x00, 0xff, 0xd9]));
    chunks.push(Buffer.from(`\r\n--${boundary}--\r\n`));
    return Buffer.concat(chunks);
}

async function listen(server) {
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
}

async function close(server) {
    await new Promise((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
    });
}

function request(server, { fields, token = null, fileBuffer, fileName, mimeType }) {
    const boundary = `----geosync-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const body = multipartBody(boundary, fields, { fileBuffer, fileName, mimeType });
    const address = server.address();
    const headers = {
        'content-type': `multipart/form-data; boundary=${boundary}`,
        'content-length': String(body.length)
    };
    if (token) headers[DEFAULT_HEADER_NAMES.user] = token;
    return new Promise((resolve, reject) => {
        const req = http.request({
            host: '127.0.0.1',
            port: address.port,
            method: 'POST',
            path: '/api/photospots',
            headers
        }, res => {
            let responseBody = '';
            res.setEncoding('utf8');
            res.on('data', chunk => { responseBody += chunk; });
            res.on('end', () => resolve({
                statusCode: res.statusCode,
                body: JSON.parse(responseBody)
            }));
        });
        req.once('error', reject);
        req.end(body);
    });
}

test('real photospot multipart route authenticates before upload and owns files only after create', async () => {
    const privateStorageError = Object.assign(
        new Error('ENOENT C:\\private\\uploads?token=fake-secret'),
        { code: 'ENOENT' }
    );
    const storageFailure = classifyImageUploadError(privateStorageError);
    assert.deepEqual(storageFailure, {
        httpStatus: 503,
        code: 9001,
        message: '图片存储暂不可用',
        logCode: 'ENOENT'
    });
    assert.doesNotMatch(JSON.stringify(storageFailure), /private|fake-secret/);
    assert.equal(
        classifyImageUploadError({
            code: 'https://user:fake-secret@example.test/private',
            message: 'private storage detail'
        }).logCode,
        'UPLOAD_STORAGE_UNAVAILABLE'
    );

    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'geosync-multipart-route-'));
    const previous = {
        uploadDir: CONFIG.uploadDir,
        scenicId: CONFIG.scenicId,
        nodeEnv: CONFIG.nodeEnv,
        isProduction: CONFIG.isProduction,
        authSignRequired: CONFIG.authSignRequired,
        legacyOpenIdEnabled: CONFIG.legacyOpenIdEnabled,
        sessionSecret: CONFIG.sessionSecret
    };
    let createCalls = 0;
    const ExternalUser = {
        findOne(filter) {
            return {
                lean: async () => filter.openId === 'user-1'
                    ? { openId: 'user-1', role: 'collector' }
                    : null
            };
        }
    };
    const UserSessionRevocation = {
        findOne() {
            return { lean: async () => null };
        },
        async updateOne() {
            return { acknowledged: true };
        }
    };

    let server;
    let PhotoSpot;
    let originalCreate;
    try {
        Object.assign(CONFIG, {
            uploadDir: tempDir,
            scenicId: 'multipart-test',
            nodeEnv: 'test',
            isProduction: false,
            authSignRequired: true,
            legacyOpenIdEnabled: false,
            sessionSecret: SESSION_SECRET
        });
        const models = modelModule.registerModels(new mongoose.Mongoose(), {
            User: ExternalUser,
            UserSessionRevocation
        });
        PhotoSpot = models.PhotoSpot;
        originalCreate = PhotoSpot.create;
        PhotoSpot.create = async () => {
            createCalls += 1;
            return { _id: 'spot-1' };
        };
        const router = require('../../routes/photospots');
        const app = express();
        app.use('/api/photospots', router);
        server = http.createServer(app);
        await listen(server);

        const token = createSessionToken({
            secret: SESSION_SECRET,
            kind: SESSION_KINDS.USER,
            subject: 'user-1',
            role: 'collector',
            ttlSec: 600,
            sessionId: 'multipart-route-session'
        });
        const validFields = {
            poiId: 'poi-1',
            name: 'Photo spot',
            heading: '90',
            lng: '120',
            lat: '30'
        };

        const anonymous = await request(server, { fields: validFields });
        assert.equal(anonymous.statusCode, 401);
        assert.deepEqual(await readdir(tempDir), []);

        const mismatch = await request(server, {
            token,
            fields: { ...validFields, userOpenId: 'user-2' }
        });
        assert.equal(mismatch.statusCode, 403);
        assert.equal(mismatch.body.code, 9001);
        assert.equal(createCalls, 0);
        assert.deepEqual(await readdir(tempDir), []);

        const invalid = await request(server, {
            token,
            fields: { openId: 'user-1', poiId: 'poi-1', heading: '90', lng: '120', lat: '30' }
        });
        assert.equal(invalid.statusCode, 400);
        assert.equal(createCalls, 0);
        assert.deepEqual(await readdir(tempDir), []);

        const wrongType = await request(server, {
            token,
            fields: validFields,
            fileName: 'sample.txt',
            mimeType: 'text/plain',
            fileBuffer: Buffer.from('not an image')
        });
        assert.equal(wrongType.statusCode, 400);
        assert.equal(wrongType.body.code, 1101);
        assert.deepEqual(await readdir(tempDir), []);

        const tooLarge = await request(server, {
            token,
            fields: validFields,
            fileBuffer: Buffer.alloc(10 * 1024 * 1024 + 1, 0xff)
        });
        assert.equal(tooLarge.statusCode, 413);
        assert.equal(tooLarge.body.code, 1101);
        assert.deepEqual(await readdir(tempDir), []);

        const accepted = await request(server, {
            token,
            fields: { ...validFields, openId: 'user-1' }
        });
        assert.equal(accepted.statusCode, 200);
        assert.equal(accepted.body.success, true);
        assert.equal(createCalls, 1);
        assert.equal((await readdir(tempDir)).length, 1);

        await rm(tempDir, { recursive: true, force: true });
        const originalConsoleError = console.error;
        console.error = () => {};
        let storageUnavailable;
        try {
            storageUnavailable = await request(server, {
                token,
                fields: validFields
            });
        } finally {
            console.error = originalConsoleError;
        }
        assert.equal(storageUnavailable.statusCode, 503);
        assert.equal(storageUnavailable.body.code, 9001);
        assert.doesNotMatch(JSON.stringify(storageUnavailable.body), /ENOENT|geosync-multipart-route/);
    } finally {
        if (server) await close(server);
        if (PhotoSpot && originalCreate) PhotoSpot.create = originalCreate;
        Object.assign(CONFIG, previous);
        await rm(tempDir, { recursive: true, force: true });
    }
});
