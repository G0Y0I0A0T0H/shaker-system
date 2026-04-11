/**
 * auth.js — SHAKER v12 (production-hardened)
 * ═══════════════════════════════════════════
 * SECURITY FIXES vs v11:
 *  [S1] guardPage FAILS CLOSED when user profile is missing. v11 relied on
 *       firebase.js auto-creating an admin profile — that backdoor is gone,
 *       so guardPage now signs out and redirects any signed-in user with no
 *       DB profile, no valid role, or a role mismatch.
 *  [S2] loginAdmin no longer creates a profile if one is missing. If the
 *       Firebase Auth account exists but the DB profile doesn't (or isn't
 *       role='admin'), we reject and sign out.
 *  [S3] loginModerator rejects accounts whose DB role isn't 'moderator'
 *       or whose profile is missing — no silent upgrade to admin.
 *  [S4] guardPage handles the new (user, role, userData, dbError) signature.
 *  [S5] Inactivity timer is unchanged (was already correct in v11).
 *
 * KEPT FROM v11:
 *  [M1] guardPage 12s timeout fallback
 *  [M2] Inactivity listeners tracked & removed to prevent memory leak
 *  [L1] addModerator secondary app cleanup with logging
 */

const Auth = (() => {
    const INACTIVITY_MS  = 12 * 60 * 60 * 1000; // 12h
    const GUARD_TIMEOUT  = 12 * 1000;           // 12s
    let _inactivityTimer = null;
    let _activityListeners = [];

    // ══════════════════════════════════
    // GUARD (fail-closed)
    // ══════════════════════════════════
    function guardPage(requiredRole, loginPage = 'login.html') {
        document.body.style.visibility = 'hidden';

        return new Promise(resolve => {
            let settled = false;

            const timeoutId = setTimeout(() => {
                if (settled) return;
                settled = true;
                console.error('[Auth] guardPage timeout — redirecting to login');
                window.location.href = loginPage;
            }, GUARD_TIMEOUT);

            const unsub = FB.onAuthChange(async (user, role, userData, dbError) => {
                if (settled) return;
                if (typeof unsub === 'function') unsub();
                settled = true;
                clearTimeout(timeoutId);

                // 1) Not signed in
                if (!user) { window.location.href = loginPage; return; }

                // 2) DB read error — fail closed
                if (dbError) {
                    console.error('[Auth] guardPage: DB error — access denied:', dbError.message);
                    try { await FB.logout(); } catch (_) {}
                    window.location.href = loginPage;
                    return;
                }

                // 3) FIX S1: no profile OR no valid role → fail closed
                if (!userData || !role) {
                    console.warn('[Auth] guardPage: no profile/role — signing out');
                    try { await FB.logout(); } catch (_) {}
                    window.location.href = loginPage;
                    return;
                }

                // 4) Disabled account
                if (userData.active === false) {
                    await FB.logout();
                    window.location.href = loginPage;
                    return;
                }

                // 5) Role mismatch — redirect to matching home
                if (requiredRole && role !== requiredRole) {
                    if (role === 'admin')     { window.location.href = 'index.html';     return; }
                    if (role === 'moderator') { window.location.href = 'Moderator.html'; return; }
                    await FB.logout();
                    window.location.href = loginPage;
                    return;
                }

                document.body.style.visibility = 'visible';
                _startInactivity(loginPage);
                resolve({ user, role, userData });
            });
        });
    }

    // ══════════════════════════════════
    // ADMIN LOGIN — no auto-profile creation
    // ══════════════════════════════════
    async function loginAdmin(email, password) {
        const auth = FB.getAuth();
        if (!auth) throw new Error('Firebase غير متصل');

        let cred;
        try { cred = await auth.signInWithEmailAndPassword(email, password); }
        catch (e) { throw _xlate(e); }

        let profile;
        try { profile = await FB.readUserProfile(cred.user.uid); }
        catch (e) {
            await auth.signOut().catch(() => {});
            throw new Error('تعذر قراءة ملف الحساب — تحقق من الاتصال أو قواعد Firebase');
        }

        // FIX S2: no auto-creation. Missing profile = reject.
        if (!profile) {
            await auth.signOut().catch(() => {});
            throw new Error('لا يوجد ملف لهذا الحساب — تواصل مع مسؤول النظام');
        }
        if (profile.active === false) {
            await auth.signOut().catch(() => {});
            throw new Error('هذا الحساب معطل');
        }
        if (profile.role !== 'admin') {
            await auth.signOut().catch(() => {});
            throw new Error('هذا الحساب ليس حساب أدمن');
        }

        await FB.log('admin_login', { email });
        return cred.user;
    }

    // ══════════════════════════════════
    // MODERATOR LOGIN
    // ══════════════════════════════════
    async function loginModerator(username, password) {
        const auth = FB.getAuth();
        if (!auth) throw new Error('Firebase غير متصل');

        const clean = String(username || '').toLowerCase().trim();
        if (!/^[a-z0-9_]{3,30}$/.test(clean))
            throw new Error('اسم المستخدم غير صالح');

        const email = `${clean}@shaker.mod`;
        let cred;
        try { cred = await auth.signInWithEmailAndPassword(email, password); }
        catch (e) { throw _xlate(e); }

        let profile;
        try { profile = await FB.readUserProfile(cred.user.uid); }
        catch (e) {
            await auth.signOut().catch(() => {});
            throw new Error('تعذر قراءة ملف الحساب');
        }

        // FIX S3: no auto-creation, strict role check
        if (!profile) {
            await auth.signOut().catch(() => {});
            throw new Error('لا يوجد ملف لهذا الحساب — تواصل مع المدير');
        }
        if (profile.active === false) {
            await auth.signOut().catch(() => {});
            throw new Error('هذا الحساب معطل — تواصل مع المدير');
        }
        if (profile.role !== 'moderator') {
            await auth.signOut().catch(() => {});
            throw new Error('هذا الحساب ليس حساب مشرف');
        }

        await FB.log('mod_login', { username: clean });
        return cred.user;
    }

    // ══════════════════════════════════
    // CREATE MODERATOR (admin-only)
    // ══════════════════════════════════
    async function addModerator(username, password, displayName) {
        if (!FB.isOk()) throw new Error('Firebase غير متصل');

        // Caller must already be an authenticated admin
        const currentUser = FB.getAuth()?.currentUser;
        if (!currentUser) throw new Error('غير مسجل الدخول');
        const callerProfile = await FB.readUserProfile(currentUser.uid);
        if (!callerProfile || callerProfile.role !== 'admin' || callerProfile.active === false) {
            throw new Error('صلاحيات غير كافية');
        }

        if (!/^[a-z0-9_]{3,30}$/.test(username))
            throw new Error('اسم المستخدم: 3-30 حرف إنجليزي صغير وأرقام فقط');
        if (password.length < 6)
            throw new Error('كلمة المرور: 6 أحرف على الأقل');

        const email = `${username}@shaker.mod`;
        let secondaryApp = null;
        try {
            secondaryApp = firebase.initializeApp(FIREBASE_CONFIG, 'mod_create_' + Date.now());
            const secAuth = secondaryApp.auth();
            let cred;
            try { cred = await secAuth.createUserWithEmailAndPassword(email, password); }
            catch (e) { throw _xlate(e); }
            finally { await secAuth.signOut().catch(() => {}); }

            const uid = cred.user.uid;
            await FB.getDb().ref(`shaker/users/${uid}`).set({
                uid, email, username,
                displayName: displayName || username,
                role: 'moderator', active: true, createdAt: Date.now()
            });
            await FB.log('add_mod', { username, uid });
            return uid;
        } finally {
            if (secondaryApp) {
                try { await secondaryApp.delete(); }
                catch (e) { console.warn('[Auth] secondary app cleanup failed:', e.message); }
            }
        }
    }

    // ══════════════════════════════════
    // MODERATOR MANAGEMENT
    // ══════════════════════════════════
    async function getModerators() {
        const db = FB.getDb();
        if (!db) return [];
        try {
            const snap = await db.ref('shaker/users')
                .orderByChild('role').equalTo('moderator').once('value');
            if (!snap.exists()) return [];
            return Object.entries(snap.val())
                .map(([uid, d]) => ({ uid, ...d }))
                .filter(m => !m.deletedAt);
        } catch (e) { console.error('[Auth] getModerators:', e.message); return []; }
    }

    async function toggleModActive(uid, currentlyActive) {
        await FB.getDb().ref(`shaker/users/${uid}/active`).set(!currentlyActive);
        await FB.log('toggle_mod', { uid, active: !currentlyActive });
    }

    async function deleteModerator(uid, username) {
        // Soft delete: keeps UID for audit trail, blocks login via active=false
        await FB.getDb().ref(`shaker/users/${uid}`).update({
            active: false,
            deletedAt: Date.now()
        });
        await FB.log('delete_mod', { uid, username });
    }

    async function changeAdminPassword(currentPass, newPass) {
        const auth = FB.getAuth();
        const user = auth?.currentUser;
        if (!user) throw new Error('غير مسجل الدخول');
        if (newPass.length < 6) throw new Error('كلمة المرور: 6 أحرف على الأقل');
        if (newPass === currentPass) throw new Error('كلمة المرور الجديدة مطابقة للقديمة');
        try {
            const cred = firebase.auth.EmailAuthProvider.credential(user.email, currentPass);
            await user.reauthenticateWithCredential(cred);
            await user.updatePassword(newPass);
            await FB.log('change_admin_pw', {});
        } catch (e) {
            if (e.code === 'auth/wrong-password') throw new Error('كلمة المرور الحالية غير صحيحة');
            throw _xlate(e);
        }
    }

    // ══════════════════════════════════
    // INACTIVITY
    // ══════════════════════════════════
    function _startInactivity(loginPage) {
        _stopActivityListeners();
        const reset = () => {
            clearTimeout(_inactivityTimer);
            _inactivityTimer = setTimeout(async () => {
                console.warn('[Auth] Auto-logout: inactivity');
                _stopActivityListeners();
                await FB.logout();
                window.location.href = loginPage;
            }, INACTIVITY_MS);
        };
        const events = ['click','keydown','mousemove','touchstart'];
        events.forEach(evt => {
            const handler = () => reset();
            document.addEventListener(evt, handler, { passive: true });
            _activityListeners.push({ evt, handler });
        });
        reset();
    }

    function _stopActivityListeners() {
        _activityListeners.forEach(({ evt, handler }) => {
            document.removeEventListener(evt, handler);
        });
        _activityListeners = [];
        clearTimeout(_inactivityTimer);
    }

    // ══════════════════════════════════
    // ERROR TRANSLATION
    // ══════════════════════════════════
    function _xlate(e) {
        if (!e.code) return e;
        const map = {
            'auth/user-not-found':         'اسم المستخدم أو كلمة المرور غير صحيحة',
            'auth/wrong-password':         'اسم المستخدم أو كلمة المرور غير صحيحة',
            'auth/invalid-credential':     'اسم المستخدم أو كلمة المرور غير صحيحة',
            'auth/invalid-email':          'البريد الإلكتروني غير صالح',
            'auth/too-many-requests':      'محاولات كثيرة — انتظر قليلاً',
            'auth/user-disabled':          'هذا الحساب معطل',
            'auth/email-already-in-use':   'اسم المستخدم مستخدم بالفعل',
            'auth/weak-password':          'كلمة المرور ضعيفة (6 أحرف على الأقل)',
            'auth/network-request-failed': 'خطأ في الاتصال بالإنترنت',
            'auth/operation-not-allowed':  'فعّل Email/Password في Firebase Console → Authentication',
        };
        return new Error(map[e.code] || e.message);
    }

    return {
        guardPage, loginAdmin, loginModerator,
        addModerator, getModerators, toggleModActive,
        deleteModerator, changeAdminPassword
    };
})();