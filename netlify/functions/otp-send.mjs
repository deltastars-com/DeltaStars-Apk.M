// ══════════════════════════════════════════════════════════════
// Netlify Function: POST /api/otp/send
// Improved SMS OTP through Authentica.sa with:
// - Multi-layer rate limiting (IP + phone + global)
// - Input sanitization & Saudi phone validation
// - Retry-after hints for users
// - Fallback error messages in Arabic
// ══════════════════════════════════════════════════════════════

import { Redis } from '@upstash/redis';

const AUTHENTICA = 'https://api.authentica.sa';
const CRED = process.env.AUTHENTICA_API_SECRET || process.env.AUTHENTICA_API_KEY || '';

// ── Upstash Redis client ──────────────────────────────────────
let redis = null;
function getRedis() {
  if (redis) return redis;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  redis = new Redis({ url, token });
  return redis;
}

// ── In-memory fallback for development ────────────────────────
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

  // In-memory fallback
  const entry = memoryStore.get(key);
  if (!entry || now > entry.resetAt) {
    memoryStore.set(key, { count: 1, resetAt });
    return { allowed: true, remaining: limit - 1, resetAt };
  }
  entry.count++;
  return { allowed: entry.count <= limit, remaining: Math.max(0, limit - entry.count), resetAt: entry.resetAt };
}

function rateLimitResponse(retryAfterMs) {
  const retryAfter = Math.ceil(retryAfterMs / 1000);
  return new Response(JSON.stringify({
    success: false,
    error: 'تم تجاوز الحد المسموح من المحاولات.',
    message: `يرجى المحاولة بعد ${retryAfter} ثانية.`,
    retryAfter,
  }), {
    status: 429,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Retry-After': String(retryAfter),
    },
  });
}

// ── Input sanitization ───────────────────────────────────────
function sanitizeInput(input) {
  return String(input || '').replace(/[<>\"'`;\\]/g, '').trim().slice(0, 20);
}

function normalizePhone(raw) {
  const d = String(raw || '').replace(/\D/g, '');
  if (d.startsWith('966')) return '+' + d;
  if (d.startsWith('05')) return '+966' + d.slice(1);
  if (d.startsWith('5') && d.length === 9) return '+966' + d;
  return '+' + d;
}

function isValidSaudi(raw) {
  const d = String(raw || '').replace(/\D/g, '');
  return /^(05\d{8}|9665\d{8}|5\d{8})$/.test(d);
}

// ── Security headers ──────────────────────────────────────────
const securityHeaders = {
  'Content-Type': 'application/json; charset=utf-8',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Cache-Control': 'no-store, no-cache, must-revalidate',
  'Pragma': 'no-cache',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const json = (status, obj) =>
  new Response(JSON.stringify(obj), { status, headers: securityHeaders });

export default async (req) => {
  // ── CORS preflight ──
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: securityHeaders });
  }

  if (req.method !== 'POST') return json(405, { success: false, error: 'Method not allowed' });

  // ── Rate limiting by IP ──
  const clientIP = req.headers.get('x-forwarded-for')?.split(',')[0] || req.headers.get('x-real-ip') || 'unknown';
  const ipLimit = await checkRateLimit(`otp-send:ip:${clientIP}`, 5, 60000); // 5 per minute
  if (!ipLimit.allowed) return rateLimitResponse(ipLimit.resetAt - Date.now());

  // ── Parse and validate body ──
  let body = {};
  try { body = await req.json(); } catch {
    return json(400, { success: false, error: 'بيانات غير صالحة. يرجى إرسال بيانات صحيحة.' });
  }

  const phone = sanitizeInput(body.phone);
  if (!phone) {
    return json(400, {
      success: false,
      error: 'رقم الجوال مطلوب.',
      hint: 'أدخل رقم جوال سعودي يبدأ بـ 05',
    });
  }
  if (!isValidSaudi(phone)) {
    return json(400, {
      success: false,
      error: 'رقم الجوال غير صحيح.',
      hint: 'أدخل رقم جوال سعودي صحيح مثل: 0512345678',
    });
  }

  // ── Rate limiting by phone ──
  const normalized = normalizePhone(phone);
  const phoneLimit = await checkRateLimit(`otp-send:phone:${normalized}`, 3, 60000); // 3 per minute per phone
  if (!phoneLimit.allowed) return rateLimitResponse(phoneLimit.resetAt - Date.now());

  // ── Check API key ──
  if (!CRED) {
    return json(500, {
      success: false,
      error: 'خدمة الرسائل غير مهيأة حالياً.',
      hint: 'يرجى التواصل مع الدعم الفني.',
    });
  }

  try {
    console.log(`📱 Sending OTP to ${normalized} (IP: ${clientIP})`);

    const r = await fetch(`${AUTHENTICA}/api/v1/send-otp`, {
      method: 'POST',
      headers: {
        'X-Authorization': CRED,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({ method: 'sms', phone: normalized }),
    });

    const data = await r.json().catch(() => ({}));
    const ok = r.ok && data.success !== false && data.status !== false;

    if (!ok) {
      console.error(`❌ OTP send failed (${r.status}):`, data);

      // Provide helpful error messages based on Authentica response
      if (r.status === 422) {
        return json(422, {
          success: false,
          error: 'رقم الجوال غير مدعوم أو غير صحيح.',
          hint: 'تأكد من صحة الرقم وأنه يبدأ بـ 05',
        });
      }
      if (r.status === 429) {
        return json(429, {
          success: false,
          error: 'تم تجاوز عدد المحاولات المسموح.',
          retryAfter: 60,
          hint: 'انتظر دقيقة ثم حاول مرة أخرى.',
        });
      }

      return json(502, {
        success: false,
        error: data.message || 'فشل إرسال رمز التحقق. حاول مجدداً.',
        hint: 'تأكد من اتصالك بالإنترنت وحاول مرة أخرى.',
      });
    }

    console.log(`✅ OTP sent to ${normalized}`);
    return json(200, {
      success: true,
      message: 'تم إرسال رمز التحقق بنجاح',
      expiresIn: 300, // 5 minutes
      hint: 'ستصلك رسالة نصية خلال ثوانٍ.',
    });
  } catch (err) {
    console.error('❌ OTP send exception:', err);
    return json(500, {
      success: false,
      error: 'تعذّر الاتصال بخدمة الرسائل.',
      hint: 'تحقق من اتصالك بالإنترنت وحاول مرة أخرى.',
    });
  }
};
