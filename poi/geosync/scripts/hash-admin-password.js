'use strict';

const { hashAdminPassword } = require('../services/adminPassword');

const EXIT = Object.freeze({
    OK: 0,
    FAILURE: 1,
    INPUT_ERROR: 2
});
const MAX_STDIN_BYTES = 4096;

class CliInputError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'CliInputError';
        this.code = code;
    }
}

function parseArgs(argv) {
    if (!Array.isArray(argv)) throw new TypeError('argv must be an array');
    if (!argv.length) return { help: false };
    if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) return { help: true };
    throw new CliInputError('UNKNOWN_ARGUMENT', 'Password values must not be passed as command-line arguments.');
}

function usage() {
    return [
        'Usage:',
        '  <password-producing command> | node geosync/scripts/hash-admin-password.js',
        '',
        'The password is read only from standard input. The encoded hash is written to standard output.',
        'Do not place the plaintext password in shell arguments, repository files, or persistent environment variables.'
    ].join('\n');
}

async function readPassword(stdin) {
    if (!stdin || typeof stdin[Symbol.asyncIterator] !== 'function') {
        throw new TypeError('stdin must be an async iterable stream');
    }
    if (stdin.isTTY === true) {
        throw new CliInputError(
            'PASSWORD_STDIN_REQUIRED',
            'Refusing an echoing terminal; provide the password through standard input.'
        );
    }
    const chunks = [];
    let total = 0;
    for await (const chunk of stdin) {
        const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
        total += value.length;
        if (total > MAX_STDIN_BYTES) {
            throw new CliInputError('PASSWORD_INPUT_TOO_LARGE', 'Password input is too large.');
        }
        chunks.push(value);
    }
    const bytes = Buffer.concat(chunks, total);
    try {
        let password = bytes.toString('utf8');
        if (password.endsWith('\n')) password = password.slice(0, -1);
        if (password.endsWith('\r')) password = password.slice(0, -1);
        if (!password) throw new CliInputError('PASSWORD_INPUT_REQUIRED', 'Password input is required.');
        return password;
    } finally {
        bytes.fill(0);
        for (const chunk of chunks) chunk.fill(0);
    }
}

async function runCli({
    argv = process.argv.slice(2),
    stdin = process.stdin,
    stdout = process.stdout,
    stderr = process.stderr,
    hashFn = hashAdminPassword
} = {}) {
    try {
        const args = parseArgs(argv);
        if (args.help) {
            stdout.write(`${usage()}\n`);
            return EXIT.OK;
        }
        const password = await readPassword(stdin);
        const encodedHash = await hashFn(password);
        stdout.write(`${encodedHash}\n`);
        return EXIT.OK;
    } catch (error) {
        const inputError = error instanceof CliInputError
            || error?.code === 'ADMIN_PASSWORD_INPUT_INVALID';
        stderr.write(`${JSON.stringify({
            operation: 'hash-admin-password',
            code: inputError ? error.code : 'ADMIN_PASSWORD_HASH_FAILED',
            message: inputError ? error.message : 'Administrator password hash could not be generated.'
        })}\n`);
        return inputError ? EXIT.INPUT_ERROR : EXIT.FAILURE;
    }
}

if (require.main === module) {
    runCli().then(code => {
        process.exitCode = code;
    });
}

module.exports = {
    EXIT,
    CliInputError,
    parseArgs,
    usage,
    readPassword,
    runCli
};
