// ══════════════════════════════════════════════════════════════
// netlify/functions/order-complete.mjs
// Order completion endpoint — confirms order after payment,
// validates order integrity, triggers notifications, and
// provides order summary to the frontend.
// ══════════════════════════════════════════════════════════════

import { createClient } from '@supabase/supabase-js';
import { Redis } from '@upstash/redis';

// ── Configuration ──────────────────────────────────────────
const supabaseUrl = process.env.VITE_SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = (supabaseUrl && supabaseServiceKey)
  ? createClient(supabaseUrl, supabaseServiceKey)
  : null;

// ── Rate limiting ──
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

// ── Helpers ──
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
  const clientIP = request.headers.get('x-forwarded-for')?.split(',')[0] || 'unknown';
  const rateLimit = await checkRateLimit(`order-complete:${clientIP}`, 10, 60000);
  if (!rateLimit.allowed) {
    return json(429, { error: 'تم تجاوز الحد المسموح. يرجى المحاولة بعد قليل.' });
  }

  // Parse body
  let body;
  try { body = await request.json(); } catch {
    return json(400, { error: 'بيانات غير صالحة' });
  }

  const { orderId, paymentId } = body;
  if (!orderId) return json(400, { error: 'رقم الطلب مطلوب' });

  if (!supabase) {
    return json(500, { error: 'قاعدة البيانات غير متصلة' });
  }

  try {
    // Fetch the order
    const { data: order, error: fetchError } = await supabase
      .from('orders')
      .select('*')
      .eq('id', orderId)
      .single();

    if (fetchError || !order) {
      console.error('❌ Order not found:', orderId, fetchError?.message);
      return json(404, { error: 'الطلب غير موجود' });
    }

    // Check if order is already completed
    if (order.status === 'delivered' || order.completion_status === 'completed') {
      return json(200, {
        success: true,
        message: 'الطلب مكتمل بالفعل',
        order: {
          id: order.id,
          status: order.status,
          payment_status: order.payment_status,
          total: order.total,
          created_at: order.created_at,
        },
      });
    }

    // Validate payment status
    if (order.payment_status !== 'paid' && order.payment_status !== 'completed') {
      console.warn(`⚠️ Order ${orderId} payment status is ${order.payment_status} — cannot complete.`);
      return json(400, {
        error: 'لم يتم تأكيد الدفع بعد',
        payment_status: order.payment_status,
      });
    }

    // Update order to completed
    const { error: updateError } = await supabase
      .from('orders')
      .update({
        status: 'confirmed',
        completion_status: 'completed',
        completed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', orderId);

    if (updateError) {
      console.error('❌ Failed to complete order:', updateError.message);
      return json(500, { error: 'فشل في تأكيد إتمام الطلب' });
    }

    // Update inventory (reduce stock for each item)
    if (order.items && Array.isArray(order.items)) {
      for (const item of order.items) {
        if (item.product_id && item.quantity) {
          const { error: stockError } = await supabase.rpc('reduce_stock', {
            p_product_id: item.product_id,
            p_quantity: item.quantity,
          }).single();

          if (stockError) {
            // Log but don't fail — inventory update is non-critical
            console.warn(`⚠️ Stock update failed for product ${item.product_id}:`, stockError.message);
          }
        }
      }
    }

    // Return order summary
    return json(200, {
      success: true,
      message: 'تم تأكيد إتمام الطلب بنجاح',
      order: {
        id: order.id,
        status: 'confirmed',
        payment_status: order.payment_status,
        total: order.total,
        items: order.items,
        customer_name: order.customer_name,
        customer_phone: order.customer_phone,
        delivery_address: order.delivery_address,
        created_at: order.created_at,
        completed_at: new Date().toISOString(),
      },
    });
  } catch (err) {
    console.error('❌ Order completion error:', err);
    return json(500, { error: 'خطأ داخلي في الخادم' });
  }
};
