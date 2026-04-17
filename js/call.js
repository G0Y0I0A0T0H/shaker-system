/**
 * call.js — SHAKER v15
 * ═════════════════════
 * WebRTC peer-to-peer voice/video calling.
 * Firebase Realtime Database used as signaling server.
 *
 * Flow:
 * 1. Caller creates offer → writes to shaker/calls/{targetUid}
 * 2. Callee reads offer → creates answer → writes to shaker/calls/{callerUid}
 * 3. ICE candidates exchanged via shaker/calls/{uid}/candidates
 * 4. Peer connection established
 * 5. Either party can end call → clears signals
 */

const ShakerCall = (() => {
    let _pc           = null; // RTCPeerConnection
    let _localStream  = null;
    let _remoteStream = null;
    let _myUid        = null;
    let _targetUid    = null;
    let _signalUnsub  = null;
    let _candidateRef = null;
    let _isActive     = false;
    let _role         = null; // 'admin' or 'moderator'

    const ICE_SERVERS = [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' }
    ];

    function init(role, myUid) {
        _role  = role;
        _myUid = myUid;
        // Listen for incoming calls
        _listenForIncoming();
    }

    // ── Start a call (caller side) ─────────────────
    async function startCall(targetUid, video = false) {
        if (_isActive) { _showToast('مكالمة جارية بالفعل', 'warning'); return; }
        if (!FB.isOk() || !targetUid) { _showToast('لا يمكن إجراء المكالمة', 'error'); return; }

        _targetUid = targetUid;
        _isActive  = true;
        _showCallUI('calling', video);

        try {
            _localStream = await navigator.mediaDevices.getUserMedia({
                audio: true,
                video: video ? { width: 640, height: 480 } : false
            });

            _showLocalVideo();
            _createPC();
            _localStream.getTracks().forEach(t => _pc.addTrack(t, _localStream));

            const offer = await _pc.createOffer();
            await _pc.setLocalDescription(offer);

            // Send offer to target via Firebase
            await FB.sendSignal(targetUid, {
                type: 'offer',
                from: _myUid,
                sdp:  offer.sdp,
                video: video,
                time: Date.now()
            });

            // Listen for answer
            _signalUnsub = FB.listenSignaling(_myUid, async (data) => {
                if (!data || !_pc) return;
                if (data.type === 'answer' && data.from === _targetUid) {
                    try {
                        await _pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: data.sdp }));
                        _showCallUI('connected', video);
                    } catch (e) { console.error('[Call] Set answer failed:', e); }
                }
                if (data.type === 'end') {
                    endCall();
                }
            });

            // Listen for ICE candidates
            _listenCandidates(targetUid);

        } catch (e) {
            console.error('[Call] Start failed:', e);
            _showToast('فشل بدء المكالمة: ' + e.message, 'error');
            endCall();
        }
    }

    // ── Answer a call (callee side) ────────────────
    async function answerCall(callerUid, offerSdp, video) {
        if (_isActive) return;
        _targetUid = callerUid;
        _isActive  = true;
        _showCallUI('connected', video);

        try {
            _localStream = await navigator.mediaDevices.getUserMedia({
                audio: true,
                video: video ? { width: 640, height: 480 } : false
            });

            _showLocalVideo();
            _createPC();
            _localStream.getTracks().forEach(t => _pc.addTrack(t, _localStream));

            await _pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: offerSdp }));
            const answer = await _pc.createAnswer();
            await _pc.setLocalDescription(answer);

            // Send answer back
            await FB.sendSignal(callerUid, {
                type: 'answer',
                from: _myUid,
                sdp:  answer.sdp,
                time: Date.now()
            });

            // Listen for end signal
            _signalUnsub = FB.listenSignaling(_myUid, (data) => {
                if (data && data.type === 'end') endCall();
            });

            _listenCandidates(callerUid);

        } catch (e) {
            console.error('[Call] Answer failed:', e);
            _showToast('فشل الرد: ' + e.message, 'error');
            endCall();
        }
    }

    // ── End call ───────────────────────────────────
    async function endCall() {
        if (_pc) { _pc.close(); _pc = null; }
        if (_localStream) { _localStream.getTracks().forEach(t => t.stop()); _localStream = null; }
        _remoteStream = null;
        if (_signalUnsub) { _signalUnsub(); _signalUnsub = null; }
        if (_candidateRef) {
            try { FB.getDb().ref(_candidateRef).off(); } catch (_) {}
            _candidateRef = null;
        }

        // Signal end to other party
        if (_targetUid && FB.isOk()) {
            try { await FB.sendSignal(_targetUid, { type: 'end', from: _myUid, time: Date.now() }); } catch (_) {}
        }
        // Clear own signal
        if (_myUid && FB.isOk()) {
            try { await FB.clearSignal(_myUid); } catch (_) {}
        }

        _isActive  = false;
        _targetUid = null;
        _hideCallUI();
    }

    // ── Create PeerConnection ──────────────────────
    function _createPC() {
        _pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

        _pc.onicecandidate = (e) => {
            if (e.candidate && _targetUid && FB.isOk()) {
                FB.getDb().ref(`shaker/calls/${_targetUid}/candidates`).push({
                    candidate: e.candidate.candidate,
                    sdpMid: e.candidate.sdpMid,
                    sdpMLineIndex: e.candidate.sdpMLineIndex
                }).catch(() => {});
            }
        };

        _pc.ontrack = (e) => {
            _remoteStream = e.streams[0];
            const remoteVideo = document.getElementById('call-remote-video');
            if (remoteVideo && _remoteStream) {
                remoteVideo.srcObject = _remoteStream;
            }
        };

        _pc.onconnectionstatechange = () => {
            if (_pc && (_pc.connectionState === 'disconnected' || _pc.connectionState === 'failed')) {
                endCall();
            }
        };
    }

    // ── Listen for ICE candidates ──────────────────
    function _listenCandidates(fromUid) {
        const path = `shaker/calls/${_myUid}/candidates`;
        _candidateRef = path;
        FB.getDb().ref(path).on('child_added', snap => {
            if (!_pc || !snap.exists()) return;
            const c = snap.val();
            try {
                _pc.addIceCandidate(new RTCIceCandidate({
                    candidate: c.candidate,
                    sdpMid: c.sdpMid,
                    sdpMLineIndex: c.sdpMLineIndex
                }));
            } catch (_) {}
        });
    }

    // ── Listen for incoming calls ──────────────────
    function _listenForIncoming() {
        if (!_myUid || !FB.isOk()) return;
        FB.listenSignaling(_myUid, (data) => {
            if (!data || _isActive) return;
            if (data.type === 'offer' && data.from) {
                _showIncomingCallUI(data.from, data.video || false, data.sdp);
            }
        });
    }

    // ── UI: Show incoming call notification ────────
    function _showIncomingCallUI(callerUid, video, offerSdp) {
        // Remove existing
        document.getElementById('incoming-call-modal')?.remove();

        const html = `<div id="incoming-call-modal" class="fixed inset-0 bg-black bg-opacity-70 z-[9999] flex items-center justify-center p-4" style="backdrop-filter:blur(4px)">
            <div class="bg-white dark:bg-gray-800 rounded-2xl p-8 text-center max-w-sm w-full shadow-2xl animate-pulse">
                <div class="w-20 h-20 mx-auto rounded-full bg-gradient-to-br from-green-400 to-green-600 flex items-center justify-center mb-4">
                    <i class="fas ${video ? 'fa-video' : 'fa-phone-alt'} text-white text-3xl"></i>
                </div>
                <h3 class="text-xl font-bold mb-2">${video ? 'مكالمة فيديو' : 'مكالمة صوتية'}</h3>
                <p class="text-gray-500 mb-6">مكالمة واردة...</p>
                <div class="flex justify-center gap-4">
                    <button onclick="ShakerCall.answerCall('${callerUid}',\`${btoa(offerSdp)}\`,${video}); document.getElementById('incoming-call-modal')?.remove();"
                        class="w-14 h-14 rounded-full bg-green-500 hover:bg-green-600 text-white flex items-center justify-center shadow-lg transition">
                        <i class="fas fa-phone text-xl"></i>
                    </button>
                    <button onclick="ShakerCall.rejectCall('${callerUid}'); document.getElementById('incoming-call-modal')?.remove();"
                        class="w-14 h-14 rounded-full bg-red-500 hover:bg-red-600 text-white flex items-center justify-center shadow-lg transition">
                        <i class="fas fa-phone-slash text-xl"></i>
                    </button>
                </div>
            </div>
        </div>`;
        document.body.insertAdjacentHTML('beforeend', html);
    }

    // ── Answer from incoming UI (sdp is base64) ────
    // Overloaded: when called from UI, sdp comes as base64
    const _origAnswerCall = answerCall;
    answerCall = async function(callerUid, sdpOrBase64, video) {
        let sdp = sdpOrBase64;
        try { sdp = atob(sdpOrBase64); } catch (_) { /* already plain */ }
        return _origAnswerCall(callerUid, sdp, video);
    };

    // ── Reject incoming call ───────────────────────
    async function rejectCall(callerUid) {
        if (FB.isOk()) {
            try { await FB.sendSignal(callerUid, { type: 'end', from: _myUid, time: Date.now() }); } catch (_) {}
            try { await FB.clearSignal(_myUid); } catch (_) {}
        }
    }

    // ── Show call UI overlay ───────────────────────
    function _showCallUI(state, video) {
        document.getElementById('call-overlay')?.remove();

        const html = `<div id="call-overlay" class="fixed inset-0 bg-gray-900 bg-opacity-95 z-[9998] flex flex-col items-center justify-center p-4">
            <div class="text-center mb-6">
                <div class="text-white text-lg font-bold mb-1">${state === 'calling' ? 'جارٍ الاتصال...' : 'مكالمة جارية'}</div>
                <div class="text-gray-400 text-sm" id="call-timer">00:00</div>
            </div>
            ${video ? `
            <div class="relative w-full max-w-2xl aspect-video bg-black rounded-xl overflow-hidden mb-6">
                <video id="call-remote-video" autoplay playsinline class="w-full h-full object-cover"></video>
                <video id="call-local-video" autoplay playsinline muted class="absolute bottom-3 right-3 w-32 h-24 rounded-lg border-2 border-white shadow-lg object-cover"></video>
            </div>` : `
            <div class="w-24 h-24 rounded-full bg-gradient-to-br from-amber-500 to-amber-700 flex items-center justify-center mb-6">
                <i class="fas fa-phone-alt text-white text-3xl ${state === 'calling' ? 'animate-pulse' : ''}"></i>
            </div>`}
            <div class="flex gap-4">
                <button onclick="ShakerCall.toggleMute()" id="call-mute-btn" class="w-14 h-14 rounded-full bg-gray-700 hover:bg-gray-600 text-white flex items-center justify-center transition">
                    <i class="fas fa-microphone"></i>
                </button>
                <button onclick="ShakerCall.endCall()" class="w-16 h-16 rounded-full bg-red-500 hover:bg-red-600 text-white flex items-center justify-center shadow-lg transition">
                    <i class="fas fa-phone-slash text-xl"></i>
                </button>
                ${video ? `<button onclick="ShakerCall.toggleCamera()" id="call-camera-btn" class="w-14 h-14 rounded-full bg-gray-700 hover:bg-gray-600 text-white flex items-center justify-center transition">
                    <i class="fas fa-video"></i>
                </button>` : ''}
            </div>
        </div>`;
        document.body.insertAdjacentHTML('beforeend', html);

        // Start timer if connected
        if (state === 'connected') _startTimer();
    }

    function _hideCallUI() {
        document.getElementById('call-overlay')?.remove();
        document.getElementById('incoming-call-modal')?.remove();
        _stopTimer();
    }

    function _showLocalVideo() {
        const localVideo = document.getElementById('call-local-video');
        if (localVideo && _localStream) localVideo.srcObject = _localStream;
    }

    // ── Toggle mute ────────────────────────────────
    function toggleMute() {
        if (!_localStream) return;
        const audioTrack = _localStream.getAudioTracks()[0];
        if (audioTrack) {
            audioTrack.enabled = !audioTrack.enabled;
            const btn = document.getElementById('call-mute-btn');
            if (btn) btn.innerHTML = `<i class="fas fa-microphone${audioTrack.enabled ? '' : '-slash'}"></i>`;
        }
    }

    // ── Toggle camera ──────────────────────────────
    function toggleCamera() {
        if (!_localStream) return;
        const videoTrack = _localStream.getVideoTracks()[0];
        if (videoTrack) {
            videoTrack.enabled = !videoTrack.enabled;
            const btn = document.getElementById('call-camera-btn');
            if (btn) btn.innerHTML = `<i class="fas fa-video${videoTrack.enabled ? '' : '-slash'}"></i>`;
        }
    }

    // ── Call timer ──────────────────────────────────
    let _timerInterval = null;
    let _timerSeconds  = 0;

    function _startTimer() {
        _timerSeconds = 0;
        _timerInterval = setInterval(() => {
            _timerSeconds++;
            const el = document.getElementById('call-timer');
            if (el) {
                const m = String(Math.floor(_timerSeconds / 60)).padStart(2, '0');
                const s = String(_timerSeconds % 60).padStart(2, '0');
                el.textContent = `${m}:${s}`;
            }
        }, 1000);
    }

    function _stopTimer() {
        if (_timerInterval) { clearInterval(_timerInterval); _timerInterval = null; }
        _timerSeconds = 0;
    }

    function _showToast(msg, type) {
        if (typeof Toast !== 'undefined') Toast.show(msg, type);
    }

    return {
        init, startCall, answerCall, endCall, rejectCall,
        toggleMute, toggleCamera
    };
})();
