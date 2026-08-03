'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const cron = require('node-cron');
const nodemailer = require('nodemailer');
const OcrApi20210707 = require('@alicloud/ocr-api20210707');
const packageJson = require('../../../package.json');
const packageLock = require('../../../package-lock.json');

test('production dependency graph excludes the retired OCR SDK', () => {
    assert.equal(packageJson.dependencies['@alicloud/ocr20191230'], undefined);
    assert.equal(packageLock.packages['node_modules/@alicloud/ocr20191230'], undefined);
    assert.equal(typeof OcrApi20210707.default, 'function');
    assert.equal(typeof OcrApi20210707.RecognizeAllTextRequest, 'function');
});

test('Nodemailer 9 preserves the offline message transport contract', async () => {
    const transport = nodemailer.createTransport({
        streamTransport: true,
        buffer: true,
        newline: 'unix'
    });
    const result = await transport.sendMail({
        from: 'sender@example.test',
        to: 'recipient@example.test',
        subject: 'GeoSync dependency contract',
        text: 'offline transport only'
    });

    assert.ok(Buffer.isBuffer(result.message));
    assert.match(result.message.toString('utf8'), /GeoSync dependency contract/);
    transport.close?.();
});

test('node-cron 4 preserves schedule, stop, and destroy behavior', () => {
    assert.equal(cron.validate('0 0 1 1 *'), true);
    const task = cron.schedule('0 0 1 1 *', () => {});
    try {
        assert.equal(typeof task.stop, 'function');
        assert.equal(typeof task.destroy, 'function');
        task.stop();
    } finally {
        task.destroy();
    }
});
