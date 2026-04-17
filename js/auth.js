/**
 * auth.js — SHAKER v15 (ultra-fast login + fixed mod creation)
 * ═════════════════════════════════════════════════════════════
 * [A1] guardPage: 2-phase. Cache=instant show. Firebase=background verify.
 *      Timeout reduced to 4s. If cache valid, page shows in 0ms.
 * [A2] addModerator: Secondary app isolates auth. Admin session verified post-op.
 * [A3] All redirects use location.replace() to prevent Back-button bypass.
 */

const Auth = (() => {
    const INACTIVITY_MS  = 12 * 60 * 60 * 1000;
    const GUARD_TIMEOUT  = 4000;
    let _inactivityTimer = null;
    let _activityListeners = [];

    // ── GUARD PAGE ─────────────────────────────────
    function guardPage(requiredRole, loginPage = 'login.html') {
        document.body.style.visibility = 'hidden';
        return new Promise(resolve => {
            let settled = false, cacheUsed = false;
            const timeoutId = setTimeout(() => {
                if (settled) return;
                settled = true;
                window.location.replace(loginPage);
            }, GUARD_TIMEOUT);

            const unsub = FB.onAuthChange(async (user, role, userData, dbError, meta) => {
                if (settled && !cacheUsed) return;

                // Phase 1: Cache hit → instant
                if (meta.fromCache && !settled) {
                    if (user && role === requiredRole && userData?.active !== false) {
                        settled = true; cacheUsed = true;
                        clearTimeout(timeoutId);
                        document.body.style.visibility = 'visible';
                        _startInactivity(loginPage);
                        resolve({ user, role, userData });
                        return;
                    }
                    return;
                }

                // Phase 2: Authoritative
                if (!meta.authoritative) return;
                if (typeof unsub === 'function') unsub();
                clearTimeout(timeoutId);

                if (cacheUsed) {
                    if (!user || dbError || !userData || !role || role !== requiredRole || userData.active === false) {
                        try { await FB.logout(); } catch (_) {}
                        window.location.replace(loginPage);
                    }
                    return;
                }

                settled = true;
                if (!user) { window.location.replace(loginPage); return; }
                if (dbError) { try { await FB.logout(); } catch (_) {} window.location.replace(loginPage); return; }
                if (!userData || !role) { try { await FB.logout(); } catch (_) {} window.location.replace(loginPage); return; }
                if (userData.active === false) { await FB.logout(); window.location.replace(loginPage); return; }
                if (requiredRole && role !== requiredRole) {
                    if (role === 'admin')     { window.location.replace('index.html');     return; }
                    if (role === 'moderator') { window.location.replace('Moderator.html'); return; }
                    await FB.logout(); window.location.replace(loginPage); return;
                }
                document.body.style.visibility = 'visible';
                _startInactivity(loginPage);
                resolve({ user, role, userData });
            });
        });
    }

    // ── ADMIN LOGIN ────────────────────────────────
    async function loginAdmin(email, password) {
        const auth = FB.getAuth();
        if (!auth) throw new Error('Firebase غير متصل');
        let cred;
        try { cred = await auth.signInWithEmailAndPassword(email, password); }
        catch (e) { throw _xlate(e); }

        let profile;
        try { profile = await FB.readUserProfile(cred.user.uid); }
        catch (e) { await auth.signOut().catch(() => {}); throw new Error('تعذر قراءة ملف الحساب — تحقق من الاتصال'); }

        if (!profile) { await auth.signOut().catch(() => {}); throw new Error('لا يوجد ملف لهذا الحساب'); }
        if (profile.active === false) { await auth.signOut().catch(() => {}); throw new Error('هذا الحساب معطل'); }
        if (profile.role !== 'admin') { await auth.signOut().catch(() => {}); throw new Error('هذا الحساب ليس حساب أدمن'); }
        FB.log('admin_login', { email });
        return cred.user;
    }

    // ── MODERATOR LOGIN ────────────────────────────
    async function loginModerator(username, password) {
        const auth = FB.getAuth();
        if (!auth) throw new Error('Firebase غير متصل');
        const clean = String(username || '').toLowerCase().trim();
        if (!/^[a-z0-9_]{3,30}$/.test(clean)) throw new Error('اسم المستخدم غير صالح');
        const email = `${clean}@shaker.mod`;
        let cred;
        try { cred = await auth.signInWithEmailAndPassword(email, password); }
        catch (e) { throw _xlate(e); }

        let profile;
        try { profile = await FB.readUserProfile(cred.user.uid); }
        catch (e) { await auth.signOut().catch(() => {}); throw new Error('تعذر قراءة ملف الحساب'); }

        if (!profile) { await auth.signOut().catch(() => {}); throw new Error('لا يوجد ملف لهذا الحساب'); }
        if (profile.active === false) { await auth.signOut().catch(() => {}); throw new Error('هذا الحساب معطل'); }
        if (profile.role !== 'moderator') { await auth.signOut().catch(() => {}); throw new Error('هذا الحساب ليس حساب مشرف'); }
        FB.log('mod_login', { username: clean });
        return cred.user;
    }

    // ── CREATE MODERATOR (secondary app) ───────────
    async function addModerator(username, password, displayName) {
        if (!FB.isOk()) throw new Error('Firebase غير متصل');
        const primaryAuth = FB.getAuth();
        const currentUser = primaryAuth?.currentUser;
        if (!currentUser) throw new Error('غير مسجل الدخول');
        const adminUid = currentUser.uid;

        let callerProfile = FB.getCachedProfile(adminUid);
        if (!callerProfile || callerProfile.role !== 'admin') callerProfile = await FB.readUserProfile(adminUid);
        if (!callerProfile || callerProfile.role !== 'admin' || callerProfile.active === false) throw new Error('صلاحيات غير كافية');

        if (!/^[a-z0-9_]{3,30}$/.test(username)) throw new Error('اسم المستخدم: 3-30 حرف إنجليزي صغير وأرقام و _ فقط');
        if (password.length < 6) throw new Error('كلمة المرور: 6 أحرف على الأقل');

        const email = `${username}@shaker.mod`;
        let newUid = null;

        try {
            const secondaryAuth = FB.getSecondaryAuth();
            try {
                const cred = await secondaryAuth.createUserWithEmailAndPassword(email, password);
                newUid = cred.user.uid;
            } catch (e) { throw _xlate(e); }
            await secondaryAuth.signOut().catch(() => {});
        } finally {
            await FB.deleteSecondaryApp();
        }

        if (!newUid) throw new Error('فشل إنشاء الحساب');

        // Verify admin session intact
        const postOpUser = primaryAuth.currentUser;
        if (!postOpUser || postOpUser.uid !== adminUid) {
            throw new Error('تم إنشاء الحساب لكن الجلسة تعطلت — سجّل الدخول مجدداً');
        }

        const modProfile = {
            uid: newUid, email, username,
            displayName: displayName || username,
            role: 'moderator', active: true, createdAt: Date.now()
        };

        try {
            await FB.getDb().ref(`shaker/users/${newUid}`).set(modProfile);
        } catch (e) {
            throw new Error('تم إنشاء الحساب لكن فشل حفظ البيانات: ' + e.message);
        }

        FB.log('add_mod', { username, uid: newUid });
        return newUid;
    }

    // ── MODERATOR MANAGEMENT ───────────────────────
    async function getModerators() {
        const db = FB.getDb();
        if (!db) return [];
        try {
            const snap = await db.ref('shaker/users').orderByChild('role').equalTo('moderator').once('value');
            if (!snap.exists()) return [];
            return Object.entries(snap.val()).map(([uid, d]) => ({ uid, ...d })).filter(m => !m.deletedAt);
        } catch (e) { console.error('[Auth] getModerators:', e.message); return []; }
    }

    async function toggleModActive(uid, currentlyActive) {
        await FB.getDb().ref(`shaker/users/${uid}/active`).set(!currentlyActive);
        FB.log('toggle_mod', { uid, active: !currentlyActive });
    }

    async function deleteModerator(uid, username) {
        await FB.getDb().ref(`shaker/users/${uid}`).update({ active: false, deletedAt: Date.now() });
        FB.log('delete_mod', { uid, username });
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
            FB.log('change_admin_pw', {});
        } catch (e) {
            if (e.code === 'auth/wrong-password') throw new Error('كلمة المرور الحالية غير صحيحة');
            throw _xlate(e);
        }
    }

    // ── INACTIVITY ─────────────────────────────────
    function _startInactivity(loginPage) {
        _stopActivityListeners();
        const reset = () => {
            clearTimeout(_inactivityTimer);
            _inactivityTimer = setTimeout(async () => {
                _stopActivityListeners();
                await FB.logout();
                window.location.replace(loginPage);
            }, INACTIVITY_MS);
        };
        ['click','keydown','mousemove','touchstart'].forEach(evt => {
            const handler = () => reset();
            document.addEventListener(evt, handler, { passive: true });
            _activityListeners.push({ evt, handler });
        });
        reset();
    }

    function _stopActivityListeners() {
        _activityListeners.forEach(({ evt, handler }) => document.removeEventListener(evt, handler));
        _activityListeners = [];
        clearTimeout(_inactivityTimer);
    }

    // ── ERROR TRANSLATION ──────────────────────────
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
            'auth/operation-not-allowed':  'فعّل Email/Password في Firebase Console',
        };
        return new Error(map[e.code] || e.message);
    }

    return {
        guardPage, loginAdmin, loginModerator,
        addModerator, getModerators, toggleModActive,
        deleteModerator, changeAdminPassword
    };
})();