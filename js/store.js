/**
 * store.js — SHAKER FIXED v18
 * ✔️ Real-time sync with Firebase
 * ✔️ Auto refresh after updates
 * ✔️ Smart cache handling
 */
'use strict';

const Store = (() => {
    const CACHE_VERSION = 'v18';

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
            console.warn('⚠️ cache version changed → clearing');

            ['products','inventory','orders','marketers','shipping','nextBillNumber']
                .forEach(k => localStorage.removeItem('shaker_' + k));

            localStorage.setItem('shaker_cache_ver', CACHE_VERSION);
        }
    }

    // ================= GET (FIXED) =================
    async function get(key) {
        _checkCacheVersion();

        try {
            const data = await FB.readCollection(key);

            if (data) {
                _cSet(key, data);
                return FB.toArray(data);
            }

            return [];
        } catch (e) {
            console.error('❌ get error:', key, e);

            const cached = _cGet(key);
            if (cached) return FB.toArray(cached);

            return [];
        }
    }

    // ================= GET OBJECT =================
    function getObj(key) {
        _checkCacheVersion();

        const cached = _cGet(key);
        if (!cached) return {};

        if (Array.isArray(cached)) {
            return cached.reduce((acc, item) => {
                if (item && item.id) acc[item.id] = item;
                return acc;
            }, {});
        }

        return cached;
    }

    // ================= GET FRESH =================
    async function getFresh(key) {
        try {
            const data = await FB.readCollection(key);
            _cSet(key, data);
            return FB.toArray(data);
        } catch (e) {
            console.error('[Store] getFresh:', key, e);
            return [];
        }
    }

    // ================= SYNC COLLECTION =================
    async function syncCollection(key) {
        try {
            const data = await FB.readCollection(key);
            _cSet(key, data);
            console.log('✅ synced:', key);
            return FB.toArray(data);
        } catch (e) {
            console.error('❌ sync failed:', key, e);
            return [];
        }
    }

    // ================= SYNC ALL (FIXED) =================
    async function syncAll() {
        const keys = ['products','inventory','orders','marketers','shipping'];

        for (const key of keys) {
            try {
                const data = await FB.readCollection(key);
                _cSet(key, data);
                console.log('✅ synced:', key);
            } catch (e) {
                console.error('❌ syncAll error:', key, e);
            }
        }

        // sync bill number
        try {
            const db = FB.getDb();
            if (db) {
                const snap = await db.ref('shaker/nextBillNumber').once('value');
                if (snap.exists()) _cSet('nextBillNumber', snap.val());
            }
        } catch (e) {
            console.warn('⚠️ bill number sync failed:', e.message);
        }
    }

    // ================= SET =================
    async function set(key, data) {
        const obj = Array.isArray(data)
            ? data.reduce((acc, item) => {
                if (item && item.id) acc[item.id] = item;
                return acc;
            }, {})
            : (data || {});

        _cSet(key, obj);

        try {
            await FB.writeCollection(key, obj);
            await syncAll(); // 🔥 FIX
        } catch (e) {
            console.error('❌ set error:', e);
        }
    }

    // ================= ADD =================
    async function add(key, item) {
        if (!item.id) item.id = genId();

        const obj = getObj(key);
        obj[item.id] = item;

        _cSet(key, obj);

        try {
            await FB.writeItem(key, item.id, item);
            await syncAll(); // 🔥 FIX
        } catch (e) {
            console.error('❌ add error:', e);
        }

        return item;
    }

    // ================= UPDATE =================
    async function update(key, id, fields) {
        const obj = getObj(key);

        if (obj[id]) {
            obj[id] = { ...obj[id], ...fields };
            _cSet(key, obj);
        }

        try {
            await FB.writeItem(key, id, obj[id] || fields);
            await syncAll(); // 🔥 FIX
        } catch (e) {
            console.error('❌ update error:', e);
        }

        return obj[id];
    }

    // ================= DELETE =================
    async function del(key, id) {
        const obj = getObj(key);

        delete obj[id];
        _cSet(key, obj);

        try {
            await FB.deleteItem(key, id);
            await syncAll(); // 🔥 FIX
        } catch (e) {
            console.error('❌ delete error:', e);
        }
    }

    // ================= STOCK =================
    async function deductStock(items) {
        const r = await FB.deductStock(items);

        if (r.ok) {
            await syncCollection('inventory');
        }

        return r;
    }

    async function restoreStock(items) {
        await FB.restoreStock(items);
        await syncCollection('inventory');
    }

    // ================= BILL =================
    async function getNextBillNumber() {
        return FB.getNextBillNumber();
    }

    // ================= UTILS =================
    function genId() {
        return Date.now().toString(36) +
               Math.random().toString(36).substr(2, 6);
    }

    return {
        get,
        getObj,
        getFresh,
        syncCollection,
        syncAll,
        set,
        add,
        update,
        delete: del,
        getNextBillNumber,
        deductStock,
        restoreStock,
        genId
    };
})();