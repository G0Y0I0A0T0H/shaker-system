// ===== FILE: js/chat.js =====
// ShakerChat — Real-time WhatsApp-like chat system
// UID-based only. No username fallbacks.
// Used by both admin (index.html) and moderator (Moderator.html)
'use strict';

const ShakerChat = (() => {
    let _role = null;       // 'admin' or 'moderator'
    let _myUid = null;      // Current user's UID
    let _activeModUid = null; // Currently open chat (moderator UID)
    let _listener = null;   // Firebase realtime listener ref
    let _messagesContainerId = null; // DOM element ID for messages
    let _isMuted = false;

    // ── Init ──────────────────────────────────────────
    function init(role, uid) {
        _role = role;
        _myUid = uid;
        _activeModUid = null;
        _detachListener();
    }

    // ── Detach existing listener ──────────────────────
    function _detachListener() {
        if (_listener) {
            try { _listener.off(); } catch (_) {}
            _listener = null;
        }
    }

    // ── Render moderator list (admin side) ────────────
    function renderModList(containerId) {
        if (!FB.isOk()) return;
        const container = document.getElementById(containerId);
        if (!container) return;

        FB.getDb().ref('shaker/users').orderByChild('role').equalTo('moderator').once('value', snap => {
            const users = snap.val() || {};
            const mods = Object.entries(users)
                .filter(([, u]) => u.active !== false)
                .map(([uid, u]) => ({ uid, name: u.displayName || u.username || uid }));

            if (!mods.length) {
                container.innerHTML = '<div class="p-4 text-center text-gray-400 text-sm">لا يوجد مشرفون</div>';
                return;
            }

            container.innerHTML = mods.map(m => `
                <button onclick="AdminChat.openWith('${m.uid}')"
                    class="w-full text-right px-4 py-3 hover:bg-gray-50 dark:hover:bg-gray-700 transition flex items-center gap-3 ${_activeModUid === m.uid ? 'bg-brand-50 dark:bg-brand-900/20 border-r-4 border-brand-500' : ''}">
                    <div class="w-8 h-8 rounded-full bg-gradient-to-br from-indigo-500 to-indigo-700 flex items-center justify-center text-white text-xs font-bold flex-shrink-0">
                        ${(m.name || '?')[0].toUpperCase()}
                    </div>
                    <div class="flex-1 min-w-0">
                        <div class="font-bold text-sm truncate">${_escHtml(m.name)}</div>
                        <div class="text-xs text-gray-400">UID: ${m.uid.slice(0, 8)}…</div>
                    </div>
                </button>
            `).join('');
        });
    }

    // ── Open chat with a moderator (admin or moderator side) ──
    function open(modUid, resolvedUid) {
        if (!FB.isOk() || !modUid) return;
        const uid = resolvedUid || modUid;
        _activeModUid = uid;

        // Update header (admin side)
        const header = document.getElementById('admin-chat-header');
        if (header) {
            FB.getDb().ref('shaker/users/' + uid).once('value', snap => {
                const u = snap.val();
                const name = u ? (u.displayName || u.username || uid) : uid;
                header.innerHTML = `
                    <div class="flex items-center gap-3">
                        <div class="w-8 h-8 rounded-full bg-gradient-to-br from-indigo-500 to-indigo-700 flex items-center justify-center text-white text-xs font-bold">${(name || '?')[0].toUpperCase()}</div>
                        <div><div class="font-bold">${_escHtml(name)}</div><div class="text-xs text-gray-400">محادثة مباشرة</div></div>
                    </div>
                    <button onclick="AdminChat.deleteConversation('${uid}')" class="text-red-500 hover:text-red-700 text-sm" title="حذف المحادثة"><i class="fas fa-trash"></i></button>
                `;
                header.classList.add('flex', 'justify-between', 'items-center');
            });
        }

        // Show input area (admin side)
        const inputArea = document.getElementById('admin-chat-input-area');
        if (inputArea) inputArea.classList.remove('hidden');

        // Attach realtime listener
        _attachListener(uid, 'admin-chat-messages');

        // Re-render mod list to highlight active
        renderModList('admin-chat-list');
    }

    // ── Open own chat (moderator side) ────────────────
    function openOwn(modUid, messagesContainerId) {
        if (!FB.isOk() || !modUid) return;
        _activeModUid = modUid;
        _messagesContainerId = messagesContainerId;

        // Check mute status
        _checkMuted(modUid);

        // Attach realtime listener
        _attachListener(modUid, messagesContainerId);
    }

    // ── Check if moderator is muted ───────────────────
    function _checkMuted(uid) {
        if (!FB.isOk()) return;
        FB.getDb().ref('shaker/users/' + uid + '/muted').on('value', snap => {
            _isMuted = snap.val() === true;
        });
    }

    // ── Attach realtime listener ──────────────────────
    function _attachListener(modUid, containerId) {
        _detachListener();
        if (!FB.isOk() || !modUid) return;

        const ref = FB.getDb().ref('shaker/chats/' + modUid);
        _listener = ref;

        ref.on('value', snap => {
            const data = snap.val() || {};
            const messages = Object.entries(data)
                .map(([id, msg]) => ({ id, ...msg }))
                .sort((a, b) => (a.time || 0) - (b.time || 0));

            _renderMessages(messages, containerId);
        });
    }

    // ── Render messages (WhatsApp-like bubbles) ───────
    function _renderMessages(messages, containerId) {
        const container = document.getElementById(containerId);
        if (!container) return;

        const isDark = document.documentElement.classList.contains('dark');

        if (!messages.length) {
            container.innerHTML = `
                <div class="flex flex-col items-center justify-center h-full text-gray-400">
                    <i class="fas fa-comments text-4xl mb-3 opacity-30"></i>
                    <p class="text-sm">لا توجد رسائل بعد</p>
                    <p class="text-xs mt-1">ابدأ المحادثة الآن</p>
                </div>`;
            return;
        }

        container.innerHTML = messages.map(msg => {
            const isMe = msg.from === _myUid;
            const time = msg.time ? new Date(msg.time).toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' }) : '';
            const date = msg.time ? new Date(msg.time).toLocaleDateString('ar-EG', { month: 'short', day: 'numeric' }) : '';

            if (isMe) {
                return `
                    <div class="flex justify-end mb-2">
                        <div class="max-w-[75%] ${isDark ? 'bg-indigo-700' : 'bg-indigo-500'} text-white rounded-2xl rounded-bl-md px-4 py-2 shadow-sm">
                            <div class="text-sm leading-relaxed break-words">${_escHtml(msg.text || '')}</div>
                            <div class="text-[10px] opacity-70 mt-1 text-left">${time} · ${date}</div>
                        </div>
                    </div>`;
            } else {
                return `
                    <div class="flex justify-start mb-2">
                        <div class="max-w-[75%] ${isDark ? 'bg-gray-700' : 'bg-white'} ${isDark ? 'text-gray-100' : 'text-gray-800'} rounded-2xl rounded-br-md px-4 py-2 shadow-sm border ${isDark ? 'border-gray-600' : 'border-gray-200'}">
                            <div class="text-sm leading-relaxed break-words">${_escHtml(msg.text || '')}</div>
                            <div class="text-[10px] ${isDark ? 'text-gray-400' : 'text-gray-500'} mt-1 text-left">${time} · ${date}</div>
                        </div>
                    </div>`;
            }
        }).join('');

        // Auto scroll to bottom
        requestAnimationFrame(() => {
            container.scrollTop = container.scrollHeight;
        });
    }

    // ── Send message ──────────────────────────────────
    function send(inputId) {
        if (!FB.isOk() || !_activeModUid || !_myUid) return;

        // Check mute status (moderator side)
        if (_role === 'moderator' && _isMuted) {
            if (typeof Toast !== 'undefined') {
                Toast.show('⛔ تم كتم حسابك — لا يمكنك إرسال رسائل', 'error');
            }
            return;
        }

        const input = document.getElementById(inputId);
        if (!input) return;

        const text = (input.value || '').trim();
        if (!text) return;

        const message = {
            text: text,
            from: _myUid,
            time: firebase.database.ServerValue.TIMESTAMP
        };

        // Clear input immediately (optimistic)
        input.value = '';
        input.focus();

        // Push to Firebase
        const ref = FB.getDb().ref('shaker/chats/' + _activeModUid);
        ref.push(message).catch(err => {
            console.error('Chat send error:', err);
            if (typeof Toast !== 'undefined') {
                Toast.show('❌ فشل إرسال الرسالة', 'error');
            }
            // Restore text on failure
            input.value = text;
        });
    }

    // ── Delete conversation (admin only) ──────────────
    function deleteConv(modUid) {
        if (!FB.isOk() || _role !== 'admin') return;
        if (!confirm('هل أنت متأكد من حذف هذه المحادثة؟ لا يمكن التراجع.')) return;

        FB.getDb().ref('shaker/chats/' + modUid).remove()
            .then(() => {
                if (typeof Toast !== 'undefined') {
                    Toast.show('✅ تم حذف المحادثة', 'success');
                }
                // Clear messages display
                const messagesEl = document.getElementById('admin-chat-messages');
                if (messagesEl) {
                    messagesEl.innerHTML = '<div class="flex flex-col items-center justify-center h-full text-gray-400"><i class="fas fa-comments text-4xl mb-3 opacity-30"></i><p class="text-sm">تم حذف المحادثة</p></div>';
                }
            })
            .catch(err => {
                console.error('Delete chat error:', err);
                if (typeof Toast !== 'undefined') {
                    Toast.show('❌ فشل حذف المحادثة', 'error');
                }
            });
    }

    // ── HTML escape ───────────────────────────────────
    function _escHtml(str) {
        if (typeof Sanitize !== 'undefined' && Sanitize.html) return Sanitize.html(str);
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    // ── Cleanup ──────────────────────────────────────
    function destroy() {
        _detachListener();
        _role = null;
        _myUid = null;
        _activeModUid = null;
    }

    return {
        init,
        renderModList,
        open,
        openOwn,
        send,
        deleteConv,
        destroy
    };
})();