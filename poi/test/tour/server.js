'use strict';

const express = require('express');
const path = require('path');

const app = express();
const publicRoot = path.resolve(__dirname, '..', '..', 'public');
const port = Number(process.env.TOUR_TEST_PORT) || 4177;

app.disable('x-powered-by');
app.get(['/tour', '/tour.html'], (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.sendFile('tour.html', { root: publicRoot });
});
app.get('/api/test-slow', (req, res) => {
    const timer = setTimeout(() => res.json({ success: true, code: 0, data: { ok: true }, message: '' }), 1000);
    req.on('close', () => clearTimeout(timer));
});
app.use(express.static(publicRoot, { index: false, etag: false, lastModified: false }));
app.use((_req, res) => res.status(404).json({ success: false, code: 404, data: null, message: 'Not found' }));

const server = app.listen(port, '127.0.0.1', () => {
    console.log(`Tour test server listening on http://127.0.0.1:${port}`);
});

for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => server.close(() => process.exit(0)));
}
