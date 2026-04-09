╔══════════════════════════════════════════════════════════╗
║              SHAKER — نظام إدارة المبيعات               ║
╚══════════════════════════════════════════════════════════╝

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🔑 المشاكل التي تم إصلاحها:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

✅ 1. تسجيل دخول المشرف يعمل 100%
   المشكلة الجذرية: النظام القديم كان يحفظ كلمة المرور في localStorage
   بشكل مختلف عن طريقة البحث (SHA-256 hash vs plaintext)
   الحل: استخدام Firebase Auth مباشرة (username@shaker.mod)

✅ 2. إنشاء المشرف من لوحة الأدمن يعمل بشكل صحيح
   - ModMgr.save() → Auth.addModerator() → Firebase Auth createUser
   - يستخدم Secondary Firebase App (الأدمن لا يتم تسجيل خروجه)
   - يحفظ profile في DB: shaker/users/{uid}

✅ 3. الشات مرتبط بـ UID (آمن ولا يمكن التلاعب به)
   - قبل: مفتاح username (قابل للانتحال)
   - بعد: مفتاح uid من Firebase Auth
   - Firebase Rules: كل مشرف يقرأ شاته فقط

✅ 4. Firebase Rules محدّثة وكاملة
   - inventory: admin فقط
   - orders: moderator يكتب طلباته فقط (بـ moderatorUid === auth.uid)
   - chats: $modUid مقيد بـ uid

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🚀 الإعداد (مرة واحدة):
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

1. Firebase Console → Authentication → Enable Email/Password
2. Rules مؤقتاً: { "rules": { ".write": true, ".read": "auth != null" } }
3. افتح setup-admin.html → أنشئ الأدمن → احذف الملف
4. طبّق config/firebase-rules.json في Firebase Console
5. افتح login.html ✅

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
👥 إضافة مشرف:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

1. سجّل دخول كأدمن → "إدارة المشرفين" → "إضافة مشرف"
2. أدخل اسم المستخدم (إنجليزي صغير) وكلمة المرور
3. ينشئ النظام: حساب Firebase Auth (username@shaker.mod) + profile في DB
4. المشرف يدخل من Moderator_login.html باسم المستخدم وكلمة المرور

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🖥️ تشغيل سيرفر النسخ الاحتياطي (اختياري):
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

cd server
npm install
SHAKER_TOKEN=your_secret node server.js
