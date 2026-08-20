// ══════════════════════════════════════════════════════════════
// netlify/functions/verify-payment.mjs
// Verify payment status via Moyasar with improved validation,
// rate limiting, CORS, and Arabic user-friendly responses.
// ══════════════════════════════════════════════════════════════

import { Redis } from '@upstash/redis';

// ── Configuration ──────────────────────────────────────────
const MOYASAR_API_URL = 'https://api.moyasar.com/v1';
const MOYASAR_SECRET_KEY = process.env.MOYASAR_SECRET_KEY || process.env.VITE_MOYASAR_SECRET_KEY;
const RATE_LIMIT_MAX = 20;
const RATE_LIMIT_WINDOW = 60000; // 1 minute

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
    } catch (e) { console.error('Redis error:', e); }
  }
  const entry = memoryStore.get(key);
  if (!entry || now > entry.resetAt) {
    memoryStore.set(key, { count: 1, resetAt });
    return { allowed: true, remaining: limit - 1, resetAt };
  }
  entry.count++;
  return { allowed: entry.count <= limit, remaining: Math.max(0, limit - entry.count), resetAt: entry.resetAt };
}

// ── Helpers ────────────────────────────────────────────────
const securityHeaders = {
  'Content-Type': 'application/json; charset=utf-8',
  'X-Content-Type-Options': 'nosniff',
  'Cache-Control': 'no-store, no-cache, must-revalidate',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const json = (status, obj) =>
  new Response(JSON.stringify(obj), { status, headers: securityHeaders });

function isValidPaymentId(id) {
  return typeof id === 'string' && /^pay_[a-zA-Z0-9_-]{8,64}$/.test(id);
}

function statusSummary(moyasarStatus) {
  const map = {
    pending: { label: 'معلق', emoji: '⏳', next: 'في انتظار الدفع' },
    initiated: { label: 'قيد المعالجة', emoji: '🔄', next: 'جارٍ تأكيد الدفع' },
    paid: { label: 'مدفوع', emoji: '✅', next: 'تم تأكيد الطلب' },
    captured: { label: 'محتجز', emoji: '✅', next: 'تم تأكيد الطلب' },
    failed: { label: 'فشل', emoji: '❌', next: 'يمكنك المحاولة مرة أخرى' },
    refunded: { label: 'مسترد', emoji: '💰', next: 'يُعاد المبلغ خلال 3-5 أيام' },
    voided: { label: 'ملغى', emoji: '🚫', next: 'تم إلغاء الدفع' },
  };
  return map[moyasarStatus] || { label: moyasarStatus, emoji: '❓', next: 'تواصل معنا' };
}

// ══════════════════════════════════════════════════════════════
// MAIN HANDLER — supports both GET and POST
// ══════════════════════════════════════════════════════════════
export default async (request) => {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: securityHeaders });
  }

  if (request.method !== 'GET' && request.method !== 'POST') {
    return json(405, { error: 'Method Not Allowed' });
  }

  // Rate limiting
  const clientIP = request.headers.get('x-forwarded-for')?.split(',')[0] || 'unknown';
  const rateLimit = await checkRateLimit(`payment:verify:${clientIP}`, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW);
  if (!rateLimit.allowed) {
    return json(429, {
      error: 'تم تجاوز الحد المسموح. حاول بعد قليل.',
      retryAfter: Math.ceil((rateLimit.resetAt - Date.now()) / 1000),
    });
  }

  // Extract paymentId from query params (GET) or body (POST)
  let paymentId;
  if (request.method === 'GET') {
    const url = new URL(request.url);
    paymentId = url.searchParams.get('paymentId') || url.searchParams.get('payment_id');
  } else {
    try {
      const body = await request.json();
      paymentId = body.paymentId || body.payment_id;
    } catch {
      return json(400, { error: 'بيانات غير صالحة' });
    }
  }

  if (!paymentId) {
    return json(400, {
      error: 'رقم الدفع (paymentId) مطلوب',
      hint: 'أرسل paymentId كمعامل في الرابط أو في جسم الطلب.',
    });
  }

  if (!isValidPaymentId(paymentId)) {
    return json(400, { error: 'رقم الدفع غير صحيح' });
  }

  if (!MOYASAR_SECRET_KEY) {
    console.error('❌ Moyasar secret key is missing.');
    return json(500, { error: 'خدمة الدفع غير مهيأة حالياً.' });
  }

  try {
    console.log(`🔍 Verifying payment: ${paymentId}`);

    const response = await fetch(`${MOYASAR_API_URL}/payments/${paymentId}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${MOYASAR_SECRET_KEY}`,
        'Content-Type': 'application/json',
      },
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('❌ Moyasar API error:', data);
      return json(response.status, {
        error: data.message || 'فشل في التحقق من حالة الدفع',
      });
    }

    const summary = statusSummary(data.status);

    console.log(`✅ Payment ${paymentId}: ${data.status}`);
    return json(200, {
      id: data.id,
      status: data.status,
      statusLabel: summary.label,
      statusEmoji: summary.emoji,
      nextStep: summary.next,
      amount: data.amount / 100,
      currency: data.currency,
      description: data.description,
      transaction_id: data.transaction_id || null,
      metadata: data.metadata,
      created_at: data.created_at,
      updated_at: data.updated_at,
    });
  } catch (error) {
    console.error('❌ Error verifying payment:', error);
    return json(500, { error: 'حدث خطأ أثناء التحقق. حاول مرة أخرى.' });
  }
};
