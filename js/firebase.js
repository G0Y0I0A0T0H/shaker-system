/**
 * firebase.js — SHAKER v12 (production-hardened)
 * ═══════════════════════════════════════════════
 * SECURITY FIXES vs v11:
 *  [S1] CRITICAL: Removed admin auto-creation backdoor in onAuthChange.
 *       v11 would silently create a profile with role='admin' for ANY
 *       authenticated user whose DB record was missing. This meant anyone
 *       who could sign up via Firebase Auth (or whose profile was deleted)
 *       became an admin automatically. Now we FAIL CLOSED: missing profile
 *       → no role → caller must reject.
 *  [S2] onAuthChange callback signature expanded: cb(user, role, userData, dbError)
 *       so guardPage can distinguish "no profile" from "transient DB error".
 *  [S3] Removed every fallback that assumed role='admin'. No default role.
 *  [S4] Profile reads no longer swallow errors — we surface them upstream.
 *  [S5] log() never crashes but no longer leaks user email into logs unnecessarily.
 *
 * KEPT FROM v11:
 *  [C1] writeCollection deletes removed keys (orphan fix)
 *  [C2] deductStock atomic transaction on specific key
 *  [C3] _watchConnection guarded against duplicate calls
 *  [C4] startRealtime guarded against multiple calls
 */

const FIREBASE_CONFIG = {
    apiKey:            "AIzaSyBA0tDEOqi1L2nYF-4vS2aPQIADzLvs7ms",
    authDomain:        "shaker-b307b.firebaseapp.com",
    databaseURL:       "https://shaker-b307b-default-rtdb.firebaseio.com",
    projectId:         "shaker-b307b",
    storageBucket:     "shaker-b307b.firebasestorage.app",
    messagingSenderId: "594608212735",
    appId:             "1:594608212735:web:19450e64ce6b09364e9aca"
};

const FB = (() => {
    let _db              = null;
    let _auth            = null;
    let _ok              = false;
    let _timers          = {};
    let _badgeTimer      = null;
    let _listeners       = {};
    let _realtimeStarted = false;
    let _connListening   = false;

    // ══════════════════════════════════
    // INIT
    // ══════════════════════════════════
    function init() {
        try {
            const app = firebase.apps.length
                ? firebase.apps[0]
                : firebase.initializeApp(FIREBASE_CONFIG);
            _db   = app.database();
            _auth = app.auth();
            _ok   = true;
            console.log('[FB] ✅ Initialized');
            _watchConnection();
        } catch (e) {
            _ok = false;
            console.error('[FB] Init failed:', e.message);
        }
    }

    function _watchConnection() {
        if (!_db || _connListening) return;
        _connListening = true;
        _db.ref('.info/connected').on('value', snap => {
            const on = snap.val() === true;
            const el = document.getElementById('fb-sidebar-status');
            if (el) {
                el.textContent = on ? '🔥 Firebase: متصل  ✅' : '⚠️ Firebase: غير متصل';
                el.style.color = on ? '#4ade80' : '#f87171';
            }
        });
    }

    // ══════════════════════════════════
    // AUTH STATE — FIX S1/S2/S3
    // ══════════════════════════════════
    // Callback signature: cb(user, role, userData, dbError)
    //   user:      firebase.User | null
    //   role:      'admin' | 'moderator' | null  (NEVER defaults to anything)
    //   userData:  profile object | null
    //   dbError:   Error | null   — set only on transient DB read failure
    function onAuthChange(cb) {
        if (!_auth) { cb(null, null, null, null); return () => {}; }
        return _auth.onAuthStateChanged(async user => {
            if (!user) {
                console.log('[FB] 👤 Signed out');
                cb(null, null, null, null);
                return;
            }
            console.log(`[FB] 🔑 Auth state: ${user.uid}`);
            try {
                const snap = await _db.ref(`shaker/users/${user.uid}`).once('value');
                if (!snap.exists()) {
                    // FIX S1: NO auto-creation. Missing profile = unauthorized.
                    console.warn('[FB] ⛔ No profile for uid', user.uid, '— access denied');
                    cb(user, null, null, null);
                    return;
                }
                const userData = snap.val();
                const role = userData.role;
                if (role !== 'admin' && role !== 'moderator') {
                    console.warn('[FB] ⛔ Invalid role:', role);
                    cb(user, null, userData, null);
                    return;
                }
                cb(user, role, userData, null);
            } catch (e) {
                // FIX S2: surface DB error so guardPage can reject (not assume admin)
                console.error('[FB] onAuthChange DB error:', e.message);
                cb(user, null, null, e);
            }
        });
    }

    // ══════════════════════════════════
    // READS
    // ══════════════════════════════════
    async function readCollection(col) {
        if (!_ok) throw new Error(`Firebase not ready — cannot read ${col}`);
        const snap = await _db.ref(`shaker/${col}`).once('value');
        return snap.exists() ? snap.val() : {};
    }

    async function readItem(col, id) {
        if (!_ok) return null;
        const snap = await _db.ref(`shaker/${col}/${id}`).once('value');
        return snap.exists() ? snap.val() : null;
    }

    // FIX S4: no longer swallows errors silently — returns null only for missing
    async function readUserProfile(uid) {
        if (!_ok || !uid) return null;
        const snap = await _db.ref(`shaker/users/${uid}`).once('value');
        return snap.exists() ? snap.val() : null;
    }

    // ══════════════════════════════════
    // WRITES
    // ══════════════════════════════════
    function writeCollection(col, data) {
        if (!_ok) return;
        clearTimeout(_timers[col]);
        _timers[col] = setTimeout(async () => {
            try {
                const obj = _toObj(data);
                const currentSnap = await _db.ref(`shaker/${col}`).once('value');
                const currentKeys = currentSnap.exists() ? Object.keys(currentSnap.val()) : [];
                const newKeys     = Object.keys(obj);
                const updates = {};
                newKeys.forEach(id => { updates[`shaker/${col}/${id}`] = obj[id]; });
                currentKeys
                    .filter(k => !newKeys.includes(k))
                    .forEach(k => { updates[`shaker/${col}/${k}`] = null; });
                if (Object.keys(updates).length > 0) {
                    await _db.ref('/').update(updates);
                }
                badge('💾 محفوظ ✅', '#16a34a');
            } catch (e) {
                console.error(`[FB] writeCollection(${col}):`, e.message);
                badge('❌ فشل الحفظ: ' + e.message, '#dc2626');
            }
        }, 900);
    }

    async function writeItem(col, id, data) {
        if (!_ok) throw new Error('Firebase غير متصل');
        await _db.ref(`shaker/${col}/${id}`).update(data);
    }

    async function pushItem(col, data) {
        if (!_ok) throw new Error('Firebase غير متصل');
        const ref = await _db.ref(`shaker/${col}`).push(data);
        return ref.key;
    }

    async function deleteItem(col, id) {
        if (!_ok) throw new Error('Firebase غير متصل');
        await _db.ref(`shaker/${col}/${id}`).remove();
    }

    async function setField(path, value) {
        if (!_ok) throw new Error('Firebase غير متصل');
        await _db.ref('shaker/' + path).set(value);
    }

    async function updateUserField(uid, fields) {
        if (!_ok) throw new Error('Firebase غير متصل');
        await _db.ref(`shaker/users/${uid}`).update(fields);
    }

    // ══════════════════════════════════
    // TRANSACTIONS
    // ══════════════════════════════════
    async function getNextBillNumber() {
        if (!_ok) {
            const cur = parseInt(localStorage.getItem('shaker_nextBillNumber') || '100000000');
            localStorage.setItem('shaker_nextBillNumber', String(cur + 1));
            return cur;
        }
        try {
            let bill = 100000000;
            await _db.ref('shaker/nextBillNumber').transaction(cur => {
                bill = cur || 100000000;
                return bill + 1;
            });
            localStorage.setItem('shaker_nextBillNumber', String(bill + 1));
            return bill;
        } catch (e) {
            console.error('[FB] getNextBillNumber:', e.message);
            const cur = parseInt(localStorage.getItem('shaker_nextBillNumber') || '100000000');
            localStorage.setItem('shaker_nextBillNumber', String(cur + 1));
            return cur;
        }
    }

    async function deductStock(items) {
        if (!_ok) return { ok: false, error: 'Firebase غير متصل' };
        const errors = [];
        try {
            const invSnap = await _db.ref('shaker/inventory').once('value');
            const invData = invSnap.exists() ? invSnap.val() : {};
            for (const item of items) {
                let invKey = null;
                for (const [k, v] of Object.entries(invData)) {
                    if (v.productId === item.productId &&
                        v.color     === item.color &&
                        String(v.size) === String(item.size)) {
                        invKey = k; break;
                    }
                }
                if (!invKey) {
                    errors.push(`${_safe(item.productName)} (${_safe(item.color)}/${_safe(item.size)}) غير موجود في المخزون`);
                    continue;
                }
                let txOk = false;
                let txAbortReason = null;
                await _db.ref(`shaker/inventory/${invKey}/stock`).transaction(cur => {
                    if (cur === null) { txAbortReason = 'item_deleted'; return undefined; }
                    if (cur < item.qty) { txAbortReason = 'insufficient'; return undefined; }
                    txOk = true;
                    return cur - item.qty;
                });
                if (!txOk) {
                    const reason = txAbortReason === 'item_deleted'
                        ? 'غير موجود في المخزون (تم حذفه)'
                        : 'المخزون غير كافٍ';
                    errors.push(`${_safe(item.productName)} (${_safe(item.color)}/${_safe(item.size)}): ${reason}`);
                }
            }
        } catch (e) {
            console.error('[FB] deductStock:', e.message);
            return { ok: false, error: 'خطأ في تحديث المخزون: ' + e.message };
        }
        return errors.length ? { ok: false, error: errors.join('\n') } : { ok: true };
    }

    async function restoreStock(items) {
        if (!_ok) return;
        try {
            const invSnap = await _db.ref('shaker/inventory').once('value');
            const invData = invSnap.exists() ? invSnap.val() : {};
            for (const item of items) {
                let invKey = null;
                for (const [k, v] of Object.entries(invData)) {
                    if (v.productId === item.productId &&
                        v.color === item.color &&
                        String(v.size) === String(item.size)) {
                        invKey = k; break;
                    }
                }
                if (!invKey) continue;
                await _db.ref(`shaker/inventory/${invKey}/stock`).transaction(cur => (cur || 0) + item.qty);
            }
        } catch (e) { console.error('[FB] restoreStock:', e.message); }
    }

    // ══════════════════════════════════
    // REALTIME LISTENERS
    // ══════════════════════════════════
    function listen(col, cb) {
        if (!_ok) return () => {};
        if (_listeners[col]) _db.ref(`shaker/${col}`).off('value', _listeners[col]);
        const handler = snap => cb(snap.exists() ? snap.val() : {});
        _db.ref(`shaker/${col}`).on('value', handler);
        _listeners[col] = handler;
        return () => { _db.ref(`shaker/${col}`).off('value', handler); delete _listeners[col]; };
    }

    function stopAllListeners() {
        Object.keys(_listeners).forEach(col =>
            _db.ref(`shaker/${col}`).off('value', _listeners[col])
        );
        _listeners = {};
        _realtimeStarted = false;
    }

    function startRealtime(onUpdate) {
        if (!_ok || _realtimeStarted) return;
        _realtimeStarted = true;
        ['products','inventory','orders','marketers','shipping'].forEach(col => {
            listen(col, data => {
                if (data && Object.keys(data).length)
                    localStorage.setItem('shaker_' + col, JSON.stringify(data));
                if (onUpdate) onUpdate();
            });
        });
    }

    function listenCollection(col, cb) { return listen(col, cb); }

    // ══════════════════════════════════
    // BACKUP
    // ══════════════════════════════════
    async function saveBackup(label = 'auto') {
        if (!_ok) return;
        try {
            const [products, inventory, orders, marketers, shipping] = await Promise.all([
                readCollection('products').catch(() => ({})),
                readCollection('inventory').catch(() => ({})),
                readCollection('orders').catch(() => ({})),
                readCollection('marketers').catch(() => ({})),
                readCollection('shipping').catch(() => ({})),
            ]);
            const payload = { products, inventory, orders, marketers, shipping, savedAt: Date.now(), label };
            const updates = { 'shaker_backups/latest': payload };
            if (label !== 'auto') updates[`shaker_backups/manual_${Date.now()}`] = payload;
            await _db.ref('/').update(updates);
            if (label !== 'auto') {
                const snap = await _db.ref('shaker_backups').once('value');
                if (snap.exists()) {
                    const keys = Object.keys(snap.val()).filter(k => k.startsWith('manual_')).sort();
                    if (keys.length > 10)
                        for (const k of keys.slice(0, keys.length - 10))
                            await _db.ref(`shaker_backups/${k}`).remove();
                }
            }
        } catch (e) { console.error('[FB] saveBackup:', e.message); throw e; }
    }

    async function loadBackups() {
        if (!_ok) return {};
        try {
            const snap = await _db.ref('shaker_backups').once('value');
            return snap.exists() ? snap.val() : {};
        } catch (e) { return {}; }
    }

    async function restoreBackup(key) {
        if (!_ok) throw new Error('Firebase غير متصل');
        const snap = await _db.ref(`shaker_backups/${key}`).once('value');
        if (!snap.exists()) throw new Error('النسخة غير موجودة');
        const d = snap.val();
        const updates = {};
        ['products','inventory','orders','marketers','shipping'].forEach(k => {
            if (d[k]) updates[`shaker/${k}`] = d[k];
        });
        await _db.ref('/').update(updates);
    }

    // ══════════════════════════════════
    // MIGRATION
    // ══════════════════════════════════
    async function migrateIfEmpty() {
        if (!_ok) return;
        try {
            const snap = await _db.ref('shaker/products').once('value');
            if (snap.exists()) return;
            const updates = {};
            ['products','inventory','orders','marketers','shipping'].forEach(k => {
                const raw = localStorage.getItem('shaker_' + k);
                if (!raw) return;
                try {
                    const parsed = JSON.parse(raw);
                    const obj = Array.isArray(parsed)
                        ? parsed.reduce((a, item) => { if (item?.id) a[item.id] = item; return a; }, {})
                        : parsed;
                    if (Object.keys(obj).length) updates[`shaker/${k}`] = obj;
                } catch (_) {}
            });
            const bn = localStorage.getItem('shaker_nextBillNumber');
            if (bn) updates['shaker/nextBillNumber'] = parseInt(bn);
            if (Object.keys(updates).length) {
                await _db.ref('/').update(updates);
                badge('⬆️ تم رفع البيانات إلى Firebase', '#2563eb');
            }
        } catch (e) { console.warn('[FB] migrateIfEmpty:', e.message); }
    }

    // ══════════════════════════════════
    // LOGGING
    // ══════════════════════════════════
    async function log(action, details = {}) {
        if (!_ok || !_auth?.currentUser) return;
        try {
            await _db.ref('shaker/logs').push({
                uid:    _auth.currentUser.uid,
                action, details, time: Date.now()
            });
        } catch (_) { /* never crash on log failure */ }
    }

    // ══════════════════════════════════
    // CHAT — keyed by UID only (FIX: no username-keyed chats)
    // ══════════════════════════════════
    async function sendChatMessage(modUid, sender, text) {
        if (!_ok) throw new Error('Firebase غير متصل');
        if (!modUid || !sender || !text) throw new Error('بيانات الرسالة ناقصة');
        const clean = String(text).trim();
        if (!clean) throw new Error('الرسالة فارغة');
        if (clean.length > 2000) throw new Error('الرسالة أطول من 2000 حرف');
        const ref = await _db.ref(`shaker/chats/${modUid}`).push({
            sender, text: clean, time: Date.now()
        });
        return ref.key;
    }

    function listenChat(modUid, cb) {
        if (!_ok || !modUid) return () => {};
        const ref = _db.ref(`shaker/chats/${modUid}`);
        const handler = snap => cb(snap.exists() ? snap.val() : {});
        ref.on('value', handler);
        return () => ref.off('value', handler);
    }

    async function deleteChatMessage(modUid, msgId) {
        if (!_ok) throw new Error('Firebase غير متصل');
        await _db.ref(`shaker/chats/${modUid}/${msgId}`).remove();
    }

    // ══════════════════════════════════
    // LOGOUT
    // ══════════════════════════════════
    async function logout() {
        stopAllListeners();
        if (_auth) await _auth.signOut().catch(() => {});
        // Clear session storage
        try { sessionStorage.removeItem('shaker_mod_session'); } catch (_) {}
    }

    // ══════════════════════════════════
    // HELPERS
    // ══════════════════════════════════
    function _toObj(data) {
        if (!data) return {};
        if (!Array.isArray(data)) return data;
        return data.reduce((acc, item) => { if (item?.id) acc[item.id] = item; return acc; }, {});
    }

    function toArray(obj) {
        if (!obj) return [];
        if (Array.isArray(obj)) return obj;
        return Object.entries(obj).map(([id, val]) => ({ ...val, id: val.id || id }));
    }

    function _safe(s) {
        if (typeof s !== 'string') return String(s || '');
        return s.replace(/[<>"'&]/g, c => ({ '<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;','&':'&amp;' }[c]));
    }

    function badge(msg, bg) {
        let el = document.getElementById('_fb_badge');
        if (!el) {
            el = document.createElement('div');
            el.id = '_fb_badge';
            el.style.cssText = 'position:fixed;bottom:4.5rem;left:1rem;z-index:99999;padding:5px 14px;border-radius:20px;font-size:.78rem;font-weight:700;color:#fff;pointer-events:none;transition:opacity .6s;font-family:Tajawal,sans-serif;';
            document.body.appendChild(el);
        }
        el.textContent = msg; el.style.background = bg; el.style.opacity = '1';
        clearTimeout(_badgeTimer);
        _badgeTimer = setTimeout(() => { el.style.opacity = '0'; }, 3500);
    }

    const getDb   = () => _db;
    const getAuth = () => _auth;
    const isOk    = () => _ok;

    return {
        init, onAuthChange,
        readCollection, readItem, readUserProfile,
        writeCollection, writeItem, pushItem, deleteItem, setField, updateUserField,
        getNextBillNumber, deductStock, restoreStock,
        listen, stopAllListeners, startRealtime, listenCollection,
        saveBackup, loadBackups, restoreBackup,
        migrateIfEmpty, log, logout,
        sendChatMessage, listenChat, deleteChatMessage,
        toArray, badge, getDb, getAuth, isOk
    };
})();