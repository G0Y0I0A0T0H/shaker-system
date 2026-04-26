/**
 * chat.js — SHAKER v20 FIXED
 * ✔️ push() for sending (NOT set())
 * ✔️ Persistent realtime listener
 * ✔️ Proper ref.off() cleanup
 * ✔️ Object→array with timestamp sort
 * ✔️ Both admin & moderator can send unlimited
 * ✔️ Flat structure: shaker/chats/{modUid}/{pushId}
 */

const ShakerChat = (() => {
    let _modUid   = null;
    let _unsub    = null;
    let _role     = null;
    let _myUid    = null;

    function init(role, myUid) {
        _role = role;
        _myUid = myUid;
        if (!_myUid) {
            console.error('[Chat] myUid is null');
        }
    }

    async function renderModList(containerId) {
        const el = document.getElementById(containerId);
        if (!el || !FB.isOk()) return;

        let mods = [];
        try {
            mods = await Auth.getModerators();
        } catch (e) {
            console.error('[Chat] getModerators failed:', e);
        }

        mods = mods.filter(m => !m.deletedAt);

        if (!mods.length) {
            el.innerHTML = '<div class="p-4 text-sm text-gray-400 text-center">لا يوجد مشرفون</div>';
            return;
        }

        el.innerHTML = mods.map(mod => {
            const uid = mod.uid;
            const name = _e(mod.displayName || mod.username || '?');
            const active = _modUid === uid;

            return `
            <div class="flex items-center border-b dark:border-gray-700 ${active ? 'bg-amber-50 dark:bg-amber-900/20' : ''}">
                <button onclick="ShakerChat.open('${uid}','${_e(mod.username||mod.displayName||'')}')" 
                        class="flex-1 text-right px-4 py-3 flex items-center gap-3 hover:bg-gray-50 dark:hover:bg-gray-700 transition">
                    <div class="w-10 h-10 rounded-full bg-amber-600 text-white flex items-center justify-center font-bold">
                        ${(mod.username||'?')[0].toUpperCase()}
                    </div>
                    <div>
                        <div class="font-semibold text-sm">${name}</div>
                        <div class="text-xs text-gray-400">${mod.active!==false?'متصل':'غير نشط'}</div>
                    </div>
                </button>
                <button onclick="ShakerChat.deleteConv('${uid}')" 
                        class="px-3 text-red-400 hover:text-red-600" title="حذف المحادثة">
                    <i class="fas fa-trash text-xs"></i>
                </button>
            </div>`;
        }).join('');
    }

    function open(modUid, modName) {
        if (!modUid) {
            console.error('[Chat] open: UID is null');
            return;
        }

        _modUid = modUid;

        const header = document.getElementById('admin-chat-header');
        if (header) header.textContent = modName || modUid;
        const inputArea = document.getElementById('admin-chat-input-area');
        if (inputArea) inputArea.classList.remove('hidden');

        renderModList('admin-chat-list');
        _listen(modUid, 'admin-chat-messages');
    }

    function _listen(uid, cid) {
        if (!uid) return;

        // Clean up previous listener
        if (_unsub) {
            _unsub();
            _unsub = null;
        }

        if (!FB.isOk()) return;

        const ref = FB.getDb().ref('shaker/chats/' + uid);

        const handler = snap => {
            try {
                const msgs = [];
                const data = snap.val();

                if (data && typeof data === 'object') {
                    Object.keys(data).forEach(key => {
                        const val = data[key];
                        if (val && typeof val === 'object' && val.text !== undefined && val.sender !== undefined) {
                            // Flat message: shaker/chats/{modUid}/{pushId}
                            msgs.push({ id: key, ...val });
                        } else if (val && typeof val === 'object') {
                            // Legacy nested — try children
                            Object.keys(val).forEach(subKey => {
                                const sv = val[subKey];
                                if (sv && typeof sv === 'object' && sv.text !== undefined) {
                                    msgs.push({ id: subKey, ...sv });
                                }
                            });
                        }
                    });
                }

                msgs.sort((a, b) => (a.time || 0) - (b.time || 0));
                _render(msgs, cid);
            } catch (e) {
                console.error('[Chat] listener error:', e);
            }
        };

        ref.on('value', handler);
        _unsub = () => ref.off('value', handler);
    }

    function _render(msgs, cid) {
        const c = document.getElementById(cid);
        if (!c) return;

        if (!msgs.length) {
            c.innerHTML = '<div class="text-center text-gray-400 py-6">لا توجد رسائل</div>';
            return;
        }

        c.innerHTML = msgs.map(m => {
            const isAdmin = m.sender === 'admin' || m.sender === _myUid;
            const isMine = (_role === 'admin' && m.sender === 'admin') || (_role === 'moderator' && m.sender === 'moderator') || m.sender === _myUid;
            const t = m.time ? new Date(m.time).toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' }) : '';
            const align = isMine ? 'justify-end' : 'justify-start';
            const bg = isMine
                ? (_role === 'admin' ? 'bg-amber-600 text-white' : 'bg-indigo-600 text-white')
                : 'bg-gray-200 dark:bg-gray-600 dark:text-white';

            return `<div class="flex ${align} mb-2">
                <div class="px-3 py-2 rounded-lg max-w-[75%] break-words ${bg}">
                    ${_e(m.text || '')}
                    <div class="text-xs opacity-60 mt-1">${t}</div>
                </div>
            </div>`;
        }).join('');

        c.scrollTop = c.scrollHeight;
    }

    function send(inputId) {
        if (!_modUid) { console.error('[Chat] send: no modUid'); return; }
        if (!_myUid) { console.error('[Chat] send: no myUid'); return; }
        if (!FB.isOk()) { console.error('[Chat] send: Firebase offline'); return; }

        const inp = document.getElementById(inputId || 'admin-chat-input');
        if (!inp) return;

        const text = (inp.value || '').trim();
        if (!text) return;

        inp.value = '';

        // CRITICAL: push() NOT set()
        FB.getDb().ref('shaker/chats/' + _modUid).push({
            sender: _role === 'admin' ? 'admin' : 'moderator',
            text: text,
            time: Date.now()
        }).catch(e => {
            console.error('[Chat] send failed:', e);
            if (typeof Toast !== 'undefined') Toast.show('فشل إرسال الرسالة', 'error');
        });
    }

    async function deleteConv(modUid) {
        if (_role !== 'admin') return;
        if (!FB.isOk()) return;
        if (!confirm('حذف المحادثة؟')) return;

        try {
            await FB.getDb().ref('shaker/chats/' + modUid).remove();
            if (typeof Toast !== 'undefined') Toast.show('تم حذف المحادثة', 'success');
        } catch (e) {
            console.error('[Chat] deleteConv failed:', e);
        }
    }

    function _e(s) {
        return typeof s !== 'string'
            ? String(s || '')
            : s.replace(/[<>"'&]/g, c => ({'<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;','&':'&amp;'}[c]));
    }

    function openOwn(uid, containerId) {
        _modUid = uid;
        _listen(uid, containerId || 'mod-chat-messages');
    }

    return {
        init,
        renderModList,
        open,
        openOwn,
        send,
        deleteConv
    };
})();
