'use strict';

const multer = require('multer');
const { CONFIG } = require('../config');
const { fail } = require('./respond');

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png']);

function createImageUpload(fieldName = 'photo') {
    const upload = multer({
        dest: CONFIG.uploadDir,
        limits: { fileSize: MAX_IMAGE_BYTES },
        fileFilter: (_req, file, cb) => {
            if (ALLOWED_IMAGE_TYPES.has(file.mimetype)) return cb(null, true);
            const error = new Error('unsupported image type');
            error.code = 'UNSUPPORTED_IMAGE_TYPE';
            return cb(error);
        }
    });

    return function imageUpload(req, res, next) {
        upload.single(fieldName)(req, res, error => {
            if (!error) return next();
            if (error.code === 'LIMIT_FILE_SIZE') {
                return fail(res, 413, 1101, '图片不能超过10MB');
            }
            if (error.code === 'UNSUPPORTED_IMAGE_TYPE') {
                return fail(res, 400, 1101, '仅支持JPEG/PNG图片');
            }
            if (String(error.code || '').startsWith('LIMIT_')) {
                return fail(res, 400, 1101, '图片上传请求无效');
            }
            console.error('[GeoSync] [UPLOAD]', {
                name: String(error.name || 'Error').replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 64),
                code: String(error.code || 'UPLOAD_STORAGE_UNAVAILABLE')
                    .replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 64)
            });
            return fail(res, 503, 9001, '图片存储暂不可用');
        });
    };
}

module.exports = {
    MAX_IMAGE_BYTES,
    ALLOWED_IMAGE_TYPES,
    createImageUpload
};
