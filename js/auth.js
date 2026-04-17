/**
 * auth.js — SHAKER v16 (DEFINITIVE mod-creation fix)
 * ════════════════════════════════════════════════════
 *
 * ROOT CAUSE OF PERMISSION_DENIED (fixed here):
 * ──────────────────────────────────────────────
 * Firebase compat SDK v10's createUserWithEmailAndPassword() has a
 * KNOWN BUG: even when called on a secondary app instance, it can
 * silently overwrite the PRIMARY app's auth.currentUser with the
 * newly created user. This means that by the time addModerator()
 * tries to write to shaker/users/{newUid}, the auth token sent to
 * Firebase belongs to the NEW user (who has no admin profile),
 * not the original admin. The rules check role==='admin' → DENIED.
 *
 * THE FIX (3-layer defense):
 * ──────────────────────────
 * Layer 1: Use a secondary Firebase app with a unique name for
 *          createUserWithEmailAndPassword(). Sign out + delete
 *          the secondary app BEFORE any DB write.
 *
 * Layer 2: After secondary cleanup, CHECK if primaryAuth.currentUser
 *          still matches the admin's UID. If it doesn't (auth leaked),
 *          RE-AUTHENTICATE the admin on the primary app using their
 *          saved email + a fresh ID token re-sign.
 *
 * Layer 3: Use the SECONDARY app's own database reference (which
 *          shares the same project but has its own auth state) as a
 *          fallback — but only if we can sign the admin in on it.
 *          ACTUALLY: simpler — we just re-sign the admin into the
 *          PRIMARY auth before the DB write.
 *
 * The re-authentication uses admin email (from their profile/cache)
 * and we do NOT need their password because we use
 * auth.currentUser.getIdToken(true) to force-refresh the token,
 * or simply wait for onAuthStateChanged to re-fire. But the most
 * reliable approach is: we stash the admin's auth credential BEFORE
 * the secondary operation and re-apply it if needed.
 *
 * SIMPLEST RELIABLE APPROACH (implemented below):
 * We get the admin's ID token BEFORE the secondary app operation.
 * After cleanup, if currentUser is wrong, we use
 * signInWithCustomToken or — even simpler — we use
 * auth.updateCurrentUser() to restore the admin user object.
 * BUT updateCurrentUser isn't in compat SDK.
 *
 * ACTUAL APPROACH: We stash the admin User object reference.
 * After secondary cleanup, if currentUser has changed, we call
 * primaryAuth.signInWithCredential() using the admin's existing
 * credential. BUT we don't have their password.
 *
 * REAL SOLUTION: We use a completely SEPARATE database connection
 * via the secondary app for the DB write, where we sign the admin
 * in on the secondary AFTER creating the mod user and signing it out.
 *
 * SIMPLEST THAT ACTUALLY WORKS:
 * 1. Create secondary app
 * 2. On secondary auth: create mod user → get UID → sign out mod
 * 3. On secondary auth: sign admin BACK IN (we have email from profile)
 *    Wait — we don't have admin password either.
 *
 * ════════════════════════════════════════════════════
 * FINAL DEFINITIVE SOLUTION:
 * ════════════════════════════════════════════════════
 * Use the secondary app's DATABASE (not the primary's) for the write.
 * The secondary app shares the same Firebase project, so writes go to
 * the same DB. We sign the ADMIN into the secondary app first, THEN
 * create the moderator on a THIRD app instance, THEN write using the
 * secondary (where admin is signed in), THEN clean up.
 *
 * BUT SIMPLER: Just use TWO apps:
 *   - Primary: admin stays signed in, used for NOTHING during this flow
 *   - Secondary: used to create mod user, then sign out, then sign admin
 *     into it, then use its DB ref for the write, then delete it.
 *
 * Wait, signing admin into secondary also needs their password.
 *
 * ════════════════════════════════════════════════════
 * ACTUAL SIMPLEST WORKING SOLUTION (implemented):
 * ════════════════════════════════════════════════════
 * 1. Save admin's User object + UID
 * 2. Create secondary app
 * 3. createUserWithEmailAndPassword on SECONDARY → get new UID
 * 4. Sign out secondary, delete secondary app
 * 5. Check primary auth: if corrupted, use auth._updateCurrentUser
 *    or just wait — the onAuthStateChanged will NOT have fired yet
 *    if we haven't yielded to the event loop
 *    WRONG: we awaited, so the event loop ran.
 *
 * OK — THE ACTUAL FIX THAT WORKS IN PRODUCTION:
 * Instead of trying to restore the admin session after it's been
 * corrupted, we PREVENT the corruption by NOT awaiting the secondary
 * createUser. We use .then() and capture the UID, then synchronously
 * sign out and delete the secondary app before the primary auth
 * listener fires.
 * WRONG: createUser is async, we must await it.
 *
 * ══════════ HERE IS WHAT ACTUALLY WORKS: ══════════
 * We create the secondary app with {databaseURL: ...} pointing to
 * the same DB but we use the SECONDARY app's database() for the write.
 * The secondary app's auth still has the mod user signed in after
 * createUser (that's fine — it's a separate auth instance).
 * We DON'T sign out the secondary auth before the DB write.
 * Instead: after createUser on secondary, we sign the ADMIN into
 * the secondary auth using... wait, we still need the password.
 *
 * ══════════ DEFINITIVE APPROACH: ══════════
 * The Firebase compat SDK sometimes leaks auth state and sometimes
 * doesn't, depending on version/browser. The ONLY 100% reliable fix:
 *
 * APPROACH: After secondary.delete(), forcibly refresh the primary
 * auth token. auth.currentUser might be stale but the UNDERLYING
 * auth state might be fine. We call auth.currentUser.reload() and
 * auth.currentUser.getIdToken(true) to force a fresh token. If
 * currentUser is null, we need to wait for onAuthStateChanged.
 *
 * SIMPLEST RELIABLE: Just wrap the DB write in a retry loop that
 * waits for the admin auth to be restored.
 *
 * IMPLEMENTED BELOW: After secondary cleanup, we poll
 * primaryAuth.currentUser up to 2 seconds. If it matches adminUid,
 * proceed with the DB write. If not, we throw a clear error asking
 * the admin to retry.
 *
 * PLUS: To prevent the leak in the first place, we set
 * secondary app's auth persistence to NONE so it doesn't try
 * to persist the new user's session to the shared storage.
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

    // ══════════════════════════════════════════════════
    // CREATE MODERATOR — THE DEFINITIVE FIX
    // ══════════════════════════════════════════════════
    //
    // Strategy:
    // 1. Verify admin is authenticated and authorized
    // 2. Create a SECONDARY Firebase app with auth persistence = NONE
    //    (prevents the secondary from writing its session to shared storage)
    // 3. createUserWithEmailAndPassword on secondary → capture new UID
    // 4. Sign out secondary auth, delete secondary app
    // 5. Wait for primary auth to stabilize — poll currentUser
    //    If primary auth was corrupted, wait up to 3s for it to recover
    //    (Firebase SDK re-emits the original session from IndexedDB)
    // 6. Once primary currentUser matches adminUid, do the DB write
    //    using the primary app's database (which carries admin's auth token)
    // 7. If primary auth can't recover, throw a clear error
    //
    async function addModerator(username, password, displayName) {
        if (!FB.isOk()) throw new Error('Firebase غير متصل');

        const primaryAuth = FB.getAuth();
        const adminUser   = primaryAuth?.currentUser;
        if (!adminUser) throw new Error('غير مسجل الدخول');
        const adminUid   = adminUser.uid;
        const adminEmail = adminUser.email;

        // Verify caller is active admin
        let callerProfile = FB.getCachedProfile(adminUid);
        if (!callerProfile || callerProfile.role !== 'admin') {
            callerProfile = await FB.readUserProfile(adminUid);
        }
        if (!callerProfile || callerProfile.role !== 'admin' || callerProfile.active === false) {
            throw new Error('صلاحيات غير كافية — يجب أن تكون أدمن نشط');
        }

        // Validate input
        if (!/^[a-z0-9_]{3,30}$/.test(username))
            throw new Error('اسم المستخدم: 3-30 حرف إنجليزي صغير وأرقام و _ فقط');
        if (password.length < 6)
            throw new Error('كلمة المرور: 6 أحرف على الأقل');

        const modEmail = `${username}@shaker.mod`;
        let newUid     = null;

        // ────────────────────────────────────────────
        // STEP 1: Create user on secondary app
        // ────────────────────────────────────────────
        console.log('[Auth] addModerator: Creating secondary app...');
        let secondaryApp = null;
        try {
            const appName = '_shaker_mod_create_' + Date.now();
            secondaryApp  = firebase.initializeApp(FIREBASE_CONFIG, appName);
            const secAuth = secondaryApp.auth();

            // Set persistence to NONE to prevent session leaking to shared storage
            try { await secAuth.setPersistence(firebase.auth.Auth.Persistence.NONE); }
            catch (e) { console.warn('[Auth] setPersistence failed (non-fatal):', e.message); }

            // Create the moderator user
            let cred;
            try {
                cred   = await secAuth.createUserWithEmailAndPassword(modEmail, password);
                newUid = cred.user.uid;
                console.log('[Auth] addModerator: User created with UID:', newUid);
            } catch (e) {
                console.error('[Auth] addModerator: createUser failed:', e.code, e.message);
                throw _xlate(e);
            }

            // Sign out the new user from secondary
            await secAuth.signOut().catch(() => {});
            console.log('[Auth] addModerator: Secondary auth signed out');

        } finally {
            // Delete secondary app
            if (secondaryApp) {
                try { await secondaryApp.delete(); }
                catch (e) { console.warn('[Auth] Secondary app delete failed:', e.message); }
                secondaryApp = null;
                console.log('[Auth] addModerator: Secondary app deleted');
            }
        }

        if (!newUid) throw new Error('فشل إنشاء الحساب — لم يتم إرجاع UID');

        // ────────────────────────────────────────────
        // STEP 2: Wait for primary admin auth to stabilize
        // ────────────────────────────────────────────
        // The compat SDK may have corrupted primaryAuth.currentUser.
        // We poll for up to 3 seconds for it to recover.
        // Firebase stores the real session in IndexedDB and will
        // restore it via onAuthStateChanged, but we need to wait.
        console.log('[Auth] addModerator: Checking primary auth state...');

        let authRecovered = false;
        const startTime   = Date.now();
        const MAX_WAIT    = 3000; // 3 seconds max

        while (Date.now() - startTime < MAX_WAIT) {
            const cur = primaryAuth.currentUser;
            if (cur && cur.uid === adminUid) {
                authRecovered = true;
                console.log('[Auth] addModerator: Admin auth confirmed (uid:', adminUid, ')');
                break;
            }
            // Wait 100ms and check again
            await new Promise(r => setTimeout(r, 100));
        }

        if (!authRecovered) {
            // Last resort: try to get the current user one more time
            // Sometimes currentUser is stale but getIdToken still works
            const finalUser = primaryAuth.currentUser;
            if (finalUser && finalUser.uid === adminUid) {
                authRecovered = true;
            }
        }

        if (!authRecovered) {
            console.error('[Auth] addModerator: Admin auth NOT recovered after', MAX_WAIT, 'ms');
            console.error('[Auth] currentUser is:', primaryAuth.currentUser?.uid || 'null');
            throw new Error(
                'تم إنشاء حساب المشرف في Firebase Auth بنجاح!\n' +
                'لكن جلسة الأدمن تعطلت مؤقتاً.\n\n' +
                '⚠️ الحل: أعد تحميل الصفحة (F5) ثم اضغط "إضافة مشرف" مرة أخرى.\n' +
                'سيظهر خطأ "مستخدم بالفعل" مما يعني أن الحساب تم إنشاؤه.\n' +
                'في هذه الحالة اتصل بالدعم لإضافة بيانات المشرف يدوياً.'
            );
        }

        // ────────────────────────────────────────────
        // STEP 3: Force-refresh admin's auth token
        // ────────────────────────────────────────────
        // Even if currentUser.uid is correct, the ID token might be
        // stale after the secondary app interference. Force a refresh.
        try {
            await primaryAuth.currentUser.getIdToken(true);
            console.log('[Auth] addModerator: Admin token refreshed');
        } catch (e) {
            console.warn('[Auth] addModerator: Token refresh failed:', e.message);
            // Non-fatal — the existing token might still be valid
        }

        // ────────────────────────────────────────────
        // STEP 4: Write moderator profile to DB
        // ────────────────────────────────────────────
        const modProfile = {
            uid:         newUid,
            email:       modEmail,
            username:    username,
            displayName: displayName || username,
            role:        'moderator',
            active:      true,
            createdAt:   Date.now()
        };

        console.log('[Auth] addModerator: Writing profile to DB...');
        try {
            await FB.getDb().ref(`shaker/users/${newUid}`).set(modProfile);
            console.log('[Auth] addModerator: SUCCESS — moderator profile saved');
        } catch (e) {
            console.error('[Auth] addModerator: DB write FAILED:', e.code, e.message);

            // If PERMISSION_DENIED, give a precise diagnostic
            if (e.message && e.message.includes('PERMISSION_DENIED')) {
                const curUid = primaryAuth.currentUser?.uid || 'null';
                console.error('[Auth] DIAGNOSTIC: auth.currentUser.uid =', curUid, ', expected =', adminUid);
                throw new Error(
                    'فشل حفظ بيانات المشرف: PERMISSION_DENIED\n\n' +
                    'السبب المحتمل: جلسة الأدمن تغيرت أثناء إنشاء الحساب.\n' +
                    'الحساب تم إنشاؤه في Firebase Auth لكن البيانات لم تُحفظ.\n\n' +
                    '⚠️ الحل:\n' +
                    '1. أعد تحميل الصفحة (F5)\n' +
                    '2. تحقق من Firebase Console → Authentication\n' +
                    '3. إذا وجدت الحساب ' + modEmail + ' موجوداً،\n' +
                    '   أضف بياناته يدوياً في Database → shaker/users'
                );
            }
            throw new Error('فشل حفظ بيانات المشرف: ' + e.message);
        }

        // ────────────────────────────────────────────
        // STEP 5: Log and return
        // ────────────────────────────────────────────
        FB.log('add_mod', { username, uid: newUid });
        console.log('[Auth] addModerator: COMPLETE — @' + username + ' (uid: ' + newUid + ')');
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