// ===== FILE: js/auth.js =====
// Auth Module v19 — FINAL SECURE VERSION

'use strict';

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

    // ================= ADMIN LOGIN =================
    async function loginAdmin(email, password) {
        if (!FB.isOk()) throw new Error('Firebase غير متصل');

        const auth = FB.getAuth();

        // 🔥 FIX: منع الدخول التلقائي
        await auth.signOut();

        const cred = await auth.signInWithEmailAndPassword(email, password);
        const user = cred.user;

        let profile = await FB.readUserProfile(user.uid);

        // v19 SECURITY: FAIL CLOSED — no profile = no access
        if (!profile) {
            await auth.signOut();
            throw new Error('لا يوجد ملف تعريف لهذا الحساب — تواصل مع مسؤول النظام');
        }

        if (profile.role !== 'admin' || profile.active === false) {
            await auth.signOut();
            throw new Error('غير مصرح');
        }

        return user;
    }

    // ================= MODERATOR LOGIN =================
    async function loginModerator(username, password) {
        if (!FB.isOk()) throw new Error('Firebase غير متصل');

        const auth = FB.getAuth();

        // 🔥 FIX: منع الدخول التلقائي
        await auth.signOut();

        const email = username.toLowerCase().trim() + '@shaker.mod';

        const cred = await auth.signInWithEmailAndPassword(email, password);
        const user = cred.user;

        let profile = await FB.readUserProfile(user.uid);

        // v19 SECURITY: FAIL CLOSED — no profile = no access
        if (!profile) {
            await auth.signOut();
            throw new Error('لا يوجد ملف تعريف لهذا الحساب');
        }

        if (profile.role !== 'moderator' || profile.active === false) {
            await auth.signOut();
            throw new Error('غير مصرح');
        }

        return user;
    }

    // ================= GUARD =================
    async function guardPage(requiredRole, loginUrl) {
        if (!FB.isOk()) {
            window.location.replace(loginUrl);
            return new Promise(() => {});
        }

        const auth = FB.getAuth();

        return new Promise((resolve) => {
            const unsub = auth.onAuthStateChanged(async (user) => {
                unsub();

                if (!user) {
                    window.location.replace(loginUrl);
                    return;
                }

                try {
                    const profile = await FB.readUserProfile(user.uid);

                    if (!profile || profile.role !== requiredRole || profile.active === false) {
                        await auth.signOut();
                        window.location.replace(loginUrl);
                        return;
                    }

                    document.body.style.visibility = 'visible';
                    resolve({ user, userData: profile });

                } catch (e) {
                    console.error('Auth guard error:', e);
                    await auth.signOut();
                    window.location.replace(loginUrl);
                }
            });
        });
    }

    // ================= GET MODS =================
    async function getModerators() {
        if (!FB.isOk()) return [];

        try {
            const snap = await FB.getDb().ref('shaker/users').once('value');
            const users = snap.val();

            if (!users) return [];

            return Object.values(users).filter(u => u.role === 'moderator' && u.active !== false);
        } catch (e) {
            console.error('getModerators error:', e);
            return [];
        }
    }

    // ================= ADD MODERATOR =================
    async function addModerator(username, password, displayName) {
        if (!FB.isOk()) throw new Error('Firebase غير متصل');

        const db = FB.getDb();
        const email = username.toLowerCase().trim() + '@shaker.mod';

        let secondaryApp = null;

        try {
            const cfg = firebase.app().options;

            // 🔥 FIX: اسم unique + منع conflict
            secondaryApp = firebase.initializeApp(cfg, 'temp_' + Date.now());
            const secAuth = secondaryApp.auth();

            const cred = await secAuth.createUserWithEmailAndPassword(email, password);
            const uid = cred.user.uid;

            await secAuth.signOut();

            await db.ref('shaker/users/' + uid).set({
                uid,
                username: username.toLowerCase().trim(),
                email,
                displayName: displayName || username,
                role: 'moderator',
                active: true,
                createdAt: Date.now()
            });

            return uid;

        } catch (e) {
            console.error('❌ addModerator:', e);

            const errors = {
                'auth/email-already-in-use': 'اسم المستخدم مستخدم',
                'auth/weak-password': 'كلمة المرور ضعيفة',
                'auth/invalid-email': 'اسم غير صالح'
            };

            throw new Error(errors[e.code] || e.message);

        } finally {
            // 🔥 FIX مهم جداً
            if (secondaryApp) {
                try {
                    await secondaryApp.delete();
                } catch (_) {}
            }
        }
    }

    async function toggleModActive(uid, active) {
        await FB.getDb().ref('shaker/users/' + uid + '/active').set(!active);
    }

    async function deleteModerator(uid) {
        await FB.getDb().ref('shaker/users/' + uid).update({
            active: false,
            deletedAt: Date.now()
        });
    }

    return {
        loginAdmin,
        loginModerator,
        guardPage,
        getModerators,
        addModerator,
        toggleModActive,
        deleteModerator
    };
})();