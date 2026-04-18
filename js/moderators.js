// ===== FILE: js/moderators.js =====
// ModMgr — Moderator Management (admin-only)
// Handles add, toggle, delete, impersonate, mute
'use strict';

const ModMgr = (() => {

    // ── Render moderator list ─────────────────────────
    async function render() {
        if (!FB.isOk()) return;

        const statsGrid = document.getElementById('mod-stats-grid');
        const tbody = document.getElementById('moderators-table-body');
        if (!tbody) return;

        try {
            const snap = await FB.getDb().ref('shaker/users').orderByChild('role').equalTo('moderator').once('value');
            const users = snap.val() || {};
            const mods = Object.entries(users).map(([uid, u]) => ({ uid, ...u }));
            const orders = Store.get('orders');

            if (!mods.length) {
                tbody.innerHTML = '<tr><td colspan="7" class="p-4 text-center text-gray-400">لا يوجد مشرفون</td></tr>';
                if (statsGrid) statsGrid.innerHTML = '';
                return;
            }

            // Stats grid
            if (statsGrid) {
                statsGrid.innerHTML = mods.map(m => {
                    const modOrders = orders.filter(o => o.moderatorUid === m.uid);
                    const delivered = modOrders.filter(o => o.status === 'Delivered').length;
                    const sales = modOrders.filter(o => ['Confirmed', 'Shipped', 'Delivered'].includes(o.status)).reduce((s, o) => s + (o.total || 0), 0);
                    return `
                        <div class="bg-white dark:bg-gray-800 p-4 rounded-xl shadow-sm border-r-4 ${m.active !== false ? 'border-green-500' : 'border-red-500'}">
                            <div class="flex items-center gap-2 mb-2">
                                <div class="w-8 h-8 rounded-full bg-gradient-to-br from-indigo-500 to-indigo-700 flex items-center justify-center text-white text-xs font-bold">${(m.displayName || m.username || '?')[0].toUpperCase()}</div>
                                <div>
                                    <div class="font-bold text-sm">${Sanitize.html(m.displayName || m.username || '')}</div>
                                    <div class="text-xs text-gray-400">@${Sanitize.html(m.username || '')}</div>
                                </div>
                            </div>
                            <div class="grid grid-cols-3 gap-2 text-center text-xs">
                                <div><div class="font-bold text-lg">${modOrders.length}</div>الطلبات</div>
                                <div><div class="font-bold text-lg text-green-600">${delivered}</div>مسلم</div>
                                <div><div class="font-bold text-sm text-brand-600">${Utils.formatCurrency(sales)}</div>المبيعات</div>
                            </div>
                        </div>`;
                }).join('');
            }

            // Table
            tbody.innerHTML = mods.map(m => {
                const modOrders = orders.filter(o => o.moderatorUid === m.uid);
                const isMuted = m.muted === true;
                return `
                    <tr class="border-b dark:border-gray-700 ${m.active === false ? 'opacity-50' : ''}">
                        <td class="p-3">
                            <div class="flex items-center gap-2">
                                <div class="w-8 h-8 rounded-full bg-gradient-to-br from-indigo-500 to-indigo-700 flex items-center justify-center text-white text-xs font-bold">${(m.displayName || m.username || '?')[0].toUpperCase()}</div>
                                <div>
                                    <div class="font-bold">${Sanitize.html(m.displayName || m.username || '')}</div>
                                    <div class="text-xs text-gray-400">@${Sanitize.html(m.username || '')}</div>
                                </div>
                            </div>
                        </td>
                        <td class="p-3 text-xs text-gray-500">${Sanitize.html(m.email || '')}</td>
                        <td class="p-3 text-xs">${Sanitize.html(m.phone || '-')}</td>
                        <td class="p-3">
                            <span class="px-2 py-1 rounded text-xs font-bold ${m.active !== false ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}">${m.active !== false ? 'نشط' : 'معطل'}</span>
                            ${isMuted ? '<span class="px-2 py-1 rounded text-xs font-bold bg-yellow-100 text-yellow-700 mr-1"><i class="fas fa-volume-mute"></i> مكتوم</span>' : ''}
                        </td>
                        <td class="p-3 font-bold">${modOrders.length}</td>
                        <td class="p-3 text-xs text-gray-500">${m.createdAt ? new Date(m.createdAt).toLocaleDateString('ar-EG') : '-'}</td>
                        <td class="p-3">
                            <div class="flex gap-1 flex-wrap">
                                <button onclick="ModMgr.toggleActive('${m.uid}', ${m.active !== false})" class="px-2 py-1 rounded text-xs ${m.active !== false ? 'bg-red-100 text-red-600 hover:bg-red-200' : 'bg-green-100 text-green-600 hover:bg-green-200'}" title="${m.active !== false ? 'تعطيل' : 'تفعيل'}">
                                    <i class="fas ${m.active !== false ? 'fa-ban' : 'fa-check'}"></i>
                                </button>
                                <button onclick="ModMgr.toggleMute('${m.uid}', ${isMuted})" class="px-2 py-1 rounded text-xs ${isMuted ? 'bg-green-100 text-green-600 hover:bg-green-200' : 'bg-yellow-100 text-yellow-600 hover:bg-yellow-200'}" title="${isMuted ? 'إلغاء الكتم' : 'كتم'}">
                                    <i class="fas ${isMuted ? 'fa-volume-up' : 'fa-volume-mute'}"></i>
                                </button>
                                <button onclick="ModMgr.impersonate('${m.uid}')" class="px-2 py-1 rounded text-xs bg-purple-100 text-purple-600 hover:bg-purple-200" title="عرض كمشرف">
                                    <i class="fas fa-eye"></i>
                                </button>
                                <button onclick="ModMgr.resetPassword('${m.uid}')" class="px-2 py-1 rounded text-xs bg-blue-100 text-blue-600 hover:bg-blue-200" title="تغيير كلمة المرور">
                                    <i class="fas fa-key"></i>
                                </button>
                                <button onclick="ModMgr.deleteMod('${m.uid}', '${Sanitize.attr(m.username || '')}')" class="px-2 py-1 rounded text-xs bg-red-100 text-red-600 hover:bg-red-200" title="حذف">
                                    <i class="fas fa-trash"></i>
                                </button>
                            </div>
                        </td>
                    </tr>`;
            }).join('');

        } catch (e) {
            console.error('[ModMgr] render error:', e);
            tbody.innerHTML = '<tr><td colspan="7" class="p-4 text-center text-red-400">خطأ في تحميل البيانات</td></tr>';
        }
    }

    // ── Open Add Modal ────────────────────────────────
    function openAdd() {
        document.getElementById('mod-edit-id').value = '';
        document.getElementById('mod-username').value = '';
        document.getElementById('mod-password').value = '';
        document.getElementById('mod-modal-title').textContent = 'إضافة مشرف';
        document.getElementById('mod-username').disabled = false;
        document.getElementById('modModal').classList.remove('hidden');
    }

    // ── Save (Add new moderator) ─────────────────────
    async function save() {
        const username = document.getElementById('mod-username').value.trim().toLowerCase();
        const password = document.getElementById('mod-password').value;

        if (!username || !password) {
            Toast.show('يرجى تعبئة جميع الحقول', 'error');
            return;
        }
        if (!/^[a-z0-9_]{3,30}$/.test(username)) {
            Toast.show('اسم المستخدم: 3-30 حرف إنجليزي + أرقام + _ فقط', 'error');
            return;
        }
        if (password.length < 6) {
            Toast.show('كلمة المرور: 6 أحرف على الأقل', 'error');
            return;
        }
        if (!FB.isOk()) {
            Toast.show('Firebase غير متصل', 'error');
            return;
        }

        Loading.show('جارٍ إنشاء حساب المشرف...');

        try {
            // Save current admin user
            const currentUser = FB.getAuth().currentUser;
            const adminEmail = currentUser.email;

            // We need to create the moderator auth account
            // Using REST API to avoid signing out admin
            const email = username + '@shaker.mod';

            // Create via Firebase Auth REST API
            const apiKey = "AIzaSyBA0tDEOqi1L2nYF-4vS2aPQIADzLvs7ms";
            const response = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${apiKey}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    email: email,
                    password: password,
                    returnSecureToken: false
                })
            });

            const result = await response.json();
            if (result.error) {
                throw new Error(result.error.message === 'EMAIL_EXISTS' ? 'اسم المستخدم موجود بالفعل' : result.error.message);
            }

            const uid = result.localId;

            // Write profile to database
            await FB.getDb().ref('shaker/users/' + uid).set({
                uid: uid,
                email: email,
                username: username,
                displayName: username,
                role: 'moderator',
                active: true,
                muted: false,
                createdAt: Date.now()
            });

            document.getElementById('modModal').classList.add('hidden');
            Toast.show('✅ تم إنشاء المشرف: ' + username, 'success');
            render();

        } catch (e) {
            console.error('[ModMgr] save error:', e);
            Toast.show('❌ ' + (e.message || 'فشل إنشاء المشرف'), 'error');
        } finally {
            Loading.hide();
        }
    }

    // ── Toggle Active ─────────────────────────────────
    async function toggleActive(uid, isCurrentlyActive) {
        if (!FB.isOk()) return;
        const newState = !isCurrentlyActive;
        const label = newState ? 'تفعيل' : 'تعطيل';
        if (!confirm(`هل أنت متأكد من ${label} هذا المشرف؟`)) return;

        try {
            await FB.getDb().ref('shaker/users/' + uid + '/active').set(newState);
            Toast.show(`✅ تم ${label} المشرف`, 'success');
            render();
        } catch (e) {
            Toast.show('❌ فشل: ' + e.message, 'error');
        }
    }

    // ── Toggle Mute ───────────────────────────────────
    async function toggleMute(uid, isCurrentlyMuted) {
        if (!FB.isOk()) return;
        const newState = !isCurrentlyMuted;

        try {
            await FB.getDb().ref('shaker/users/' + uid + '/muted').set(newState);
            Toast.show(newState ? '🔇 تم كتم المشرف' : '🔊 تم إلغاء كتم المشرف', 'success');
            render();
        } catch (e) {
            Toast.show('❌ فشل: ' + e.message, 'error');
        }
    }

    // ── Impersonate (view as moderator) ───────────────
    function impersonate(modUid) {
        sessionStorage.setItem('shaker_impersonate', JSON.stringify({
            modUid: modUid,
            ts: Date.now()
        }));
        window.open('Moderator.html?impersonate=' + modUid, '_blank');
    }

    // ── Reset Password ────────────────────────────────
    async function resetPassword(uid) {
        const newPass = prompt('أدخل كلمة المرور الجديدة (6 أحرف على الأقل):');
        if (!newPass || newPass.length < 6) {
            Toast.show('❌ كلمة المرور قصيرة', 'error');
            return;
        }
        Toast.show('⚠️ تغيير كلمة المرور يتطلب Firebase Admin SDK — استخدم Firebase Console', 'warning');
    }

    // ── Delete Moderator ──────────────────────────────
    async function deleteMod(uid, username) {
        if (!FB.isOk()) return;
        if (!confirm(`هل أنت متأكد من حذف المشرف "${username}"؟ لا يمكن التراجع.`)) return;
        if (!confirm('تأكيد أخير — سيتم حذف الحساب نهائياً')) return;

        Loading.show('جارٍ الحذف...');
        try {
            // Deactivate profile (can't delete Auth account from client)
            await FB.getDb().ref('shaker/users/' + uid).update({
                active: false,
                deletedAt: Date.now()
            });
            // Delete chat
            await FB.getDb().ref('shaker/chats/' + uid).remove();
            Toast.show('✅ تم تعطيل المشرف وحذف محادثاته', 'success');
            render();
        } catch (e) {
            Toast.show('❌ فشل: ' + e.message, 'error');
        } finally {
            Loading.hide();
        }
    }

    return {
        render,
        openAdd,
        save,
        toggleActive,
        toggleMute,
        impersonate,
        resetPassword,
        deleteMod
    };
})();