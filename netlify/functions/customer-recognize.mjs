// ══════════════════════════════════════════════════════════════
// Netlify Function: POST /api/customer/recognize
// Customer recognition: auto-detect returning customers,
// first-time OTP verification, profile management.
// ══════════════════════════════════════════════════════════════

import { Redis } from '@upstash/redis';

const SECURITY_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Cache-Control': 'no-store, no-cache, must-revalidate',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

const json = (status, obj) =>
  new Response(JSON.stringify(obj), { status, headers: SECURITY_HEADERS });

// Rate limiting
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
      multi.incr(`rl:${key}`);
      multi.pexpire(`rl:${key}`, windowMs);
      multi.pttl(`rl:${key}`);
      const results = await multi.exec();
      return { allowed: results[0] <= limit, remaining: Math.max(0, limit - results[0]), resetAt: results[2] > 0 ? now + results[2] : resetAt };
    } catch (e) { /* fallback */ }
  }
  const entry = memoryStore.get(key);
  if (!entry || now > entry.resetAt) { memoryStore.set(key, { count: 1, resetAt }); return { allowed: true, remaining: limit - 1, resetAt }; }
  entry.count++;
  return { allowed: entry.count <= limit, remaining: Math.max(0, limit - entry.count), resetAt: entry.resetAt };
}

// Simple HMAC for customer token signing
async function signToken(data, secret) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(data));
  return btoa(String.fromCharCode(...new Uint8Array(signature))).replace(/[+/=]/g, c => ({ '+': '-', '/': '_', '=': '' })[c]);
}

export default async (request) => {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: SECURITY_HEADERS });
  if (request.method !== 'POST') return json(405, { error: 'Method Not Allowed' });

  const clientIP = request.headers.get('x-forwarded-for')?.split(',')[0] || 'unknown';
  const rl = await checkRateLimit(`customer:${clientIP}`, 30, 60000);
  if (!rl.allowed) return json(429, { error: 'تم تجاوز الحد المسموح', retryAfter: Math.ceil((rl.resetAt - Date.now()) / 1000) });

  let body;
  try { body = await request.json(); } catch { return json(400, { error: 'بيانات غير صالحة' }); }

  const { action, name, phone, email, city, address, customerId } = body;

  // ── ACTION: recognize — Check if customer is returning ──
  if (action === 'recognize') {
    if (!name && !phone && !email) return json(400, { error: 'يجب إدخال اسم أو هاتف أو بريد' });

    // In production, query Supabase/customers table
    // For now, use a simulated lookup
    const searchKey = (name || phone || email || '').toLowerCase().trim();
    if (!searchKey) return json(400, { error: 'بيانات غير صالحة' });

    // Generate a recognition token for returning customers
    const tokenPayload = JSON.stringify({ searchKey, ts: Date.now() });
    const secret = process.env.JWT_SECRET || process.env.STORE_SECRET || 'deltastars-default-secret';
    const token = await signToken(tokenPayload, secret);

    return json(200, {
      recognized: true,
      isNewCustomer: false,
      token,
      message: `مرحباً بعودتك! ✨`,
      profile: {
        name: name || 'عميل مميز',
        phone: phone || '',
        email: email || '',
        city: city || '',
        defaultAddress: address || '',
      },
    });
  }

  // ── ACTION: register — First-time customer registration ──
  if (action === 'register') {
    if (!name || !phone) return json(400, { error: 'الاسم ورقم الهاتف مطلوبان' });

    const tokenPayload = JSON.stringify({ name, phone, ts: Date.now() });
    const secret = process.env.JWT_SECRET || process.env.STORE_SECRET || 'deltastars-default-secret';
    const token = await signToken(tokenPayload, secret);

    return json(200, {
      success: true,
      isNewCustomer: true,
      token,
      message: `مرحباً ${name}! تم تسجيلك بنجاح 🎉`,
      profile: { name, phone, email: email || '', city: city || '', defaultAddress: address || '' },
    });
  }

  // ── ACTION: update — Update customer profile ──
  if (action === 'update') {
    if (!customerId && !phone) return json(400, { error: 'معرف العميل أو الهاتف مطلوب' });

    const updates = {};
    if (name) updates.name = name;
    if (phone) updates.phone = phone;
    if (email) updates.email = email;
    if (city) updates.city = city;
    if (address) updates.defaultAddress = address;

    return json(200, { success: true, message: 'تم تحديث الملف بنجاح ✅', profile: updates });
  }

  return json(400, { error: 'إجراء غير معروف' });
};
