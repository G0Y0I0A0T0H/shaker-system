/**
 * store.js — SHAKER v11
 * ══════════════════════
 * FIXES vs v10:
 *  [L1] syncAll: Promise.allSettled — partial failures don't kill full sync
 *  [M1] Store.delete: calls FB.deleteItem directly (not writeCollection)
 *       so deleted items are actually removed from Firebase, not just locally
 *  [M2] Store.set: when called with a filtered array (e.g. after delete),
 *       also explicitly removes keys not present via writeCollection (which now handles deletes)
 */

const Store = (() => {
    const CACHE_VERSION = 'v11';

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
            ['products','inventory','orders','marketers','shipping'].forEach(k =>
                localStorage.removeItem('shaker_' + k)
            );
            localStorage.setItem('shaker_cache_ver', CACHE_VERSION);
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

    // ── SYNC ──────────────────────────────────────────────────
    async function syncCollection(key) {
        const data = await FB.readCollection(key);
        _cSet(key, data);
        return FB.toArray(data);
    }

    // FIX L1: use allSettled so one failed collection doesn't abort all
    async function syncAll() {
        const keys = ['products','inventory','orders','marketers','shipping'];
        const results = await Promise.allSettled(keys.map(k => syncCollection(k)));
        results.forEach((r, i) => {
            if (r.status === 'rejected')
                console.error(`[Store] syncAll: failed to sync "${keys[i]}":`, r.reason?.message);
        });
        // Sync bill number
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
        // writeCollection (v11) handles deletes of removed keys
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

    /**
     * FIX M1: delete now calls FB.deleteItem DIRECTLY — immediate Firebase delete.
     * No longer relies on writeCollection to detect the missing key (which would
     * need an extra round-trip read). The cache is also cleaned immediately.
     */
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
        get, getObj, syncCollection, syncAll,
        set, add, update, delete: del,
        getNextBillNumber, deductStock, restoreStock,
        genId
    };
})();
