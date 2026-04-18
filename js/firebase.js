// ===== FILE: js/firebase.js =====
// FB Module — Firebase wrapper (v12 hardened)
// Centralized config, auth, database, caching, realtime
'use strict';

const FB = (() => {
    const CONFIG = {
        apiKey: "AIzaSyBA0tDEOqi1L2nYF-4vS2aPQIADzLvs7ms",
        authDomain: "shaker-b307b.firebaseapp.com",
        databaseURL: "https://shaker-b307b-default-rtdb.firebaseio.com",
        projectId: "shaker-b307b",
        storageBucket: "shaker-b307b.firebasestorage.app",
        messagingSenderId: "594608212735",
        appId: "1:594608212735:web:19450e64ce6b09364e9aca"
    };

    let _app = null;
    let _auth = null;
    let _db = null;
    let _ok = false;
    let _profileCache = {};
    let _realtimeRefs = [];

    function init() {
        try {
            if (!firebase.apps.length) {
                _app = firebase.initializeApp(CONFIG);
            } else {
                _app = firebase.apps[0];
            }
            _auth = firebase.auth();
            _db = firebase.database();
            _ok = true;
        } catch (e) {
            console.error('[FB] init failed:', e);
            _ok = false;
        }
    }

    // Auto-init on load
    try { init(); } catch (_) {}

    function isOk() { return _ok && _db !== null; }
    function getAuth() { return _auth; }
    function getDb() { return _db; }

    // ── User Profile ──────────────────────────────────
    function getCachedProfile(uid) {
        return _profileCache[uid] || null;
    }

    async function readUserProfile(uid) {
        if (!isOk() || !uid) return null;
        try {
            const snap = await _db.ref('shaker/users/' + uid).once('value');
            const data = snap.val();
            if (data) {
                _profileCache[uid] = { ...data, uid };
            }
            return data ? { ...data, uid } : null;
        } catch (e) {
            console.error('[FB] readUserProfile error:', e);
            return null;
        }
    }

    // ── Data Operations ───────────────────────────────
    async function readAll(collection) {
        if (!isOk()) return {};
        try {
            const snap = await _db.ref('shaker/' + collection).once('value');
            return snap.val() || {};
        } catch (e) {
            console.error('[FB] readAll error:', collection, e);
            return {};
        }
    }

    async function writeAll(collection, data) {
        if (!isOk()) return;
        await _db.ref('shaker/' + collection).set(data);
    }

    async function writeItem(collection, id, data) {
        if (!isOk()) return;
        await _db.ref('shaker/' + collection + '/' + id).set(data);
    }

    async function deleteItem(collection, id) {
        if (!isOk()) return;
        await _db.ref('shaker/' + collection + '/' + id).remove();
    }

    // ── Pull all data collections ─────────────────────
    async function pullAll() {
        if (!isOk()) return;
        const collections = ['products', 'inventory', 'orders', 'marketers', 'shipping'];
        for (const c of collections) {
            const data = await readAll(c);
            const arr = data ? Object.values(data) : [];
            localStorage.setItem('shaker_' + c, JSON.stringify(arr));
        }
    }

    // ── Migrate (if Firebase empty, push local) ───────
    async function migrateIfEmpty() {
        if (!isOk()) return;
        const collections = ['products', 'inventory', 'orders', 'marketers', 'shipping'];
        for (const c of collections) {
            const snap = await _db.ref('shaker/' + c).once('value');
            if (!snap.exists()) {
                const local = JSON.parse(localStorage.getItem('shaker_' + c) || '[]');
                if (local.length) {
                    const obj = {};
                    local.forEach(item => { if (item.id) obj[item.id] = item; });
                    await _db.ref('shaker/' + c).set(obj);
                }
            }
        }
    }

    // ── Backup ────────────────────────────────────────
    async function saveBackup(type) {
        if (!isOk()) return;
        const key = type === 'auto' ? 'latest' : 'manual_' + Date.now();
        const data = {};
        const collections = ['products', 'inventory', 'orders', 'marketers', 'shipping'];
        for (const c of collections) {
            const snap = await _db.ref('shaker/' + c).once('value');
            data[c] = snap.val() || {};
        }
        data.savedAt = Date.now();
        data.type = type;
        await _db.ref('shaker_backups/' + key).set(data);
    }

    async function loadBackups() {
        if (!isOk()) return {};
        const snap = await _db.ref('shaker_backups').once('value');
        return snap.val() || {};
    }

    async function restoreBackup(key) {
        if (!isOk()) return;
        const snap = await _db.ref('shaker_backups/' + key).once('value');
        const data = snap.val();
        if (!data) throw new Error('النسخة غير موجودة');
        const collections = ['products', 'inventory', 'orders', 'marketers', 'shipping'];
        for (const c of collections) {
            if (data[c]) {
                await _db.ref('shaker/' + c).set(data[c]);
            }
        }
    }

    // ── Realtime listeners ────────────────────────────
    function startRealtime(callback) {
        if (!isOk()) return;
        // Detach old listeners
        stopRealtime();
        const collections = ['products', 'inventory', 'orders', 'marketers', 'shipping'];
        collections.forEach(c => {
            const ref = _db.ref('shaker/' + c);
            ref.on('value', snap => {
                const data = snap.val() || {};
                const arr = Object.values(data);
                localStorage.setItem('shaker_' + c, JSON.stringify(arr));
                if (typeof callback === 'function') callback(c);
            });
            _realtimeRefs.push(ref);
        });
    }

    function stopRealtime() {
        _realtimeRefs.forEach(ref => {
            try { ref.off(); } catch (_) {}
        });
        _realtimeRefs = [];
    }

    // ── Logout (total wipe) ──────────────────────────
    async function logout() {
        stopRealtime();
        try {
            // Clear all shaker_ localStorage keys
            Object.keys(localStorage).forEach(k => {
                if (k.startsWith('shaker_')) localStorage.removeItem(k);
            });
            // Clear sessionStorage
            sessionStorage.clear();
            // Clear throttle keys
            Object.keys(localStorage).forEach(k => {
                if (k.startsWith('throttle_')) localStorage.removeItem(k);
            });
        } catch (_) {}
        if (_auth) {
            await _auth.signOut();
        }
        _profileCache = {};
    }

    return {
        init,
        isOk,
        getAuth,
        getDb,
        getCachedProfile,
        readUserProfile,
        readAll,
        writeAll,
        writeItem,
        deleteItem,
        pullAll,
        migrateIfEmpty,
        saveBackup,
        loadBackups,
        restoreBackup,
        startRealtime,
        stopRealtime,
        logout
    };
})();