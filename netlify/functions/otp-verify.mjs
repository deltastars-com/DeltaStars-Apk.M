// ══════════════════════════════════════════════════════════════
// Netlify Function: POST /api/otp/verify
// Verifies SMS OTP through Authentica.sa with advanced security.
// Features: Brute force protection via Upstash Redis, rate limiting, input validation.
// ══════════════════════════════════════════════════════════════

import { Redis } from '@upstash/redis';

const AUTHENTICA = "https://api.authentica.sa";
const CRED = process.env.AUTHENTICA_API_SECRET || process.env.AUTHENTICA_API_KEY || "";

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
      console.error("Redis error:", e);
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
      console.error("Redis brute force error:", e);
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
  return new Response(JSON.stringify({ error: message || "تم تجاوز الحد المسموح. يرجى المحاولة لاحقاً.", retryAfter }), {
    status: 429,
    headers: { "Content-Type": "application/json; charset=utf-8", "Retry-After": String(retryAfter) },
  });
}

// ── Input sanitization ───────────────────────────────────────
function sanitizeInput(input) {
  return String(input || "").replace(/[<>"'`;\\]/g, "").trim().slice(0, 20);
}

function normalizePhone(raw) {
  const d = String(raw || "").replace(/\D/g, "");
  if (d.startsWith("966")) return "+" + d;
  if (d.startsWith("05")) return "+966" + d.slice(1);
  if (d.startsWith("5") && d.length === 9) return "+966" + d;
  return "+" + d;
}

function isValidSaudi(raw) {
  const d = String(raw || "").replace(/\D/g, "");
  return /^(05\d{8}|9665\d{8}|5\d{8})$/.test(d);
}

const securityHeaders = {
  "Content-Type": "application/json; charset=utf-8",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Cache-Control": "no-store, no-cache, must-revalidate",
  "Pragma": "no-cache",
  "Access-Control-Allow-Origin": "https://deltastars.store",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const json = (status, obj) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: securityHeaders,
  });

export default async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: securityHeaders });
  }

  if (req.method !== "POST") return json(405, { success: false, error: "Method not allowed" });

  // ── Rate limiting by IP ──
  const clientIP = req.headers.get("x-forwarded-for")?.split(",")[0] || "unknown";
  const ipLimit = await checkRateLimit(`otp-verify:ip:${clientIP}`, 10, 60000);
  if (!ipLimit.allowed) return rateLimitResponse(ipLimit.resetAt - Date.now());

  // ── Parse body ──
  let body = {};
  try { body = await req.json(); } catch {
    return json(400, { success: false, error: "بيانات غير صالحة" });
  }

  const phone = sanitizeInput(body.phone);
  const code = body.code != null ? String(body.code).replace(/\D/g, "") : "";
  if (!phone || !code) return json(400, { success: false, error: "رقم الجوال والرمز مطلوبان" });
  if (!isValidSaudi(phone)) return json(400, { success: false, error: "رقم الجوال غير صحيح" });
  if (!/^\d{4,6}$/.test(code)) return json(400, { success: false, error: "رمز التحقق يجب أن يكون 4-6 أرقام" });

  if (!CRED) return json(500, { success: false, error: "خدمة الرسائل غير مهيأة على الخادم (AUTHENTICA_API_SECRET مفقود)" });

  const normalized = normalizePhone(phone);

  // ── Brute force protection ──
  const bruteForce = await checkBruteForce(`verify:${normalized}`, 10, 900000); // 10 attempts per 15 min
  if (!bruteForce.allowed) {
    return rateLimitResponse(bruteForce.resetAt - Date.now(), "تم حظر المحاولات مؤقتاً بسبب محاولات كثيرة خاطئة. حاول بعد 15 دقيقة.");
  }

  // ── Rate limit per phone ──
  const phoneLimit = await checkRateLimit(`otp-verify:phone:${normalized}`, 5, 60000);
  if (!phoneLimit.allowed) return rateLimitResponse(phoneLimit.resetAt - Date.now());

  try {
    const r = await fetch(`${AUTHENTICA}/api/v1/verify-otp`, {
      method: "POST",
      headers: {
        "X-Authorization": CRED,
        "Content-Type": "application/json",
        "Accept": "application/json",
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
        try {
          await client.incr(`bruteforce:verify:${normalized}`);
        } catch (e) { /* ignore */ }
      } else {
        const entry = memoryStore.get(`bf:verify:${normalized}`);
        if (entry) entry.count++;
      }
      
      if (!r.ok && r.status !== 422) {
        return json(502, { success: false, error: "تعذّر التحقق من الرمز حالياً. حاول مجدداً." });
      }
      return json(422, { success: false, error: data.message || "رمز التحقق غير صحيح أو منتهي الصلاحية" });
    }

    // Clear brute force on success
    const client = getRedis();
    if (client) {
      try {
        await client.del(`bruteforce:verify:${normalized}`);
      } catch (e) { /* ignore */ }
    } else {
      memoryStore.delete(`bf:verify:${normalized}`);
    }

    return json(200, {
      success: true,
      verified: true,
      phone: normalized,
      user: { phone: normalized, role: "customer", verified: true },
    });
  } catch {
    return json(500, { success: false, error: "تعذّر الاتصال بخدمة التحقق" });
  }
};
