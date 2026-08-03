'use strict';

const multer = require('multer');
const { CONFIG } = require('../config');
const { fail, safeErrorCode } = require('./respond');

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png']);

function classifyImageUploadError(error) {
    const rawCode = String(error?.code || '');
    if (rawCode === 'LIMIT_FILE_SIZE') {
        return { httpStatus: 413, code: 1101, message: '图片不能超过10MB', logCode: null };
    }
    if (rawCode === 'UNSUPPORTED_IMAGE_TYPE') {
        return { httpStatus: 400, code: 1101, message: '仅支持JPEG/PNG图片', logCode: null };
    }
    if (rawCode.startsWith('LIMIT_')) {
        return { httpStatus: 400, code: 1101, message: '图片上传请求无效', logCode: null };
    }
    return {
        httpStatus: 503,
        code: 9001,
        message: '图片存储暂不可用',
        logCode: safeErrorCode(error, 'UPLOAD_STORAGE_UNAVAILABLE')
    };
}

function createImageUpload(fieldName = 'photo', options = {}) {
    const uploadOptions = {
        limits: { fileSize: MAX_IMAGE_BYTES },
        fileFilter: (_req, file, cb) => {
            if (ALLOWED_IMAGE_TYPES.has(file.mimetype)) return cb(null, true);
            const error = new Error('unsupported image type');
            error.code = 'UNSUPPORTED_IMAGE_TYPE';
            return cb(error);
        }
    };
    if (options.storage) uploadOptions.storage = options.storage;
    else uploadOptions.dest = CONFIG.uploadDir;
    const upload = multer(uploadOptions);
    const logPrefix = options.logPrefix || '[GeoSync] [UPLOAD]';

    return function imageUpload(req, res, next) {
        upload.single(fieldName)(req, res, error => {
            if (!error) return next();
            const failure = classifyImageUploadError(error);
            if (failure.logCode) {
                console.error(logPrefix, { code: failure.logCode });
            }
            return fail(res, failure.httpStatus, failure.code, failure.message);
        });
    };
}

module.exports = {
    MAX_IMAGE_BYTES,
    ALLOWED_IMAGE_TYPES,
    classifyImageUploadError,
    createImageUpload
};
