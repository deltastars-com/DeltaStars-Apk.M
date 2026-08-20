// ══════════════════════════════════════════════════════════════
// Netlify Function: POST /api/ai-chat
// Secure server-side AI assistant "عدّي" for Delta Stars Store
// Moves the Gemini API key server-side and adds conversation
// context, product matching, and fast fallback responses.
// ══════════════════════════════════════════════════════════════

import { Redis } from '@upstash/redis';

// ── Configuration ──────────────────────────────────────────
const GEMINI_MODELS = ['gemini-2.0-flash', 'gemini-1.5-flash', 'gemini-1.5-flash-latest'];
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || process.env.VITE_GEMINI_API_KEY || '';
const GEMINI_TIMEOUT_MS = 12000; // 12s timeout for fast UX
const MAX_HISTORY_MESSAGES = 6;
const MAX_INPUT_LENGTH = 500;
const MAX_OUTPUT_TOKENS = 400;

// ── Store contact info ─────────────────────────────────────
const STORE_CONTACT = {
  phone: process.env.STORE_PHONE || '+966558828009',
  whatsapp: process.env.STORE_WHATSAPP || 'https://wa.me/966558828009',
  email: process.env.STORE_EMAIL || 'info@deltastars.store',
  address: process.env.STORE_ADDRESS || 'المملكة العربية السعودية',
};

// ── Rate limiting ──────────────────────────────────────────
let redis = null;
function getRedis() {
  if (redis) return redis;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  redis = new Redis({ url, token });
  return redis;
}

const memoryStore = new Map();

async function checkRateLimit(key, limit, windowMs) {
  const client = getRedis();
  const now = Date.now();
  const resetAt = now + windowMs;

  if (client) {
    try {
      const multi = client.multi();
      multi.incr(`ratelimit:${key}`);
      multi.pexpire(`ratelimit:${key}`, windowMs);
      multi.pttl(`ratelimit:${key}`);
      const results = await multi.exec();
      const count = results[0];
      const ttl = results[2];
      return { allowed: count <= limit, remaining: Math.max(0, limit - count), resetAt: ttl > 0 ? now + ttl : resetAt };
    } catch (e) {
      console.error('Redis error:', e);
    }
  }

  const entry = memoryStore.get(key);
  if (!entry || now > entry.resetAt) {
    memoryStore.set(key, { count: 1, resetAt });
    return { allowed: true, remaining: limit - 1, resetAt };
  }
  entry.count++;
  return { allowed: entry.count <= limit, remaining: Math.max(0, limit - entry.count), resetAt: entry.resetAt };
}

// ── JSON response helper ───────────────────────────────────
const securityHeaders = {
  'Content-Type': 'application/json; charset=utf-8',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Cache-Control': 'no-store, no-cache, must-revalidate',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const json = (status, obj) =>
  new Response(JSON.stringify(obj), { status, headers: securityHeaders });

// ── Input sanitization ─────────────────────────────────────
function sanitize(input) {
  return String(input || '').replace(/[<>]/g, '').trim().slice(0, MAX_INPUT_LENGTH);
}

// ══════════════════════════════════════════════════════════════
// 1. LOCAL KNOWLEDGE BASE — Instant responses (0 latency)
// ══════════════════════════════════════════════════════════════

/**
 * Match products from the provided catalog based on query keywords.
 * Uses weighted scoring: exact name match > category > description.
 */
function matchProducts(query, products) {
  if (!products || !products.length) return [];
  const keywords = query.toLowerCase().split(/\s+/).filter(w => w.length > 1);
  if (!keywords.length) return [];

  return products
    .map(p => {
      const nameAr = (p.name_ar || '').toLowerCase();
      const nameEn = (p.name_en || '').toLowerCase();
      const cat = (p.category || '').toLowerCase();
      const subcat = (p.sub_category || '').toLowerCase();
      const desc = `${p.description_ar || ''} ${p.description || ''}`.toLowerCase();
      let score = 0;
      for (const kw of keywords) {
        // Exact name match = highest score
        if (nameAr.includes(kw) || nameEn.includes(kw)) score += 3;
        // Category match
        else if (cat.includes(kw) || subcat.includes(kw)) score += 2;
        // Description match
        else if (desc.includes(kw)) score += 1;
      }
      return { product: p, score };
    })
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 6)
    .map(item => item.product);
}

/**
 * Format a product for display in the AI response
 */
function formatProduct(p) {
  const name = p.name_ar || p.name_en;
  const price = p.price && p.price > 0 ? `${p.price} ريال` : 'حسب السوق';
  const unit = p.unit_ar || p.unit || p.unit_en || '';
  const origin = p.origin ? ` — الأصل: ${p.origin}` : '';
  const stock = p.in_stock === false || p.stock_status === 'out_of_stock'
    ? '❌ غير متوفر حالياً'
    : '✅ متوفر';
  return `• ${name} — ${price}${unit ? ` / ${unit}` : ''}${origin} (${stock})`;
}

/**
 * Build a summary of ALL products for Gemini context (capped to avoid token overflow)
 */
function buildFullProductSummary(products) {
  if (!products || !products.length) return '';
  return products.slice(0, 40).map(p => {
    const name = p.name_ar || p.name_en;
    const price = p.price > 0 ? `${p.price} ريال` : 'حسب السوق';
    const unit = p.unit || p.unit_ar || '';
    const cat = p.category || '';
    return `${name} (${cat}) — ${price}${unit ? '/' + unit : ''}`;
  }).join(' | ');
}

/**
 * Local fast-path responses for common questions.
 * Returns a string response or null if no local match.
 */
function getLocalResponse(query, products) {
  const q = query.toLowerCase();
  const has = (...terms) => terms.some(t => q.includes(t));

  // ── Greetings ──
  if (has('سلام', 'مرحب', 'هلا', 'أهلا', 'هاي', 'صباح', 'مساء', 'hi', 'hello', 'هايي', 'السلام')) {
    return 'هلا والله! 🌟 أنا عدي، مساعد نجوم دلتا الذكي.\nاسألني عن أي منتج وسعره، التوصيل، طريقة الطلب، الدفع، أو أي شيء تبيه!';
  }

  // ── Minimum order ──
  if (has('حد ادنى', 'الحد الأدنى', 'اقل طلب', 'أقل طلب', 'minimum', 'أقل كمية', 'أدنى مبلغ')) {
    return 'الحد الأدنى لإتمام أي طلب هو 50 ريال فقط 🛒\nاجمع منتجاتك في السلة ثم أكمل خطوات الشراء بسهولة.';
  }

  // ── Delivery ──
  if (has('توصيل', 'الشحن', 'شحن', 'delivery', 'shipping', 'رسوم التوصيل', 'وصّل', 'يوصّل')) {
    return 'التوصيل مجاني للطلبات من 300 ريال فأكثر 🚚\nوللطلبات الأقل تُحسب رسوم التوصيل تلقائياً حسب بُعد موقعك عن أقرب فرع (تبدأ من 15 ريال) وتظهر لك قبل تأكيد الدفع.';
  }

  // ── Payment methods ──
  if (has('دفع', 'الدفع', 'بطاقة', 'مدى', 'فيزا', 'ماستر', 'apple pay', 'payment', 'pay', 'وسيلة الدفع', 'اشتري بالآجل')) {
    return 'الدفع آمن عبر بوابة ميسر (Moyasar) 💳\nطرق الدفع المتاحة:\n• مدى (Mada)\n• فيزا (Visa)\n• ماستركارد (Mastercard)\n• Apple Pay\n\nجميع الأسعار شاملة ضريبة القيمة المضافة 15%.';
  }

  // ── Cash on delivery ──
  if (has('الدفع عند الاستلام', 'كاش', 'نقدي', 'cash on delivery', 'cod')) {
    return 'الدفع عند الاستلام غير متاح حالياً 💳\nلكن الدفع الإلكتروني آمن وسريع عبر:\n• مدى • فيزا • ماستركارد • Apple Pay\n\nيمكنك الدفع في ثوانٍ من هاتفك!';
  }

  // ── Tax / VAT ──
  if (has('ضريبة', 'القيمة المضافة', 'vat', 'tax', 'ضريب')) {
    return 'جميع الأسعار المعروضة شاملة ضريبة القيمة المضافة 15% 🧾\nوتظهر مفصّلة في فاتورتك عند الدفع.';
  }

  // ── How to order ──
  if (has('كيف اطلب', 'طريقة الطلب', 'كيف أطلب', 'اشتري', 'أكمل الطلب', 'اطلب', 'أطلب', 'خطوات الطلب', 'شراء')) {
    return 'خطوات الطلب سهلة وسريعة:\n\n1️⃣ تصفّح المنتجات وأضفها للسلة 🛒\n2️⃣ افتح السلة وراجع طلبك\n3️⃣ أدخل بياناتك وموقع التوصيل\n4️⃣ اختر طريقة الدفع وأكمل الدفع بأمان\n\nالحد الأدنى 50 ريال فقط! ✅';
  }

  // ── Order tracking ──
  if (has('تتبع الطلب', 'وين طلبي', 'وين وصل', 'تتبع', 'status', 'حالة الطلب', 'متى يوصل', 'متى يصل')) {
    return 'تتبع طلبك بسهولة 📦\n• بعد تأكيد الطلب ستصلك رسالة واتساب بتفاصيل التتبع\n• يمكنك تتبع حالة الطلب من صفحة الطلبات في حسابك\n• للتواصل المباشر: ' + STORE_CONTACT.whatsapp;
  }

  // ── Cancel order ──
  if (has('الغاء الطلب', 'إلغاء الطلب', 'ألغِ', 'الغِ', 'cancel', 'cancel order')) {
    return 'يمكنك إلغاء الطلب خلال ساعة من التأكيد ⏰\n\nإذا كان الطلب قيد التجهيز:\n💬 تواصل معنا عبر الواتساب: ' + STORE_CONTACT.whatsapp + '\n\nسنقوم بالإلغاء واسترداد المبلغ خلال 3-5 أيام عمل.';
  }

  // ── Refund ──
  if (has('استرداد', 'money back', 'ارجاع فلوس')) {
    return 'سياسة استرداد المبلغ 💰\n✅ يُعاد المبلغ خلال 3-5 أيام عمل\n✅ عبر الطريقة الأصلية للدفع\n\nلطلب الاسترداد تواصل معنا:\n💬 واتساب: ' + STORE_CONTACT.whatsapp;
  }

  // ── Return / Exchange ──
  if (has('ارجاع', 'استرجاع', 'استبدال', 'مرتجع', 'return', 'refund', 'تبديل')) {
    return 'سياسة الإرجاع والاستبدال:\n✅ يمكنك استبدال أو إرجاع المنتج خلال 24 ساعة من الاستلام\n✅ يجب أن يكون المنتج في حالته الأصلية\n✅ المبلغ يُعاد خلال 3-5 أيام عمل\n\nللتواصل: ' + STORE_CONTACT.whatsapp;
  }

  // ── Contact info ──
  if (has('تواصل', 'رقم', 'جوال', 'هاتف', 'اتصال', 'ايميل', 'بريد', 'contact', 'phone', 'عنوان', 'وين', 'فرع', 'address', 'location', 'وتس اب', 'واتساب', 'رقم جوال')) {
    return `تقدر تتواصل معنا بسهولة:\n📞 هاتف: ${STORE_CONTACT.phone}\n💬 واتساب: ${STORE_CONTACT.whatsapp}\n✉️ بريد: ${STORE_CONTACT.email}\n📍 العنوان: ${STORE_CONTACT.address}`;
  }

  // ── Thanks ──
  if (has('شكرا', 'مشكور', 'يعطيك', 'تسلم', 'thanks', 'thank', 'الله يعطيك', 'العفو')) {
    return 'العفو! 🌟 أي خدمة ثانية أنا حاضر.\nنجوم دلتا دايم يهتمون بعملائهم!';
  }

  // ── Return policy ──
  if (has('سياسة', 'الشروط', 'terms', 'policy', 'الخصوصية')) {
    return 'سياسات المتجر:\n📦 الإرجاع خلال 24 ساعة\n🔒 الدفع آن ومؤمّن 100%\n🚚 توصيل مجاني من 300 ريال\n💳 الحد الأدنى 50 ريال\n\nللاستفسار: ' + STORE_CONTACT.whatsapp;
  }

  // ── Freshness / quality ──
  if (has('طازج', 'جودة', 'فريش', 'fresh', 'quality', 'addon')) {
    return 'نضمن جودة منتجاتنا! 🌿\n• جميع منتجاتنا طازجة يومياً من أفضل المزارع\n• نختار لك أجود أنواع الخضروات والفواكه والتمور\n• توصيل مبرد للحفاظ على طزاجة المنتجات\n\nجربنا وماراح تندم! ⭐';
  }

  // ── Working hours ──
  if (has('ساعات', 'مواعيد', 'من يفتح', 'متى يفتح', 'ساعات العمل', 'hours', 'مفتوح', 'مقفل')) {
    return 'مواعيد العمل: 🕐\n⏰ السبت - الخميس: 8 صباحاً - 10 مساءً\n⏰ الجمعة: 4 عصراً - 10 مساءً\n\nالطلبات متاحة على مدار الساعة عبر الموقع! 🛒';
  }

  // ── Wholesale / bulk ──
  if (has('جملة', 'wholesale', 'كمي', 'كميات', 'بالجملة', 'كبيّر')) {
    return 'أسعار الجملة متاحة للكميات الكبيرة! 🏪\n\nللحصول على عرض سعر خاص:\n💬 واتساب: ' + STORE_CONTACT.whatsapp + '\n📞 هاتف: ' + STORE_CONTACT.phone + '\n\nفريقنا جاهز لخدمتك!';
  }

  // ── Cart help ──
  if (has('سلة', 'السلة', 'cart', ' basket', 'أضف للسلة')) {
    return 'إضافة المنتجات للسلة سهلة 🛒\n\n1️⃣ اضغط على زر "+" بجانب المنتج\n2️⃣ اختر الكمية المطلوبة\n3️⃣ اضغط "أضف للسلة"\n4️⃣ تابع تسوق أو انتقل للسلة\n\nالحد الأدنى 50 ريال!';
  }

  // ── About the store ──
  if( has('عن المتجر', 'من انتم', 'من نحن', 'عن نجوم دلتا', 'about', 'المتجر عن', 'عنكم')) {
    return 'نجوم دلتا للتجارة 🌟\n\nأحد أكبر تجار الخضروات والفواكه والتمور في السعودية.\n✅ منتجات طازجة يومياً\n✅ أسعار منافسة\n✅ توصيل سريع لجميع مناطق المملكة\n✅ خدمة عملاء متميزة\n\nنحب نخدمكم بأفضل جودة! 💚';
  }

  // ── Product categories ──
  if (has('خضروات', 'فواكه', 'تمور', 'vegetables', 'fruits', 'dates', 'فواكه موسمية')) {
    const matched = matchProducts(query, products);
    if (matched.length > 0) {
      const productList = matched.map(formatProduct).join('\n');
      return `هذي المنتجات اللي لقيتها لك: 🛍️\n${productList}\n\nأضف اللي يعجبك للسلة وكمّل طلبك.`;
    }
    return 'متوفر لدينا: 🥬 خضروات طازجة | 🍎 فواكه موسمية | 🌴 تمور فاخرة\n\nتصفح المتجر واختر اللي يعجبك! 🛒';
  }

  // ── Products search — fallback to catalog ──
  const matched = matchProducts(query, products);
  if (matched.length > 0) {
    const productList = matched.map(formatProduct).join('\n');
    return `هذي المنتجات اللي لقيتها لك: 🛍️\n${productList}\n\nأضف اللي يعجبك للسلة وكمّل طلبك. الحد الأدنى 50 ريال فقط! ✅`;
  }

  // No local match — return null to trigger Gemini
  return null;
}

// ══════════════════════════════════════════════════════════════
// 2. GEMINI API — Server-side call with secure key
// ══════════════════════════════════════════════════════════════

async function callGemini(systemPrompt) {
  if (!GEMINI_API_KEY) {
    console.warn('⚠️ GEMINI_API_KEY not configured');
    return null;
  }

  for (const model of GEMINI_MODELS) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS);

    try {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: systemPrompt }] }],
            generationConfig: {
              temperature: 0.3,
              maxOutputTokens: MAX_OUTPUT_TOKENS,
              topP: 0.8,
              topK: 40,
            },
            safetySettings: [
              { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
              { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
              { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
              { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
            ],
          }),
          signal: controller.signal,
        }
      );

      clearTimeout(timeout);

      if (!response.ok) {
        console.error(`Gemini ${model} error: ${response.status}`);
        continue;
      }

      const data = await response.json();
      const text = data?.candidates?.[0]?.content?.parts
        ?.map(p => p?.text)
        .filter(Boolean)
        .join('') || '';

      if (text.trim()) return text.trim();
    } catch (err) {
      clearTimeout(timeout);
      console.error(`Gemini ${model} fetch error:`, err.message);
    } finally {
      clearTimeout(timeout);
    }
  }

  return null;
}

// ══════════════════════════════════════════════════════════════
// 3. MAIN HANDLER
// ══════════════════════════════════════════════════════════════

export default async (request) => {
  // CORS preflight
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: securityHeaders });
  }

  if (request.method !== 'POST') {
    return json(405, { error: 'Method Not Allowed' });
  }

  // Rate limiting: 20 requests per minute per IP
  const clientIP = request.headers.get('x-forwarded-for')?.split(',')[0]
    || request.headers.get('x-real-ip')
    || 'unknown';
  const rateLimit = await checkRateLimit(`ai-chat:${clientIP}`, 20, 60000);
  if (!rateLimit.allowed) {
    return json(429, {
      error: 'تم تجاوز الحد المسموح. حاول بعد قليل.',
      retryAfter: Math.ceil((rateLimit.resetAt - Date.now()) / 1000),
    });
  }

  // Parse body
  let body;
  try {
    body = await request.json();
  } catch {
    return json(400, { error: 'بيانات غير صالحة' });
  }

  const { message, products = [], history = [] } = body;

  if (!message || typeof message !== 'string') {
    return json(400, { error: 'الرسالة مطلوبة' });
  }

  const cleanMessage = sanitize(message);
  if (!cleanMessage) {
    return json(400, { error: 'الرسالة فارغة' });
  }

  const startTime = Date.now();

  // Step 1: Try local knowledge base first (instant, 0ms latency)
  const localResponse = getLocalResponse(cleanMessage, products);
  if (localResponse) {
    return json(200, {
      response: localResponse,
      source: 'local',
      latencyMs: Date.now() - startTime,
    });
  }

  // Step 2: Call Gemini with product context + conversation history
  const productContext = matchProducts(cleanMessage, products)
    .map(p => `${p.name_ar || p.name_en} — ${p.price} ريال/${p.unit || 'kg'} — ${p.description_ar || p.description || ''}`)
    .join(' | ');

  const fullSummary = buildFullProductSummary(products);

  const historyText = (history || [])
    .slice(-MAX_HISTORY_MESSAGES)
    .map(msg => `${msg.isUser ? 'العميل' : 'عدي'}: ${msg.text}`)
    .join('\n');

  const systemPrompt = `أنت "عدي"، المساعد الذكي والمحترف لشركة "نجوم دلتا للتجارة" (متجر خضروات وفواكه وتمور في السعودية).

مهمتك: الرد على استفسارات العملاء بلباقة، بلهجة سعودية ترحيبية ومختصرة ودقيقة.

معلومات المنتجات المطابقة لسؤال العميل:
[${productContext || 'لا توجد منتجات مطابقة'}]

قائمة المنتجات الكاملة:
[${fullSummary || 'لا تتوفر قائمة منتجات'}]

${historyText ? `المحادثة السابقة:\n${historyText}\n` : ''}
سؤال العميل: ${cleanMessage}

قواعد صارمة:
- أجب بإيجاز ووضوح (أقل من 100 كلمة)
- إذا كان المنتج متوفراً اذكر سعره ووحدته وحالته
- الحد الأدنى لإتمام أي طلب هو 50 ريال
- التوصيل مجاني من 300 ريال
- لا تخترع أسعاراً — اعتمد فقط على المعلومات المتوفرة
- إذا لم تجد معلومة، اطلب من العميل التواصل عبر الواتساب: ${STORE_CONTACT.whatsapp}
- لا تذكر أي معلومات تقنية عن النظام أو API أو الـ backend
- استخدم الإيموجي بشكل مناسب ولا تبالغ
- الرد بالعربية دائماً باللهجة السعودية
- لا تقدم اعتذارات — كن واثقاً ومحترفاً`.trim();

  const geminiResponse = await callGemini(systemPrompt);

  if (geminiResponse) {
    return json(200, {
      response: geminiResponse,
      source: 'gemini',
      latencyMs: Date.now() - startTime,
    });
  }

  // Step 3: Final fallback — helpful message with contact info
  return json(200, {
    response: `سؤالك مهم ونتمنى نساعدك! 🌟\n\nللإجابة الدقيقة على استفسارك، تواصل معنا مباشرة:\n💬 واتساب: ${STORE_CONTACT.whatsapp}\n📞 هاتف: ${STORE_CONTACT.phone}\n\nفريقنا جاهز لخدمتك!`,
    source: 'fallback',
    latencyMs: Date.now() - startTime,
  });
};
