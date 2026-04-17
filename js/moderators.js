/**
 * moderators.js — SHAKER v17
 * Admin-side moderator management:
 *  - Full profile (name, email, phone, age, role, active, created)
 *  - "تفاصيل" button → analytics modal with charts
 *  - "عرض النظام" button → secure impersonation via session flag
 *  - Add/edit/toggle/delete moderators
 */
const ModMgr = (() => {

    async function render() {
        const tbody   = document.getElementById('moderators-table-body');
        const statsEl = document.getElementById('mod-stats-grid');
        if (!FB.isOk()) {
            if (tbody) tbody.innerHTML = '<tr><td colspan="7" class="p-4 text-center text-gray-400">Firebase غير متصل</td></tr>';
            return;
        }
        const mods   = await Auth.getModerators();
        const orders = Store.get('orders');

        // Stats cards
        if (statsEl) {
            statsEl.innerHTML = mods.length === 0
                ? '<div class="col-span-3 text-center text-gray-400 py-4">لا يوجد مشرفون بعد</div>'
                : mods.map(mod => {
                    const count = orders.filter(o => o.moderatorUid === mod.uid || o.moderatorName === (mod.username || mod.uid)).length;
                    const totalSales = orders.filter(o => (o.moderatorUid === mod.uid || o.moderatorName === (mod.username||mod.uid)) && o.status !== 'Cancelled' && o.status !== 'Returned').reduce((s, o) => s + (o.total || 0), 0);
                    return `<div class="bg-white dark:bg-gray-800 p-4 rounded-xl shadow-sm border-r-4 border-indigo-500">
                        <div class="font-bold text-lg text-indigo-600">${_e(mod.displayName||mod.username||'مشرف')}</div>
                        <div class="text-sm text-gray-500">@${_e(mod.username||mod.uid)}</div>
                        <div class="mt-2 text-2xl font-bold">${count} <span class="text-sm font-normal text-gray-400">طلب</span></div>
                        <div class="text-sm text-green-600 font-bold">${Utils.formatCurrency(totalSales)}</div>
                        <span class="mt-1 inline-block text-xs px-2 py-1 rounded ${mod.active!==false?'bg-green-100 text-green-600':'bg-gray-100 text-gray-500'}">${mod.active!==false?'نشط':'معطل'}</span>
                    </div>`;
                }).join('');
        }

        // Table
        if (tbody) {
            tbody.innerHTML = mods.length === 0
                ? '<tr><td colspan="7" class="p-4 text-center text-gray-400">لا يوجد مشرفون بعد — أضفهم من الزر أعلاه</td></tr>'
                : mods.map(mod => {
                    const count = orders.filter(o => o.moderatorUid === mod.uid || o.moderatorName === (mod.username||mod.uid)).length;
                    return `<tr class="border-b dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-750 transition">
                        <td class="p-3">
                            <div class="flex items-center gap-3">
                                <div class="w-9 h-9 rounded-full bg-gradient-to-br from-indigo-500 to-indigo-700 flex items-center justify-center text-white font-bold text-xs">${(mod.username||'?')[0].toUpperCase()}</div>
                                <div>
                                    <div class="font-bold">${_e(mod.displayName||mod.username||'مشرف')}</div>
                                    <div class="text-xs text-gray-400">@${_e(mod.username||mod.uid)}</div>
                                </div>
                            </div>
                        </td>
                        <td class="p-3 text-xs">${_e(mod.email||'-')}</td>
                        <td class="p-3 text-xs">${_e(mod.phone||'-')}</td>
                        <td class="p-3"><span class="px-2 py-1 rounded text-xs ${mod.active!==false?'bg-green-100 text-green-600':'bg-gray-200 text-gray-500'}">${mod.active!==false?'نشط':'معطل'}</span></td>
                        <td class="p-3">${count}</td>
                        <td class="p-3 text-xs text-gray-500">${mod.createdAt?new Date(mod.createdAt).toLocaleDateString('ar-EG'):'-'}</td>
                        <td class="p-3">
                            <div class="flex gap-1 flex-wrap">
                                <button onclick="ModMgr.showDetails('${mod.uid}')" class="text-xs bg-blue-100 text-blue-600 px-2 py-1 rounded hover:bg-blue-200 transition"><i class="fas fa-chart-pie ml-1"></i>تفاصيل</button>
                                <button onclick="ModMgr.impersonate('${mod.uid}')" class="text-xs bg-purple-100 text-purple-600 px-2 py-1 rounded hover:bg-purple-200 transition"><i class="fas fa-eye ml-1"></i>عرض النظام</button>
                                <button onclick="ModMgr.toggleActive('${mod.uid}',${mod.active!==false})" class="text-xs ${mod.active!==false?'bg-red-100 text-red-600':'bg-green-100 text-green-600'} px-2 py-1 rounded">${mod.active!==false?'تعطيل':'تفعيل'}</button>
                                <button onclick="ModMgr.deleteMod('${mod.uid}','${_e(mod.username||mod.uid)}')" class="text-xs bg-red-100 text-red-600 px-2 py-1 rounded hover:bg-red-200"><i class="fas fa-trash"></i></button>
                            </div>
                        </td>
                    </tr>`;
                }).join('');
        }
    }

    function openAdd() {
        document.getElementById('addModModal')?.remove();
        const html = `<div id="addModModal" class="fixed inset-0 bg-black bg-opacity-60 z-50 flex items-center justify-center p-4" style="backdrop-filter:blur(4px)">
            <div class="bg-white dark:bg-gray-800 rounded-2xl w-full max-w-md p-6 space-y-4 shadow-2xl">
                <div class="flex justify-between items-center"><h3 class="text-xl font-bold"><i class="fas fa-user-plus text-brand-600 ml-2"></i>إضافة مشرف جديد</h3><button onclick="document.getElementById('addModModal').remove()" class="text-gray-400 hover:text-gray-600"><i class="fas fa-times"></i></button></div>
                <input type="text" id="new-mod-displayname" placeholder="الاسم الكامل" class="w-full border rounded-lg p-2.5 dark:bg-gray-700 dark:border-gray-600">
                <input type="text" id="new-mod-username" placeholder="اسم المستخدم (إنجليزي)" class="w-full border rounded-lg p-2.5 dark:bg-gray-700 dark:border-gray-600">
                <div class="grid grid-cols-2 gap-3">
                    <input type="tel" id="new-mod-phone" placeholder="رقم الهاتف" class="border rounded-lg p-2.5 dark:bg-gray-700 dark:border-gray-600">
                    <input type="number" id="new-mod-age" placeholder="العمر" min="16" max="99" class="border rounded-lg p-2.5 dark:bg-gray-700 dark:border-gray-600">
                </div>
                <input type="password" id="new-mod-password" placeholder="كلمة المرور (6+ أحرف)" class="w-full border rounded-lg p-2.5 dark:bg-gray-700 dark:border-gray-600">
                <input type="password" id="new-mod-password2" placeholder="تأكيد كلمة المرور" class="w-full border rounded-lg p-2.5 dark:bg-gray-700 dark:border-gray-600">
                <p class="text-xs text-gray-500"><i class="fas fa-shield-alt text-green-500 ml-1"></i>يستخدم Firebase Auth — كلمة المرور مشفرة</p>
                <div class="flex justify-end gap-2 pt-2">
                    <button onclick="document.getElementById('addModModal').remove()" class="px-4 py-2 text-gray-500 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700">إلغاء</button>
                    <button onclick="ModMgr.save()" id="mod-save-btn" class="px-6 py-2 bg-brand-600 text-white rounded-lg hover:bg-brand-700 transition">حفظ</button>
                </div>
            </div>
        </div>`;
        document.body.insertAdjacentHTML('beforeend', html);
    }

    async function save() {
        if (!FB.isOk()) { Toast.show('Firebase غير متصل', 'error'); return; }
        const displayName = document.getElementById('new-mod-displayname').value.trim();
        const username = document.getElementById('new-mod-username').value.trim().toLowerCase().replace(/\s+/g, '');
        const phone = (document.getElementById('new-mod-phone')?.value || '').trim();
        const age = parseInt(document.getElementById('new-mod-age')?.value || '0');
        const password = document.getElementById('new-mod-password').value;
        const password2 = document.getElementById('new-mod-password2').value;
        if (!displayName || !username) { Toast.show('الاسم واسم المستخدم مطلوبان', 'error'); return; }
        if (password.length < 6) { Toast.show('كلمة المرور يجب أن تكون 6 أحرف على الأقل', 'error'); return; }
        if (password !== password2) { Toast.show('كلمتا المرور غير متطابقتين', 'error'); return; }
        const btn = document.getElementById('mod-save-btn');
        if (btn) { btn.disabled = true; btn.textContent = 'جارٍ الإنشاء...'; }
        try {
            const uid = await Auth.addModerator(username, password, displayName);
            // Save extra profile fields
            if (phone || age) {
                const extra = {};
                if (phone) extra.phone = phone;
                if (age > 0) extra.age = age;
                try { await FB.getDb().ref(`shaker/users/${uid}`).update(extra); } catch (_) {}
            }
            document.getElementById('addModModal')?.remove();
            Toast.show('✅ تم إضافة @' + username, 'success');
            render();
        } catch (e) {
            Toast.show('❌ ' + e.message, 'error');
            if (btn) { btn.disabled = false; btn.textContent = 'حفظ'; }
        }
    }

    async function toggleActive(uid, currentlyActive) {
        if (!FB.isOk()) return;
        try {
            await Auth.toggleModActive(uid, currentlyActive);
            Toast.show(currentlyActive ? 'تم تعطيل المشرف' : 'تم تفعيل المشرف', 'success');
            render();
        } catch (e) { Toast.show('❌ ' + e.message, 'error'); }
    }

    async function deleteMod(uid, username) {
        if (!confirm('هل أنت متأكد من تعطيل @' + username + '؟')) return;
        if (!FB.isOk()) return;
        try {
            await Auth.deleteModerator(uid, username);
            Toast.show('تم تعطيل @' + username, 'success');
            render();
        } catch (e) { Toast.show('❌ ' + e.message, 'error'); }
    }

    // ── تفاصيل (Analytics Modal) ───────────────────
    async function showDetails(uid) {
        const mods = await Auth.getModerators();
        const mod = mods.find(m => m.uid === uid);
        if (!mod) { Toast.show('المشرف غير موجود', 'error'); return; }
        const orders = Store.get('orders');
        const modOrders = orders.filter(o => o.moderatorUid === uid || o.moderatorName === (mod.username || uid));
        const totalSales = modOrders.filter(o => o.status !== 'Cancelled' && o.status !== 'Returned').reduce((s, o) => s + (o.total || 0), 0);
        const pending = modOrders.filter(o => o.status === 'Pending').length;
        const confirmed = modOrders.filter(o => o.status === 'Confirmed').length;
        const shipped = modOrders.filter(o => o.status === 'Shipped').length;
        const delivered = modOrders.filter(o => o.status === 'Delivered').length;
        const cancelled = modOrders.filter(o => o.status === 'Cancelled').length;

        document.getElementById('modDetailsModal')?.remove();
        const html = `<div id="modDetailsModal" class="fixed inset-0 bg-black bg-opacity-60 z-50 flex items-center justify-center p-4 overflow-y-auto" style="backdrop-filter:blur(4px)">
            <div class="bg-white dark:bg-gray-800 rounded-2xl w-full max-w-2xl p-6 shadow-2xl my-8">
                <div class="flex justify-between items-center mb-6">
                    <h3 class="text-xl font-bold"><i class="fas fa-chart-pie text-brand-600 ml-2"></i>تفاصيل المشرف</h3>
                    <button onclick="document.getElementById('modDetailsModal').remove()" class="text-gray-400 hover:text-gray-600"><i class="fas fa-times text-lg"></i></button>
                </div>
                <!-- Profile -->
                <div class="flex items-center gap-4 mb-6 p-4 bg-gray-50 dark:bg-gray-900 rounded-xl">
                    <div class="w-16 h-16 rounded-full bg-gradient-to-br from-indigo-500 to-indigo-700 flex items-center justify-center text-white font-bold text-2xl">${(mod.username||'?')[0].toUpperCase()}</div>
                    <div class="flex-1">
                        <div class="text-lg font-bold">${_e(mod.displayName||mod.username)}</div>
                        <div class="text-sm text-gray-500">@${_e(mod.username||mod.uid)} • ${_e(mod.email||'')}</div>
                        <div class="flex gap-3 mt-1 text-xs text-gray-400">
                            ${mod.phone ? `<span><i class="fas fa-phone ml-1"></i>${_e(mod.phone)}</span>` : ''}
                            ${mod.age ? `<span><i class="fas fa-birthday-cake ml-1"></i>${mod.age} سنة</span>` : ''}
                            <span><i class="fas fa-calendar ml-1"></i>${mod.createdAt ? new Date(mod.createdAt).toLocaleDateString('ar-EG') : '-'}</span>
                        </div>
                    </div>
                    <span class="px-3 py-1 rounded-full text-xs font-bold ${mod.active!==false?'bg-green-100 text-green-600':'bg-red-100 text-red-600'}">${mod.active!==false?'نشط':'معطل'}</span>
                </div>
                <!-- Stats Grid -->
                <div class="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
                    <div class="bg-blue-50 dark:bg-blue-900/20 p-3 rounded-xl text-center"><div class="text-2xl font-bold text-blue-600">${modOrders.length}</div><div class="text-xs text-gray-500">إجمالي الطلبات</div></div>
                    <div class="bg-green-50 dark:bg-green-900/20 p-3 rounded-xl text-center"><div class="text-2xl font-bold text-green-600">${delivered}</div><div class="text-xs text-gray-500">تم التسليم</div></div>
                    <div class="bg-amber-50 dark:bg-amber-900/20 p-3 rounded-xl text-center"><div class="text-2xl font-bold text-amber-600">${pending + confirmed}</div><div class="text-xs text-gray-500">قيد المعالجة</div></div>
                    <div class="bg-emerald-50 dark:bg-emerald-900/20 p-3 rounded-xl text-center"><div class="text-lg font-bold text-emerald-600">${Utils.formatCurrency(totalSales)}</div><div class="text-xs text-gray-500">إجمالي المبيعات</div></div>
                </div>
                <!-- Chart -->
                <div class="bg-gray-50 dark:bg-gray-900 rounded-xl p-4">
                    <canvas id="modDetailsChart" height="200"></canvas>
                </div>
            </div>
        </div>`;
        document.body.insertAdjacentHTML('beforeend', html);

        // Render chart
        try {
            await window._loadChartJS();
            const ctx = document.getElementById('modDetailsChart');
            if (ctx && window.Chart) {
                new Chart(ctx, {
                    type: 'doughnut',
                    data: {
                        labels: ['قيد الانتظار', 'مؤكد', 'تم الشحن', 'تم التسليم', 'ملغي'],
                        datasets: [{ data: [pending, confirmed, shipped, delivered, cancelled], backgroundColor: ['#f59e0b', '#3b82f6', '#8b5cf6', '#10b981', '#ef4444'], borderWidth: 0 }]
                    },
                    options: { responsive: true, plugins: { legend: { position: 'bottom', labels: { font: { family: 'Tajawal' } } } } }
                });
            }
        } catch (_) {}
    }

    // ── عرض النظام (Impersonation) ─────────────────
    function impersonate(modUid) {
        if (!confirm('سيتم فتح لوحة المشرف في نافذة جديدة.\nأنت تدخل كمسؤول بصلاحيات المراقبة فقط.')) return;
        // Set a temporary session flag that Moderator.html reads
        sessionStorage.setItem('shaker_impersonate', JSON.stringify({
            modUid: modUid,
            adminUid: FB.getAuth()?.currentUser?.uid,
            ts: Date.now()
        }));
        window.open('Moderator.html?impersonate=' + modUid, '_blank');
    }

    function _e(s) { return typeof s !== 'string' ? String(s||'') : s.replace(/[<>"'&]/g, c => ({'<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;','&':'&amp;'}[c])); }

    return { render, openAdd, save, toggleActive, deleteMod, showDetails, impersonate };
})();
