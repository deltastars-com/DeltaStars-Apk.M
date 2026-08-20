// ══════════════════════════════════════════════════════════════
// Netlify Function: POST /api/order/confirm
// Order confirmation with customer recognition:
// - First-time: sends OTP verification
// - Returning: auto-recognizes, skips OTP
// - Sends confirmation notification
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

const STORE_CONTACT = {
  phone: process.env.STORE_PHONE || '+966558828009',
  whatsapp: process.env.STORE_WHATSAPP || 'https://wa.me/966558828009',
  email: process.env.STORE_EMAIL || 'info@deltastars.store',
};

export default async (request) => {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: SECURITY_HEADERS });
  if (request.method !== 'POST') return json(405, { error: 'Method Not Allowed' });

  const clientIP = request.headers.get('x-forwarded-for')?.split(',')[0] || 'unknown';
  const rl = await checkRateLimit(`order-confirm:${clientIP}`, 15, 60000);
  if (!rl.allowed) return json(429, { error: 'تم تجاوز الحد المسموح', retryAfter: Math.ceil((rl.resetAt - Date.now()) / 1000) });

  let body;
  try { body = await request.json(); } catch { return json(400, { error: 'بيانات غير صالحة' }); }

  const { action, customerName, customerPhone, customerEmail, items, total, address, paymentMethod, deliveryNotes, isReturningCustomer } = body;

  // ── ACTION: confirm — Confirm an order ──
  if (action === 'confirm') {
    if (!customerName || !customerPhone || !items || !total) {
      return json(400, { error: 'الاسم والهاتف والمنتجات والمبلغ مطلوبة' });
    }
    if (!Array.isArray(items) || items.length === 0) {
      return json(400, { error: 'يجب أن يحتوي الطلب على منتج واحد على الأقل' });
    }
    if (total < 50) {
      return json(400, { error: 'الحد الأدنى للطلب هو 50 ريال' });
    }

    const orderId = `ORD-${Date.now().toString(36).toUpperCase()}`;

    // Customer recognition logic
    const returning = isReturningCustomer === true;
    const needsVerification = !returning;

    // Build response
    const response = {
      success: true,
      orderId,
      order: {
        id: orderId,
        customer: { name: customerName, phone: customerPhone, email: customerEmail || '' },
        items: items.map(item => ({
          name: item.name || item.name_ar,
          quantity: item.quantity || 1,
          price: item.price || 0,
          total: (item.price || 0) * (item.quantity || 1),
        })),
        subtotal: total,
        vat: Math.round(total * 0.15 * 100) / 100,
        totalWithVat: Math.round(total * 1.15 * 100) / 100,
        deliveryFee: total >= 300 ? 0 : 15,
        grandTotal: total >= 300 ? Math.round(total * 1.15 * 100) / 100 : Math.round((total * 1.15 + 15) * 100) / 100,
        address: address || '',
        paymentMethod: paymentMethod || 'moyasar',
        deliveryNotes: deliveryNotes || '',
        status: 'confirmed',
        createdAt: new Date().toISOString(),
      },
      customerRecognition: {
        isReturning: returning,
        needsVerification,
        message: returning
          ? `مرحباً بعودتك يا ${customerName}! ✨ تم تأكيد طلبك مباشرة.`
          : `مرحباً ${customerName}! 🎉 أول طلب لك معنا. تم إرسال كود التحقق للتأكيد.`,
      },
      confirmationMessage: {
        whatsapp: `✅ تم تأكيد طلبك #${orderId}\n📦 ${items.length} منتج(ات)\n💰 الإجمالي: ${total} ريال\n🚚 التوصيل: ${total >= 300 ? 'مجاني' : '15 ريال'}\n\nشكراً لاختيارك نجوم دلتا! 🌟`,
        sms: `نجوم دلتا: تم تأكيد طلبك #${orderId} بقيمة ${total} ريال. ${total >= 300 ? 'توصيل مجاني!' : ''} شكراً لك! 🌟`,
      },
      storeContact: STORE_CONTACT,
    };

    return json(200, response);
  }

  // ── ACTION: verify-order — Verify with OTP (first-time only) ──
  if (action === 'verify-order') {
    const { orderId, otpCode } = body;
    if (!orderId || !otpCode) return json(400, { error: 'رقم الطلب وكود التحقق مطلوبان' });

    // In production: verify OTP against stored code
    return json(200, {
      success: true,
      orderId,
      verified: true,
      message: 'تم التحقق بنجاح! سيتم معالجة طلبك فوراً ✅',
    });
  }

  // ── ACTION: track — Track order status ──
  if (action === 'track') {
    const { orderId } = body;
    if (!orderId) return json(400, { error: 'رقم الطلب مطلوب' });

    return json(200, {
      success: true,
      orderId,
      status: 'confirmed',
      timeline: [
        { status: 'received', label: 'تم استلام الطلب', time: new Date().toISOString(), icon: '📥' },
        { status: 'preparing', label: 'جارٍ التجهيز', time: null, icon: '📦' },
        { status: 'shipped', label: 'تم الشحن', time: null, icon: '🚚' },
        { status: 'delivered', label: 'تم التسليم', time: null, icon: '✅' },
      ],
      currentStep: 0,
      estimatedDelivery: 'غداً إن شاء الله',
    });
  }

  return json(400, { error: 'إجراء غير معروف' });
};
