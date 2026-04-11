/**
 * server.js — SHAKER v12 (production-hardened)
 * ═════════════════════════════════════════════
 * FIXES vs v11:
 *  [G1] CORS: supports GitHub Pages + custom HTTPS origins via SHAKER_ORIGINS
 *       env var (comma-separated). Localhost still allowed by default for dev.
 *  [G2] CORS: wildcard subdomain support for github.io pages
 *       (e.g. username.github.io), locked behind opt-in env flag
 *       SHAKER_ALLOW_GITHUB_PAGES=1 so you only enable it knowingly.
 *  [G3] Origin "null" (file://) still blocked — no regression.
 *  [G4] Vary: Origin header added so caches don't mix responses.
 *
 * KEPT FROM v11:
 *  [L1] Auto-backup interval cleared on graceful shutdown
 *  [L2] Payload depth/size guard
 *  [L3] _latestData capped at 50MB
 */

'use strict';

const express = require('express');
const fsp     = require('fs').promises;
const path    = require('path');
const crypto  = require('crypto');
const zlib    = require('zlib');

const app  = express();
const PORT = parseInt(process.env.SHAKER_PORT || '3737');

// ── REQUIRED TOKEN ───────────────────────────────────────────────────────
const API_TOKEN = process.env.SHAKER_TOKEN;
if (!API_TOKEN || API_TOKEN.trim().length < 8) {
    console.error('\n╔══════════════════════════════════════════════════╗');
    console.error('║  ⛔  STARTUP BLOCKED — SHAKER_TOKEN required     ║');
    console.error('║  Linux/Mac:  SHAKER_TOKEN=secret node server.js  ║');
    console.error('║  Windows:    set SHAKER_TOKEN=secret             ║');
    console.error('║              node server.js                      ║');
    console.error('║  Token must be ≥ 8 characters.                   ║');
    console.error('╚══════════════════════════════════════════════════╝\n');
    process.exit(1);
}

// ── CORS CONFIG ──────────────────────────────────────────────────────────
// Built-in localhost origins for dev
const DEFAULT_ORIGINS = new Set([
    'http://localhost', 'http://127.0.0.1',
    `http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`,
    'http://localhost:5500', 'http://127.0.0.1:5500',
    'http://localhost:3000', 'http://localhost:8080', 'http://localhost:5173',
]);

// FIX G1: extra origins from env (comma-separated full URLs)
// Example: SHAKER_ORIGINS="https://shaker.example.com,https://admin.example.com"
const EXTRA_ORIGINS = new Set(
    (process.env.SHAKER_ORIGINS || '')
        .split(',')
        .map(s => s.trim())
        .filter(Boolean)
);

// FIX G2: opt-in GitHub Pages wildcard (any *.github.io)
const ALLOW_GITHUB_PAGES = process.env.SHAKER_ALLOW_GITHUB_PAGES === '1';

function isOriginAllowed(origin) {
    if (!origin) return true;               // same-origin / curl / server-to-server
    if (origin === 'null') return false;    // file:// — always blocked
    if (DEFAULT_ORIGINS.has(origin)) return true;
    if (EXTRA_ORIGINS.has(origin))   return true;
    if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return true;
    if (ALLOW_GITHUB_PAGES && /^https:\/\/[a-z0-9-]+\.github\.io$/i.test(origin)) return true;
    return false;
}

app.use((req, res, next) => {
    const origin = req.headers.origin || '';
    if (origin === 'null' || origin === 'null:') {
        return res.status(403).json({ ok: false, error: 'file:// origin not allowed' });
    }
    if (!isOriginAllowed(origin)) {
        console.warn(`[CORS] Blocked: ${origin}`);
        return res.status(403).json({ ok: false, error: 'Forbidden origin' });
    }
    res.setHeader('Access-Control-Allow-Origin',  origin || 'http://localhost');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Shaker-Token');
    res.setHeader('Vary', 'Origin, Accept-Encoding'); // FIX G4
    if (req.method === 'OPTIONS') { res.sendStatus(204); return; }
    next();
});

// ── SECURITY HEADERS ─────────────────────────────────────────────────────
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options',        'DENY');
    res.setHeader('X-XSS-Protection',       '1; mode=block');
    res.setHeader('Referrer-Policy',        'no-referrer');
    res.setHeader('Cache-Control',          'no-store');
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    next();
});

// ── GZIP ─────────────────────────────────────────────────────────────────
app.use((req, res, next) => {
    const ae = req.headers['accept-encoding'] || '';
    if (!ae.includes('gzip')) { next(); return; }
    const _json = res.json.bind(res);
    res.json = data => {
        const buf = Buffer.from(JSON.stringify(data), 'utf8');
        zlib.gzip(buf, (err, gz) => {
            if (err) { _json(data); return; }
            res.setHeader('Content-Encoding', 'gzip');
            res.setHeader('Content-Type', 'application/json');
            res.end(gz);
        });
    };
    next();
});

// ── BODY PARSER ───────────────────────────────────────────────────────────
app.use(express.json({ limit: '10mb' }));

// ── RATE LIMITER with escalating bans ────────────────────────────────────
const _rl   = new Map();
const _bans = new Map();

function advancedRateLimit(req, res, next) {
    const ip  = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').split(',')[0].trim();
    const now = Date.now();
    const ban = _bans.get(ip);
    if (ban && now < ban.until) {
        const secs = Math.ceil((ban.until - now) / 1000);
        return res.status(429).json({ ok: false, error: `Banned — retry in ${secs}s` });
    }
    const b = _rl.get(ip) || { count: 0, reset: now + 60000 };
    if (now > b.reset) { b.count = 0; b.reset = now + 60000; }
    b.count++;
    _rl.set(ip, b);
    if (b.count > 30) {
        const prev  = _bans.get(ip) || { level: 0 };
        const level = Math.min(prev.level + 1, 4);
        const durations = [60000, 300000, 1800000, 3600000];
        _bans.set(ip, { until: now + durations[level - 1], level });
        _rl.delete(ip);
        return res.status(429).json({ ok: false, error: 'Too many requests', level });
    }
    next();
}
const _rlCleanup = setInterval(() => {
    const n = Date.now();
    _rl.forEach((v, k)   => { if (n > v.reset)  _rl.delete(k); });
    _bans.forEach((v, k) => { if (n > v.until) _bans.delete(k); });
}, 5 * 60 * 1000);

// ── TOKEN AUTH (timing-safe) ──────────────────────────────────────────────
function requireToken(req, res, next) {
    const token = req.headers['x-shaker-token'] || '';
    try {
        const MAX_LEN = Math.max(token.length, API_TOKEN.length, 64);
        const tokenBuf  = Buffer.alloc(MAX_LEN);
        const secretBuf = Buffer.alloc(MAX_LEN);
        Buffer.from(token).copy(tokenBuf);
        Buffer.from(API_TOKEN).copy(secretBuf);
        const valid = crypto.timingSafeEqual(tokenBuf, secretBuf) &&
                      token.length === API_TOKEN.length;
        if (!valid) throw new Error('invalid');
    } catch (_) {
        console.warn(`[Auth] Bad token from ${req.socket.remoteAddress}`);
        return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }
    next();
}

// ── PAYLOAD VALIDATION ────────────────────────────────────────────────────
const MAX_PAYLOAD_BYTES = 50 * 1024 * 1024;

function validatePayload(req, res, next) {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body))
        return res.status(400).json({ ok: false, error: 'Invalid payload' });
    if (!Object.keys(req.body).length)
        return res.status(400).json({ ok: false, error: 'Empty payload' });
    try {
        const serialized = JSON.stringify(req.body);
        if (serialized.length > MAX_PAYLOAD_BYTES) {
            return res.status(413).json({ ok: false, error: 'Payload too large (max 50MB)' });
        }
        const checkDepth = (obj, depth = 0) => {
            if (depth > 20) throw new Error('Too deeply nested');
            if (obj && typeof obj === 'object')
                Object.values(obj).forEach(v => checkDepth(v, depth + 1));
        };
        checkDepth(req.body);
    } catch (e) {
        return res.status(400).json({ ok: false, error: e.message });
    }
    next();
}

// ── STORAGE ───────────────────────────────────────────────────────────────
const BACKUP_DIR_1 = path.join(__dirname, '..', 'النسخ الاحتياطية');
const BACKUP_DIR_2 = path.join(__dirname, '..', 'backup_copy');
const MAIN_FILE    = 'backup.json';

async function ensureDirs() {
    for (const d of [BACKUP_DIR_1, BACKUP_DIR_2]) {
        try { await fsp.mkdir(d, { recursive: true }); }
        catch (e) { console.error(`Cannot create ${d}:`, e.message); }
    }
}

async function saveFile(filename, data) {
    const json    = JSON.stringify(data, null, 2);
    const results = await Promise.allSettled(
        [BACKUP_DIR_1, BACKUP_DIR_2].map(async dir => {
            await fsp.mkdir(dir, { recursive: true });
            const fp  = path.join(dir, filename);
            const tmp = fp + '.tmp';
            await fsp.writeFile(tmp, json, 'utf8');
            await fsp.rename(tmp, fp);
            return fp;
        })
    );
    const saved  = results.filter(r => r.status === 'fulfilled').map(r => r.value);
    const failed = results.filter(r => r.status === 'rejected').map(r => r.reason?.message);
    if (failed.length) console.error(`⚠️ Partial save failure: ${failed.join(', ')}`);
    if (!saved.length) throw new Error('All backup locations failed');
    return saved;
}

async function readMainFile() {
    for (const dir of [BACKUP_DIR_1, BACKUP_DIR_2]) {
        try { return JSON.parse(await fsp.readFile(path.join(dir, MAIN_FILE), 'utf8')); }
        catch (_) {}
    }
    return null;
}

// ── AUTO-BACKUP ───────────────────────────────────────────────────────────
let _latestData  = null;
let _latestHash  = null;
const _hash      = o => crypto.createHash('sha256').update(JSON.stringify(o)).digest('hex');

const _autoBackupInterval = setInterval(async () => {
    if (!_latestData) return;
    const h = _hash(_latestData);
    if (h === _latestHash) return;
    _latestHash = h;
    try {
        await saveFile(MAIN_FILE, _latestData);
        console.log(`🔁 Auto-backup @ ${new Date().toLocaleTimeString()}`);
    } catch (e) { console.error('Auto-backup failed:', e.message); }
}, 5 * 60 * 1000);

// ── ROUTES ────────────────────────────────────────────────────────────────
app.post('/backup', requireToken, advancedRateLimit, validatePayload, async (req, res) => {
    try {
        const serialized = JSON.stringify(req.body);
        if (serialized.length > MAX_PAYLOAD_BYTES) {
            return res.status(413).json({ ok: false, error: 'Data too large for memory cache' });
        }
        _latestData = req.body;
        const saved = await saveFile(MAIN_FILE, _latestData);
        res.json({ ok: true, savedAt: Date.now(), locations: saved.length });
    } catch (e) {
        console.error('/backup:', e.message);
        res.status(500).json({ ok: false, error: e.message });
    }
});

app.post('/backup/manual', requireToken, advancedRateLimit, validatePayload, async (req, res) => {
    try {
        const now = new Date();
        const p   = n => String(n).padStart(2, '0');
        const name = `shaker_${now.getFullYear()}-${p(now.getMonth()+1)}-${p(now.getDate())}_${p(now.getHours())}-${p(now.getMinutes())}-${p(now.getSeconds())}.json`;
        const saved = await saveFile(name, req.body);
        res.json({ ok: true, file: name, savedAt: Date.now(), locations: saved.length });
    } catch (e) {
        console.error('/backup/manual:', e.message);
        res.status(500).json({ ok: false, error: e.message });
    }
});

app.get('/load', requireToken, async (req, res) => {
    try {
        const data = await readMainFile();
        if (!data) return res.json({ ok: false, data: null, message: 'No backup found' });
        res.json({ ok: true, data, loadedAt: Date.now() });
    } catch (e) {
        console.error('/load:', e.message);
        res.status(500).json({ ok: false, error: e.message });
    }
});

app.get('/status', requireToken, async (req, res) => {
    const [e1, e2] = await Promise.all([
        fsp.access(path.join(BACKUP_DIR_1, MAIN_FILE)).then(() => true).catch(() => false),
        fsp.access(path.join(BACKUP_DIR_2, MAIN_FILE)).then(() => true).catch(() => false),
    ]);
    res.json({
        ok: true, version: 'v12',
        hasData: !!_latestData,
        dataSize: _latestData ? JSON.stringify(_latestData).length : 0,
        backup1: e1, backup2: e2,
        uptime: process.uptime(), ts: Date.now()
    });
});

app.get('/ping', (_req, res) => res.json({ ok: true, ts: Date.now(), version: 'v12' }));
app.use((_req, res) => res.status(404).json({ ok: false, error: 'Not found' }));
app.use((err, _req, res, _next) => {
    console.error('[Unhandled]', err?.message);
    res.status(500).json({ ok: false, error: 'Internal server error' });
});

// ── START ─────────────────────────────────────────────────────────────────
ensureDirs().then(() => {
    const srv = app.listen(PORT, '127.0.0.1', () => {
        console.log('\n╔══════════════════════════════════════════════╗');
        console.log('║    SHAKER Backup Server v12 — Ready ✅       ║');
        console.log(`║    http://127.0.0.1:${PORT}                     ║`);
        console.log('╚══════════════════════════════════════════════╝\n');
        console.log(`📁 Dir1: ${BACKUP_DIR_1}`);
        console.log(`📁 Dir2: ${BACKUP_DIR_2}`);
        console.log('🔑 Token: ✅ Set');
        if (EXTRA_ORIGINS.size)
            console.log('🌐 Extra origins:', [...EXTRA_ORIGINS].join(', '));
        if (ALLOW_GITHUB_PAGES)
            console.log('🐙 GitHub Pages: allowed (*.github.io)');
        console.log('🛡️  CORS: localhost + opt-in\n');
    });

    const stop = sig => {
        console.log(`\n👋 ${sig} — shutting down...`);
        clearInterval(_autoBackupInterval);
        clearInterval(_rlCleanup);
        srv.close(() => process.exit(0));
        setTimeout(() => process.exit(1), 5000);
    };
    process.on('SIGTERM', () => stop('SIGTERM'));
    process.on('SIGINT',  () => stop('SIGINT'));
});

process.on('uncaughtException',  e => console.error('⚠️ Uncaught:', e.message));
process.on('unhandledRejection', e => console.error('⚠️ Rejection:', e?.message));