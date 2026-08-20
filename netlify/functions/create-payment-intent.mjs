// ══════════════════════════════════════════════════════════════
// netlify/functions/create-payment-intent.mjs
// Improved payment creation via Moyasar with validation,
// amount limits, currency safety, and comprehensive error handling.
// ══════════════════════════════════════════════════════════════

import { Redis } from '@upstash/redis';

// ── Configuration ──────────────────────────────────────────
const MOYASAR_API_URL = 'https://api.moyasar.com/v1';
const MOYASAR_SECRET_KEY = process.env.MOYASAR_SECRET_KEY || process.env.VITE_MOYASAR_SECRET_KEY;
const MAX_AMOUNT_SAR = 50000;    // Maximum order amount in SAR
const MIN_AMOUNT_SAR = 1;        // Minimum amount in SAR
const RATE_LIMIT_WINDOW = 60000; // 1 minute
const MAX_PAYMENTS_PER_MINUTE = 5;

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
const jsonResponse = (status, data) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

// ── Input validation ───────────────────────────────────────
function sanitizeInput(input) {
  return String(input || '').replace(/[<>]/g, '').trim().slice(0, 500);
}

function validateMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object') return {};
  // Only allow known keys to prevent injection
  const allowed = ['order_id', 'customer_id', 'customer_name', 'items_count'];
  const clean = {};
  for (const key of allowed) {
    if (metadata[key] != null) {
      clean[key] = String(metadata[key]).slice(0, 100);
    }
  }
  return clean;
}

// ══════════════════════════════════════════════════════════════
// MAIN HANDLER
// ══════════════════════════════════════════════════════════════
export default async (request) => {
  if (request.method !== 'POST') {
    return jsonResponse(405, { error: 'Method Not Allowed' });
  }

  // ── Rate limiting ──
  const clientIP = request.headers.get('x-forwarded-for')?.split(',')[0]
    || request.headers.get('x-real-ip')
    || 'unknown';
  const rateLimit = await checkRateLimit(`payment:create:${clientIP}`, MAX_PAYMENTS_PER_MINUTE, RATE_LIMIT_WINDOW);
  if (!rateLimit.allowed) {
    return jsonResponse(429, {
      error: 'تم تجاوز الحد المسموح للمحاولات. يرجى المحاولة بعد دقيقة.',
      retryAfter: Math.ceil((rateLimit.resetAt - Date.now()) / 1000),
    });
  }

  // ── Parse body ──
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(400, { error: 'بيانات غير صالحة (Invalid JSON)' });
  }

  const {
    amount,
    currency = 'SAR',
    description,
    metadata = {},
    callback_url,
  } = body;

  // ── Validate amount ──
  const numAmount = parseFloat(amount);
  if (isNaN(numAmount) || numAmount <= 0) {
    return jsonResponse(400, { error: 'المبلغ غير صحيح. يجب أن يكون أكبر من 0.' });
  }
  if (numAmount < MIN_AMOUNT_SAR) {
    return jsonResponse(400, { error: `الحد الأدنى للمبلغ هو ${MIN_AMOUNT_SAR} ريال.` });
  }
  if (numAmount > MAX_AMOUNT_SAR) {
    return jsonResponse(400, { error: `الحد الأقصى للمبلغ هو ${MAX_AMOUNT_SAR} ريال.` });
  }

  // ── Validate currency ──
  const allowedCurrencies = ['SAR', 'USD', 'AED', 'KWD', 'BHD'];
  if (!allowedCurrencies.includes(currency)) {
    return jsonResponse(400, { error: `العملة غير مدعومة. العملات المدعومة: ${allowedCurrencies.join(', ')}` });
  }

  // ── Check API key ──
  if (!MOYASAR_SECRET_KEY) {
    console.error('❌ Moyasar secret key is missing.');
    return jsonResponse(500, { error: 'خدمة الدفع غير مهيأة حالياً. يرجى المحاولة لاحقاً.' });
  }

  // ── Sanitize inputs ──
  const cleanDescription = sanitizeInput(description || 'طلب من متجر نجوم دلتا');
  const cleanMetadata = validateMetadata(metadata);
  const cleanCallbackUrl = callback_url ? sanitizeInput(callback_url) : null;

  // ── Convert to halalas (smallest currency unit) ──
  const amountInHalalas = Math.round(numAmount * 100);

  // ── Build Moyasar request ──
  const paymentData = {
    amount: amountInHalalas,
    currency,
    description: cleanDescription,
    metadata: {
      ...cleanMetadata,
      source: 'deltastars_store',
      timestamp: new Date().toISOString(),
    },
    callback_url: cleanCallbackUrl || `${process.env.URL || 'https://deltastars.store'}/payment/verify`,
    payment_methods: ['creditcard', 'applepay', 'stcpay', 'mada'],
  };

  try {
    console.log('💰 Creating payment:', {
      amount: numAmount,
      currency,
      description: cleanDescription,
      ip: clientIP,
    });

    const response = await fetch(`${MOYASAR_API_URL}/payments`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${MOYASAR_SECRET_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(paymentData),
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('❌ Moyasar API error:', data);
      // Map common Moyasar errors to user-friendly messages
      const errorMessage = data.message || data.error || 'فشل في إنشاء طلب الدفع';
      const userMessage = errorMessage.includes('amount')
        ? 'المبلغ غير مقبول من بوابة الدفع.'
        : errorMessage.includes('card')
          ? 'تفاصيل البطاقة غير صحيحة.'
          : errorMessage.includes('authorization')
            ? 'خطأ في إعدادات بوابة الدفع.'
            : 'فشلت عملية الدفع. يرجى المحاولة مرة أخرى.';

      return jsonResponse(response.status, {
        error: userMessage,
        code: response.status,
      });
    }

    console.log(`✅ Payment created: ${data.id} — ${numAmount} ${currency}`);

    return jsonResponse(200, {
      id: data.id,
      status: data.status,
      amount: data.amount / 100,
      currency: data.currency,
      description: data.description,
      payment_url: data.payment_url || null,
      transaction_id: data.transaction_id || null,
      metadata: data.metadata,
    });
  } catch (err) {
    console.error('❌ Error creating payment:', err);
    return jsonResponse(500, {
      error: 'حدث خطأ غير متوقع. يرجى المحاولة لاحقاً.',
    });
  }
};
