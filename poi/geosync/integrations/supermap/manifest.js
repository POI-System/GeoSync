'use strict';

const fs = require('node:fs');

const SUPPORTED_CONTRACT_MAJOR = 1;
const MAX_FEATURES = 500;
const LOGICAL_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]*$/;
const FIELD_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const CONTRACT_VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const REQUIRED_SERVICE_OPERATIONS = Object.freeze({
    map: ['status'],
    data: ['status', 'queryFeatures'],
    network: ['status', 'findPath', 'findPathWithBarriers']
});

class ManifestValidationError extends Error {
    constructor(message, options = {}) {
        super(message);
        this.name = 'ManifestValidationError';
        this.code = options.code || 'SUPERMAP_MANIFEST_INVALID';
        this.field = options.field;
        if (options.cause) this.cause = options.cause;
    }
}

function isPlainObject(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function fail(field, message, code = 'SUPERMAP_MANIFEST_INVALID', cause) {
    throw new ManifestValidationError(`${field}: ${message}`, { code, field, cause });
}

function requireObject(value, field) {
    if (!isPlainObject(value)) fail(field, 'must be an object');
    return value;
}

function requireNonEmptyString(value, field) {
    if (typeof value !== 'string' || value.trim() === '') {
        fail(field, 'must be a nonempty string');
    }
    return value.trim();
}

function requireLogicalName(value, field) {
    const name = requireNonEmptyString(value, field);
    if (!LOGICAL_NAME_PATTERN.test(name)) {
        fail(field, 'must contain only letters, numbers, underscores, or hyphens and start with a letter');
    }
    return name;
}

function assertOnlyKeys(object, allowedKeys, field) {
    const allowed = new Set(allowedKeys);
    for (const key of Object.keys(object)) {
        if (!allowed.has(key)) fail(`${field}.${key}`, 'is not allowed');
    }
}

function normalizeContractVersion(value) {
    const contractVersion = requireNonEmptyString(value, 'contractVersion');
    const match = CONTRACT_VERSION_PATTERN.exec(contractVersion);
    if (!match) fail('contractVersion', 'must be a semantic version such as 1.0.0');

    const major = Number(match[1]);
    if (major !== SUPPORTED_CONTRACT_MAJOR) {
        fail(
            'contractVersion',
            `major version ${major} is incompatible; supported major is ${SUPPORTED_CONTRACT_MAJOR}`,
            'SUPERMAP_MANIFEST_INCOMPATIBLE'
        );
    }
    return contractVersion;
}

function normalizeCoordinate(value, field) {
    if (!Array.isArray(value) || value.length !== 2 || !value.every(Number.isFinite)) {
        fail(field, 'must be a finite [lng, lat] coordinate');
    }
    const [lng, lat] = value;
    if (lng < -180 || lng > 180 || lat < -90 || lat > 90) {
        fail(field, 'must be within EPSG:4326 longitude and latitude ranges');
    }
    return [lng, lat];
}

function normalizeExtent(value) {
    if (!Array.isArray(value) || value.length !== 4 || !value.every(Number.isFinite)) {
        fail('extent', 'must be [minLng, minLat, maxLng, maxLat] with finite numbers');
    }
    const [minLng, minLat, maxLng, maxLat] = value;
    if (minLng >= maxLng || minLat >= maxLat) {
        fail('extent', 'must be strictly ordered as minLng < maxLng and minLat < maxLat');
    }
    if (minLng < -180 || maxLng > 180 || minLat < -90 || maxLat > 90) {
        fail('extent', 'must be within EPSG:4326 longitude and latitude ranges');
    }
    return [minLng, minLat, maxLng, maxLat];
}

function normalizeRelativePath(value, field) {
    const path = requireNonEmptyString(value, field);
    if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\') || path.includes('://')) {
        fail(field, 'must be a root-relative path');
    }
    if (path.split('/').includes('..')) fail(field, 'must not contain parent-directory segments');
    return path;
}

function normalizeOperation(value, field) {
    const operation = requireObject(value, field);
    assertOnlyKeys(operation, ['method', 'path'], field);

    const method = requireNonEmptyString(operation.method, `${field}.method`).toUpperCase();
    if (!['GET', 'POST'].includes(method)) fail(`${field}.method`, 'must be GET or POST');

    return {
        method,
        path: normalizeRelativePath(operation.path, `${field}.path`)
    };
}

function normalizeServices(value) {
    const services = requireObject(value, 'services');
    if (Object.keys(services).length === 0) fail('services', 'must define logical services');

    const normalized = {};
    for (const [serviceKey, rawService] of Object.entries(services)) {
        requireLogicalName(serviceKey, `services.${serviceKey}`);
        const field = `services.${serviceKey}`;
        const service = requireObject(rawService, field);
        assertOnlyKeys(service, ['enabled', 'path', 'operations'], field);
        if (typeof service.enabled !== 'boolean') fail(`${field}.enabled`, 'must be a boolean');

        const operations = requireObject(service.operations, `${field}.operations`);
        const normalizedOperations = {};
        for (const [operationKey, rawOperation] of Object.entries(operations)) {
            requireLogicalName(operationKey, `${field}.operations.${operationKey}`);
            normalizedOperations[operationKey] = normalizeOperation(
                rawOperation,
                `${field}.operations.${operationKey}`
            );
        }

        if (service.enabled && Object.keys(normalizedOperations).length === 0) {
            fail(`${field}.operations`, 'must not be empty for an enabled service');
        }

        const servicePath = service.enabled
            ? normalizeRelativePath(service.path, `${field}.path`)
            : service.path === undefined || service.path === null
                ? null
                : normalizeRelativePath(service.path, `${field}.path`);

        normalized[serviceKey] = {
            enabled: service.enabled,
            path: servicePath,
            operations: normalizedOperations
        };
    }

    for (const [serviceKey, requiredOperations] of Object.entries(REQUIRED_SERVICE_OPERATIONS)) {
        const service = normalized[serviceKey];
        if (!service || !service.enabled) {
            fail(`services.${serviceKey}`, 'is a required enabled P0 service');
        }
        for (const operationKey of requiredOperations) {
            if (!service.operations[operationKey]) {
                fail(`services.${serviceKey}.operations.${operationKey}`, 'is required');
            }
        }
    }

    return normalized;
}

function normalizeFields(value, field) {
    if (!Array.isArray(value) || value.length === 0) fail(field, 'must be a nonempty field allowlist');

    const seen = new Set();
    return value.map((rawField, index) => {
        const itemField = `${field}[${index}]`;
        const name = requireNonEmptyString(rawField, itemField);
        if (!FIELD_NAME_PATTERN.test(name)) {
            fail(itemField, 'must be a safe field identifier');
        }
        if (seen.has(name)) fail(itemField, 'must not duplicate another allowlisted field');
        seen.add(name);
        return name;
    });
}

function normalizePropertyMap(value, fields, field) {
    const propertyMap = requireObject(value, field);
    if (Object.keys(propertyMap).length === 0) fail(field, 'must define at least one canonical public property');
    const allowedFields = new Set(fields);
    const publicNames = new Set();
    const entries = [];

    for (const [rawField, rawPublicName] of Object.entries(propertyMap)) {
        const itemField = `${field}.${rawField}`;
        if (!allowedFields.has(rawField)) {
            fail(itemField, 'must reference an allowlisted raw field');
        }

        const publicName = requireNonEmptyString(rawPublicName, itemField);
        if (!FIELD_NAME_PATTERN.test(publicName)) {
            fail(itemField, 'must map to a safe public property identifier');
        }
        if (['sourceRef', '__proto__', 'prototype', 'constructor'].includes(publicName)) {
            fail(itemField, `must not use reserved public property name ${publicName}`);
        }
        if (publicNames.has(publicName)) {
            fail(itemField, `must map to a unique public property name; ${publicName} is already used`);
        }

        publicNames.add(publicName);
        entries.push([rawField, publicName]);
    }

    return Object.fromEntries(entries);
}

function normalizeDatasets(value, services) {
    const datasets = requireObject(value, 'datasets');
    if (Object.keys(datasets).length === 0) fail('datasets', 'must define at least one allowlisted dataset');

    const normalized = {};
    for (const [datasetKey, rawDataset] of Object.entries(datasets)) {
        requireLogicalName(datasetKey, `datasets.${datasetKey}`);
        const field = `datasets.${datasetKey}`;
        const dataset = requireObject(rawDataset, field);
        assertOnlyKeys(dataset, ['service', 'name', 'fields', 'propertyMap'], field);

        const service = requireLogicalName(dataset.service, `${field}.service`);
        if (!services[service] || !services[service].enabled) {
            fail(`${field}.service`, 'must reference an enabled logical service');
        }
        if (!services[service].operations.queryFeatures) {
            fail(`${field}.service`, 'must reference a service with a queryFeatures operation');
        }

        const fields = normalizeFields(dataset.fields, `${field}.fields`);

        normalized[datasetKey] = {
            service,
            name: requireNonEmptyString(dataset.name, `${field}.name`),
            fields,
            propertyMap: normalizePropertyMap(dataset.propertyMap, fields, `${field}.propertyMap`)
        };
    }
    return normalized;
}

function normalizeLimits(value) {
    if (value === undefined) return { maxFeatures: MAX_FEATURES };
    const limits = requireObject(value, 'limits');
    assertOnlyKeys(limits, ['maxFeatures'], 'limits');
    const maxFeatures = limits.maxFeatures === undefined ? MAX_FEATURES : limits.maxFeatures;
    if (!Number.isInteger(maxFeatures) || maxFeatures < 1) {
        fail('limits.maxFeatures', 'must be a positive integer');
    }
    return { maxFeatures: Math.min(maxFeatures, MAX_FEATURES) };
}

function normalizePublicUrl(value, field) {
    const url = requireNonEmptyString(value, field);
    let parsed;

    if (url.startsWith('/')) {
        if (url.startsWith('//') || url.includes('\\')) fail(field, 'must be a safe root-relative URL');
        parsed = new URL(url, 'https://public.invalid');
    } else {
        try {
            parsed = new URL(url);
        } catch (error) {
            fail(field, 'must be a root-relative, HTTP, or HTTPS URL', 'SUPERMAP_MANIFEST_INVALID', error);
        }
        if (!['http:', 'https:'].includes(parsed.protocol)) fail(field, 'must use HTTP or HTTPS');
        if (parsed.username || parsed.password) fail(field, 'must not contain embedded credentials');
    }

    if (parsed.search) fail(field, 'must not contain a query string');
    if (parsed.hash) fail(field, 'must not contain a fragment');
    return url;
}

function normalizePublic(value, services) {
    const publicConfig = requireObject(value, 'public');
    assertOnlyKeys(publicConfig, ['features', 'services'], 'public');

    const features = requireObject(publicConfig.features, 'public.features');
    const normalizedFeatures = {};
    for (const [featureKey, enabled] of Object.entries(features)) {
        requireLogicalName(featureKey, `public.features.${featureKey}`);
        if (typeof enabled !== 'boolean') fail(`public.features.${featureKey}`, 'must be a boolean');
        normalizedFeatures[featureKey] = enabled;
    }

    const publicServices = requireObject(publicConfig.services, 'public.services');
    const normalizedServices = {};
    for (const [serviceKey, publicUrl] of Object.entries(publicServices)) {
        requireLogicalName(serviceKey, `public.services.${serviceKey}`);
        if (!services[serviceKey] || !services[serviceKey].enabled) {
            fail(`public.services.${serviceKey}`, 'must reference an enabled logical service');
        }
        normalizedServices[serviceKey] = normalizePublicUrl(publicUrl, `public.services.${serviceKey}`);
    }

    return { features: normalizedFeatures, services: normalizedServices };
}

function validateManifest(input) {
    const manifest = requireObject(input, 'manifest');
    const contractVersion = normalizeContractVersion(manifest.contractVersion);
    const dataVersion = requireNonEmptyString(manifest.dataVersion, 'dataVersion');
    const scenicId = requireNonEmptyString(manifest.scenicId, 'scenicId');
    const crs = requireNonEmptyString(manifest.crs, 'crs').toUpperCase();
    if (crs !== 'EPSG:4326') fail('crs', 'must be EPSG:4326');

    const extent = normalizeExtent(manifest.extent);
    const center = manifest.center === undefined || manifest.center === null
        ? null
        : normalizeCoordinate(manifest.center, 'center');
    if (center && (
        center[0] < extent[0] || center[0] > extent[2]
        || center[1] < extent[1] || center[1] > extent[3]
    )) {
        fail('center', 'must lie within extent');
    }

    const services = normalizeServices(manifest.services);
    const datasets = normalizeDatasets(manifest.datasets, services);
    const limits = normalizeLimits(manifest.limits);
    const publicConfig = normalizePublic(manifest.public, services);

    return {
        contractVersion,
        dataVersion,
        scenicId,
        crs,
        center,
        extent,
        services,
        datasets,
        limits,
        public: publicConfig
    };
}

function createPublicConfig(manifest) {
    const validated = validateManifest(manifest);
    const publicConfig = {
        scenicId: validated.scenicId,
        contractVersion: validated.contractVersion,
        dataVersion: validated.dataVersion,
        crs: validated.crs,
        extent: [...validated.extent],
        features: { ...validated.public.features },
        publicServices: { ...validated.public.services }
    };
    if (validated.center) publicConfig.center = [...validated.center];
    return publicConfig;
}

function loadManifest(filePath) {
    const resolvedPath = requireNonEmptyString(filePath, 'manifestPath');
    let text;
    try {
        text = fs.readFileSync(resolvedPath, 'utf8');
    } catch (error) {
        if (error && error.code === 'ENOENT') {
            throw new ManifestValidationError('SuperMap manifest file was not found.', {
                code: 'SUPERMAP_MANIFEST_NOT_FOUND',
                field: 'manifestPath',
                cause: error
            });
        }
        throw new ManifestValidationError('SuperMap manifest file could not be read.', {
            code: 'SUPERMAP_MANIFEST_READ_ERROR',
            field: 'manifestPath',
            cause: error
        });
    }

    let parsed;
    try {
        parsed = JSON.parse(text);
    } catch (error) {
        throw new ManifestValidationError('SuperMap manifest is not valid JSON.', {
            code: 'SUPERMAP_MANIFEST_JSON_INVALID',
            field: 'manifest',
            cause: error
        });
    }
    return validateManifest(parsed);
}

function loadManifestSafe(filePath) {
    try {
        const manifest = loadManifest(filePath);
        return {
            ok: true,
            state: 'online',
            manifest,
            publicConfig: createPublicConfig(manifest),
            error: null
        };
    } catch (error) {
        const knownError = error instanceof ManifestValidationError;
        return {
            ok: false,
            state: 'offline',
            manifest: null,
            publicConfig: null,
            error: {
                code: knownError ? error.code : 'SUPERMAP_MANIFEST_UNAVAILABLE',
                message: knownError ? error.message : 'SuperMap manifest is unavailable.',
                ...(knownError && error.field ? { field: error.field } : {})
            }
        };
    }
}

module.exports = {
    MAX_FEATURES,
    SUPPORTED_CONTRACT_MAJOR,
    ManifestValidationError,
    validateManifest,
    loadManifest,
    loadManifestSafe,
    safeLoadManifest: loadManifestSafe,
    createPublicConfig,
    buildPublicConfig: createPublicConfig
};
