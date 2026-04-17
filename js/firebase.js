/**
 * firebase.js — SHAKER v14 (secure logout + secondary app)
 * ═════════════════════════════════════════════════════════
 * CHANGES vs v13:
 *  [S1] logout() now nukes ALL localStorage/sessionStorage to prevent
 *       cached data from allowing re-entry without authentication.
 *       Specifically: shaker_user_cache, shaker_products, shaker_inventory,
 *       shaker_orders, shaker_marketers, shaker_shipping, shaker_nextBillNumber,
 *       shaker_cache_ver, shaker_mod_session (sessionStorage), and all
 *       Throttle keys. This ensures that after logout, no cached profile
 *       or session token can bypass the login screen.
 *
 *  [S2] getSecondaryAuth() — creates and returns a secondary Firebase app
 *       for user creation WITHOUT disturbing the primary admin session.
 *       The secondary app is auto-deleted after use via deleteSecondaryApp().
 *       This is the fix for PERMISSION_DENIED when creating moderators:
 *       createUserWithEmailAndPassword on the compat SDK can affect the
 *       primary app's auth state; the secondary app isolates this.
 *
 * PERFORMANCE: UNCHANGED from v13:
 *  - Profile cache (P1-P4) still works for instant page loads
 *  - Cache is cleared on logout to prevent bypass
 *
 * SECURITY: ENHANCED from v13:
 *  - Logout is now TOTAL — no residual data
 *  - Secondary app prevents admin session loss during mod creation
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
    let _initDone        = false;  // P4: idempotent init

    // ══════════════════════════════════
    // PROFILE CACHE — P1
    // ══════════════════════════════════
    const CACHE_KEY      = 'shaker_user_cache';
    const CACHE_MAX_AGE  = 30 * 60 * 1000; // 30 min max — background refresh keeps it fresh

    function _cacheGet(uid) {
        try {
            const raw = localStorage.getItem(CACHE_KEY);
            if (!raw) return null;
            const c = JSON.parse(raw);
            if (!c || c.uid !== uid) return null;
            c._expired = (Date.now() - (c._cachedAt || 0)) > CACHE_MAX_AGE;
            return c;
        } catch (_) { return null; }
    }

    function _cacheSet(uid, profileData) {
        if (!uid || !profileData) return;
        try {
            const toStore = {
                uid:         profileData.uid || uid,
                email:       profileData.email || '',
                role:        profileData.role || null,
                active:      profileData.active,
                displayName: profileData.displayName || '',
                username:    profileData.username || '',
                _cachedAt:   Date.now()
            };
            localStorage.setItem(CACHE_KEY, JSON.stringify(toStore));
        } catch (_) { /* quota errors — not critical */ }
    }

    function _cacheClear() {
        try { localStorage.removeItem(CACHE_KEY); } catch (_) {}
    }

    // ══════════════════════════════════
    // INIT — P4: runs once, idempotent
    // ══════════════════════════════════
    function init() {
        if (_initDone) return;
        _initDone = true;
        try {
            const app = firebase.apps.length
                ? firebase.apps[0]
                : firebase.initializeApp(FIREBASE_CONFIG);
            _db   = app.database();
            _auth = app.auth();
            _ok   = true;
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
    // AUTH STATE — P3: cache-first, then authoritative
    // ══════════════════════════════════
    function onAuthChange(cb) {
        if (!_auth) { cb(null, null, null, null, { fromCache: false, authoritative: true }); return () => {}; }
        return _auth.onAuthStateChanged(async user => {
            if (!user) {
                _cacheClear();
                cb(null, null, null, null, { fromCache: false, authoritative: true });
                return;
            }

            const uid = user.uid;

            // ── PHASE 1: Instant cache hit ──
            const cached = _cacheGet(uid);
            if (cached && cached.role && cached.active !== false) {
                cb(user, cached.role, cached, null, { fromCache: true, authoritative: false });
            }

            // ── PHASE 2: Authoritative Firebase read ──
            try {
                const snap = await _db.ref(`shaker/users/${uid}`).once('value');
                if (!snap.exists()) {
                    _cacheClear();
                    cb(user, null, null, null, { fromCache: false, authoritative: true });
                    return;
                }
                const userData = snap.val();
                const role = userData.role;
                if (role !== 'admin' && role !== 'moderator') {
                    _cacheClear();
                    cb(user, null, userData, null, { fromCache: false, authoritative: true });
                    return;
                }
                _cacheSet(uid, userData);
                cb(user, role, userData, null, { fromCache: false, authoritative: true });
            } catch (e) {
                console.error('[FB] onAuthChange DB error:', e.message);
                cb(user, null, null, e, { fromCache: false, authoritative: true });
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

    // P2: readUserProfile with cache-first option
    async function readUserProfile(uid, opts = {}) {
        if (!_ok || !uid) return null;
        const { useCache = false } = opts;

        if (useCache) {
            const cached = _cacheGet(uid);
            if (cached && !cached._expired) return cached;
        }

        const snap = await _db.ref(`shaker/users/${uid}`).once('value');
        const data = snap.exists() ? snap.val() : null;
        if (data) _cacheSet(uid, data);
        return data;
    }

    // Synchronous cache-only read (for instant redirects, never for auth decisions)
    function getCachedProfile(uid) {
        return _cacheGet(uid);
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
        if (uid && fields) {
            const cached = _cacheGet(uid);
            if (cached) _cacheSet(uid, { ...cached, ...fields, _cachedAt: undefined });
        }
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
    // CHAT — keyed by UID only
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
    // SECONDARY APP — S2: for creating users without disturbing admin session
    // ══════════════════════════════════
    let _secondaryApp = null;

    /**
     * Creates a secondary Firebase app instance for user creation.
     * The compat SDK's createUserWithEmailAndPassword can bleed auth state
     * into the primary app. A separate app instance isolates this completely.
     *
     * IMPORTANT: Always call deleteSecondaryApp() in a finally block after use.
     *
     * @returns {firebase.auth.Auth} The secondary app's auth instance
     */
    function getSecondaryAuth() {
        const appName = '_shaker_secondary_' + Date.now();
        _secondaryApp = firebase.initializeApp(FIREBASE_CONFIG, appName);
        return _secondaryApp.auth();
    }

    /**
     * Cleans up the secondary Firebase app after moderator creation.
     * Signs out the secondary auth (the newly created user) and deletes the app.
     */
    async function deleteSecondaryApp() {
        if (_secondaryApp) {
            try {
                await _secondaryApp.auth().signOut().catch(() => {});
                await _secondaryApp.delete();
            } catch (e) {
                console.warn('[FB] Secondary app cleanup failed:', e.message);
            }
            _secondaryApp = null;
        }
    }

    // ══════════════════════════════════
    // LOGOUT — S1: TOTAL WIPE
    // ══════════════════════════════════
    /**
     * Comprehensive logout that ensures NO re-entry without fresh authentication.
     *
     * Steps:
     * 1. Stop all Firebase realtime listeners (prevents background writes)
     * 2. Clear the user profile cache (prevents guardPage cache-hit bypass)
     * 3. Sign out from Firebase Auth (invalidates the auth session)
     * 4. Wipe ALL shaker-related localStorage keys:
     *    - shaker_user_cache (profile cache)
     *    - shaker_products, shaker_inventory, shaker_orders, etc. (data caches)
     *    - shaker_nextBillNumber (bill number cache)
     *    - shaker_cache_ver (cache version marker)
     *    - _t_* (Throttle rate-limit keys)
     * 5. Clear ALL sessionStorage (mod session tokens, etc.)
     * 6. Cancel any pending debounced write timers
     *
     * After this executes, Auth.guardPage() will find:
     *   - No Firebase auth user → immediate redirect to login
     *   - No cached profile → no cache-hit phase 1 shortcut
     *   - No session tokens → no sessionStorage bypass
     */
    async function logout() {
        // 1. Stop realtime listeners to prevent stale writes
        stopAllListeners();

        // 2. Clear profile cache
        _cacheClear();

        // 3. Firebase Auth sign out
        if (_auth) await _auth.signOut().catch(() => {});

        // 4. Wipe ALL shaker-related localStorage keys
        const keysToRemove = [];
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key && (
                key.startsWith('shaker_') ||   // Data caches + profile cache + cache version
                key.startsWith('_t_')           // Throttle rate-limit keys
            )) {
                keysToRemove.push(key);
            }
        }
        keysToRemove.forEach(key => {
            try { localStorage.removeItem(key); } catch (_) {}
        });

        // 5. Clear ALL sessionStorage (mod session, any temp data)
        try { sessionStorage.clear(); } catch (_) {}

        // 6. Cancel pending debounced writes
        Object.keys(_timers).forEach(key => {
            clearTimeout(_timers[key]);
            delete _timers[key];
        });
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
        readCollection, readItem, readUserProfile, getCachedProfile,
        writeCollection, writeItem, pushItem, deleteItem, setField, updateUserField,
        getNextBillNumber, deductStock, restoreStock,
        listen, stopAllListeners, startRealtime, listenCollection,
        saveBackup, loadBackups, restoreBackup,
        migrateIfEmpty, log, logout,
        sendChatMessage, listenChat, deleteChatMessage,
        getSecondaryAuth, deleteSecondaryApp,
        toArray, badge, getDb, getAuth, isOk
    };
})();

// P4: Auto-init at script load time — don't wait for DOMContentLoaded
FB.init();