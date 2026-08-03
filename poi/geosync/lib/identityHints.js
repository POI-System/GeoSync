'use strict';

const fs = require('node:fs/promises');

const IDENTITY_HINT_FIELDS = Object.freeze(['openId', 'openid', 'userOpenId']);

function valuesOf(value) {
    return Array.isArray(value) ? value : [value];
}

function hasMismatchedIdentityHint(req, expectedOpenId) {
    const expected = String(expectedOpenId || '').trim();
    if (!expected) return false;

    const sources = [
        ['header', { 'x-open-id': req?.headers?.['x-open-id'] }],
        ['body', req?.body],
        ['query', req?.query]
    ];
    for (const [sourceName, source] of sources) {
        if (!source || typeof source !== 'object') continue;
        const fields = sourceName === 'header' ? ['x-open-id'] : IDENTITY_HINT_FIELDS;
        for (const field of fields) {
            if (!Object.prototype.hasOwnProperty.call(source, field)) continue;
            for (const value of valuesOf(source[field])) {
                const hint = String(value ?? '').trim();
                if (hint && hint !== expected) return true;
            }
        }
    }
    return false;
}

function requestUploadFiles(req) {
    const files = [];
    if (req?.file && typeof req.file === 'object') files.push(req.file);
    if (Array.isArray(req?.files)) {
        files.push(...req.files);
    } else if (req?.files && typeof req.files === 'object') {
        for (const value of Object.values(req.files)) {
            if (Array.isArray(value)) files.push(...value);
            else if (value && typeof value === 'object') files.push(value);
        }
    }
    return [...new Set(files)];
}

async function cleanupRequestUploads(req, options = {}) {
    const unlink = options.unlink || fs.unlink;
    const logger = options.logger || console;
    const files = requestUploadFiles(req);
    await Promise.all(files.map(async file => {
        const target = typeof file?.path === 'string' ? file.path : '';
        if (!target) return;
        try {
            await unlink(target);
        } catch (error) {
            if (error?.code !== 'ENOENT') {
                logger?.warn?.('[Upload Cleanup]', String(error?.code || 'UNLINK_FAILED'));
            }
        }
    }));
    return files.length;
}

async function rejectMismatchedMultipartIdentity(req, expectedOpenId, options = {}) {
    if (!hasMismatchedIdentityHint(req, expectedOpenId)) return false;
    await cleanupRequestUploads(req, options);
    return true;
}

module.exports = {
    IDENTITY_HINT_FIELDS,
    hasMismatchedIdentityHint,
    cleanupRequestUploads,
    rejectMismatchedMultipartIdentity
};
