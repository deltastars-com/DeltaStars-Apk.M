// ══════════════════════════════════════════════════════════════
// netlify/functions/payment-webhook.mjs
// Improved webhook handler for Moyasar payment confirmations
// with idempotency, retry logic, order status tracking,
// and comprehensive notification system.
// ══════════════════════════════════════════════════════════════

import { createClient } from '@supabase/supabase-js';

// ============================================================
// 1. Supabase setup
// ============================================================
const supabaseUrl = process.env.VITE_SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
  console.error('❌ Supabase credentials are missing in environment variables.');
}

const supabase = (supabaseUrl && supabaseServiceKey)
  ? createClient(supabaseUrl, supabaseServiceKey)
  : null;

// ============================================================
// 2. JSON response helper
// ============================================================
const jsonResponse = (statusCode, data) =>
  new Response(JSON.stringify(data), {
    status: statusCode,
    headers: { 'Content-Type': 'application/json' },
  });

// ============================================================
// 3. HMAC signature verification (Moyasar)
// ============================================================
import { createHmac, timingSafeEqual } from 'crypto';

const MOYASAR_WEBHOOK_SECRET = process.env.MOYASAR_WEBHOOK_SECRET || '';

function verifyMoyasarSignature(rawBody, signatureHeader, secret) {
  if (!secret) {
    console.warn('⚠️ MOYASAR_WEBHOOK_SECRET not set — skipping verification (INSECURE in production).');
    return true;
  }
  if (!signatureHeader) {
    console.warn('⚠️ No signature header in webhook request.');
    return false;
  }
  try {
    const expected = createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
    const sigBytes = Buffer.from(expected, 'hex');
    const headerBytes = Buffer.from(signatureHeader, 'hex');
    if (sigBytes.length !== headerBytes.length) return false;
    return timingSafeEqual(sigBytes, headerBytes);
  } catch (err) {
    console.error('❌ Signature verification error:', err.message);
    return false;
  }
}

// ============================================================
// 4. Idempotency check — prevent duplicate processing
// ============================================================
const processedWebhooks = new Map(); // In-memory dedup (ephemeral in serverless)
const IDEMPOTENCY_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours

function isAlreadyProcessed(transactionId, orderId) {
  const key = `webhook:${transactionId}:${orderId}`;
  if (processedWebhooks.has(key)) {
    console.log(`⚠️ Webhook already processed: ${key} — skipping duplicate.`);
    return true;
  }
  // Also check database for production idempotency
  return false;
}

function markProcessed(transactionId, orderId) {
  const key = `webhook:${transactionId}:${orderId}`;
  processedWebhooks.set(key, Date.now());
  // Cleanup old entries periodically
  if (processedWebhooks.size > 1000) {
    const now = Date.now();
    for (const [k, v] of processedWebhooks) {
      if (now - v > IDEMPOTENCY_WINDOW_MS) processedWebhooks.delete(k);
    }
  }
}

// ============================================================
// 5. Order status update with retry
// ============================================================
async function updateOrderStatus(orderId, updates, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const { error } = await supabase
        .from('orders')
        .update(updates)
        .eq('id', orderId);

      if (!error) {
        console.log(`✅ Order ${orderId} updated successfully (attempt ${attempt})`);
        return true;
      }

      console.error(`❌ Order update attempt ${attempt} failed:`, error.message);
      if (attempt < retries) {
        await new Promise(r => setTimeout(r, 1000 * attempt)); // Exponential backoff
      }
    } catch (err) {
      console.error(`❌ Order update exception (attempt ${attempt}):`, err.message);
      if (attempt < retries) {
        await new Promise(r => setTimeout(r, 1000 * attempt));
      }
    }
  }
  return false;
}

// ============================================================
// 6. Payment record insertion with retry
// ============================================================
async function insertPaymentRecord(record, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const { error } = await supabase.from('payments').insert(record);
      if (!error) return true;

      // If duplicate key error, payment was already recorded (idempotent)
      if (error.code === '23505') {
        console.log(`ℹ️ Payment record already exists for order ${record.order_id}`);
        return true;
      }

      console.error(`❌ Payment insert attempt ${attempt} failed:`, error.message);
      if (attempt < retries) {
        await new Promise(r => setTimeout(r, 1000 * attempt));
      }
    } catch (err) {
      console.error(`❌ Payment insert exception (attempt ${attempt}):`, err.message);
      if (attempt < retries) {
        await new Promise(r => setTimeout(r, 1000 * attempt));
      }
    }
  }
  return false;
}

// ============================================================
// 7. Notification system
// ============================================================

/**
 * Send customer notification via stored procedures / WhatsApp
 */
async function sendCustomerNotification(orderId, type, orderData = null) {
  try {
    let order = orderData;
    if (!order) {
      const { data, error } = await supabase
        .from('orders')
        .select('customer_id, customer_phone, customer_email, customer_name, total')
        .eq('id', orderId)
        .single();
      if (error || !data) {
        console.error('❌ Failed to fetch order for notification:', error?.message);
        return;
      }
      order = data;
    }

    const messages = {
      payment_success: {
        title: '✅ تم تأكيد الدفع',
        ar: `مرحباً ${order.customer_name || 'عميلنا'}! ✅ تم تأكيد دفع طلبك رقم ${orderId} بنجاح.\n\nالإجمالي: ${order.total} ريال\n\nسيتم تجهيز طلبك وتوصيله قريباً. شكراً لثقتكم بنا! 🌟`,
      },
      payment_failed: {
        title: '❌ فشل الدفع',
        ar: `عذراً ${order.customer_name || 'عميلنا'}، فشل دفع طلبك رقم ${orderId}. يرجى المحاولة مرة أخرى أو التواصل مع خدمة العملاء. 💬`,
      },
      order_preparing: {
        title: '📦 جاري تجهيز طلبك',
        ar: `مرحباً! طلبك رقم ${orderId} جاري تجهيزه الآن. سيصل إليك قريباً! 🚚`,
      },
      order_delivered: {
        title: '🎉 تم توصيل طلبك',
        ar: `مرحباً! تم توصيل طلبك رقم ${orderId} بنجاح. نتمنى أن يكون عند حسن ظنكم! ⭐`,
      },
    };

    const msg = messages[type];
    if (!msg) return;

    // Save notification in database
    if (supabase && order.customer_id) {
      await supabase.from('notifications').insert({
        user_id: order.customer_id,
        title_ar: msg.title,
        message_ar: msg.ar,
        type: 'payment',
        order_id: orderId,
        is_read: false,
        created_at: new Date().toISOString(),
      }).catch(err => console.error('Notification insert error:', err.message));
    }

    console.log(`📧 Notification queued for order ${orderId}: ${type}`);
  } catch (err) {
    console.error('❌ Notification error:', err.message);
  }
}

/**
 * Send admin notification about order status
 */
async function sendAdminNotification(orderId, type) {
  try {
    const messages = {
      payment_success: `🛒 طلب جديد #${orderId} — تم تأكيد الدفع بنجاح. يرجى مراجعة لوحة التحكم.`,
      payment_failed: `⚠️ طلب #${orderId} — فشل الدفع. يرجى المتابعة.`,
      order_delivered: `✅ طلب #${orderId} — تم التوصيل بنجاح.`,
    };

    const msg = messages[type];
    if (!msg) return;

    // Save admin notification
    if (supabase) {
      const { data: admins } = await supabase
        .from('users')
        .select('id')
        .eq('role', 'admin');

      if (admins) {
        for (const admin of admins) {
          await supabase.from('notifications').insert({
            user_id: admin.id,
            title_ar: `🔔 إشعار نظام`,
            message_ar: msg,
            type: 'admin_order',
            order_id: orderId,
            is_read: false,
            created_at: new Date().toISOString(),
          }).catch(() => {});
        }
      }
    }

    console.log(`🔔 Admin notification sent for order ${orderId}: ${type}`);
  } catch (err) {
    console.error('❌ Admin notification error:', err.message);
  }
}

// ============================================================
// 8. Main webhook handler
// ============================================================
export default async (request) => {
  if (request.method !== 'POST') {
    return jsonResponse(405, { error: 'Method Not Allowed' });
  }

  // Read raw body for signature verification
  const rawBody = await request.text();
  const signature = request.headers.get('x-moyasar-signature')
    || request.headers.get('x-webhook-signature')
    || '';

  // Verify HMAC signature
  if (!verifyMoyasarSignature(rawBody, signature, MOYASAR_WEBHOOK_SECRET)) {
    console.error('❌ Webhook signature verification failed');
    return jsonResponse(403, { error: 'Invalid webhook signature' });
  }

  // Parse payload
  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch (err) {
    console.error('❌ Invalid JSON payload:', err.message);
    return jsonResponse(400, { error: 'Invalid JSON payload' });
  }

  // Extract core fields
  const { id: transactionId, status, amount, metadata } = payload;
  const orderId = metadata?.order_id || payload.order_id;

  if (!transactionId || !status || !orderId) {
    console.error('❌ Missing required fields:', { transactionId, status, orderId });
    return jsonResponse(400, { error: 'Missing required fields: id, status, order_id' });
  }

  console.log(`📥 Webhook: Order ${orderId} | Txn ${transactionId} | Status: ${status}`);

  // ── IDEMPOTENCY CHECK ──
  // Check database for previously processed webhook
  if (supabase) {
    const { data: existingPayment } = await supabase
      .from('payments')
      .select('id')
      .eq('transaction_id', transactionId)
      .eq('order_id', orderId)
      .limit(1);

    if (existingPayment && existingPayment.length > 0) {
      console.log(`ℹ️ Payment already recorded for order ${orderId} (txn ${transactionId}) — idempotent skip.`);
      return jsonResponse(200, {
        success: true,
        message: 'Webhook already processed (idempotent)',
        orderId,
        transactionId,
      });
    }
  }

  // Also check in-memory dedup
  if (isAlreadyProcessed(transactionId, orderId)) {
    return jsonResponse(200, {
      success: true,
      message: 'Webhook already processed (idempotent)',
      orderId,
      transactionId,
    });
  }

  // Process based on status
  try {
    if (status === 'paid' || status === 'captured' || status === 'succeeded') {
      // ── PAYMENT SUCCESS ──
      console.log(`✅ Payment succeeded for order ${orderId}`);

      // Update order status
      const orderUpdated = await updateOrderStatus(orderId, {
        payment_status: 'paid',
        payment_method: 'card',
        transaction_id: transactionId,
        paid_at: new Date().toISOString(),
        status: 'confirmed',
        updated_at: new Date().toISOString(),
      });

      if (!orderUpdated) {
        console.error(`❌ CRITICAL: Failed to update order ${orderId} after payment. Manual intervention required.`);
        // Still return 200 to prevent Moyasar from retrying — we'll handle via admin notification
        await sendAdminNotification(orderId, 'payment_failed');
      }

      // Record payment
      await insertPaymentRecord({
        order_id: orderId,
        transaction_id: transactionId,
        amount: parseFloat(amount) / 100,
        status: 'completed',
        payment_method: 'card',
        created_at: new Date().toISOString(),
      });

      // Send notifications
      await sendCustomerNotification(orderId, 'payment_success');
      await sendAdminNotification(orderId, 'payment_success');

      // Mark as processed
      markProcessed(transactionId, orderId);

      return jsonResponse(200, {
        success: true,
        message: 'Payment confirmed and order updated',
        orderId,
        transactionId,
      });
    }

    if (status === 'failed' || status === 'voided' || status === 'refunded') {
      // ── PAYMENT FAILED / REFUNDED ──
      console.warn(`⚠️ Payment ${status} for order ${orderId}`);

      await updateOrderStatus(orderId, {
        payment_status: status === 'refunded' ? 'refunded' : 'failed',
        transaction_id: transactionId,
        updated_at: new Date().toISOString(),
      });

      // Record the payment attempt
      await insertPaymentRecord({
        order_id: orderId,
        transaction_id: transactionId,
        amount: parseFloat(amount) / 100,
        status,
        payment_method: 'card',
        created_at: new Date().toISOString(),
      });

      await sendCustomerNotification(orderId, 'payment_failed');
      await sendAdminNotification(orderId, 'payment_failed');

      markProcessed(transactionId, orderId);

      return jsonResponse(200, {
        success: true,
        message: `Payment ${status} recorded`,
        orderId,
      });
    }

    // ── UNKNOWN STATUS ──
    console.warn(`⚠️ Unknown payment status: ${status} for order ${orderId}`);

    // Still record it for audit trail
    if (supabase) {
      await supabase.from('payments').insert({
        order_id: orderId,
        transaction_id: transactionId,
        amount: parseFloat(amount) / 100,
        status: `unknown_${status}`,
        payment_method: 'card',
        created_at: new Date().toISOString(),
      }).catch(() => {});
    }

    markProcessed(transactionId, orderId);

    return jsonResponse(200, {
      success: true,
      message: `Payment status ${status} received`,
    });
  } catch (err) {
    console.error('❌ Webhook processing error:', err);
    return jsonResponse(500, {
      error: 'Internal server error',
      message: err.message,
    });
  }
};
