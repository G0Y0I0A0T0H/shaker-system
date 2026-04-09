/**
 * auth.js — SHAKER v11
 * ═════════════════════
 * FIXES vs v10:
 *  [M1] guardPage: 10s timeout → redirect to login if Firebase never responds
 *  [M2] _startInactivity: stores & removes event listeners to prevent memory leak
 *  [L1] addModerator: explicit error if secondaryApp.delete() fails
 */

const Auth = (() => {
    const INACTIVITY_MS  = 12 * 60 * 60 * 1000; // 12h
    const GUARD_TIMEOUT  = 12 * 1000;             // 12s — FIX M1
    let _inactivityTimer = null;
    let _activityListeners = [];                  // FIX M2: track for removal

    // ══════════════════════════════════
    // GUARD
    // ══════════════════════════════════
    function guardPage(requiredRole, loginPage = 'login.html') {
        document.body.style.visibility = 'hidden';

        return new Promise(resolve => {
            let settled = false;

            // FIX M1: timeout guard — if Firebase never calls back, redirect after 12s
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

                if (!user) { window.location.href = loginPage; return; }

                if (dbError) {
                    console.error('[Auth] guardPage DB error — access denied:', dbError.message);
                    try { await FB.logout(); } catch (_) {}
                    window.location.href = loginPage;
                    return;
                }

                if (userData?.active === false) {
                    await FB.logout();
                    window.location.href = loginPage;
                    return;
                }

                if (requiredRole && role !== requiredRole) {
                    if (role === 'admin')     { window.location.href = 'index.html'; return; }
                    if (role === 'moderator') { window.location.href = 'Moderator.html'; return; }
                    await FB.logout();
                    window.location.href = loginPage;
                    return;
                }

                document.body.style.visibility = 'visible';
                _startInactivity(loginPage);
                resolve({ user, role, userData: userData || {} });
            });
        });
    }

    // ══════════════════════════════════
    // ADMIN LOGIN
    // ══════════════════════════════════
    async function loginAdmin(email, password) {
        const auth = FB.getAuth();
        if (!auth) throw new Error('Firebase غير متصل');
        let cred;
        try { cred = await auth.signInWithEmailAndPassword(email, password); }
        catch (e) { throw _xlate(e); }

        const profile = await FB.readUserProfile(cred.user.uid);
        if (profile?.active === false) { await auth.signOut(); throw new Error('هذا الحساب معطل'); }
        if (!profile) {
            await FB.getDb().ref(`shaker/users/${cred.user.uid}`).update({
                uid: cred.user.uid, email, role: 'admin',
                displayName: 'Admin', active: true, createdAt: Date.now()
            });
        } else if (profile.role !== 'admin') {
            await auth.signOut();
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
        const email = `${username.toLowerCase().trim()}@shaker.mod`;
        let cred;
        try { cred = await auth.signInWithEmailAndPassword(email, password); }
        catch (e) { throw _xlate(e); }

        const profile = await FB.readUserProfile(cred.user.uid);
        if (profile?.active === false) { await auth.signOut(); throw new Error('هذا الحساب معطل — تواصل مع المدير'); }
        if (profile && profile.role !== 'moderator') {
            await auth.signOut();
            throw new Error('هذا الحساب ليس حساب مشرف');
        }
        await FB.log('mod_login', { username });
        return cred.user;
    }

    // ══════════════════════════════════
    // CREATE MODERATOR
    // ══════════════════════════════════
    async function addModerator(username, password, displayName) {
        if (!FB.isOk()) throw new Error('Firebase غير متصل');
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
            await FB.getDb().ref(`shaker/users/${uid}`).update({
                uid, email, username,
                displayName: displayName || username,
                role: 'moderator', active: true, createdAt: Date.now()
            });
            await FB.log('add_mod', { username, uid });
            return uid;
        } finally {
            // FIX L1: improved cleanup with logging
            if (secondaryApp) {
                try {
                    await secondaryApp.delete();
                } catch (e) {
                    console.warn('[Auth] addModerator: secondary app cleanup failed:', e.message);
                }
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
        await FB.getDb().ref(`shaker/users/${uid}`).update({ active: false, deletedAt: Date.now() });
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
    // INACTIVITY — FIX M2: no duplicate listeners
    // ══════════════════════════════════
    function _startInactivity(loginPage) {
        // Remove any previously added listeners first
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

        // Store references so we can remove them later
        const events = ['click','keydown','mousemove','touchstart'];
        events.forEach(evt => {
            const handler = () => reset();
            document.addEventListener(evt, handler, { passive: true });
            _activityListeners.push({ evt, handler });
        });

        reset(); // Start the first timer
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
