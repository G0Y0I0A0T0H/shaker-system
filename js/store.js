/**
 * store.js — SHAKER v14
 * Uses FB.readCollection, FB.toArray, FB.writeCollection correctly
 */
'use strict';

const Store = (() => {
    const CACHE_VERSION = 'v14';

    function _cGet(key) {
        try { return JSON.parse(localStorage.getItem('shaker_' + key) || 'null'); }
        catch (_) { return null; }
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
        }
    }

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
            return cached.reduce((acc, item) => { if (item && item.id) acc[item.id] = item; return acc; }, {});
        return cached;
    }

    async function getFresh(key) {
        try {
            const data = await FB.readCollection(key);
            _cSet(key, data);
            return FB.toArray(data);
        } catch (e) { console.error('[Store] getFresh:', key, e); return get(key); }
    }

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
                console.error('[Store] syncAll failed for "' + keys[i] + '":', r.reason && r.reason.message);
        });
        try {
            const db = FB.getDb();
            if (db) {
                const snap = await db.ref('shaker/nextBillNumber').once('value');
                if (snap.exists()) _cSet('nextBillNumber', snap.val());
            }
        } catch (e) { console.warn('[Store] nextBillNumber sync failed:', e.message); }
    }

    function set(key, data) {
        const obj = Array.isArray(data)
            ? data.reduce((acc, item) => { if (item && item.id) acc[item.id] = item; return acc; }, {})
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
        await FB.writeItem(key, id, obj[id] || fields);
        return obj[id];
    }

    async function del(key, id) {
        const obj = getObj(key);
        delete obj[id];
        _cSet(key, obj);
        await FB.deleteItem(key, id);
    }

    async function getNextBillNumber() { return FB.getNextBillNumber(); }

    async function deductStock(items) {
        const r = await FB.deductStock(items);
        if (r.ok) await syncCollection('inventory');
        return r;
    }

    async function restoreStock(items) {
        await FB.restoreStock(items);
        await syncCollection('inventory');
    }

    function genId() {
        return Date.now().toString(36) + Math.random().toString(36).substr(2, 6);
    }

    return {
        get, getObj, getFresh, syncCollection, syncAll,
        set, add, update, delete: del,
        getNextBillNumber, deductStock, restoreStock, genId
    };
})();