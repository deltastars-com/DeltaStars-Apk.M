# 🌟 Delta Stars Store (نجوم دلتا)

متجر إلكتروني متعدد المنصات لبيع الخضروات والفواكه والتمور عالية الجودة في المملكة العربية السعودية.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Version](https://img.shields.io/badge/version-3.1.1-blue.svg)](https://github.com/deltastars/store)
[![Netlify](https://img.shields.io/badge/deployed-Netlify-00C7B7.svg)](https://app.netlify.com)

## 📱 المنصات

| المنصة | الحالة | الرابط |
|--------|--------|--------|
| 🌐 الويب (PWA) | ✅ مباشر | [deltastars.store](https://deltastars.store) |
| 🤖 أندرويد | ✅ متاح | [Google Play](#) |
| 🍎 iOS | ✅ متاح | [App Store](#) |

## 🛠️ حزمة التقنيات

### الواجهة الأمامية
- **React 19** - واجهة المستخدم
- **Vite** - بناء وتطوير سريع
- **TypeScript** - برمجة آمنة
- **Capacitor** - تحويل إلى تطبيقات أصلية

### الخادم والبنية التحتية
- **Netlify Functions** - دوال بدون خادم
- **Supabase** - قاعدة البيانات (PostgreSQL)
- **Firebase** - المصادقة والتحليلات

### خدمات الدفع والمصادقة
- **Moyasar** - بوابة الدفع السعودي
- **Authentica.sa** - إرسال وتحقق OTP

## 🚀 بدء المشروع

### المتطلبات
- Node.js >= 18.0.0
- npm أو yarn أو pnpm

### التثبيت
```bash
# استنساخ المستودع
git clone https://github.com/deltastars/store.git
cd store

# تثبيت الاعتماديات
npm install

# بدء خادم التطوير
npm run dev
```

### متغيرات البيئة
أنشئ ملف `.env` في جذر المشروع:
```env
# Supabase
VITE_SUPABASE_URL=your_supabase_url
VITE_SUPABASE_ANON_KEY=your_supabase_anon_key
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key

# Moyasar (Boabda الدفع)
MOYASAR_SECRET_KEY=your_moyasar_secret_key
MOYASAR_WEBHOOK_SECRET=your_webhook_secret

# Authentica (OTP)
AUTHENTICA_API_SECRET=your_authentica_secret

# Firebase
FIREBASE_PROJECT_ID=deltastars-firebase
```

## 📦 بناء التطبيقات

### بناء الويب
```bash
npm run build:web
```

### بناء أندرويد
```bash
npm run build:android
```

### بناء iOS
```bash
npm run build:ios
```

## 🔧 التطوير

### هيكل المشروع
```
deltastars-store/
├── 📱 تطبيق الويب
│   ├── index.html          # الصفحة الرئيسية
│   ├── assets/             # ملفات JS/CSS
│   └── manifest.json       # PWA Manifest
│
├── ⚡ Netlify Functions
│   ├── create-payment-intent.mjs  # إنشاء الدفع
│   ├── verify-payment.mjs         # تأكيد الدفع
│   ├── payment-webhook.mjs        # Webhook الدفع
│   ├── otp-send.mjs               # إرسال OTP
│   ├── otp-verify.mjs             # التحقق من OTP
│   └── contact-form.ts            # نموذج الاتصال
│
├── 📱 تطبيق Android
│   └── android/            # Capacitor Android
│
├── 🍎 تطبيق iOS
│   └── ios/                # Capacitor iOS
│
└── 📄 ملفات التكوين
    ├── netlify.toml        # إعدادات النشر
    ├── _headers            # ترويسات الأمان
    ├── _redirects          # توجيهات Netlify
    └── capacitor.config.ts # تكوين Capacitor
```

## 🔐 الأمان

- ✅ CSP (Content Security Policy) شامل
- ✅ HSTS مع تحميل مسبق
- ✅ Rate Limiting على جميع النقاط النهاية
- ✅ حماية Brute Force لـ OTP
- ✅ تنقية المدخلات
- ✅ CORS مشدد
- ✅ حظر مسارات الهجوم الشائعة
- ✅ Service Worker متقدم

## 📊 المميزات

### للمستخدمين
- 🛒 سلة تسوق ذكية
- 💳 دفع إلكتروني متعدد الطرق
- 📱 تتبع الطلب مباشرة
- 🤖 مساعد ذكي
- ⭐ تقييم المنتجات
- 🔐 تسجيل دخول بـ OTP

### للإدارة
- 📊 لوحة تحكم شاملة
- 📦 إدارة المنتجات
- 👥 إدارة العملاء
- 💰 تقارير المبيعات
- 🚗 إدارة السائقين

## 🚀 النشر

### Netlify
1. اربط المستودع بـ Netlify
2. أضف متغيرات البيئة في لوحة التحكم
3. سيعمل البناء تلقائياً

### الإعدادات المطلوبة في Netlify
```bash
# متغيرات البيئة
VITE_SUPABASE_URL
VITE_SUPABASE_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY
MOYASAR_SECRET_KEY
MOYASAR_WEBHOOK_SECRET
AUTHENTICA_API_SECRET
```

## 📝 الترخيص

هذا المشروع مرخص بموجب MIT License - راجع ملف [LICENSE](LICENSE) للتفاصيل.

## 📞 التواصل

- **الموقع الإلكتروني**: [deltastars.store](https://deltastars.store)
- **البريد الإلكتروني**: info@deltastars.store
- **الأمان**: security@deltastars.store

---

**نجوم دلتا** © 2026 - جميع الحقوق محفوظة 🌟
