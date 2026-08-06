'use strict';

const crypto = require('node:crypto');
const { promisify } = require('node:util');

const scryptAsync = promisify(crypto.scrypt);
const FORMAT_PREFIX = '$scrypt$v=1$';
const MAX_ENCODED_HASH_LENGTH = 512;
const MAX_PASSWORD_BYTES = 1024;
const MIN_NEW_PASSWORD_BYTES = 16;
const DEFAULT_MAX_CONCURRENT = 2;
const PARAMS = Object.freeze({
    ln: 15,
    N: 2 ** 15,
    r: 8,
    p: 3,
    keyLength: 32,
    saltLength: 16,
    maxmem: 64 * 1024 * 1024
});
const PARAM_SEGMENT = `ln=${PARAMS.ln},r=${PARAMS.r},p=${PARAMS.p}`;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

class AdminPasswordError extends Error {
    constructor(code, message, options = {}) {
        super(message, options);
        this.name = 'AdminPasswordError';
        this.code = code;
        Error.captureStackTrace?.(this, this.constructor);
    }
}

class AdminPasswordConfigurationError extends AdminPasswordError {
    constructor(code = 'ADMIN_PASSWORD_HASH_INVALID') {
        super(code, 'Administrator password authentication is not configured securely.');
        this.name = 'AdminPasswordConfigurationError';
    }
}

class AdminPasswordBusyError extends AdminPasswordError {
    constructor() {
        super('ADMIN_PASSWORD_VERIFY_BUSY', 'Administrator password verification is busy.');
        this.name = 'AdminPasswordBusyError';
    }
}

function canonicalBase64Url(value, expectedBytes, field) {
    if (typeof value !== 'string' || !BASE64URL_PATTERN.test(value)) {
        throw new AdminPasswordConfigurationError(`ADMIN_PASSWORD_HASH_${field}_INVALID`);
    }
    let decoded;
    try {
        decoded = Buffer.from(value, 'base64url');
    } catch {
        throw new AdminPasswordConfigurationError(`ADMIN_PASSWORD_HASH_${field}_INVALID`);
    }
    if (decoded.length !== expectedBytes || decoded.toString('base64url') !== value) {
        throw new AdminPasswordConfigurationError(`ADMIN_PASSWORD_HASH_${field}_INVALID`);
    }
    return decoded;
}

function parseAdminPasswordHash(encodedHash) {
    if (typeof encodedHash !== 'string'
        || !encodedHash
        || encodedHash.length > MAX_ENCODED_HASH_LENGTH
        || encodedHash !== encodedHash.trim()) {
        throw new AdminPasswordConfigurationError('ADMIN_PASSWORD_HASH_INVALID');
    }
    const segments = encodedHash.split('$');
    if (segments.length !== 6
        || segments[0] !== ''
        || segments[1] !== 'scrypt'
        || segments[2] !== 'v=1'
        || segments[3] !== PARAM_SEGMENT) {
        throw new AdminPasswordConfigurationError('ADMIN_PASSWORD_HASH_FORMAT_UNSUPPORTED');
    }
    return Object.freeze({
        salt: canonicalBase64Url(segments[4], PARAMS.saltLength, 'SALT'),
        digest: canonicalBase64Url(segments[5], PARAMS.keyLength, 'DIGEST')
    });
}

function passwordBuffer(value, { creating = false } = {}) {
    if (typeof value !== 'string' || !value || /[\u0000\r\n]/.test(value)) return null;
    const bytes = Buffer.byteLength(value, 'utf8');
    if (bytes > MAX_PASSWORD_BYTES || (creating && bytes < MIN_NEW_PASSWORD_BYTES)) return null;
    return Buffer.from(value, 'utf8');
}

async function derive(passwordBytes, salt) {
    try {
        return await scryptAsync(passwordBytes, salt, PARAMS.keyLength, {
            N: PARAMS.N,
            r: PARAMS.r,
            p: PARAMS.p,
            maxmem: PARAMS.maxmem
        });
    } catch (cause) {
        throw new AdminPasswordError(
            'ADMIN_PASSWORD_KDF_FAILED',
            'Administrator password verification could not be completed.',
            { cause }
        );
    }
}

async function hashAdminPassword(password, options = {}) {
    const passwordBytes = passwordBuffer(password, { creating: true });
    if (!passwordBytes) {
        throw new AdminPasswordError(
            'ADMIN_PASSWORD_INPUT_INVALID',
            `Administrator password must contain ${MIN_NEW_PASSWORD_BYTES}-${MAX_PASSWORD_BYTES} UTF-8 bytes without control newlines.`
        );
    }
    const salt = options.salt === undefined
        ? crypto.randomBytes(PARAMS.saltLength)
        : Buffer.from(options.salt);
    if (salt.length !== PARAMS.saltLength) {
        passwordBytes.fill(0);
        throw new TypeError(`salt must contain exactly ${PARAMS.saltLength} bytes`);
    }

    let digest;
    try {
        digest = await derive(passwordBytes, salt);
        return `${FORMAT_PREFIX}${PARAM_SEGMENT}$${salt.toString('base64url')}$${digest.toString('base64url')}`;
    } finally {
        passwordBytes.fill(0);
        digest?.fill(0);
    }
}

async function verifyParsedPassword(password, parsed) {
    const passwordBytes = passwordBuffer(password);
    if (!passwordBytes) return false;
    let actual;
    try {
        actual = await derive(passwordBytes, parsed.salt);
        return crypto.timingSafeEqual(actual, parsed.digest);
    } finally {
        passwordBytes.fill(0);
        actual?.fill(0);
    }
}

async function verifyAdminPassword(password, encodedHash) {
    return verifyParsedPassword(password, parseAdminPasswordHash(encodedHash));
}

function createAdminPasswordVerifier(options = {}) {
    const legacyPasswordConfigured = options.legacyPasswordConfigured === true;
    const maxConcurrent = Number(options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT);
    if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 16) {
        throw new TypeError('maxConcurrent must be an integer between 1 and 16');
    }

    let parsed = null;
    let configurationError = null;
    if (legacyPasswordConfigured) {
        configurationError = new AdminPasswordConfigurationError('ADMIN_PASSWORD_PLAINTEXT_FORBIDDEN');
    } else {
        try {
            parsed = parseAdminPasswordHash(options.encodedHash);
        } catch (error) {
            if (!(error instanceof AdminPasswordConfigurationError)) throw error;
            configurationError = error;
        }
    }

    let active = 0;
    async function verify(password) {
        if (!parsed) throw configurationError;
        if (active >= maxConcurrent) throw new AdminPasswordBusyError();
        active++;
        try {
            return await verifyParsedPassword(password, parsed);
        } finally {
            active--;
        }
    }

    return Object.freeze({
        configured: Boolean(parsed),
        configurationError,
        verify,
        get activeVerifications() {
            return active;
        }
    });
}

module.exports = {
    FORMAT_PREFIX,
    PARAMS,
    MAX_PASSWORD_BYTES,
    MIN_NEW_PASSWORD_BYTES,
    AdminPasswordError,
    AdminPasswordConfigurationError,
    AdminPasswordBusyError,
    parseAdminPasswordHash,
    hashAdminPassword,
    verifyAdminPassword,
    createAdminPasswordVerifier
};
