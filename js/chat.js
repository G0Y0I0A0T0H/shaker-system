/**
 * chat.js — SHAKER v17
 * Real-time WhatsApp-style chat.
 * UID-only. Admin full control. Moderator write-only.
 */
const ShakerChat = (() => {
    let _modUid   = null;
    let _unsub    = null;
    let _role     = null;
    let _myUid    = null;

    function init(role, myUid) { _role = role; _myUid = myUid; }

    async function renderModList(containerId) {
        const el = document.getElementById(containerId);
        if (!el || !FB.isOk()) return;
        let mods = [];
        try { mods = await Auth.getModerators(); } catch (_) {}
        mods = mods.filter(m => !m.deletedAt);
        if (!mods.length) { el.innerHTML = '<div class="p-4 text-sm text-gray-400 text-center">لا يوجد مشرفون</div>'; return; }
        el.innerHTML = mods.map(mod => {
            const uid = mod.uid, name = _e(mod.displayName || mod.username || '?');
            const active = _modUid === uid;
            const dot = mod.active !== false ? 'bg-green-400' : 'bg-gray-400';
            return `<div class="flex items-center border-b border-gray-100 dark:border-gray-700 ${active ? 'bg-amber-50 dark:bg-amber-900/20' : 'hover:bg-gray-50 dark:hover:bg-gray-700/50'} transition-colors">
                <button onclick="ShakerChat.open('${uid}','${_e(mod.username||mod.displayName||'')}')" class="flex-1 text-right px-4 py-3 flex items-center gap-3">
                    <div class="relative"><div class="w-10 h-10 rounded-full bg-gradient-to-br from-amber-500 to-amber-700 flex items-center justify-center text-white font-bold text-sm shadow">${(mod.username||'?')[0].toUpperCase()}</div><div class="absolute -bottom-0.5 -left-0.5 w-3 h-3 rounded-full ${dot} border-2 border-white dark:border-gray-800"></div></div>
                    <div class="text-right min-w-0"><div class="font-semibold text-sm truncate">${name}</div><div class="text-xs text-gray-400">${mod.active!==false?'متصل':'غير نشط'}</div></div>
                </button>
                <button onclick="ShakerChat.deleteConv('${uid}')" title="حذف المحادثة" class="px-3 py-3 text-gray-300 hover:text-red-500 transition"><i class="fas fa-trash-alt text-xs"></i></button>
            </div>`;
        }).join('');
    }

    function open(modUid, modName) {
        _modUid = modUid;
        const h = document.getElementById('admin-chat-header');
        if (h) h.innerHTML = `<div class="flex items-center gap-3"><div class="w-8 h-8 rounded-full bg-gradient-to-br from-amber-500 to-amber-700 flex items-center justify-center text-white font-bold text-xs">${(modName||'?')[0].toUpperCase()}</div><div><div class="font-bold text-sm">${_e(modName||modUid)}</div><div class="text-xs text-green-500">متصل</div></div></div>`;
        const ia = document.getElementById('admin-chat-input-area');
        if (ia) ia.classList.remove('hidden');
        renderModList('admin-chat-list');
        _listen(modUid, 'admin-chat-messages');
    }

    function openOwn(myUid, containerId) { _modUid = myUid; _listen(myUid, containerId); }

    function _listen(uid, cid) {
        if (_unsub) { _unsub(); _unsub = null; }
        if (!FB.isOk()) return;
        const ref = FB.getDb().ref('shaker/chats/' + uid);
        const handler = snap => {
            const msgs = [];
            if (snap.exists()) snap.forEach(c => msgs.push({ id: c.key, ...c.val() }));
            msgs.sort((a, b) => a.time - b.time);
            _render(msgs, cid);
        };
        ref.on('value', handler);
        _unsub = () => ref.off('value', handler);
    }

    function _render(msgs, cid) {
        const c = document.getElementById(cid);
        if (!c) return;
        if (!msgs.length) { c.innerHTML = '<div class="flex flex-col items-center justify-center h-full text-gray-400"><i class="fas fa-comments text-4xl mb-3 opacity-30"></i><p class="text-sm">لا توجد رسائل بعد</p></div>'; return; }
        let lastDate = '', html = '';
        msgs.forEach(m => {
            const d = new Date(m.time).toLocaleDateString('ar-EG', { year:'numeric', month:'long', day:'numeric' });
            if (d !== lastDate) { lastDate = d; html += `<div class="flex justify-center my-3"><span class="bg-gray-200 dark:bg-gray-700 text-gray-500 dark:text-gray-400 text-xs px-3 py-1 rounded-full">${d}</span></div>`; }
            const isAdmin = m.sender === 'admin';
            const t = new Date(m.time).toLocaleTimeString('ar-EG', { hour:'2-digit', minute:'2-digit' });
            const canDel = _role === 'admin';
            html += `<div class="flex ${isAdmin ? 'justify-start' : 'justify-end'} group mb-1">
                <div class="relative max-w-[75%] px-3.5 py-2 rounded-2xl text-sm shadow-sm ${isAdmin ? 'bg-gradient-to-br from-amber-500 to-amber-600 text-white rounded-tl-md' : 'bg-white dark:bg-gray-700 text-gray-800 dark:text-gray-200 rounded-tr-md border border-gray-100 dark:border-gray-600'}">
                    <div class="leading-relaxed" style="word-break:break-word">${_e(m.text||'')}</div>
                    <div class="flex items-center gap-1 mt-1 ${isAdmin?'text-amber-100':'text-gray-400'}"><span class="text-[10px]">${t}</span>${isAdmin?'<i class="fas fa-check-double text-[9px]"></i>':''}</div>
                    ${canDel ? `<button onclick="ShakerChat.delMsg('${_modUid}','${m.id}')" class="absolute -top-2 ${isAdmin?'-right-2':'-left-2'} w-5 h-5 bg-red-500 text-white rounded-full text-[9px] opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center shadow"><i class="fas fa-times"></i></button>` : ''}
                </div>
            </div>`;
        });
        c.innerHTML = html;
        requestAnimationFrame(() => { c.scrollTop = c.scrollHeight; });
    }

    function send(inputId) {
        const uid = _modUid;
        if (!uid || !FB.isOk()) return;
        const inp = document.getElementById(inputId || 'admin-chat-input');
        if (!inp) return;
        const text = (inp.value || '').trim();
        if (!text || text.length > 2000) return;
        inp.value = ''; inp.focus();
        FB.getDb().ref('shaker/chats/' + uid).push({
            sender: _role === 'admin' ? 'admin' : 'moderator', text, time: Date.now()
        }).catch(e => { if (typeof Toast !== 'undefined') Toast.show('فشل الإرسال: ' + e.message, 'error'); });
    }

    async function delMsg(modUid, msgId) {
        if (_role !== 'admin' || !FB.isOk()) return;
        try { await FB.getDb().ref(`shaker/chats/${modUid}/${msgId}`).remove(); } catch (_) {}
    }

    async function deleteConv(modUid) {
        if (_role !== 'admin') return;
        if (!confirm('هل تريد حذف كل رسائل هذه المحادثة؟')) return;
        if (!FB.isOk()) return;
        try {
            let targetUid = modUid;
            const mods = await Auth.getModerators();
            const mod = mods.find(m => m.uid === modUid || m.username === modUid);
            if (mod?.uid) targetUid = mod.uid;
            await FB.getDb().ref('shaker/chats/' + targetUid).remove();
            const el = document.getElementById('admin-chat-messages');
            if (el) el.innerHTML = '<div class="text-center text-gray-400 py-8"><i class="fas fa-check-circle text-green-400 text-2xl mb-2"></i><br>تم حذف المحادثة</div>';
            if (typeof Toast !== 'undefined') Toast.show('تم حذف المحادثة', 'success');
        } catch (e) { if (typeof Toast !== 'undefined') Toast.show('فشل: ' + e.message, 'error'); }
    }

    function destroy() { if (_unsub) { _unsub(); _unsub = null; } _modUid = null; }
    function getModUid() { return _modUid; }
    function _e(s) { return typeof s !== 'string' ? String(s||'') : s.replace(/[<>"'&]/g, c => ({'<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;','&':'&amp;'}[c])); }

    return { init, renderModList, open, openOwn, send, delMsg, deleteConv, destroy, getModUid };
})();