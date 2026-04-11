/**
 * ui.js — SHAKER v12
 * ═══════════════════
 * Unchanged from v11 — no security issues in UI helpers.
 * Throttle keys remain page-scoped to prevent cross-page collision.
 */

// ══════════════════════════════════
// XSS SANITIZER
// ══════════════════════════════════
const Sanitize = {
    html(str) {
        if (str === null || str === undefined) return '';
        return String(str).replace(/[&<>"'`]/g, c => ({
            '&':'&amp;', '<':'&lt;', '>':'&gt;',
            '"':'&quot;', "'":"&#39;", '`':'&#96;'
        }[c]));
    },
    text(str) {
        if (!str) return '';
        const d = document.createElement('div');
        d.textContent = String(str);
        return d.innerHTML;
    },
    obj(data) {
        if (!data || typeof data !== 'object') return data;
        const out = {};
        Object.entries(data).forEach(([k, v]) => {
            out[k] = typeof v === 'string' ? Sanitize.html(v) : v;
        });
        return out;
    }
};

// ══════════════════════════════════
// TOAST — uses textContent (XSS-safe)
// ══════════════════════════════════
const Toast = {
    show(msg, type = 'success', duration = 3500) {
        const cfg = {
            success: { bg:'#16a34a', icon:'fa-check-circle' },
            error:   { bg:'#dc2626', icon:'fa-times-circle' },
            warning: { bg:'#d97706', icon:'fa-exclamation-triangle' },
            info:    { bg:'#2563eb', icon:'fa-info-circle' },
        };
        const { bg, icon } = cfg[type] || cfg.info;
        const container = document.getElementById('toast-container');
        if (!container) return;
        const el    = document.createElement('div');
        el.className = 'toast';
        el.style.cssText = `background:${bg};padding:.75rem 1.25rem;border-radius:.5rem;color:#fff;font-size:.9rem;box-shadow:0 4px 12px rgba(0,0,0,.2);display:flex;align-items:center;gap:.6rem;max-width:340px;animation:slideInLeft .3s ease;font-family:Tajawal,sans-serif;`;
        const ico  = document.createElement('i');
        ico.className  = `fas ${icon}`;
        ico.style.flexShrink = '0';
        const span = document.createElement('span');
        span.textContent = msg; // XSS-safe
        el.appendChild(ico);
        el.appendChild(span);
        container.appendChild(el);
        setTimeout(() => {
            el.style.transition = 'opacity .3s, transform .3s';
            el.style.opacity    = '0';
            el.style.transform  = 'translateX(-20px)';
            setTimeout(() => el.remove(), 300);
        }, duration);
    }
};

// ══════════════════════════════════
// LOADING OVERLAY
// ══════════════════════════════════
const Loading = {
    show(msg = 'جارٍ التحميل...') {
        let el = document.getElementById('_shaker_loading');
        if (!el) {
            el = document.createElement('div');
            el.id = '_shaker_loading';
            el.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:99998;display:flex;align-items:center;justify-content:center;font-family:Tajawal,sans-serif;';
            const inner = document.createElement('div');
            inner.style.cssText = 'background:#1f2937;color:#fff;padding:1.5rem 2rem;border-radius:1rem;display:flex;align-items:center;gap:1rem;min-width:200px;';
            inner.innerHTML = `<svg style="width:1.5rem;height:1.5rem;flex-shrink:0;animation:_sp 1s linear infinite" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="#4b5563" stroke-width="3"/><path d="M12 2a10 10 0 0 1 10 10" stroke="#6366f1" stroke-width="3" stroke-linecap="round"/></svg>`;
            const msgEl = document.createElement('span');
            msgEl.id = '_shaker_loading_msg';
            msgEl.textContent = msg;
            inner.appendChild(msgEl);
            el.appendChild(inner);
            const s = document.createElement('style');
            s.textContent = '@keyframes _sp{to{transform:rotate(360deg)}}';
            el.appendChild(s);
            document.body.appendChild(el);
        } else {
            const m = document.getElementById('_shaker_loading_msg');
            if (m) m.textContent = msg;
            el.style.display = 'flex';
        }
    },
    hide() {
        const el = document.getElementById('_shaker_loading');
        if (el) el.style.display = 'none';
    }
};

// ══════════════════════════════════
// UTILS
// ══════════════════════════════════
const Utils = {
    generateId: () => Date.now().toString(36) + Math.random().toString(36).substr(2, 6),
    formatCurrency: n => new Intl.NumberFormat('ar-EG', { style:'currency', currency:'EGP' }).format(n || 0),
    formatDate:     ts => new Date(ts).toLocaleDateString('ar-EG'),
    startOfDay:     d  => { const x = new Date(d); x.setHours(0,0,0,0); return x.getTime(); },
    endOfDay:       d  => { const x = new Date(d); x.setHours(23,59,59,999); return x.getTime(); },
    debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
};

// ══════════════════════════════════
// CLOUDINARY
// ══════════════════════════════════
const Cloudinary = {
    cloudName:    'dazgb5uem',
    uploadPreset: 'shaker_upload',
    FALLBACK:     'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><rect width="200" height="200" fill="%23e5e7eb"/><text x="50%25" y="50%25" dominant-baseline="middle" text-anchor="middle" font-size="13" fill="%236b7280">لا توجد صورة</text></svg>',

    async upload(file, onProgress) {
        if (!file) throw new Error('لم يتم اختيار ملف');
        if (file.size > 10 * 1024 * 1024) throw new Error('حجم الصورة أكبر من 10MB');
        if (!file.type.startsWith('image/')) throw new Error('الملف ليس صورة');
        const fd = new FormData();
        fd.append('file', file);
        fd.append('upload_preset', this.uploadPreset);
        fd.append('folder', 'shaker_products');
        return new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            xhr.open('POST', `https://api.cloudinary.com/v1_1/${this.cloudName}/image/upload`);
            xhr.upload.onprogress = e => { if (onProgress && e.lengthComputable) onProgress(Math.round(e.loaded/e.total*100)); };
            xhr.onload = () => {
                try {
                    const res = JSON.parse(xhr.responseText);
                    if (res.secure_url) resolve(res.secure_url);
                    else reject(new Error(res.error?.message || 'فشل رفع الصورة'));
                } catch (e) { reject(new Error('خطأ في قراءة استجابة Cloudinary')); }
            };
            xhr.onerror   = () => reject(new Error('خطأ في الشبكة'));
            xhr.ontimeout = () => reject(new Error('انتهت مدة الاتصال'));
            xhr.timeout   = 60000;
            xhr.send(fd);
        });
    },

    img(src, alt = '', cls = '') {
        const s = Sanitize.html(src || this.FALLBACK);
        return `<img src="${s}" alt="${Sanitize.html(alt)}" class="${Sanitize.html(cls)}" loading="lazy" onerror="this.src='${this.FALLBACK}';this.onerror=null;">`;
    }
};

// ══════════════════════════════════
// THROTTLE — FIX L1: page-scoped keys
// ══════════════════════════════════
const Throttle = {
    MAX:          5,
    BASE_LOCK_MS: 30 * 1000,
    MAX_LOCK_MS:  10 * 60 * 1000,

    // FIX L1: include page path in key to isolate per-page throttle state
    _key(base) {
        const page = window.location.pathname.split('/').pop() || 'index';
        return `_t_${page}_${base}`;
    },

    check(base) {
        const key     = this._key(base);
        const banUntil = parseInt(localStorage.getItem(`${key}_ban`) || '0');
        if (banUntil && Date.now() < banUntil) {
            const s = Math.ceil((banUntil - Date.now()) / 1000);
            const m = s > 60 ? `${Math.ceil(s/60)} دقائق` : `${s} ثانية`;
            Toast.show(`محاولات كثيرة — محظور لـ ${m}`, 'error');
            return false;
        }
        return true;
    },

    record(base) {
        const key = this._key(base);
        const n   = parseInt(localStorage.getItem(`${key}_n`) || '0') + 1;
        localStorage.setItem(`${key}_n`, n);
        if (n >= this.MAX) {
            const banCount = parseInt(localStorage.getItem(`${key}_bans`) || '0') + 1;
            localStorage.setItem(`${key}_bans`, banCount);
            const lockMs = Math.min(this.BASE_LOCK_MS * Math.pow(2, banCount - 1), this.MAX_LOCK_MS);
            localStorage.setItem(`${key}_ban`, Date.now() + lockMs);
            localStorage.removeItem(`${key}_n`);
        }
    },

    clear(base) {
        const key = this._key(base);
        ['_n','_ban','_bans'].forEach(s => localStorage.removeItem(`${key}${s}`));
    }
};