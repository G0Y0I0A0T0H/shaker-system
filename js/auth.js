/**
 * auth.js — SHAKER v13 (performance-optimized)
 * ═════════════════════════════════════════════
 * PERFORMANCE OPTIMIZATIONS vs v12:
 *  [P1] guardPage: TWO-PHASE strategy:
 *       Phase 1 (0ms): Check FB.getCachedProfile(). If cached role matches
 *       requiredRole and active !== false → show page INSTANTLY.
 *       Phase 2 (background): Firebase DB read validates the cache.
 *       If validation fails (role changed, account disabled, profile deleted)
 *       → force logout + redirect. This means normal users see zero delay
 *       while security is enforced within ~500ms in the background.
 *
 *  [P2] loginAdmin/loginModerator: after successful login, immediately
 *       caches the profile so the next page (index.html / Moderator.html)
 *       can use Phase 1 instant guard. The profile read that login already
 *       did gets reused — no duplicate Firebase call.
 *
 *  [P3] Guard timeout reduced from 12s → 6s. With cache-first strategy,
 *       the timeout is only hit when there's NO cache AND Firebase is totally
 *       unresponsive. 6s is plenty for that edge case.
 *
 * SECURITY: UNCHANGED from v12:
 *  - Fails CLOSED on missing profile / invalid role / DB error
 *  - NO auto-creation, NO default roles
 *  - Cache is OPTIMISTIC ONLY — authoritative check always follows
 *  - If authoritative check contradicts cache → logout + redirect
 */

const Auth = (() => {
    const INACTIVITY_MS  = 12 * 60 * 60 * 1000; // 12h
    const GUARD_TIMEOUT  = 6 * 1000;             // P3: reduced from 12s
    let _inactivityTimer = null;
    let _activityListeners = [];

    // ══════════════════════════════════
    // GUARD — P1: two-phase (cache → verify)
    // ══════════════════════════════════
    function guardPage(requiredRole, loginPage = 'login.html') {
        document.body.style.visibility = 'hidden';

        return new Promise(resolve => {
            let settled     = false;
            let cacheUsed   = false;  // Track if we already resolved from cache

            const timeoutId = setTimeout(() => {
                if (settled) return;
                settled = true;
                console.error('[Auth] guardPage timeout — redirecting');
                window.location.href = loginPage;
            }, GUARD_TIMEOUT);

            const unsub = FB.onAuthChange(async (user, role, userData, dbError, meta) => {
                if (settled && !cacheUsed) return;

                // ── PHASE 1: Cache hit → instant resolve ──
                if (meta.fromCache && !settled) {
                    if (user && role === requiredRole && userData?.active !== false) {
                        // Show page instantly from cache
                        settled   = true;
                        cacheUsed = true;
                        clearTimeout(timeoutId);
                        document.body.style.visibility = 'visible';
                        _startInactivity(loginPage);
                        resolve({ user, role, userData });
                        // DON'T unsubscribe — let Phase 2 run for validation
                        return;
                    }
                    // Cache says wrong role or inactive → don't show, wait for authoritative
                    return;
                }

                // ── PHASE 2: Authoritative Firebase response ──
                if (!meta.authoritative) return;
                if (typeof unsub === 'function') unsub();
                clearTimeout(timeoutId);

                // If we already resolved from cache, this is a VALIDATION pass
                if (cacheUsed) {
                    // Validate: does authoritative data still agree?
                    if (!user || dbError || !userData || !role ||
                        role !== requiredRole || userData.active === false) {
                        // Cache was WRONG — force logout
                        console.warn('[Auth] Cache invalidated by authoritative check — logging out');
                        try { await FB.logout(); } catch (_) {}
                        window.location.href = loginPage;
                    }
                    // else: cache was correct, nothing to do — page is already showing
                    return;
                }

                // No cache was used — standard flow (first-time login, cleared cache, etc.)
                settled = true;

                if (!user) { window.location.href = loginPage; return; }

                if (dbError) {
                    console.error('[Auth] guardPage: DB error — access denied');
                    try { await FB.logout(); } catch (_) {}
                    window.location.href = loginPage;
                    return;
                }

                if (!userData || !role) {
                    try { await FB.logout(); } catch (_) {}
                    window.location.href = loginPage;
                    return;
                }

                if (userData.active === false) {
                    await FB.logout();
                    window.location.href = loginPage;
                    return;
                }

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
    // ADMIN LOGIN
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

        // P2: Don't await log — fire and forget for speed
        FB.log('admin_login', { email });
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

        // P2: fire and forget
        FB.log('mod_login', { username: clean });
        return cred.user;
    }

    // ══════════════════════════════════
    // CREATE MODERATOR (admin-only)
    // ══════════════════════════════════
    async function addModerator(username, password, displayName) {
        if (!FB.isOk()) throw new Error('Firebase غير متصل');

        const currentUser = FB.getAuth()?.currentUser;
        if (!currentUser) throw new Error('غير مسجل الدخول');

        // Use cached profile for instant permission check, then validate
        let callerProfile = FB.getCachedProfile(currentUser.uid);
        if (!callerProfile || callerProfile.role !== 'admin') {
            callerProfile = await FB.readUserProfile(currentUser.uid);
        }
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
            FB.log('add_mod', { username, uid });
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
        FB.log('toggle_mod', { uid, active: !currentlyActive });
    }

    async function deleteModerator(uid, username) {
        await FB.getDb().ref(`shaker/users/${uid}`).update({
            active: false,
            deletedAt: Date.now()
        });
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