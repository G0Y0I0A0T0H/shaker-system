// ===== FILE: js/store.js =====
// Store Module — localStorage + Firebase sync
// v12: cache wiped on upgrade
'use strict';

const Store = (() => {
    const VERSION_KEY = 'shaker_store_version';
    const CURRENT_VERSION = '12';
    const COLLECTIONS = ['products', 'inventory', 'orders', 'marketers', 'shipping'];

    // Wipe cache on version upgrade
    (function checkVersion() {
        const v = localStorage.getItem(VERSION_KEY);
        if (v !== CURRENT_VERSION) {
            COLLECTIONS.forEach(c => localStorage.removeItem('shaker_' + c));
            localStorage.setItem(VERSION_KEY, CURRENT_VERSION);
        }
    })();

    // ── Get (array) ──────────────────────────────────
    function get(collection) {
        try {
            return JSON.parse(localStorage.getItem('shaker_' + collection) || '[]');
        } catch (_) {
            return [];
        }
    }

    // ── Get as object (keyed by id) ──────────────────
    function getObj(collection) {
        const arr = get(collection);
        const obj = {};
        arr.forEach(item => { if (item.id) obj[item.id] = item; });
        return obj;
    }

    // ── Set (full array) ─────────────────────────────
    function set(collection, data) {
        const arr = Array.isArray(data) ? data : Object.values(data);
        localStorage.setItem('shaker_' + collection, JSON.stringify(arr));
        // Sync to Firebase
        _syncToFirebase(collection, arr);
    }

    // ── Add single item ──────────────────────────────
    async function add(collection, item) {
        const arr = get(collection);
        arr.push(item);
        localStorage.setItem('shaker_' + collection, JSON.stringify(arr));
        if (FB.isOk() && item.id) {
            await FB.writeItem(collection, item.id, item);
        }
    }

    // ── Update single item ───────────────────────────
    async function update(collection, id, data) {
        const arr = get(collection);
        const idx = arr.findIndex(item => item.id === id);
        if (idx !== -1) {
            arr[idx] = { ...arr[idx], ...data };
            localStorage.setItem('shaker_' + collection, JSON.stringify(arr));
            if (FB.isOk()) {
                await FB.writeItem(collection, id, arr[idx]);
            }
        }
    }

    // ── Delete single item ───────────────────────────
    async function del(collection, id) {
        let arr = get(collection);
        arr = arr.filter(item => item.id !== id);
        localStorage.setItem('shaker_' + collection, JSON.stringify(arr));
        if (FB.isOk()) {
            await FB.deleteItem(collection, id);
        }
    }

    // ── Sync all from Firebase ────────────────────────
    async function syncAll() {
        if (!FB.isOk()) return;
        for (const c of COLLECTIONS) {
            const data = await FB.readAll(c);
            const arr = data ? Object.values(data) : [];
            localStorage.setItem('shaker_' + c, JSON.stringify(arr));
        }
    }

    // ── Generate ID ──────────────────────────────────
    function genId() {
        return Date.now().toString(36) + Math.random().toString(36).substr(2, 9);
    }

    // ── Get next bill number ─────────────────────────
    async function getNextBillNumber() {
        const orders = get('orders');
        if (orders.length === 0) return 1001;
        const maxBill = Math.max(...orders.map(o => parseInt(o.billNumber) || 0));
        return maxBill + 1;
    }

    // ── Internal: sync to Firebase ───────────────────
    function _syncToFirebase(collection, arr) {
        if (!FB.isOk()) return;
        const obj = {};
        arr.forEach(item => { if (item.id) obj[item.id] = item; });
        FB.writeAll(collection, obj).catch(e => console.error('[Store] sync error:', e));
    }

    return {
        get,
        getObj,
        set,
        add,
        update,
        delete: del,
        syncAll,
        genId,
        getNextBillNumber
    };
})();