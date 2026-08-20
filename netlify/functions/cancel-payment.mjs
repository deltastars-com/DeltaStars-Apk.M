// ══════════════════════════════════════════════════════════════
// netlify/functions/cancel-payment.mjs
// Cancel a pending payment via Moyasar with improved validation,
// rate limiting, CORS, and Arabic error messages.
// ══════════════════════════════════════════════════════════════

import { Redis } from '@upstash/redis';

// ── Configuration ──────────────────────────────────────────
const MOYASAR_API_URL = 'https://api.moyasar.com/v1';
const MOYASAR_SECRET_KEY = process.env.MOYASAR_SECRET_KEY || process.env.VITE_MOYASAR_SECRET_KEY;
const RATE_LIMIT_MAX = 5;
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
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const json = (status, obj) =>
  new Response(JSON.stringify(obj), { status, headers: securityHeaders });

function isValidPaymentId(id) {
  return typeof id === 'string' && /^pay_[a-zA-Z0-9_-]{8,64}$/.test(id);
}

// ══════════════════════════════════════════════════════════════
// MAIN HANDLER
// ══════════════════════════════════════════════════════════════
export default async (request) => {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: securityHeaders });
  }

  if (request.method !== 'POST') {
    return json(405, { error: 'Method Not Allowed' });
  }

  // Rate limiting
  const clientIP = request.headers.get('x-forwarded-for')?.split(',')[0] || request.headers.get('x-real-ip') || 'unknown';
  const rateLimit = await checkRateLimit(`payment:cancel:${clientIP}`, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW);
  if (!rateLimit.allowed) {
    return json(429, {
      error: 'تم تجاوز الحد المسموح. يرجى المحاولة بعد قليل.',
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

  const { paymentId } = body;

  if (!paymentId) {
    return json(400, { error: 'رقم الدفع (paymentId) مطلوب' });
  }

  if (!isValidPaymentId(paymentId)) {
    return json(400, { error: 'رقم الدفع غير صحيح' });
  }

  if (!MOYASAR_SECRET_KEY) {
    console.error('❌ Moyasar secret key is missing.');
    return json(500, { error: 'خدمة الدفع غير مهيأة حالياً.' });
  }

  try {
    console.log(`🗑️ Cancelling payment: ${paymentId}`);

    // First: fetch payment status to check if it's cancellable
    const getResponse = await fetch(`${MOYASAR_API_URL}/payments/${paymentId}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${MOYASAR_SECRET_KEY}`,
        'Content-Type': 'application/json',
      },
    });

    const paymentData = await getResponse.json();

    if (!getResponse.ok) {
      const msg = paymentData.message || paymentData.error || 'فشل في جلب بيانات الدفع';
      return json(getResponse.status, { error: msg });
    }

    // Check if payment is in a cancellable state
    const cancellableStatuses = ['pending', 'initiated'];
    if (!cancellableStatuses.includes(paymentData.status)) {
      const statusMessages = {
        paid: 'الدفع مكتمل بالفعل ولا يمكن إلغاؤه.',
        captured: 'تم احتواء المبلغ ولا يمكن إلغاؤه. يمكنك طلب استرداد.',
        failed: 'الدفع فشل بالفعل.',
        refunded: 'تم استرداد المبلغ بالفعل.',
        voided: 'تم إلغاء الدفع بالفعل.',
      };
      return json(400, {
        error: statusMessages[paymentData.status] || `لا يمكن إلغاء الدفع (${paymentData.status}).`,
        currentStatus: paymentData.status,
      });
    }

    // Cancel: use void for pending, refund for initiated
    const cancelEndpoint = paymentData.status === 'pending'
      ? `${MOYASAR_API_URL}/payments/${paymentId}/void`
      : `${MOYASAR_API_URL}/payments/${paymentId}/refund`;

    const cancelResponse = await fetch(cancelEndpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${MOYASAR_SECRET_KEY}`,
        'Content-Type': 'application/json',
      },
    });

    const cancelData = await cancelResponse.json();

    if (!cancelResponse.ok) {
      console.error('❌ Moyasar cancellation error:', cancelData);
      return json(cancelResponse.status, {
        error: cancelData.message || 'فشل في إلغاء الدفع. حاول مرة أخرى.',
      });
    }

    console.log(`✅ Payment cancelled: ${paymentId}`);
    return json(200, {
      success: true,
      message: 'تم إلغاء الدفع بنجاح',
      paymentId,
      status: cancelData.status,
    });
  } catch (error) {
    console.error('❌ Error cancelling payment:', error);
    return json(500, { error: 'حدث خطأ غير متوقع. يرجى المحاولة لاحقاً.' });
  }
};
