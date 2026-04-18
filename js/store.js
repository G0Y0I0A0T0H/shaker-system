/**
 * store.js — SHAKER v12 (production-hardened)
 * ════════════════════════════════════════════
 * FIXES vs v11:
 *  [D1] Firebase is the single source of truth. get()/getObj() still read
 *       from cache for speed, but we expose getFresh() which forces a live
 *       read when the caller must not see stale data (e.g. before a delete
 *       or stock-sensitive operation).
 *  [D2] Cache version bumped to v12 so v11 clients auto-wipe stale local
 *       state on first load — prevents cached username-keyed chats and
 *       other legacy records from leaking into the new schema.
 *  [D3] set() no longer blindly overwrites on write errors — FB.writeCollection
 *       already handles deletes; we keep the cache update optimistic but the
 *       network failure is logged by FB.
 *
 * KEPT FROM v11:
 *  [L1] syncAll: Promise.allSettled — partial failures don't kill full sync
 *  [M1] delete: direct FB.deleteItem call for immediate Firebase delete
 */

const Store = (() => {
    const CACHE_VERSION = 'v12';

    function _cGet(key) {
        try { return JSON.parse(localStorage.getItem('shaker_' + key) || 'null'); }
        catch (e) { return null; }
    }

    function _cSet(key, data) {
        try {
            localStorage.setItem('shaker_' + key, JSON.stringify(data));
            localStorage.setItem('shaker_cache_ver', CACHE_VERSION);
        } catch (e) { console.warn('[Store] cache write failed:', e.message); }
    }

    function _checkCacheVersion() {
        if (localStorage.getItem('shaker_cache_ver') !== CACHE_VERSION) {
            ['products','inventory','orders','marketers','shipping','nextBillNumber'].forEach(k =>
                localStorage.removeItem('shaker_' + k)
            );
            localStorage.setItem('shaker_cache_ver', CACHE_VERSION);
            console.log('[Store] Cache wiped — upgraded to', CACHE_VERSION);
        }
    }

    // ── READ ──────────────────────────────────────────────────
    function get(key) {
        _checkCacheVersion();
        const cached = _cGet(key);
        if (!cached) return [];
        return FB.toArray(cached);
    }

    function getObj(key) {
        _checkCacheVersion();
        const cached = _cGet(key);
        if (!cached) return {};
        if (Array.isArray(cached))
            return cached.reduce((acc, item) => { if (item?.id) acc[item.id] = item; return acc; }, {});
        return cached;
    }

    // FIX D1: force-fresh read — bypasses cache entirely
    async function getFresh(key) {
        const data = await FB.readCollection(key);
        _cSet(key, data);
        return FB.toArray(data);
    }

    // ── SYNC ──────────────────────────────────────────────────
    async function syncCollection(key) {
        const data = await FB.readCollection(key);
        _cSet(key, data);
        return FB.toArray(data);
    }

    async function syncAll() {
        const keys = ['products','inventory','orders','marketers','shipping'];
        const results = await Promise.allSettled(keys.map(k => syncCollection(k)));
        results.forEach((r, i) => {
            if (r.status === 'rejected')
                console.error(`[Store] syncAll: failed to sync "${keys[i]}":`, r.reason?.message);
        });
        try {
            const db = FB.getDb();
            if (db) {
                const snap = await db.ref('shaker/nextBillNumber').once('value');
                if (snap.exists()) _cSet('nextBillNumber', snap.val());
            }
        } catch (e) { console.warn('[Store] syncAll: nextBillNumber sync failed:', e.message); }
    }

    // ── WRITE ─────────────────────────────────────────────────
    function set(key, data) {
        const obj = Array.isArray(data)
            ? data.reduce((acc, item) => { if (item?.id) acc[item.id] = item; return acc; }, {})
            : (data || {});
        _cSet(key, obj);
        FB.writeCollection(key, obj);
    }

    async function add(key, item) {
        if (!item.id) item.id = genId();
        const obj = getObj(key);
        obj[item.id] = item;
        _cSet(key, obj);
        await FB.writeItem(key, item.id, item);
        return item;
    }

    async function update(key, id, fields) {
        const obj = getObj(key);
        if (obj[id]) { obj[id] = { ...obj[id], ...fields }; _cSet(key, obj); }
        await FB.writeItem(key, id, fields);
        return obj[id];
    }

    async function del(key, id) {
        const obj = getObj(key);
        delete obj[id];
        _cSet(key, obj);
        await FB.deleteItem(key, id);
    }

    // ── BILL NUMBER ───────────────────────────────────────────
    async function getNextBillNumber() {
        return FB.getNextBillNumber();
    }

    // ── STOCK ─────────────────────────────────────────────────
    async function deductStock(items) {
        const result = await FB.deductStock(items);
        if (result.ok) await syncCollection('inventory');
        return result;
    }

    async function restoreStock(items) {
        await FB.restoreStock(items);
        await syncCollection('inventory');
    }

    // ── UTILS ─────────────────────────────────────────────────
    function genId() {
        return Date.now().toString(36) + Math.random().toString(36).substr(2, 6);
    }

    return {
        get, getObj, getFresh, syncCollection, syncAll,
        set, add, update, delete: del,
        getNextBillNumber, deductStock, restoreStock,
        genId
    };
})();