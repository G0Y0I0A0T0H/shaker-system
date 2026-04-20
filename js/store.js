/**
 * store.js — SHAKER v19 (FIXED)
 *
 * ARCHITECTURE:
 *   get()      → SYNCHRONOUS — reads from localStorage cache, returns array
 *   set/add/update/delete → ASYNC — writes to cache AND Firebase
 *   syncAll()  → ASYNC — pulls all data from Firebase into cache (called on startup)
 *
 * Cache is kept in sync by:
 *   1. syncAll() on page load
 *   2. Every write updates cache immediately, then writes to Firebase
 *   3. FB.startRealtime() updates localStorage on remote changes
 */
'use strict';

const Store = (() => {
    const CACHE_VERSION = 'v19';

    // ── Cache helpers ────────────────────────────────
    function _cGet(key) {
        try {
            return JSON.parse(localStorage.getItem('shaker_' + key) || 'null');
        } catch (_) {
            return null;
        }
    }

    function _cSet(key, data) {
        try {
            localStorage.setItem('shaker_' + key, JSON.stringify(data));
            localStorage.setItem('shaker_cache_ver', CACHE_VERSION);
        } catch (e) {
            console.warn('[Store] cache write failed:', e.message);
        }
    }

    function _checkCacheVersion() {
        if (localStorage.getItem('shaker_cache_ver') !== CACHE_VERSION) {
            console.warn('[Store] cache version changed → clearing');
            ['products','inventory','orders','marketers','nextBillNumber']
                .forEach(k => localStorage.removeItem('shaker_' + k));
            localStorage.setItem('shaker_cache_ver', CACHE_VERSION);
        }
    }

    function _toArray(data) {
        if (!data) return [];
        if (Array.isArray(data)) return data;
        if (typeof data === 'object') return Object.values(data);
        return [];
    }

    // ═══════════════════════════════════════════════
    // GET — SYNCHRONOUS — reads from localStorage cache
    // ═══════════════════════════════════════════════
    function get(key) {
        _checkCacheVersion();
        var cached = _cGet(key);
        return _toArray(cached);
    }

    // ═══════════════════════════════════════════════
    // GET OBJECT — SYNCHRONOUS — returns {id: item} map
    // ═══════════════════════════════════════════════
    function getObj(key) {
        _checkCacheVersion();
        var cached = _cGet(key);
        if (!cached) return {};
        if (Array.isArray(cached)) {
            return cached.reduce(function(acc, item) {
                if (item && item.id) acc[item.id] = item;
                return acc;
            }, {});
        }
        return typeof cached === 'object' ? cached : {};
    }

    // ═══════════════════════════════════════════════
    // GET FRESH — ASYNC — reads from Firebase
    // ═══════════════════════════════════════════════
    async function getFresh(key) {
        try {
            var data = await FB.readCollection(key);
            _cSet(key, data);
            return _toArray(data);
        } catch (e) {
            console.error('[Store] getFresh:', key, e);
            return get(key);
        }
    }

    // ═══════════════════════════════════════════════
    // SYNC COLLECTION — ASYNC — pulls one collection
    // ═══════════════════════════════════════════════
    async function syncCollection(key) {
        try {
            var data = await FB.readCollection(key);
            _cSet(key, data);
            return _toArray(data);
        } catch (e) {
            console.error('[Store] sync failed:', key, e);
            return get(key);
        }
    }

    // ═══════════════════════════════════════════════
    // SYNC ALL — ASYNC — pulls ALL collections (startup)
    // ═══════════════════════════════════════════════
    async function syncAll() {
        var keys = ['products','inventory','orders','marketers','shipping'];
        for (var i = 0; i < keys.length; i++) {
            try {
                var data = await FB.readCollection(keys[i]);
                _cSet(keys[i], data);
            } catch (e) {
                console.error('[Store] syncAll error:', keys[i], e);
            }
        }
        try {
            var db = FB.getDb();
            if (db) {
                var snap = await db.ref('shaker/nextBillNumber').once('value');
                if (snap.exists()) _cSet('nextBillNumber', snap.val());
            }
        } catch (e) {
            console.warn('[Store] bill number sync failed:', e.message);
        }
    }

    // ═══════════════════════════════════════════════
    // SET — ASYNC — replaces entire collection
    // ═══════════════════════════════════════════════
    async function set(key, data) {
        var obj = Array.isArray(data)
            ? data.reduce(function(acc, item) {
                if (item && item.id) acc[item.id] = item;
                return acc;
            }, {})
            : (data || {});
        _cSet(key, obj);
        await FB.writeCollection(key, obj);
    }

    // ═══════════════════════════════════════════════
    // ADD — ASYNC — adds single item
    // ═══════════════════════════════════════════════
    async function add(key, item) {
        if (!item.id) item.id = genId();
        var obj = getObj(key);
        obj[item.id] = item;
        _cSet(key, obj);
        await FB.writeItem(key, item.id, item);
        return item;
    }

    // ═══════════════════════════════════════════════
    // UPDATE — ASYNC — updates single item by id
    // ═══════════════════════════════════════════════
    async function update(key, id, fields) {
        var obj = getObj(key);
        var merged = obj[id] ? Object.assign({}, obj[id], fields) : Object.assign({ id: id }, fields);
        obj[id] = merged;
        _cSet(key, obj);
        await FB.writeItem(key, id, merged);
        return merged;
    }

    // ═══════════════════════════════════════════════
    // DELETE — ASYNC — removes single item by id
    // ═══════════════════════════════════════════════
    async function del(key, id) {
        var obj = getObj(key);
        delete obj[id];
        _cSet(key, obj);
        await FB.deleteItem(key, id);
    }

    // ═══════════════════════════════════════════════
    // STOCK helpers
    // ═══════════════════════════════════════════════
    async function deductStock(items) {
        var r = await FB.deductStock(items);
        if (r.ok) await syncCollection('inventory');
        return r;
    }

    async function restoreStock(items) {
        await FB.restoreStock(items);
        await syncCollection('inventory');
    }

    // ═══════════════════════════════════════════════
    // BILL NUMBER
    // ═══════════════════════════════════════════════
    async function getNextBillNumber() {
        return FB.getNextBillNumber();
    }

    // ═══════════════════════════════════════════════
    // UTILS
    // ═══════════════════════════════════════════════
    function genId() {
        return Date.now().toString(36) + Math.random().toString(36).substr(2, 6);
    }

    return {
        get: get,
        getObj: getObj,
        getFresh: getFresh,
        syncCollection: syncCollection,
        syncAll: syncAll,
        set: set,
        add: add,
        update: update,
        delete: del,
        getNextBillNumber: getNextBillNumber,
        deductStock: deductStock,
        restoreStock: restoreStock,
        genId: genId
    };
})();