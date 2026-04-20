/**
 * chat.js — SHAKER FIXED v18
 * FIXES:
 * ✔️ Prevent silent fails
 * ✔️ Ensure UID always exists
 * ✔️ Better error handling
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
            console.error('❌ المستخدم غير معرف (myUid)');
        }
    }

    async function renderModList(containerId) {
        const el = document.getElementById(containerId);
        if (!el || !FB.isOk()) return;

        let mods = [];
        try {
            mods = await Auth.getModerators();
        } catch (e) {
            console.error('❌ فشل تحميل المشرفين:', e);
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
            const dot = mod.active !== false ? 'bg-green-400' : 'bg-gray-400';

            return `
            <div class="flex items-center border-b ${active ? 'bg-amber-50' : ''}">
                <button onclick="ShakerChat.open('${uid}','${_e(mod.username||mod.displayName||'')}')" 
                        class="flex-1 text-right px-4 py-3 flex items-center gap-3">

                    <div class="w-10 h-10 rounded-full bg-amber-600 text-white flex items-center justify-center">
                        ${(mod.username||'?')[0].toUpperCase()}
                    </div>

                    <div>
                        <div class="font-semibold text-sm">${name}</div>
                        <div class="text-xs text-gray-400">${mod.active!==false?'متصل':'غير نشط'}</div>
                    </div>
                </button>

                <button onclick="ShakerChat.deleteConv('${uid}')" 
                        class="px-3 text-red-400 hover:text-red-600">
                    🗑
                </button>
            </div>`;
        }).join('');
    }

    function open(modUid, modName) {
        if (!modUid) {
            console.error('❌ UID غير موجود');
            return;
        }

        _modUid = modUid;

        // Show chat header and input area
        const header = document.getElementById('admin-chat-header');
        if (header) header.textContent = modName || modUid;
        const inputArea = document.getElementById('admin-chat-input-area');
        if (inputArea) inputArea.classList.remove('hidden');

        renderModList('admin-chat-list');
        _listen(modUid, 'admin-chat-messages');
    }

    function _listen(uid, cid) {
        if (!uid) {
            console.warn('⚠️ محاولة استماع بدون UID');
            return;
        }

        if (_unsub) {
            _unsub();
            _unsub = null;
        }

        if (!FB.isOk()) {
            console.error('❌ Firebase غير متصل');
            return;
        }

        const ref = FB.getDb().ref('shaker/chats/' + uid);

        const handler = snap => {
            try {
                const msgs = [];

                if (snap.exists()) {
                    snap.forEach(c => msgs.push({ id: c.key, ...c.val() }));
                }

                msgs.sort((a, b) => a.time - b.time);
                _render(msgs, cid);

            } catch (e) {
                console.error('❌ خطأ في قراءة الرسائل:', e);
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

        let html = '';

        msgs.forEach(m => {
            const isAdmin = m.sender === 'admin';
            const t = new Date(m.time).toLocaleTimeString();

            html += `
            <div class="flex ${isAdmin ? 'justify-start' : 'justify-end'} mb-2">
                <div class="px-3 py-2 rounded-lg ${isAdmin ? 'bg-amber-600 text-white' : 'bg-gray-200'}">
                    ${_e(m.text || '')}
                    <div class="text-xs opacity-70 mt-1">${t}</div>
                </div>
            </div>`;
        });

        c.innerHTML = html;
        c.scrollTop = c.scrollHeight;
    }

    function send(inputId) {
        if (!_modUid) {
            console.error('❌ لا يوجد محادثة محددة');
            return;
        }

        if (!_myUid) {
            console.error('❌ المستخدم غير معرف');
            return;
        }

        if (!FB.isOk()) {
            console.error('❌ Firebase غير جاهز');
            return;
        }

        const inp = document.getElementById(inputId || 'admin-chat-input');
        if (!inp) return;

        const text = (inp.value || '').trim();
        if (!text) return;

        inp.value = '';

        FB.getDb().ref('shaker/chats/' + _modUid).push({
            sender: _role === 'admin' ? 'admin' : 'moderator',
            text: text,
            time: Date.now()
        }).catch(e => {
            console.error('❌ فشل الإرسال:', e);
        });
    }

    async function deleteConv(modUid) {
        if (_role !== 'admin') return;
        if (!FB.isOk()) return;

        try {
            await FB.getDb().ref('shaker/chats/' + modUid).remove();
            console.log('✅ تم حذف المحادثة');
        } catch (e) {
            console.error('❌ فشل حذف المحادثة:', e);
        }
    }

    function _e(s) {
        return typeof s !== 'string'
            ? String(s || '')
            : s.replace(/[<>"'&]/g, c => ({
                '<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;','&':'&amp;'
            }[c]));
    }

    // Moderator opens their own chat channel
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