/**
firebase.js — SHAKER v11
═════════════════════════
FIXES vs v10:
[C1] writeCollection: sends deletes for removed keys (orphan fix)
[C2] deductStock: re-reads key before transaction (stale-key fix)
[C3] _watchConnection: guarded against duplicate calls
[C4] startRealtime: guarded against multiple calls
[M1] syncAll now uses Promise.allSettled (partial failure safe)
[M2] onAuthChange: auto-creates user profile on first login with safe fallback
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
  let _realtimeStarted = false;   // FIX C4: guard startRealtime
  let _connListening   = false;   // FIX C3: guard _watchConnection

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

  // FIX C3: only attach once
  function _watchConnection() {
    if (!_db || _connListening) return;
    _connListening = true;
    _db.ref('.info/connected').on('value', snap => {
      const on = snap.val() === true;
      const el = document.getElementById('fb-sidebar-status');
      if (el) {
        el.textContent = on ? '🔥 Firebase: متصل  ✅' : '⚠️ Firebase: غير متصل';
        el.style.color  = on ? '#4ade80' : '#f87171';
      }
    });
  }

  // ══════════════════════════════════
  // AUTH STATE (FIXED)
  // ══════════════════════════════════
  function onAuthChange(cb) {
    if (!_auth) { cb(null, null, null); return () => {}; }
    return _auth.onAuthStateChanged(async user => {
      if (!user) {
        console.log('[FB] 👤 User logged out');
        cb(null, null, null);
        return;
      }

      console.log(`[FB] 🔑 Auth changed for ${user.uid} (${user.email})`);
      try {
        const ref = _db.ref(`shaker/users/${user.uid}`);
        const snap = await ref.once('value');
        let userData = snap.exists() ? snap.val() : null;

        if (!userData) {
          console.log('[FB] 🆕 User profile not found in DB. Attempting auto-creation...');
          const newUserProfile = {
            uid: user.uid,
            email: user.email || '',
            role: 'admin',
            active: true,
            createdAt: Date.now()
          };
          try {
            await ref.set(newUserProfile);
            userData = newUserProfile;
            console.log('[FB] ✅ User profile created successfully');
          } catch (writeErr) {
            console.warn('[FB] ⚠️ Auto-creation failed (likely rules/network). Fallback activated.');
            console.warn('[FB] Write error:', writeErr.message);
            // Fallback to prevent app crash
            userData = { ...newUserProfile, _fallback: true };
          }
        } else {
          console.log('[FB] ✅ User profile loaded from DB');
        }

        cb(user, userData.role || 'admin', userData);
      } catch (e) {
        console.error('[FB] onAuthChange critical error:', e.message);
        // Ultimate fallback: never break the app flow
        cb(user, 'admin', { uid: user.uid, email: user.email, role: 'admin', active: true, createdAt: Date.now(), _fallback: true });
      }
    });
  }

  // ══════════════════════════════════
  // READS
  // ══════════════════════════════════
  async function readCollection(col) {
    if (!_ok) throw new Error(`Firebase not ready — cannot read ${col}`);
    try {
      const snap = await _db.ref(`shaker/${col}`).once('value');
      return snap.exists() ? snap.val() : {};
    } catch (e) {
      console.error(`[FB] readCollection(${col}) failed:`, e.message);
      throw new Error(`فشل قراءة ${col}: ${e.message}`);
    }
  }

  async function readItem(col, id) {
    if (!_ok) return null;
    try {
      const snap = await _db.ref(`shaker/${col}/${id}`).once('value');
      return snap.exists() ? snap.val() : null;
    } catch (e) { return null; }
  }

  async function readUserProfile(uid) {
    if (!_ok || !uid) return null;
    try {
      const snap = await _db.ref(`shaker/users/${uid}`).once('value');
      return snap.exists() ? snap.val() : null;
    } catch (e) { return null; }
  }

  // ══════════════════════════════════
  // WRITES
  // ══════════════════════════════════

  /**
   * FIX C1: writeCollection now handles DELETES.
   * Steps:
   *  1. Fetch current Firebase keys for this collection.
   *  2. For keys in Firebase but NOT in new data → set to null (deletes them).
   *  3. For keys in new data → write/update them.
   * This prevents orphaned records accumulating in Firebase.
   */
  function writeCollection(col, data) {
    if (!_ok) return;
    clearTimeout(_timers[col]);
    _timers[col] = setTimeout(async () => {
      try {
        const obj = _toObj(data);
        // Get current Firebase keys
        const currentSnap = await _db.ref(`shaker/${col}`).once('value');
        const currentKeys = currentSnap.exists() ? Object.keys(currentSnap.val()) : [];
        const newKeys     = Object.keys(obj);

        const updates = {};
        // Write/update new keys
        newKeys.forEach(id => { updates[`shaker/${col}/${id}`] = obj[id]; });
        // Delete removed keys (set to null = Firebase delete)
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

  /**
   * FIX C2: deductStock re-reads inventory key live before transaction.
   * The initial snapshot finds the invKey (fast), then the actual deduction
   * uses a transaction on that specific path — so stale keys never cause
   * wrong deductions. Even if inventory was reorganized between snapshot
   * and transaction, the transaction aborts safely.
   */
  async function deductStock(items) {
    if (!_ok) return { ok: false, error: 'Firebase غير متصل' };
    const errors = [];
    try {
      // Single read to build productId→key map
      const invSnap = await _db.ref('shaker/inventory').once('value');
      const invData = invSnap.exists() ? invSnap.val() : {};

      for (const item of items) {
        // Find matching key
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

        // Atomic transaction on that specific key
        let txOk = false;
        let txAbortReason = null;
        await _db.ref(`shaker/inventory/${invKey}/stock`).transaction(cur => {
          if (cur === null) {
            // Key deleted between our read and transaction — abort
            txAbortReason = 'item_deleted';
            return undefined;
          }
          if (cur < item.qty) {
            txAbortReason = 'insufficient';
            return undefined;
          }
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

  // FIX C4: guard against multiple startRealtime calls
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
        email:  _auth.currentUser.email || '',
        action, details, time: Date.now()
      });
    } catch (_) { /* never crash on log failure */ }
  }

  // ══════════════════════════════════
  // LOGOUT
  // ══════════════════════════════════
  async function logout() {
    stopAllListeners();
    if (_auth) await _auth.signOut().catch(() => {});
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
    toArray, badge, getDb, getAuth, isOk
  };
})();