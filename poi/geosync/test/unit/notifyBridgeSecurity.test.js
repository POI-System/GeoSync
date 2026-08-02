'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const notifyBridge = require('../../services/notifyBridge');

test('alertAdmin leaves Socket publishing to the event bus and sends only red email alerts', async () => {
    const socketTargets = [];
    const mail = [];
    notifyBridge.setIo({
        to(room) {
            socketTargets.push(room);
            return { emit() {} };
        }
    });
    notifyBridge.setHelpers({
        sendMail: async (to, subject, body) => mail.push({ to, subject, body })
    });
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
        await notifyBridge.alertAdmin('yellow', 'yellow subject', 'yellow body');
        await notifyBridge.alertAdmin('red', 'red subject', 'red body');
    } finally {
        console.warn = originalWarn;
        notifyBridge.setHelpers({ sendMail: null, sendTemplate: null });
        notifyBridge.setIo(null);
    }

    assert.deepEqual(socketTargets, []);
    assert.equal(mail.length, 1);
    assert.match(mail[0].subject, /red subject/);
    assert.equal(mail[0].body, 'red body');
});
