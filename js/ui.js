/**
 * ui.js — SHAKER v14
 * Idempotent, no duplicate declarations, no Throttle conflict
 */
if (typeof window._shakerUiLoaded === 'undefined') {
window._shakerUiLoaded = true;

window.Sanitize = {
    html(str) {
        if (str === null || str === undefined) return '';
        return String(str).replace(/[&<>"'`]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":"&#39;",'`':'&#96;'}[c]));
    },
    text(str) { if (!str) return ''; const d = document.createElement('div'); d.textContent = String(str); return d.innerHTML; },
    obj(data) {
        if (!data || typeof data !== 'object') return data;
        const out = {};
        Object.entries(data).forEach(([k,v]) => { out[k] = typeof v === 'string' ? window.Sanitize.html(v) : v; });
        return out;
    }
};

window.Toast = {
    show(msg, type='success', duration=3500) {
        const cfg = { success:{bg:'#16a34a',icon:'fa-check-circle'}, error:{bg:'#dc2626',icon:'fa-times-circle'}, warning:{bg:'#d97706',icon:'fa-exclamation-triangle'}, info:{bg:'#2563eb',icon:'fa-info-circle'} };
        const {bg,icon} = cfg[type]||cfg.info;
        const container = document.getElementById('toast-container');
        if (!container) return;
        const el = document.createElement('div');
        el.className='toast';
        el.style.cssText='background:'+bg+';padding:.75rem 1.25rem;border-radius:.5rem;color:#fff;font-size:.9rem;box-shadow:0 4px 12px rgba(0,0,0,.2);display:flex;align-items:center;gap:.6rem;max-width:340px;animation:slideInLeft .3s ease;font-family:Tajawal,sans-serif;';
        const ico=document.createElement('i'); ico.className='fas '+icon; ico.style.flexShrink='0';
        const span=document.createElement('span'); span.textContent=msg;
        el.appendChild(ico); el.appendChild(span); container.appendChild(el);
        setTimeout(()=>{ el.style.transition='opacity .3s,transform .3s'; el.style.opacity='0'; el.style.transform='translateX(-20px)'; setTimeout(()=>el.remove(),300); },duration);
    }
};

window.Loading = {
    show(msg='جارٍ التحميل...') {
        let el = document.getElementById('_shaker_loading');
        if (!el) {
            el = document.createElement('div'); el.id='_shaker_loading';
            el.style.cssText='position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:99998;display:flex;align-items:center;justify-content:center;font-family:Tajawal,sans-serif;';
            const inner = document.createElement('div');
            inner.style.cssText='background:#1f2937;color:#fff;padding:1.5rem 2rem;border-radius:1rem;display:flex;align-items:center;gap:1rem;min-width:200px;';
            inner.innerHTML='<svg style="width:1.5rem;height:1.5rem;flex-shrink:0;animation:_sp 1s linear infinite" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="#4b5563" stroke-width="3"/><path d="M12 2a10 10 0 0 1 10 10" stroke="#6366f1" stroke-width="3" stroke-linecap="round"/></svg>';
            const msgEl = document.createElement('span'); msgEl.id='_shaker_loading_msg'; msgEl.textContent=msg;
            inner.appendChild(msgEl); el.appendChild(inner);
            const s = document.createElement('style'); s.textContent='@keyframes _sp{to{transform:rotate(360deg)}}';
            el.appendChild(s); document.body.appendChild(el);
        } else { const m=document.getElementById('_shaker_loading_msg'); if(m)m.textContent=msg; el.style.display='flex'; }
    },
    hide() { const el=document.getElementById('_shaker_loading'); if(el) el.style.display='none'; }
};

window.Utils = {
    generateId: () => Date.now().toString(36)+Math.random().toString(36).substr(2,6),
    formatCurrency: n => new Intl.NumberFormat('ar-EG',{style:'currency',currency:'EGP'}).format(n||0),
    formatDate: ts => new Date(ts).toLocaleDateString('ar-EG'),
    startOfDay: d => { const x=new Date(d); x.setHours(0,0,0,0); return x.getTime(); },
    endOfDay: d => { const x=new Date(d); x.setHours(23,59,59,999); return x.getTime(); },
    debounce(fn,ms) { let t; return (...a)=>{ clearTimeout(t); t=setTimeout(()=>fn(...a),ms); }; }
};

window.Cloudinary = {
    cloudName: 'dazgb5uem',
    uploadPreset: 'shaker_upload',
    FALLBACK: 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><rect width="200" height="200" fill="%23e5e7eb"/><text x="50%25" y="50%25" dominant-baseline="middle" text-anchor="middle" font-size="13" fill="%236b7280">لا توجد صورة</text></svg>',
    async upload(file, onProgress) {
        if (!file) throw new Error('لم يتم اختيار ملف');
        if (file.size > 10*1024*1024) throw new Error('حجم الصورة أكبر من 10MB');
        if (!file.type.startsWith('image/')) throw new Error('الملف ليس صورة');
        const fd = new FormData(); fd.append('file',file); fd.append('upload_preset',this.uploadPreset); fd.append('folder','shaker_products');
        return new Promise((resolve,reject)=>{
            const xhr = new XMLHttpRequest();
            xhr.open('POST','https://api.cloudinary.com/v1_1/'+this.cloudName+'/image/upload');
            xhr.upload.onprogress = e => { if(onProgress && e.lengthComputable) onProgress(Math.round(e.loaded/e.total*100)); };
            xhr.onload = () => { try { const r=JSON.parse(xhr.responseText); if(r.secure_url) resolve(r.secure_url); else reject(new Error(r.error?.message||'فشل رفع الصورة')); } catch(_){ reject(new Error('خطأ في استجابة Cloudinary')); } };
            xhr.onerror = () => reject(new Error('خطأ في الشبكة'));
            xhr.ontimeout = () => reject(new Error('انتهت مدة الاتصال'));
            xhr.timeout = 60000; xhr.send(fd);
        });
    },
    _isValidSrc(src) { return src && typeof src === 'string' && src.indexOf('${') === -1 && src !== 'undefined' && src !== 'null'; },
    img(src, alt='', cls='') {
        const s = this._isValidSrc(src) ? src : this.FALLBACK;
        return '<img src="'+window.Sanitize.html(s)+'" alt="'+window.Sanitize.html(alt)+'" class="'+window.Sanitize.html(cls)+'" loading="lazy" data-fallback="1">';
    }
};

// Uppercase alias for index.html compatibility
window.CLOUDINARY = window.Cloudinary;

// Throttle — only if auth.js didn't define it already
if (typeof window.Throttle === 'undefined') {
    window.Throttle = {
        MAX: 5, BASE_LOCK_MS: 30000, MAX_LOCK_MS: 600000,
        _key(base) { return '_t_'+(window.location.pathname.split('/').pop()||'index')+'_'+base; },
        check(base) {
            const k=this._key(base), b=parseInt(localStorage.getItem(k+'_ban')||'0');
            if(b&&Date.now()<b){ const s=Math.ceil((b-Date.now())/1000); window.Toast.show('محاولات كثيرة — محظور لـ '+(s>60?Math.ceil(s/60)+' دقائق':s+' ثانية'),'error'); return false; }
            return true;
        },
        record(base) {
            const k=this._key(base), n=parseInt(localStorage.getItem(k+'_n')||'0')+1;
            localStorage.setItem(k+'_n',n);
            if(n>=this.MAX){ const bc=parseInt(localStorage.getItem(k+'_bans')||'0')+1; localStorage.setItem(k+'_bans',bc);
            localStorage.setItem(k+'_ban',Date.now()+Math.min(this.BASE_LOCK_MS*Math.pow(2,bc-1),this.MAX_LOCK_MS)); localStorage.removeItem(k+'_n'); }
        },
        clear(base) { const k=this._key(base); ['_n','_ban','_bans'].forEach(s=>localStorage.removeItem(k+s)); }
    };
}

// Image 404 safety net
document.addEventListener('error', function(e) {
    const t = e.target;
    if (t && t.tagName === 'IMG') {
        if (!window.Cloudinary._isValidSrc(t.src) || t.dataset.fallback === '1') {
            t.onerror = null; t.dataset.fallback = 'done';
            if (t.src !== window.Cloudinary.FALLBACK) t.src = window.Cloudinary.FALLBACK;
            else t.style.display = 'none';
        }
    }
}, true);

// Hide Tailwind CDN warning
(function(){ const _w=console.warn; console.warn=function(){ if(typeof arguments[0]==='string'&&arguments[0].indexOf('cdn.tailwindcss.com')>-1)return; _w.apply(console,arguments); }; })();

// Backward-compat aliases
var Sanitize = window.Sanitize;
var Toast = window.Toast;
var Loading = window.Loading;
var Utils = window.Utils;
var Cloudinary = window.Cloudinary;
var Throttle = window.Throttle;

} // end idempotent guard