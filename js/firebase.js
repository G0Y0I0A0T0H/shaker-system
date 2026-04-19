// ===== FILE: js/firebase.js =====
// FB Module — Firebase wrapper (v14 hardened)
// ALL methods required by store.js, chat.js, call.js, moderators.js
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

    let _app = null, _auth = null, _db = null, _ok = false;
    let _profileCache = {};
    let _realtimeRefs = [];

    function init() {
        try {
            if (typeof firebase === 'undefined') { _ok = false; return; }
            if (!firebase.apps.length) _app = firebase.initializeApp(CONFIG);
            else _app = firebase.apps[0];
            _auth = firebase.auth();
            _db = firebase.database();
            _ok = true;
        } catch (e) { console.error('[FB] init failed:', e); _ok = false; }
    }

    try { init(); } catch (_) {}

    function isOk() { return _ok && _db !== null; }
    function getAuth() { return _auth; }
    function getDb() { return _db; }

    function toArray(data) {
        if (!data) return [];
        if (Array.isArray(data)) return data;
        if (typeof data === 'object') return Object.values(data);
        return [];
    }

    function getCachedProfile(uid) { return _profileCache[uid] || null; }

    async function readUserProfile(uid) {
        if (!isOk() || !uid) return null;
        try {
            const snap = await _db.ref('shaker/users/' + uid).once('value');
            const data = snap.val();
            if (data) _profileCache[uid] = { ...data, uid };
            return data ? { ...data, uid } : null;
        } catch (e) { console.error('[FB] readUserProfile:', e); return null; }
    }

    async function readAll(collection) {
        if (!isOk()) return {};
        try { const s = await _db.ref('shaker/' + collection).once('value'); return s.val() || {}; }
        catch (e) { console.error('[FB] readAll:', collection, e); return {}; }
    }

    async function readCollection(collection) { return readAll(collection); }

    async function writeAll(collection, data) {
        if (!isOk()) return;
        await _db.ref('shaker/' + collection).set(data);
    }

    async function writeCollection(collection, data) {
        if (!isOk()) return;
        try { await _db.ref('shaker/' + collection).set(data); }
        catch (e) { console.error('[FB] writeCollection:', collection, e); }
    }

    async function writeItem(collection, id, data) {
        if (!isOk()) return;
        await _db.ref('shaker/' + collection + '/' + id).set(data);
    }

    async function deleteItem(collection, id) {
        if (!isOk()) return;
        await _db.ref('shaker/' + collection + '/' + id).remove();
    }

    async function pullAll() {
        if (!isOk()) return;
        for (const c of ['products','inventory','orders','marketers','shipping']) {
            const d = await readAll(c);
            localStorage.setItem('shaker_' + c, JSON.stringify(d ? Object.values(d) : []));
        }
    }

    async function migrateIfEmpty() {
        if (!isOk()) return;
        for (const c of ['products','inventory','orders','marketers','shipping']) {
            try {
                const s = await _db.ref('shaker/' + c).once('value');
                if (!s.exists()) {
                    const local = JSON.parse(localStorage.getItem('shaker_' + c) || '[]');
                    if (local.length) {
                        const obj = {};
                        local.forEach(i => { if (i && i.id) obj[i.id] = i; });
                        await _db.ref('shaker/' + c).set(obj);
                    }
                }
            } catch (_) {}
        }
    }

    async function getNextBillNumber() {
        if (!isOk()) return Date.now();
        try {
            const ref = _db.ref('shaker/nextBillNumber');
            const r = await ref.transaction(c => c === null ? 100000001 : c + 1);
            return r.snapshot.val();
        } catch (e) { console.error('[FB] getNextBillNumber:', e); return Date.now(); }
    }

    async function deductStock(items) {
        if (!isOk() || !items || !items.length) return { ok: false };
        try {
            const inv = (await _db.ref('shaker/inventory').once('value')).val() || {};
            for (const item of items) {
                const m = Object.entries(inv).find(([,v]) =>
                    v.productId === item.productId && v.color === item.color && String(v.size) === String(item.size));
                if (m) await _db.ref('shaker/inventory/' + m[0] + '/stock').set(Math.max(0, (m[1].stock||0) - (item.qty||1)));
            }
            return { ok: true };
        } catch (e) { return { ok: false, error: e.message }; }
    }

    async function restoreStock(items) {
        if (!isOk() || !items || !items.length) return;
        try {
            const inv = (await _db.ref('shaker/inventory').once('value')).val() || {};
            for (const item of items) {
                const m = Object.entries(inv).find(([,v]) =>
                    v.productId === item.productId && v.color === item.color && String(v.size) === String(item.size));
                if (m) await _db.ref('shaker/inventory/' + m[0] + '/stock').set((m[1].stock||0) + (item.qty||1));
            }
        } catch (e) { console.error('[FB] restoreStock:', e); }
    }

    async function saveBackup(type) {
        if (!isOk()) return;
        const key = type === 'auto' ? 'latest' : 'manual_' + Date.now();
        const data = { savedAt: Date.now(), type };
        for (const c of ['products','inventory','orders','marketers','shipping']) {
            try { data[c] = (await _db.ref('shaker/' + c).once('value')).val() || {}; } catch (_) { data[c] = {}; }
        }
        await _db.ref('shaker_backups/' + key).set(data);
    }

    async function loadBackups() {
        if (!isOk()) return {};
        try { return (await _db.ref('shaker_backups').once('value')).val() || {}; } catch (_) { return {}; }
    }

    async function restoreBackup(key) {
        if (!isOk()) return;
        const s = await _db.ref('shaker_backups/' + key).once('value');
        const d = s.val();
        if (!d) throw new Error('النسخة غير موجودة');
        for (const c of ['products','inventory','orders','marketers','shipping']) {
            if (d[c]) await _db.ref('shaker/' + c).set(d[c]);
        }
    }

    function startRealtime(callback) {
        if (!isOk()) return;
        stopRealtime();
        ['products','inventory','orders','marketers','shipping'].forEach(c => {
            const ref = _db.ref('shaker/' + c);
            ref.on('value', snap => {
                localStorage.setItem('shaker_' + c, JSON.stringify(Object.values(snap.val() || {})));
                if (typeof callback === 'function') callback(c);
            });
            _realtimeRefs.push(ref);
        });
    }

    function stopRealtime() {
        _realtimeRefs.forEach(r => { try { r.off(); } catch (_) {} });
        _realtimeRefs = [];
    }

    async function sendSignal(targetUid, data) {
        if (!isOk() || !targetUid) return;
        await _db.ref('shaker/calls/' + targetUid + '/signal').set(data);
    }

    function listenSignaling(uid, cb) {
        if (!isOk() || !uid) return () => {};
        const ref = _db.ref('shaker/calls/' + uid + '/signal');
        const h = s => { if (s.exists()) cb(s.val()); };
        ref.on('value', h);
        return () => ref.off('value', h);
    }

    async function clearSignal(uid) {
        if (!isOk() || !uid) return;
        try { await _db.ref('shaker/calls/' + uid).remove(); } catch (_) {}
    }

    async function logout() {
        stopRealtime();
        try {
            Object.keys(localStorage).forEach(k => {
                if (k.startsWith('shaker_') || k.startsWith('_t_')) localStorage.removeItem(k);
            });
            sessionStorage.clear();
        } catch (_) {}
        if (_auth) await _auth.signOut();
        _profileCache = {};
    }

    return {
        init, isOk, getAuth, getDb, toArray,
        getCachedProfile, readUserProfile,
        readAll, readCollection, writeAll, writeCollection, writeItem, deleteItem,
        pullAll, migrateIfEmpty,
        getNextBillNumber, deductStock, restoreStock,
        saveBackup, loadBackups, restoreBackup,
        startRealtime, stopRealtime,
        sendSignal, listenSignaling, clearSignal,
        logout
    };
})();