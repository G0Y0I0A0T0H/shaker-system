// ===== FILE: js/auth.js =====
// Auth Module v14 — Fail-closed + moderator management
'use strict';

// Safe Throttle — will not conflict with ui.js
if (typeof window.Throttle === 'undefined') {
    window.Throttle = {
        _store: {},
        check(key) {
            const d = this._store[key];
            if (!d) return true;
            if (d.count >= 5 && (Date.now() - d.first) < 60000) {
                if (typeof Toast !== 'undefined') Toast.show('⚠️ محاولات كثيرة — انتظر دقيقة', 'error');
                return false;
            }
            if ((Date.now() - d.first) >= 60000) delete this._store[key];
            return true;
        },
        record(key) {
            if (!this._store[key]) this._store[key] = { count: 1, first: Date.now() };
            else this._store[key].count++;
        },
        clear(key) { delete this._store[key]; }
    };
}

const Auth = (() => {

    async function loginAdmin(email, password) {
        if (!FB.isOk()) throw new Error('Firebase غير متصل');
        const auth = FB.getAuth();
        if (!auth) throw new Error('Firebase Auth غير متاح');
        const cred = await auth.signInWithEmailAndPassword(email, password);
        const user = cred.user;
        const profile = await FB.readUserProfile(user.uid);
        if (!profile) { await auth.signOut(); throw new Error('لا يوجد ملف تعريف — استخدم setup-admin.html أولاً'); }
        if (profile.role !== 'admin') { await auth.signOut(); throw new Error('هذا الحساب ليس حساب مدير'); }
        if (profile.active === false) { await auth.signOut(); throw new Error('هذا الحساب معطل'); }
        return user;
    }

    async function loginModerator(username, password) {
        if (!FB.isOk()) throw new Error('Firebase غير متصل');
        const auth = FB.getAuth();
        if (!auth) throw new Error('Firebase Auth غير متاح');
        const email = username.toLowerCase().trim() + '@shaker.mod';
        const cred = await auth.signInWithEmailAndPassword(email, password);
        const user = cred.user;
        const profile = await FB.readUserProfile(user.uid);
        if (!profile) { await auth.signOut(); throw new Error('لا يوجد ملف تعريف لهذا الحساب'); }
        if (profile.role !== 'moderator') { await auth.signOut(); throw new Error('هذا الحساب ليس حساب مشرف'); }
        if (profile.active === false) { await auth.signOut(); throw new Error('تم تعطيل حسابك — تواصل مع المدير'); }
        return user;
    }

    async function guardPage(requiredRole, loginUrl) {
        if (!FB.isOk()) { window.location.replace(loginUrl); return new Promise(() => {}); }
        const auth = FB.getAuth();
        if (!auth) { window.location.replace(loginUrl); return new Promise(() => {}); }
        return new Promise((resolve) => {
            const unsub = auth.onAuthStateChanged(async (user) => {
                unsub();
                if (!user) { window.location.replace(loginUrl); return; }
                try {
                    let profile = FB.getCachedProfile(user.uid);
                    if (!profile || profile.uid !== user.uid) profile = await FB.readUserProfile(user.uid);
                    if (!profile || profile.role !== requiredRole || profile.active === false) {
                        await FB.logout();
                        window.location.replace(loginUrl);
                        return;
                    }
                    document.body.style.visibility = 'visible';
                    resolve({ user, userData: profile });
                } catch (e) {
                    console.error('[Auth] guardPage:', e);
                    await FB.logout();
                    window.location.replace(loginUrl);
                }
            });
        });
    }

    // ── Moderator Management (admin only) ─────────────
    async function getModerators() {
        if (!FB.isOk()) return [];
        try {
            const snap = await FB.getDb().ref('shaker/users').once('value');
            const users = snap.val();
            if (!users) return [];
            return Object.values(users)
                .filter(u => u.role === 'moderator')
                .map(u => ({
                    uid: u.uid, username: u.username || '', displayName: u.displayName || u.username || '',
                    email: u.email || '', phone: u.phone || '', age: u.age || null,
                    role: u.role, active: u.active !== false,
                    createdAt: u.createdAt || null, deletedAt: u.deletedAt || null
                }));
        } catch (e) { console.error('[Auth] getModerators:', e); return []; }
    }

    async function addModerator(username, password, displayName) {
        if (!FB.isOk()) throw new Error('Firebase غير متصل');
        const db = FB.getDb();
        if (!db) throw new Error('Firebase غير متاح');
        const email = username.toLowerCase().trim() + '@shaker.mod';
        let secondaryApp;
        try {
            const cfg = {
                apiKey: "AIzaSyBA0tDEOqi1L2nYF-4vS2aPQIADzLvs7ms",
                authDomain: "shaker-b307b.firebaseapp.com",
                databaseURL: "https://shaker-b307b-default-rtdb.firebaseio.com",
                projectId: "shaker-b307b"
            };
            secondaryApp = firebase.initializeApp(cfg, 'secondary_' + Date.now());
            const secAuth = secondaryApp.auth();
            const cred = await secAuth.createUserWithEmailAndPassword(email, password);
            const uid = cred.user.uid;
            await secAuth.signOut();
            await db.ref('shaker/users/' + uid).set({
                uid, email, username: username.toLowerCase().trim(),
                displayName: displayName || username, role: 'moderator',
                active: true, createdAt: Date.now()
            });
            await secondaryApp.delete();
            return uid;
        } catch (e) {
            if (secondaryApp) try { await secondaryApp.delete(); } catch (_) {}
            const msgs = {
                'auth/email-already-in-use': 'اسم المستخدم مستخدم بالفعل',
                'auth/weak-password': 'كلمة المرور ضعيفة (6 أحرف على الأقل)',
                'auth/invalid-email': 'اسم المستخدم غير صالح',
                'auth/operation-not-allowed': 'فعّل Email/Password في Firebase Console'
            };
            throw new Error(msgs[e.code] || e.message);
        }
    }

    async function toggleModActive(uid, currentlyActive) {
        if (!FB.isOk()) throw new Error('Firebase غير متصل');
        await FB.getDb().ref('shaker/users/' + uid + '/active').set(!currentlyActive);
    }

    async function deleteModerator(uid) {
        if (!FB.isOk()) throw new Error('Firebase غير متصل');
        await FB.getDb().ref('shaker/users/' + uid).update({ active: false, deletedAt: Date.now() });
    }

    return {
        loginAdmin, loginModerator, guardPage,
        getModerators, addModerator, toggleModActive, deleteModerator
    };
})();