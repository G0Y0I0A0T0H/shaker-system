╔══════════════════════════════════════════════════════════╗
║        SHAKER v12 — نظام إدارة المبيعات (Hardened)       ║
╚══════════════════════════════════════════════════════════╝

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🔒 SECURITY FIXES IN v12 (must-read)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

🚨 [CRITICAL] Admin auto-creation backdoor removed.
   In v11, any signed-in Firebase Auth user whose DB profile was missing
   was silently assigned role='admin' in three places:
     - js/firebase.js  onAuthChange
     - index.html      inline auth guard (~line 2815)
     - js/auth.js      loginAdmin profile upsert
   Combined with Firebase Auth's default self-signup, this meant anyone
   who could create an account became admin. All three paths now FAIL
   CLOSED: missing profile / missing role / DB error → sign out +
   redirect to login.

🔐 Moderator.html 1-hour sessionStorage bypass removed.
   v11 allowed a fresh sessionStorage record to grant access without
   Firebase Auth for up to 1 hour. Gone. Auth.guardPage is the only path.

🧑‍✈️ Order ownership is now strictly moderatorUid === auth.uid.
   Legacy username-based (`moderatorName === CURRENT_USER.username`)
   fallbacks in Moderator.html removed — they allowed UID spoofing if
   two mods had the same display name.

💬 Chat is now UID-only, both client-side and in the rules.
   - AdminChat.open() refuses to proceed if it can't resolve a UID from
     the moderators list (no fallback to usernameOrUid).
   - AdminChat.deleteConversation() resolves to UID before deleting.
   - Firebase rules pin shaker/chats/$modUid reads to auth.uid === $modUid
     or admin, and writes are append-only for the moderator.

🛡️ Firebase Rules tightened across the board:
   - inventory/products/marketers/shipping writes: admin only, active:true
   - orders: admin full; moderators can only create (newData.moderatorUid
     === auth.uid) and update orders they own (data.moderatorUid ===
     auth.uid). Ownership cannot be transferred in an update.
   - users: admin only
   - chats: $modUid scoped, append-only for mods
   - logs: append-only, per-uid; only admins can read
   - Every rule now additionally requires active === true

🌐 CSP tightened:
   - login.html / Moderator_login.html / setup-admin.html:
     Dropped 'unsafe-eval' entirely. connect-src locked to Firebase
     endpoints only (no more 'self' https: wss:).
   - index.html / Moderator.html:
     connect-src locked to Firebase + Cloudinary. object-src/frame-src
     disabled, base-uri pinned. 'unsafe-inline'+'unsafe-eval' in script-src
     are still required (see note below). Tightening the rest still
     drastically reduces the attack surface.

   ⚠️ CSP note — 'unsafe-inline' and 'unsafe-eval' on admin/mod pages:
   These two directives are still present ONLY on index.html and
   Moderator.html because:
     1. Both pages contain hundreds of onclick=/onchange= handlers
        throughout the UI. Removing 'unsafe-inline' would require
        rewriting every handler to addEventListener (weeks of work,
        user said "DO NOT break UI").
     2. Both pages load Tailwind via the JIT CDN, which uses eval().
        Removing 'unsafe-eval' requires replacing the CDN with a
        pre-built Tailwind stylesheet.
   To fully eliminate both: build a static tailwind.css with `npx
   tailwindcss -o tailwind.css --minify`, replace the CDN with it, and
   then externalise the inline onclick handlers. The login pages have
   already been migrated to addEventListener as a reference pattern.

🌍 Server CORS now supports production deployments:
   - SHAKER_ORIGINS="https://a.example.com,https://b.example.com"
     → explicit allow-list of extra origins
   - SHAKER_ALLOW_GITHUB_PAGES=1
     → wildcard allow for *.github.io
   - localhost origins still allowed by default for dev
   - file:// (origin "null") always blocked
   - HSTS added

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🚀 First-time setup
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

1. Firebase Console → Authentication → Sign-in method
      - Enable Email/Password
      - ⚠️ MUST DO: open "User actions" and DISABLE "Enable create
        (sign-up)" — otherwise anyone can self-register a Firebase Auth
        account. The DB rules still block them from becoming admin, but
        it's cleaner to prevent the Auth account existing at all.

2. Firebase Console → Realtime Database → Rules
      Temporarily paste this permissive rule (for step 3 only):
        { "rules": { ".write": true, ".read": "auth != null" } }

3. Open setup-admin.html in a browser
      - Create your admin (email + ≥6 char password + display name)
      - DELETE setup-admin.html from the server immediately afterwards
      - (The setup_done flag in the DB also blocks re-use even if the
        file is left behind.)

4. Apply the production rules
      Paste config/firebase-rules.json into Firebase Console → Rules →
      Publish.

5. Open login.html and sign in as admin. ✅

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
👥 Adding a moderator
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

1. Sign in as admin → "إدارة المشرفين" → "إضافة مشرف"
2. Username: 3-30 chars, lowercase English + digits + underscore
3. Password: ≥6 chars
4. The system creates:
     - Firebase Auth account: {username}@shaker.mod
     - DB profile: shaker/users/{uid} { role:'moderator', active:true }
5. Moderator signs in at Moderator_login.html with username + password.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🖥️ Running the backup server
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

cd server
npm install

# Dev (localhost only):
SHAKER_TOKEN=your_secret_at_least_8_chars node server.js

# Production with GitHub Pages:
SHAKER_TOKEN=your_secret \
SHAKER_ALLOW_GITHUB_PAGES=1 \
SHAKER_ORIGINS="https://your-custom-domain.com" \
node server.js

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📁 Project structure
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

shaker-system/
├── index.html              (admin dashboard — patched)
├── login.html              (admin login — rewritten)
├── Moderator.html          (moderator dashboard — patched)
├── Moderator_login.html    (moderator login — rewritten)
├── setup-admin.html        (one-time admin creation)
├── js/
│   ├── firebase.js         (v12 — backdoor removed)
│   ├── auth.js             (v12 — fail-closed)
│   ├── store.js            (v12 — cache wiped on upgrade)
│   └── ui.js               (v12 — no security changes)
├── server/
│   └── server.js           (v12 — GitHub Pages CORS)
├── config/
│   └── firebase-rules.json (v12 — strict)
└── README.txt              (this file)