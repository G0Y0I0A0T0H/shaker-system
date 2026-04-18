// ===== FILE: js/ui.js =====
// UI Module — Toast, Sanitize, Utils, Loading, CLOUDINARY
'use strict';

// ── Toast Notifications ──────────────────────────
const Toast = {
    show(message, type = 'info', duration = 3000) {
        const container = document.getElementById('toast-container');
        if (!container) return;

        const colors = {
            success: 'background:#059669',
            error: 'background:#dc2626',
            info: 'background:#2563eb',
            warning: 'background:#d97706'
        };

        const toast = document.createElement('div');
        toast.className = 'toast';
        toast.style.cssText = (colors[type] || colors.info) + ';padding:0.75rem 1.25rem;border-radius:0.5rem;color:white;font-size:0.9rem;box-shadow:0 4px 12px rgba(0,0,0,0.15);animation:slideInLeft 0.3s ease;max-width:320px;direction:rtl';
        toast.innerHTML = message;

        container.appendChild(toast);

        setTimeout(() => {
            toast.style.opacity = '0';
            toast.style.transition = 'opacity 0.3s ease';
            setTimeout(() => toast.remove(), 300);
        }, duration);
    }
};

// ── Sanitize ─────────────────────────────────────
const Sanitize = {
    html(str) {
        if (str === null || str === undefined) return '';
        const s = String(str);
        const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#x27;' };
        return s.replace(/[&<>"']/g, c => map[c]);
    },
    attr(str) {
        return Sanitize.html(str);
    }
};

// ── Utils ────────────────────────────────────────
const Utils = {
    formatCurrency(amount) {
        if (isNaN(amount)) return '0 ج.م';
        return new Intl.NumberFormat('ar-EG').format(Math.round(amount)) + ' ج.م';
    },
    formatDate(timestamp) {
        if (!timestamp) return '-';
        const d = new Date(timestamp);
        if (isNaN(d.getTime())) return '-';
        return d.toLocaleDateString('ar-EG', { year: 'numeric', month: 'short', day: 'numeric' });
    },
    startOfDay(date) {
        const d = new Date(date);
        d.setHours(0, 0, 0, 0);
        return d.getTime();
    },
    endOfDay(date) {
        const d = new Date(date);
        d.setHours(23, 59, 59, 999);
        return d.getTime();
    }
};

// ── Loading Overlay ──────────────────────────────
const Loading = {
    show(message = 'جارٍ التحميل...') {
        let overlay = document.getElementById('loading-overlay');
        if (!overlay) {
            overlay = document.createElement('div');
            overlay.id = 'loading-overlay';
            overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:99999;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:1rem';
            document.body.appendChild(overlay);
        }
        overlay.innerHTML = `
            <div style="color:white;text-align:center">
                <i class="fas fa-spinner fa-spin" style="font-size:2rem;margin-bottom:0.5rem;display:block"></i>
                <span style="font-size:1rem">${Sanitize.html(message)}</span>
            </div>`;
        overlay.style.display = 'flex';
    },
    hide() {
        const overlay = document.getElementById('loading-overlay');
        if (overlay) overlay.style.display = 'none';
    }
};

// ── Cloudinary Upload ────────────────────────────
const CLOUDINARY = {
    CLOUD_NAME: 'drkjd5fhh',
    UPLOAD_PRESET: 'shaker_unsigned',
    async upload(file, progressCallback) {
        const formData = new FormData();
        formData.append('file', file);
        formData.append('upload_preset', this.UPLOAD_PRESET);

        return new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            xhr.open('POST', `https://api.cloudinary.com/v1_1/${this.CLOUD_NAME}/image/upload`);

            xhr.upload.onprogress = (e) => {
                if (e.lengthComputable && progressCallback) {
                    progressCallback(Math.round((e.loaded / e.total) * 100));
                }
            };

            xhr.onload = () => {
                if (xhr.status === 200) {
                    const result = JSON.parse(xhr.responseText);
                    resolve(result.secure_url);
                } else {
                    reject(new Error('Upload failed: ' + xhr.status));
                }
            };

            xhr.onerror = () => reject(new Error('Network error'));
            xhr.send(formData);
        });
    }
};