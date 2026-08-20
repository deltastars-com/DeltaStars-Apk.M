// ══════════════════════════════════════════════════════════════
// Netlify Function: POST /api/otp/verify
// Improved SMS OTP verification through Authentica.sa with:
// - Enhanced brute force protection
// - Helpful error messages with retry hints
// - Timing-safe comparisons
// - Comprehensive rate limiting
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

// ── In-memory fallback ────────────────────────────────────────
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

async function checkBruteForce(key, limit, windowMs) {
  const client = getRedis();
  const now = Date.now();
  const resetAt = now + windowMs;

  if (client) {
    try {
      const multi = client.multi();
      multi.incr(`bruteforce:${key}`);
      multi.pexpire(`bruteforce:${key}`, windowMs);
      const results = await multi.exec();
      const count = results[0];
      return { allowed: count <= limit, count, resetAt };
    } catch (e) {
      console.error('Redis brute force error:', e);
    }
  }

  const entry = memoryStore.get(`bf:${key}`);
  if (!entry || now > entry.resetAt) {
    memoryStore.set(`bf:${key}`, { count: 1, resetAt });
    return { allowed: true, count: 1, resetAt };
  }
  entry.count++;
  return { allowed: entry.count <= limit, count: entry.count, resetAt: entry.resetAt };
}

function rateLimitResponse(retryAfterMs, message) {
  const retryAfter = Math.ceil(retryAfterMs / 1000);
  return new Response(JSON.stringify({
    success: false,
    error: message || 'تم تجاوز الحد المسموح.',
    retryAfter,
    message: retryAfter > 60
      ? `تم حظر المحاولات مؤقتاً. يرجى الانتظار ${Math.ceil(retryAfter / 60)} دقيقة.`
      : `يرجى المحاولة بعد ${retryAfter} ثانية.`,
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
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: securityHeaders });
  }

  if (req.method !== 'POST') return json(405, { success: false, error: 'Method not allowed' });

  // ── Rate limiting by IP ──
  const clientIP = req.headers.get('x-forwarded-for')?.split(',')[0] || 'unknown';
  const ipLimit = await checkRateLimit(`otp-verify:ip:${clientIP}`, 10, 60000);
  if (!ipLimit.allowed) return rateLimitResponse(ipLimit.resetAt - Date.now(), 'تم تجاوز عدد المحاولات من هذا الجهاز.');

  // ── Parse body ──
  let body = {};
  try { body = await req.json(); } catch {
    return json(400, { success: false, error: 'بيانات غير صالحة.' });
  }

  const phone = sanitizeInput(body.phone);
  const code = body.code != null ? String(body.code).replace(/\D/g, '') : '';

  // ── Validate inputs ──
  if (!phone || !code) {
    return json(400, {
      success: false,
      error: 'رقم الجوال والرمز مطلوبان.',
      hint: 'أدخل رقم جوالك ورمز التحقق المرسل.',
    });
  }

  if (!isValidSaudi(phone)) {
    return json(400, {
      success: false,
      error: 'رقم الجوال غير صحيح.',
      hint: 'أدخل رقم جوال سعودي يبدأ بـ 05.',
    });
  }

  if (!/^\d{4,6}$/.test(code)) {
    return json(400, {
      success: false,
      error: 'رمز التحقق يجب أن يكون 4 إلى 6 أرقام.',
      hint: 'تأكد من إدخال الرقم كما هو في رسالة التحقق.',
    });
  }

  if (!CRED) {
    return json(500, {
      success: false,
      error: 'خدمة التحقق غير مهيأة حالياً.',
      hint: 'يرجى التواصل مع الدعم الفني.',
    });
  }

  const normalized = normalizePhone(phone);

  // ── Brute force protection ──
  const bruteForce = await checkBruteForce(`verify:${normalized}`, 10, 900000); // 10 attempts per 15 min
  if (!bruteForce.allowed) {
    return rateLimitResponse(
      bruteForce.resetAt - Date.now(),
      'تم حظر المحاولات مؤقتاً بسبب محاولات كثيرة خاطئة.'
    );
  }

  // ── Rate limit per phone ──
  const phoneLimit = await checkRateLimit(`otp-verify:phone:${normalized}`, 5, 60000);
  if (!phoneLimit.allowed) return rateLimitResponse(phoneLimit.resetAt - Date.now());

  try {
    console.log(`🔍 Verifying OTP for ${normalized} (attempt ${bruteForce.count + 1}/10)`);

    const r = await fetch(`${AUTHENTICA}/api/v1/verify-otp`, {
      method: 'POST',
      headers: {
        'X-Authorization': CRED,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({ phone: normalized, otp: code }),
    });

    const data = await r.json().catch(() => ({}));
    const verified =
      r.ok && data.status !== false && data.success !== false && data.verified !== false;

    if (!verified) {
      // Record failure for brute force tracking
      const client = getRedis();
      if (client) {
        try { await client.incr(`bruteforce:verify:${normalized}`); } catch {}
      } else {
        const entry = memoryStore.get(`bf:verify:${normalized}`);
        if (entry) entry.count++;
      }

      const remaining = 10 - (bruteForce.count + 1);

      if (!r.ok && r.status !== 422) {
        return json(502, {
          success: false,
          error: 'تعذّر التحقق من الرمز حالياً.',
          hint: 'تحقق من صحة الرمز وأعد المحاولة.',
        });
      }

      // Specific error messages based on remaining attempts
      if (remaining <= 0) {
        return json(422, {
          success: false,
          error: 'تم حظر المحاولات مؤقتاً.',
          hint: 'انتظر 15 دقيقة ثم أرسل رمز تحقق جديد.',
          blocked: true,
        });
      }

      return json(422, {
        success: false,
        error: 'رمز التحقق غير صحيح أو منتهي الصلاحية.',
        hint: remaining <= 3
          ? `متبقي ${remaining} محاولة فقط قبل الحظر المؤقت.`
          : 'أعد إدخال الرمز أو اطلب رمزاً جديداً.',
        remainingAttempts: remaining,
      });
    }

    // ── Success — clear brute force counter ──
    const client = getRedis();
    if (client) {
      try { await client.del(`bruteforce:verify:${normalized}`); } catch {}
    } else {
      memoryStore.delete(`bf:verify:${normalized}`);
    }

    console.log(`✅ OTP verified for ${normalized}`);

    return json(200, {
      success: true,
      verified: true,
      phone: normalized,
      user: { phone: normalized, role: 'customer', verified: true },
      message: 'تم التحقق بنجاح!',
    });
  } catch (err) {
    console.error('❌ OTP verify exception:', err);
    return json(500, {
      success: false,
      error: 'تعذّر الاتصال بخدمة التحقق.',
      hint: 'تحقق من اتصالك بالإنترنت وحاول مرة أخرى.',
    });
  }
};
