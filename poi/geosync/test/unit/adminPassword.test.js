'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable, Writable } = require('node:stream');
const {
    FORMAT_PREFIX,
    PARAMS,
    AdminPasswordBusyError,
    AdminPasswordConfigurationError,
    parseAdminPasswordHash,
    hashAdminPassword,
    verifyAdminPassword,
    createAdminPasswordVerifier
} = require('../../services/adminPassword');
const {
    EXIT,
    parseArgs,
    runCli
} = require('../../scripts/hash-admin-password');

const PASSWORD = 'admin-fixture-password-2026';
let encodedHash;

test.before(async () => {
    encodedHash = await hashAdminPassword(PASSWORD, {
        salt: Buffer.from('0123456789abcdef', 'utf8')
    });
});

function sink() {
    let value = '';
    const stream = new Writable({
        write(chunk, _encoding, callback) {
            value += chunk.toString();
            callback();
        }
    });
    return { stream, value: () => value };
}

test('administrator password hashes use the canonical bounded scrypt format', async () => {
    assert.match(encodedHash, /^\$scrypt\$v=1\$ln=15,r=8,p=3\$/);
    assert.equal(encodedHash.startsWith(FORMAT_PREFIX), true);
    assert.equal(encodedHash.includes(PASSWORD), false);
    const parsed = parseAdminPasswordHash(encodedHash);
    assert.equal(parsed.salt.length, PARAMS.saltLength);
    assert.equal(parsed.digest.length, PARAMS.keyLength);
    assert.equal(await verifyAdminPassword(PASSWORD, encodedHash), true);
    assert.equal(await verifyAdminPassword('wrong-admin-password-2026', encodedHash), false);
});

test('administrator password configuration rejects plaintext, malformed, and unsupported hashes', () => {
    for (const value of [
        '',
        PASSWORD,
        `${encodedHash} `,
        encodedHash.replace('ln=15,r=8,p=3', 'ln=14,r=8,p=5'),
        encodedHash.replace('$scrypt$', '$bcrypt$'),
        encodedHash.slice(0, -1)
    ]) {
        assert.throws(
            () => parseAdminPasswordHash(value),
            AdminPasswordConfigurationError
        );
    }

    const legacy = createAdminPasswordVerifier({
        encodedHash,
        legacyPasswordConfigured: true
    });
    assert.equal(legacy.configured, false);
    assert.equal(legacy.configurationError.code, 'ADMIN_PASSWORD_PLAINTEXT_FORBIDDEN');
});

test('administrator password verification is concurrency bounded and fails closed', async () => {
    const verifier = createAdminPasswordVerifier({ encodedHash, maxConcurrent: 1 });
    const first = verifier.verify(PASSWORD);
    await assert.rejects(
        verifier.verify(PASSWORD),
        error => error instanceof AdminPasswordBusyError
            && error.code === 'ADMIN_PASSWORD_VERIFY_BUSY'
    );
    assert.equal(await first, true);
    assert.equal(verifier.activeVerifications, 0);
    assert.equal(await verifier.verify('x'.repeat(1025)), false);

    const missing = createAdminPasswordVerifier({ encodedHash: '' });
    await assert.rejects(
        missing.verify(PASSWORD),
        error => error instanceof AdminPasswordConfigurationError
            && error.code === 'ADMIN_PASSWORD_HASH_INVALID'
    );
});

test('password hash CLI accepts stdin only and never echoes plaintext', async () => {
    assert.throws(
        () => parseArgs(['--password', PASSWORD]),
        error => error.code === 'UNKNOWN_ARGUMENT'
    );
    const stdout = sink();
    const stderr = sink();
    let received = '';
    const code = await runCli({
        argv: [],
        stdin: Readable.from([`${PASSWORD}\r\n`]),
        stdout: stdout.stream,
        stderr: stderr.stream,
        hashFn: async password => {
            received = password;
            return 'encoded-hash-fixture';
        }
    });
    assert.equal(code, EXIT.OK);
    assert.equal(received, PASSWORD);
    assert.equal(stdout.value(), 'encoded-hash-fixture\n');
    assert.equal(stderr.value(), '');
    assert.equal(stdout.value().includes(PASSWORD), false);
});
