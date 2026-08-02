'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
    MAX_FEATURES,
    ManifestValidationError,
    validateManifest,
    loadManifest,
    loadManifestSafe,
    createPublicConfig
} = require('../../integrations/supermap/manifest');

const examplePath = path.resolve(__dirname, '../../../config/supermap-manifest.example.json');

function readExample() {
    return JSON.parse(fs.readFileSync(examplePath, 'utf8'));
}

function temporaryManifest(t, contents) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'geosync-manifest-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const filePath = path.join(directory, 'manifest.json');
    fs.writeFileSync(filePath, contents, 'utf8');
    return filePath;
}

test('example manifest validates and exposes normalized P0 services', () => {
    const manifest = loadManifest(examplePath);

    assert.equal(manifest.contractVersion, '1.0.0');
    assert.equal(manifest.crs, 'EPSG:4326');
    assert.equal(manifest.services.network.enabled, true);
    assert.equal(manifest.services.network.operations.findPath.method, 'POST');
    assert.deepEqual(manifest.datasets.poi.fields, ['SmID', 'poi_id', 'name', 'category', 'capacity']);
    assert.deepEqual(manifest.datasets.poi.propertyMap, {
        poi_id: 'poiId',
        name: 'name',
        category: 'category',
        capacity: 'capacity'
    });
    assert.equal(Object.hasOwn(manifest.datasets.poi.propertyMap, 'SmID'), false);
    assert.equal(manifest.limits.maxFeatures, MAX_FEATURES);
});

test('contractVersion accepts major 1 and rejects incompatible majors', () => {
    const compatible = readExample();
    compatible.contractVersion = '1.7.3-beta.1';
    assert.equal(validateManifest(compatible).contractVersion, '1.7.3-beta.1');

    const incompatible = readExample();
    incompatible.contractVersion = '2.0.0';
    assert.throws(
        () => validateManifest(incompatible),
        error => error instanceof ManifestValidationError
            && error.code === 'SUPERMAP_MANIFEST_INCOMPATIBLE'
            && error.field === 'contractVersion'
    );
});

test('identity, CRS, and ordered EPSG:4326 extent are required', () => {
    for (const [field, value] of [
        ['dataVersion', ''],
        ['scenicId', '   '],
        ['crs', 'EPSG:3857'],
        ['extent', [10, 20, 10, 30]],
        ['extent', [10, 20, Number.NaN, 30]]
    ]) {
        const manifest = readExample();
        manifest[field] = value;
        assert.throws(
            () => validateManifest(manifest),
            error => error instanceof ManifestValidationError && error.field === field,
            `expected ${field} to be rejected`
        );
    }
});

test('required logical services and operations cannot be omitted', () => {
    const missingService = readExample();
    delete missingService.services.network;
    assert.throws(
        () => validateManifest(missingService),
        error => error instanceof ManifestValidationError && error.field === 'services.network'
    );

    const missingOperation = readExample();
    delete missingOperation.services.data.operations.queryFeatures;
    assert.throws(
        () => validateManifest(missingOperation),
        error => error instanceof ManifestValidationError
            && error.field === 'services.data.operations.queryFeatures'
    );
});

test('dataset and field allowlists reject unsafe or duplicate fields', () => {
    const wildcard = readExample();
    wildcard.datasets.poi.fields.push('*');
    assert.throws(
        () => validateManifest(wildcard),
        error => error instanceof ManifestValidationError
            && error.field === 'datasets.poi.fields[5]'
    );

    const duplicate = readExample();
    duplicate.datasets.poi.fields.push('name');
    assert.throws(
        () => validateManifest(duplicate),
        error => error instanceof ManifestValidationError
            && error.message.includes('duplicate')
    );

    const unknownService = readExample();
    unknownService.datasets.poi.service = 'missingService';
    assert.throws(
        () => validateManifest(unknownService),
        error => error instanceof ManifestValidationError
            && error.field === 'datasets.poi.service'
    );
});

test('dataset propertyMap exposes only mapped allowlisted fields with unique safe names', () => {
    const omittedFields = readExample();
    omittedFields.datasets.poi.propertyMap = { poi_id: 'poiId' };
    assert.deepEqual(validateManifest(omittedFields).datasets.poi.propertyMap, { poi_id: 'poiId' });

    const unknownRawField = readExample();
    unknownRawField.datasets.poi.propertyMap.private_field = 'privateField';
    assert.throws(
        () => validateManifest(unknownRawField),
        error => error instanceof ManifestValidationError
            && error.field === 'datasets.poi.propertyMap.private_field'
    );

    const unsafePublicName = readExample();
    unsafePublicName.datasets.poi.propertyMap.name = 'public-name';
    assert.throws(
        () => validateManifest(unsafePublicName),
        error => error instanceof ManifestValidationError
            && error.field === 'datasets.poi.propertyMap.name'
    );

    const duplicatePublicName = readExample();
    duplicatePublicName.datasets.poi.propertyMap.category = 'name';
    assert.throws(
        () => validateManifest(duplicatePublicName),
        error => error instanceof ManifestValidationError
            && error.message.includes('unique public property name')
    );

    const reservedPublicName = readExample();
    reservedPublicName.datasets.poi.propertyMap.name = 'sourceRef';
    assert.throws(
        () => validateManifest(reservedPublicName),
        error => error instanceof ManifestValidationError
            && error.message.includes('reserved public property name')
    );

    const missingPropertyMap = readExample();
    delete missingPropertyMap.datasets.poi.propertyMap;
    assert.throws(
        () => validateManifest(missingPropertyMap),
        error => error instanceof ManifestValidationError
            && error.field === 'datasets.poi.propertyMap'
    );
});

test('datasets must bind to a service that implements queryFeatures', () => {
    const manifest = readExample();
    manifest.datasets.poi.service = 'map';

    assert.throws(
        () => validateManifest(manifest),
        error => error instanceof ManifestValidationError
            && error.field === 'datasets.poi.service'
            && error.message.includes('queryFeatures')
    );
});

test('maxFeatures defaults to and is capped at 500', () => {
    const noLimits = readExample();
    delete noLimits.limits;
    assert.equal(validateManifest(noLimits).limits.maxFeatures, 500);

    const oversized = readExample();
    oversized.limits.maxFeatures = 5000;
    assert.equal(validateManifest(oversized).limits.maxFeatures, 500);

    const invalid = readExample();
    invalid.limits.maxFeatures = 0;
    assert.throws(
        () => validateManifest(invalid),
        error => error instanceof ManifestValidationError && error.field === 'limits.maxFeatures'
    );
});

test('public config contains only safe metadata and explicitly public values', () => {
    const manifest = readExample();
    manifest.internalNote = 'not public';
    manifest.services.map.privateCredential = 'must never be projected';

    assert.throws(
        () => validateManifest(manifest),
        error => error instanceof ManifestValidationError
            && error.field === 'services.map.privateCredential'
    );

    delete manifest.services.map.privateCredential;
    const publicConfig = createPublicConfig(manifest);
    assert.deepEqual(publicConfig.publicServices, { map: '/config/public-map-url' });
    assert.equal(publicConfig.features.supermap, true);
    assert.equal(publicConfig.features.threeD, false);
    assert.equal(publicConfig.services, undefined);
    assert.equal(publicConfig.datasets, undefined);
    assert.equal(publicConfig.limits, undefined);
    assert.equal(publicConfig.internalNote, undefined);
});

test('public URLs reject embedded credentials, query strings, and fragments', () => {
    const embedded = readExample();
    embedded.public.services.map = 'https://user:password@example.invalid/map';
    assert.throws(
        () => validateManifest(embedded),
        error => error instanceof ManifestValidationError
            && error.field === 'public.services.map'
    );

    const queryString = readExample();
    queryString.public.services.map = '/public/map?style=default';
    assert.throws(
        () => validateManifest(queryString),
        error => error instanceof ManifestValidationError
            && error.field === 'public.services.map'
    );

    const fragment = readExample();
    fragment.public.services.map = 'https://example.invalid/public/map#scene';
    assert.throws(
        () => validateManifest(fragment),
        error => error instanceof ManifestValidationError
            && error.field === 'public.services.map'
    );
});

test('safe loader returns structured offline state for missing manifests', () => {
    const result = loadManifestSafe(path.join(os.tmpdir(), 'definitely-missing-supermap-manifest.json'));

    assert.equal(result.ok, false);
    assert.equal(result.state, 'offline');
    assert.equal(result.manifest, null);
    assert.equal(result.publicConfig, null);
    assert.equal(result.error.code, 'SUPERMAP_MANIFEST_NOT_FOUND');
});

test('safe loader returns normalized manifest and public config on success', () => {
    const result = loadManifestSafe(examplePath);

    assert.equal(result.ok, true);
    assert.equal(result.state, 'online');
    assert.equal(result.error, null);
    assert.equal(result.manifest.services.terrain.path, null);
    assert.deepEqual(result.publicConfig.publicServices, { map: '/config/public-map-url' });
    assert.equal(result.publicConfig.datasets, undefined);
});

test('safe loader reports malformed and incompatible files without throwing', t => {
    const malformedPath = temporaryManifest(t, '{ not valid json');
    const malformed = loadManifestSafe(malformedPath);
    assert.equal(malformed.state, 'offline');
    assert.equal(malformed.error.code, 'SUPERMAP_MANIFEST_JSON_INVALID');

    const incompatibleManifest = readExample();
    incompatibleManifest.contractVersion = '9.0.0';
    const incompatiblePath = temporaryManifest(t, JSON.stringify(incompatibleManifest));
    const incompatible = loadManifestSafe(incompatiblePath);
    assert.equal(incompatible.state, 'offline');
    assert.equal(incompatible.error.code, 'SUPERMAP_MANIFEST_INCOMPATIBLE');
});

test('strict loader throws a typed error for a missing file', () => {
    assert.throws(
        () => loadManifest(path.join(os.tmpdir(), 'definitely-missing-strict-manifest.json')),
        error => error instanceof ManifestValidationError
            && error.code === 'SUPERMAP_MANIFEST_NOT_FOUND'
    );
});
