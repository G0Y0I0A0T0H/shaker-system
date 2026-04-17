/**
 * auth.js — SHAKER v14 (secure logout + fixed mod creation)
 * ══════════════════════════════════════════════════════════
 * CHANGES vs v13:
 *
 *  [S1] addModerator() — FIXED PERMISSION_DENIED:
 *       Root cause: Firebase compat SDK v10's createUserWithEmailAndPassword()
 *       can silently swap the primary app's auth state to the newly created user,
 *       even when called on a secondary app instance. This causes the subsequent
 *       DB write (shaker/users/{uid}) to fail because the auth token now belongs
 *       to the new user (who has no admin role), not the original admin.
 *
 *       Fix: We now use FB.getSecondaryAuth() which creates a completely isolated
 *       Firebase app. After creating the user, we:
 *         1. Capture the new user's UID from the credential
 *         2. Sign out the secondary app's auth immediately
 *         3. Delete the secondary app
 *         4. VERIFY the primary admin is still signed in (re-auth check)
 *         5. Write the moderator profile using the primary app's DB reference
 *            (which still has the admin's auth token)
 *
 *       Additionally, we save the admin's UID before the operation and verify it
 *       hasn't changed after. If it has (edge case), we throw an error instead
 *       of writing with wrong credentials.
 *
 *  [S2] guardPage() — No changes (v13 two-phase cache strategy is kept).
 *       The cache-first approach still works correctly because FB.logout()
 *       now clears ALL caches (see firebase.js S1), so after logout there is
 *       no cache to hit and the guard falls through to the authoritative check.
 *
 *  [S3] doLogout() guidance (for index.html/Moderator.html inline scripts):
 *       The existing doLogout() calls FB.logout() which now does a total wipe.
 *       After FB.logout() completes, redirect with window.location.replace()
 *       instead of .href to prevent Back button from returning to the dashboard.
 *
 * SECURITY: UNCHANGED from v13 (except tighter mod creation):
 *  - Fails CLOSED on missing profile / invalid role / DB error
 *  - NO auto-creation, NO default roles
 *  - Cache is optimistic only — authoritative check always follows
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
            let cacheUsed   = false;

            const timeoutId = setTimeout(() => {
                if (settled) return;
                settled = true;
                console.error('[Auth] guardPage timeout — redirecting');
                window.location.replace(loginPage);
            }, GUARD_TIMEOUT);

            const unsub = FB.onAuthChange(async (user, role, userData, dbError, meta) => {
                if (settled && !cacheUsed) return;

                // ── PHASE 1: Cache hit → instant resolve ──
                if (meta.fromCache && !settled) {
                    if (user && role === requiredRole && userData?.active !== false) {
                        settled   = true;
                        cacheUsed = true;
                        clearTimeout(timeoutId);
                        document.body.style.visibility = 'visible';
                        _startInactivity(loginPage);
                        resolve({ user, role, userData });
                        // DON'T unsubscribe — let Phase 2 run for validation
                        return;
                    }
                    return;
                }

                // ── PHASE 2: Authoritative Firebase response ──
                if (!meta.authoritative) return;
                if (typeof unsub === 'function') unsub();
                clearTimeout(timeoutId);

                // If we already resolved from cache, this is a VALIDATION pass
                if (cacheUsed) {
                    if (!user || dbError || !userData || !role ||
                        role !== requiredRole || userData.active === false) {
                        console.warn('[Auth] Cache invalidated by authoritative check — logging out');
                        try { await FB.logout(); } catch (_) {}
                        window.location.replace(loginPage);
                    }
                    return;
                }

                // No cache was used — standard flow
                settled = true;

                if (!user) { window.location.replace(loginPage); return; }

                if (dbError) {
                    console.error('[Auth] guardPage: DB error — access denied');
                    try { await FB.logout(); } catch (_) {}
                    window.location.replace(loginPage);
                    return;
                }

                if (!userData || !role) {
                    try { await FB.logout(); } catch (_) {}
                    window.location.replace(loginPage);
                    return;
                }

                if (userData.active === false) {
                    await FB.logout();
                    window.location.replace(loginPage);
                    return;
                }

                if (requiredRole && role !== requiredRole) {
                    if (role === 'admin')     { window.location.replace('index.html');     return; }
                    if (role === 'moderator') { window.location.replace('Moderator.html'); return; }
                    await FB.logout();
                    window.location.replace(loginPage);
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
    // CREATE MODERATOR — S1: FIXED (admin-only, secondary app)
    // ══════════════════════════════════
    /**
     * Creates a new moderator account.
     *
     * HOW IT WORKS:
     * 1. Verify the current user is an active admin (fail-closed)
     * 2. Save the admin's UID for post-operation verification
     * 3. Create a SECONDARY Firebase app instance (isolated auth)
     * 4. Use secondaryAuth.createUserWithEmailAndPassword() to create the
     *    moderator's Firebase Auth account — this does NOT affect the primary
     *    app's auth state because it's on a separate app instance
     * 5. Sign out the secondary auth and delete the secondary app
     * 6. Verify the primary admin session is still intact
     * 7. Write the moderator's DB profile using the PRIMARY app's DB
     *    (authenticated as admin — has write permission on shaker/users)
     *
     * WHY THIS FIXES PERMISSION_DENIED:
     * In v13, even with a secondary app, the compat SDK could leak auth state
     * changes to the primary app. By explicitly verifying the admin session
     * after secondary app operations and using FB.getDb() (bound to the primary
     * app) for the DB write, we guarantee the write happens with admin credentials.
     *
     * @param {string} username - 3-30 lowercase alphanumeric + underscore
     * @param {string} password - 6+ characters
     * @param {string} displayName - Display name for the moderator
     * @returns {string} The new moderator's UID
     */
    async function addModerator(username, password, displayName) {
        if (!FB.isOk()) throw new Error('Firebase غير متصل');

        // ── Step 1: Verify caller is active admin ──
        const primaryAuth = FB.getAuth();
        const currentUser = primaryAuth?.currentUser;
        if (!currentUser) throw new Error('غير مسجل الدخول');

        const adminUid = currentUser.uid; // Save for post-op verification

        // Use cached profile for instant permission check, then validate from DB
        let callerProfile = FB.getCachedProfile(adminUid);
        if (!callerProfile || callerProfile.role !== 'admin') {
            callerProfile = await FB.readUserProfile(adminUid);
        }
        if (!callerProfile || callerProfile.role !== 'admin' || callerProfile.active === false) {
            throw new Error('صلاحيات غير كافية — يجب أن تكون أدمن نشط');
        }

        // ── Step 2: Validate input ──
        if (!/^[a-z0-9_]{3,30}$/.test(username))
            throw new Error('اسم المستخدم: 3-30 حرف إنجليزي صغير وأرقام و _ فقط');
        if (password.length < 6)
            throw new Error('كلمة المرور: 6 أحرف على الأقل');

        const email = `${username}@shaker.mod`;
        let newUid = null;

        // ── Step 3: Create user on secondary app ──
        try {
            const secondaryAuth = FB.getSecondaryAuth();

            try {
                const cred = await secondaryAuth.createUserWithEmailAndPassword(email, password);
                newUid = cred.user.uid;
            } catch (e) {
                throw _xlate(e);
            }

            // Sign out secondary immediately — we only needed the UID
            await secondaryAuth.signOut().catch(() => {});

        } finally {
            // ── Step 4: Always clean up secondary app ──
            await FB.deleteSecondaryApp();
        }

        if (!newUid) throw new Error('فشل إنشاء الحساب — لم يتم إرجاع UID');

        // ── Step 5: Verify primary admin session is still intact ──
        // This catches the edge case where the compat SDK leaked auth state
        const postOpUser = primaryAuth.currentUser;
        if (!postOpUser || postOpUser.uid !== adminUid) {
            console.error('[Auth] addModerator: Admin session was disrupted!');
            // Attempt to recover — but don't auto-login, that's a security risk
            throw new Error(
                'تم إنشاء حساب المشرف في Firebase Auth لكن الجلسة تعطلت.\n' +
                'يرجى تسجيل الدخول مجدداً وسيظهر المشرف بعد إعادة تسجيل الدخول.\n' +
                'إذا لم يظهر، أعد إنشاءه — سيظهر خطأ "مستخدم بالفعل" مما يعني أن الحساب موجود.'
            );
        }

        // ── Step 6: Write moderator profile to DB (using admin's auth) ──
        const modProfile = {
            uid:         newUid,
            email:       email,
            username:    username,
            displayName: displayName || username,
            role:        'moderator',
            active:      true,
            createdAt:   Date.now()
        };

        try {
            await FB.getDb().ref(`shaker/users/${newUid}`).set(modProfile);
        } catch (e) {
            console.error('[Auth] addModerator: DB write failed:', e.message);
            // The Firebase Auth account was created but the DB profile wasn't.
            // This is recoverable: admin can re-create (will get email-in-use),
            // or manually add the profile via Firebase Console.
            throw new Error(
                'تم إنشاء حساب المشرف لكن فشل حفظ البيانات: ' + e.message + '\n' +
                'تحقق من قواعد Firebase — يجب أن يكون الأدمن مفعلاً ولديه صلاحية الكتابة على shaker/users'
            );
        }

        // ── Step 7: Log and return ──
        FB.log('add_mod', { username, uid: newUid });
        return newUid;
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
                window.location.replace(loginPage);
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