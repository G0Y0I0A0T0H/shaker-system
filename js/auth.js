// ===== FILE: js/auth.js =====
// Auth Module — Fail-closed authentication (v12 hardened)
// NO auto-creation of admin profiles. Missing profile = sign out.
'use strict';

const Throttle = {
    _store: {},
    check(key) {
        const data = this._store[key];
        if (!data) return true;
        if (data.count >= 5 && (Date.now() - data.first) < 60000) {
            if (typeof Toast !== 'undefined') Toast.show('⚠️ محاولات كثيرة — انتظر دقيقة', 'error');
            return false;
        }
        if ((Date.now() - data.first) >= 60000) {
            delete this._store[key];
        }
        return true;
    },
    record(key) {
        if (!this._store[key]) {
            this._store[key] = { count: 1, first: Date.now() };
        } else {
            this._store[key].count++;
        }
    },
    clear(key) {
        delete this._store[key];
    }
};

// Make Throttle globally accessible
window.Throttle = Throttle;

const Auth = (() => {

    // ── Admin Login ───────────────────────────────────
    async function loginAdmin(email, password) {
        if (!FB.isOk()) throw new Error('Firebase غير متصل');
        const auth = FB.getAuth();
        if (!auth) throw new Error('Firebase Auth غير متاح');

        const cred = await auth.signInWithEmailAndPassword(email, password);
        const user = cred.user;

        // FAIL CLOSED: must have profile with role=admin
        const profile = await FB.readUserProfile(user.uid);
        if (!profile) {
            await auth.signOut();
            throw new Error('لا يوجد ملف تعريف لهذا الحساب');
        }
        if (profile.role !== 'admin') {
            await auth.signOut();
            throw new Error('هذا الحساب ليس حساب مدير');
        }
        if (profile.active === false) {
            await auth.signOut();
            throw new Error('هذا الحساب معطل');
        }

        return user;
    }

    // ── Moderator Login ───────────────────────────────
    async function loginModerator(username, password) {
        if (!FB.isOk()) throw new Error('Firebase غير متصل');
        const auth = FB.getAuth();
        if (!auth) throw new Error('Firebase Auth غير متاح');

        // Moderators login with username@shaker.mod
        const email = username.toLowerCase().trim() + '@shaker.mod';
        const cred = await auth.signInWithEmailAndPassword(email, password);
        const user = cred.user;

        // FAIL CLOSED: must have profile with role=moderator
        const profile = await FB.readUserProfile(user.uid);
        if (!profile) {
            await auth.signOut();
            throw new Error('لا يوجد ملف تعريف لهذا الحساب');
        }
        if (profile.role !== 'moderator') {
            await auth.signOut();
            throw new Error('هذا الحساب ليس حساب مشرف');
        }
        if (profile.active === false) {
            await auth.signOut();
            throw new Error('تم تعطيل حسابك — تواصل مع المدير');
        }

        return user;
    }

    // ── Guard Page ────────────────────────────────────
    // Ensures user is authenticated with correct role
    // Returns { user, userData } or redirects to loginUrl
    async function guardPage(requiredRole, loginUrl) {
        if (!FB.isOk()) {
            window.location.replace(loginUrl);
            return new Promise(() => {}); // never resolves
        }

        const auth = FB.getAuth();
        if (!auth) {
            window.location.replace(loginUrl);
            return new Promise(() => {});
        }

        return new Promise((resolve) => {
            const unsubscribe = auth.onAuthStateChanged(async (user) => {
                unsubscribe();

                if (!user) {
                    window.location.replace(loginUrl);
                    return;
                }

                try {
                    // Try cache first for speed
                    let profile = FB.getCachedProfile(user.uid);
                    if (!profile || profile.uid !== user.uid) {
                        profile = await FB.readUserProfile(user.uid);
                    }

                    // FAIL CLOSED
                    if (!profile) {
                        await FB.logout();
                        window.location.replace(loginUrl);
                        return;
                    }
                    if (profile.role !== requiredRole) {
                        await FB.logout();
                        window.location.replace(loginUrl);
                        return;
                    }
                    if (profile.active === false) {
                        await FB.logout();
                        window.location.replace(loginUrl);
                        return;
                    }

                    // Show body
                    document.body.style.visibility = 'visible';

                    resolve({ user, userData: profile });
                } catch (e) {
                    console.error('[Auth] guardPage error:', e);
                    await FB.logout();
                    window.location.replace(loginUrl);
                }
            });
        });
    }

    return {
        loginAdmin,
        loginModerator,
        guardPage
    };
})();