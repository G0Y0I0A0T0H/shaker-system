/**
 * chat.js — SHAKER v15
 * ═════════════════════
 * Professional real-time chat system.
 * - UID-only addressing (no username keys)
 * - WhatsApp-style bubbles with timestamps
 * - Auto-scroll on new messages
 * - Admin: sees all chats, can delete messages/conversations
 * - Moderator: sees only own chat, can only send
 * - Real-time Firebase listeners
 */

const ShakerChat = (() => {
    let _currentModUid = null;
    let _listener      = null;
    let _role          = null; // 'admin' or 'moderator'
    let _myUid         = null;

    function init(role, myUid) {
        _role  = role;
        _myUid = myUid;
    }

    // ── ADMIN: Render moderator list ───────────────
    async function renderModList(containerId) {
        const el = document.getElementById(containerId);
        if (!el || !FB.isOk()) return;
        let mods = [];
        try { mods = await Auth.getModerators(); } catch (_) {}
        mods = mods.filter(m => !m.deletedAt);

        if (mods.length === 0) {
            el.innerHTML = '<div class="p-4 text-sm text-gray-400 text-center">لا يوجد مشرفون</div>';
            return;
        }

        el.innerHTML = mods.map(mod => {
            const uid  = mod.uid;
            const name = _esc(mod.displayName || mod.username || '?');
            const isActive = _currentModUid === uid;
            const statusDot = mod.active !== false ? 'bg-green-400' : 'bg-gray-400';
            return `<div class="flex items-center border-b border-gray-100 dark:border-gray-700 ${isActive ? 'bg-amber-50 dark:bg-amber-900/20' : 'hover:bg-gray-50 dark:hover:bg-gray-750'} transition-colors">
                <button onclick="ShakerChat.openWith('${uid}','${_esc(mod.username || mod.displayName || '')}')" class="flex-1 text-right px-4 py-3 flex items-center gap-3">
                    <div class="relative">
                        <div class="w-10 h-10 rounded-full bg-gradient-to-br from-amber-500 to-amber-700 flex items-center justify-center text-white font-bold text-sm shadow-sm">${(mod.username || '?')[0].toUpperCase()}</div>
                        <div class="absolute -bottom-0.5 -left-0.5 w-3 h-3 rounded-full ${statusDot} border-2 border-white dark:border-gray-800"></div>
                    </div>
                    <div class="text-right min-w-0">
                        <div class="font-semibold text-sm truncate">${name}</div>
                        <div class="text-xs text-gray-400">${mod.active !== false ? 'متصل' : 'غير نشط'}</div>
                    </div>
                </button>
                <button onclick="ShakerChat.deleteConversation('${uid}')" title="حذف المحادثة" class="px-3 py-3 text-gray-300 hover:text-red-500 transition-colors">
                    <i class="fas fa-trash-alt text-xs"></i>
                </button>
            </div>`;
        }).join('');
    }

    // ── Open chat with a specific moderator ────────
    function openWith(modUid, modName) {
        _currentModUid = modUid;

        // Update header
        const header = document.getElementById('admin-chat-header');
        if (header) {
            header.innerHTML = `<div class="flex items-center gap-3">
                <div class="w-8 h-8 rounded-full bg-gradient-to-br from-amber-500 to-amber-700 flex items-center justify-center text-white font-bold text-xs">${(modName || '?')[0].toUpperCase()}</div>
                <div>
                    <div class="font-bold text-sm">${_esc(modName || modUid)}</div>
                    <div class="text-xs text-green-500">متصل الآن</div>
                </div>
            </div>`;
        }

        // Show input area
        const inputArea = document.getElementById('admin-chat-input-area');
        if (inputArea) inputArea.classList.remove('hidden');

        // Show call buttons for admin
        const callArea = document.getElementById('chat-call-buttons');
        if (callArea) callArea.classList.remove('hidden');

        // Re-render mod list to highlight active
        renderModList('admin-chat-list');

        // Start listening
        _startListening(modUid, 'admin-chat-messages');
    }

    // ── Moderator: open own chat ───────────────────
    function openOwnChat(myUid, messagesContainerId) {
        _currentModUid = myUid;
        _startListening(myUid, messagesContainerId);
    }

    // ── Listen for messages ────────────────────────
    function _startListening(modUid, containerId) {
        if (_listener) { _listener(); _listener = null; }
        if (!FB.isOk()) {
            const el = document.getElementById(containerId);
            if (el) el.innerHTML = '<div class="text-center text-gray-400 py-8">Firebase غير متصل</div>';
            return;
        }

        const ref = FB.getDb().ref('shaker/chats/' + modUid);
        const handler = snap => {
            const msgs = [];
            if (snap.exists()) snap.forEach(child => msgs.push({ id: child.key, ...child.val() }));
            msgs.sort((a, b) => a.time - b.time);
            _renderMessages(msgs, containerId);
        };
        ref.on('value', handler);
        _listener = () => ref.off('value', handler);
    }

    // ── Render messages (WhatsApp style) ───────────
    function _renderMessages(msgs, containerId) {
        const container = document.getElementById(containerId);
        if (!container) return;

        if (msgs.length === 0) {
            container.innerHTML = `<div class="flex flex-col items-center justify-center h-full text-gray-400">
                <i class="fas fa-comments text-4xl mb-3 opacity-30"></i>
                <p class="text-sm">لا توجد رسائل بعد</p>
                <p class="text-xs mt-1">ابدأ المحادثة الآن</p>
            </div>`;
            return;
        }

        // Group by date
        let lastDate = '';
        let html = '';

        msgs.forEach((m, i) => {
            const msgDate = new Date(m.time).toLocaleDateString('ar-EG', { year: 'numeric', month: 'long', day: 'numeric' });
            if (msgDate !== lastDate) {
                lastDate = msgDate;
                html += `<div class="flex justify-center my-3">
                    <span class="bg-gray-200 dark:bg-gray-700 text-gray-500 dark:text-gray-400 text-xs px-3 py-1 rounded-full">${msgDate}</span>
                </div>`;
            }

            const isAdmin = m.sender === 'admin';
            const time = new Date(m.time).toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' });
            const canDelete = _role === 'admin';

            html += `<div class="flex ${isAdmin ? 'justify-start' : 'justify-end'} group mb-1">
                <div class="relative max-w-[75%] px-3.5 py-2 rounded-2xl text-sm shadow-sm
                    ${isAdmin
                        ? 'bg-gradient-to-br from-amber-500 to-amber-600 text-white rounded-tl-md'
                        : 'bg-white dark:bg-gray-700 text-gray-800 dark:text-gray-200 rounded-tr-md border border-gray-100 dark:border-gray-600'}">
                    <div class="leading-relaxed" style="word-break:break-word">${_esc(m.text || '')}</div>
                    <div class="flex items-center gap-1 mt-1 ${isAdmin ? 'text-amber-100' : 'text-gray-400'}">
                        <span class="text-[10px]">${time}</span>
                        ${isAdmin ? '<i class="fas fa-check-double text-[9px]"></i>' : ''}
                    </div>
                    ${canDelete ? `<button onclick="ShakerChat.deleteMessage('${_currentModUid}','${m.id}')"
                        class="absolute -top-2 ${isAdmin ? '-right-2' : '-left-2'} w-5 h-5 bg-red-500 text-white rounded-full text-[9px] opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center shadow">
                        <i class="fas fa-times"></i>
                    </button>` : ''}
                </div>
            </div>`;
        });

        container.innerHTML = html;
        // Auto-scroll to bottom
        requestAnimationFrame(() => { container.scrollTop = container.scrollHeight; });
    }

    // ── Send message ───────────────────────────────
    function send(inputId) {
        const uid = _currentModUid;
        if (!uid || !FB.isOk()) return;
        const input = document.getElementById(inputId || 'admin-chat-input');
        if (!input) return;
        const text = (input.value || '').trim();
        if (!text || text.length > 2000) return;
        input.value = '';
        input.focus();

        const sender = _role === 'admin' ? 'admin' : 'moderator';
        FB.getDb().ref('shaker/chats/' + uid).push({
            sender, text, time: Date.now()
        }).catch(e => {
            if (typeof Toast !== 'undefined') Toast.show('فشل الإرسال: ' + e.message, 'error');
        });
    }

    // ── Delete single message (admin only) ─────────
    async function deleteMessage(modUid, msgId) {
        if (_role !== 'admin') return;
        if (!FB.isOk()) return;
        try {
            await FB.getDb().ref(`shaker/chats/${modUid}/${msgId}`).remove();
        } catch (e) {
            if (typeof Toast !== 'undefined') Toast.show('فشل الحذف', 'error');
        }
    }

    // ── Delete entire conversation (admin only) ────
    async function deleteConversation(modUid) {
        if (_role !== 'admin') return;
        if (!confirm('هل تريد حذف كل رسائل هذه المحادثة؟')) return;
        if (!FB.isOk()) return;
        try {
            // Resolve to UID
            let targetUid = modUid;
            const mods = await Auth.getModerators();
            const mod = mods.find(m => m.uid === modUid || m.username === modUid);
            if (mod && mod.uid) targetUid = mod.uid;

            await FB.getDb().ref('shaker/chats/' + targetUid).remove();
            const msgs = document.getElementById('admin-chat-messages');
            if (msgs) msgs.innerHTML = '<div class="text-center text-gray-400 py-8"><i class="fas fa-check-circle text-green-400 text-2xl mb-2"></i><br>تم حذف المحادثة</div>';
            if (typeof Toast !== 'undefined') Toast.show('تم حذف المحادثة', 'success');
        } catch (e) {
            if (typeof Toast !== 'undefined') Toast.show('فشل الحذف: ' + e.message, 'error');
        }
    }

    // ── Cleanup ────────────────────────────────────
    function destroy() {
        if (_listener) { _listener(); _listener = null; }
        _currentModUid = null;
    }

    function getCurrentModUid() { return _currentModUid; }

    function _esc(s) {
        if (typeof s !== 'string') return String(s || '');
        return s.replace(/[<>"'&]/g, c => ({ '<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;','&':'&amp;' }[c]));
    }

    return {
        init, renderModList, openWith, openOwnChat,
        send, deleteMessage, deleteConversation,
        destroy, getCurrentModUid
    };
})();
