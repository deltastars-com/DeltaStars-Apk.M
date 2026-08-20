// ============================================================
// netlify/functions/payment-webhook.mjs
// دالة Netlify لاستقبال تأكيد الدفع من بوابة ميسر (Moyasar)
// وتحديث حالة الطلب وقاعدة البيانات وإرسال الإشعارات
// ============================================================

import { createClient } from '@supabase/supabase-js';

// ============================================================
// 1. إعداد الاتصال بقاعدة البيانات (Supabase)
// ============================================================

const supabaseUrl = process.env.VITE_SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
  console.error('❌ Supabase credentials are missing in environment variables.');
}

const supabase = createClient(supabaseUrl, supabaseServiceKey);

// ============================================================
// 2. دالة مساعدة لإرجاع استجابة JSON
// ============================================================

const jsonResponse = (statusCode, data) =>
  new Response(JSON.stringify(data), {
    status: statusCode,
    headers: { 'Content-Type': 'application/json' },
  });

// ============================================================
// 3. التحقق من توقيع Moyasar HMAC (إلزامي للإنتاج)
// ============================================================

import { createHmac } from 'crypto';

const MOYASAR_WEBHOOK_SECRET = process.env.MOYASAR_WEBHOOK_SECRET || '';

/**
 * Verify the HMAC signature from Moyasar webhook.
 * Moyasar signs the raw body with the webhook secret.
 * If MOYASAR_WEBHOOK_SECRET is not set, we log a warning but skip verification
 * to avoid blocking dev deployments — but this MUST be set in production.
 */
const verifyMoyasarSignature = (rawBody, signatureHeader, secret) => {
  if (!secret) {
    console.warn('⚠️ MOYASAR_WEBHOOK_SECRET is not set. Skipping signature verification (INSECURE in production).');
    return true;
  }
  if (!signatureHeader) {
    console.warn('⚠️ No signature header in webhook request.');
    return false;
  }
  try {
    const expectedSignature = createHmac('sha256', secret)
      .update(rawBody, 'utf8')
      .digest('hex');
    // Compare using timing-safe comparison
    if (expectedSignature.length !== signatureHeader.length) return false;
    let result = 0;
    for (let i = 0; i < expectedSignature.length; i++) {
      result |= expectedSignature.charCodeAt(i) ^ signatureHeader.charCodeAt(i);
    }
    return result === 0;
  } catch (error) {
    console.error('❌ Signature verification error:', error.message);
    return false;
  }
};

// ============================================================
// 4. الدالة الرئيسية (النقطة النهائية للـ Webhook)
// ============================================================

export default async (request) => {
  // 4.1 التحقق من طريقة الطلب
  if (request.method !== 'POST') {
    return jsonResponse(405, { error: 'Method Not Allowed' });
  }

  // 4.2 قراءة البيانات الخام والتحقق من التوقيع
  const rawBody = await request.text();
  const signature = request.headers.get('x-moyasar-signature') || request.headers.get('x-webhook-signature') || '';

  if (!verifyMoyasarSignature(rawBody, signature, MOYASAR_WEBHOOK_SECRET)) {
    console.error('❌ Webhook signature verification failed');
    return jsonResponse(403, { error: 'Invalid webhook signature' });
  }

  // 4.3 تحليل البيانات
  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch (error) {
    console.error('❌ Invalid JSON payload:', error);
    return jsonResponse(400, { error: 'Invalid JSON payload' });
  }

  // 4.3 استخراج البيانات الأساسية
  const { id: transactionId, status, amount, metadata } = payload;
  const orderId = metadata?.order_id || payload.order_id;

  // 4.4 التحقق من وجود البيانات المطلوبة
  if (!transactionId || !status || !orderId) {
    console.error('❌ Missing required fields:', { transactionId, status, orderId });
    return jsonResponse(400, { error: 'Missing required fields: transactionId, status, orderId' });
  }

  console.log(`📥 Webhook received: Order ${orderId}, Transaction ${transactionId}, Status ${status}`);

  // 4.5 معالجة الحالات المختلفة للدفع
  try {
    if (status === 'paid' || status === 'captured' || status === 'succeeded') {
      // ------ الدفع ناجح ------
      console.log(`✅ Payment succeeded for order ${orderId}`);

      // 4.5.1 تحديث حالة الطلب في قاعدة البيانات
      const { error: orderError } = await supabase
        .from('orders')
        .update({
          payment_status: 'paid',
          payment_method: 'card',
          transaction_id: transactionId,
          paid_at: new Date().toISOString(),
          status: 'confirmed', // أو 'preparing' حسب منطق التطبيق
          updated_at: new Date().toISOString(),
        })
        .eq('id', orderId);

      if (orderError) {
        console.error('❌ Failed to update order:', orderError);
        throw new Error(`Order update failed: ${orderError.message}`);
      }

      // 4.5.2 تسجيل الدفعة في جدول المدفوعات
      const { error: paymentError } = await supabase
        .from('payments')
        .insert({
          order_id: orderId,
          transaction_id: transactionId,
          amount: parseFloat(amount) / 100, // تحويل من هللة إلى ريال
          status: 'completed',
          payment_method: 'card',
          created_at: new Date().toISOString(),
        });

      if (paymentError) {
        console.error('❌ Failed to insert payment record:', paymentError);
        // لا نرمي خطأ هنا حتى لا نفشل الـ webhook، لكن نسجل فقط
      }

      // 4.5.3 تحديث المخزون (اختياري)
      // يمكن إضافة منطق لتقليل المخزون هنا

      // 4.5.4 إرسال إشعار للعميل (واتساب / بريد إلكتروني)
      await sendCustomerNotification(orderId, 'payment_success');

      // 4.5.5 إرسال إشعار للإدارة (اختياري)
      await sendAdminNotification(orderId, 'payment_success');

      // 4.5.6 مزامنة مع نظام Onyx Pro (اختياري)
      await syncWithOnyx(orderId);

      return jsonResponse(200, {
        success: true,
        message: 'Payment confirmed and order updated successfully',
        orderId,
        transactionId,
      });
    } 
    
    else if (status === 'failed' || status === 'voided' || status === 'refunded') {
      // ------ الدفع فشل أو تم استرجاعه ------
      console.warn(`⚠️ Payment ${status} for order ${orderId}`);

      const { error: orderError } = await supabase
        .from('orders')
        .update({
          payment_status: status === 'refunded' ? 'refunded' : 'failed',
          transaction_id: transactionId,
          updated_at: new Date().toISOString(),
        })
        .eq('id', orderId);

      if (orderError) {
        console.error('❌ Failed to update order status:', orderError);
      }

      // تسجيل الدفعة الفاشلة
      await supabase.from('payments').insert({
        order_id: orderId,
        transaction_id: transactionId,
        amount: parseFloat(amount) / 100,
        status: status,
        payment_method: 'card',
        created_at: new Date().toISOString(),
      });

      // إشعار العميل بالفشل
      await sendCustomerNotification(orderId, 'payment_failed');

      return jsonResponse(200, {
        success: true,
        message: `Payment ${status} recorded for order ${orderId}`,
      });
    } 
    
    else {
      // ------ حالة غير معروفة ------
      console.warn(`⚠️ Unknown payment status: ${status} for order ${orderId}`);
      return jsonResponse(200, {
        success: true,
        message: `Payment status ${status} received but not processed`,
      });
    }
  } catch (error) {
    console.error('❌ Webhook processing error:', error);
    return jsonResponse(500, {
      error: 'Internal server error',
      message: error.message,
    });
  }
};

// ============================================================
// 5. دوال مساعدة للإشعارات والمزامنة
// ============================================================

/**
 * إرسال إشعار للعميل (واتساب / بريد إلكتروني)
 */
async function sendCustomerNotification(orderId, type) {
  try {
    // جلب بيانات العميل من قاعدة البيانات
    const { data: order, error } = await supabase
      .from('orders')
      .select('customer_id, customer_phone, customer_email, total')
      .eq('id', orderId)
      .single();

    if (error || !order) {
      console.error('❌ Failed to fetch order for notification:', error);
      return;
    }

    const messages = {
      payment_success: {
        ar: `✅ تم تأكيد دفع طلبك رقم ${orderId} بنجاح. سيتم تجهيز طلبك وتوصيله قريباً. شكراً لثقتكم بنا!`,
        en: `✅ Your order #${orderId} payment has been confirmed. Your order will be prepared and delivered soon. Thank you for trusting us!`,
      },
      payment_failed: {
        ar: `❌ عذراً، فشل دفع طلبك رقم ${orderId}. يرجى المحاولة مرة أخرى أو التواصل مع خدمة العملاء.`,
        en: `❌ Sorry, payment for order #${orderId} failed. Please try again or contact customer support.`,
      },
    };

    const msg = messages[type];
    if (!msg) return;

    // إرسال عبر واتساب (إذا كان الرقم موجوداً)
    if (order.customer_phone) {
      await sendWhatsAppMessage(order.customer_phone, msg.ar);
    }

    // إرسال عبر البريد الإلكتروني (إذا كان البريد موجوداً)
    if (order.customer_email) {
      await sendEmailNotification(order.customer_email, msg.ar, orderId);
    }

    // حفظ الإشعار في قاعدة البيانات
    await supabase.from('notifications').insert({
      user_id: order.customer_id,
      title_ar: type === 'payment_success' ? 'تم تأكيد الدفع' : 'فشل الدفع',
      title_en: type === 'payment_success' ? 'Payment Confirmed' : 'Payment Failed',
      message_ar: msg.ar,
      message_en: msg.en,
      type: 'payment',
      order_id: orderId,
      is_read: false,
      created_at: new Date().toISOString(),
    });
  } catch (error) {
    console.error('❌ Error sending customer notification:', error);
  }
}

/**
 * إرسال إشعار للإدارة
 */
async function sendAdminNotification(orderId, type) {
  try {
    const adminPhone = process.env.ADMIN_WHATSAPP || '966558828009';
    const adminEmail = process.env.ADMIN_EMAIL || 'info@deltastars-ksa.com';

    const message = `🛒 طلب جديد #${orderId} تم تأكيد الدفع بنجاح. يرجى مراجعة لوحة التحكم لتجهيز الطلب.`;

    await sendWhatsAppMessage(adminPhone, message);
    await sendEmailNotification(adminEmail, message, orderId);
  } catch (error) {
    console.error('❌ Error sending admin notification:', error);
  }
}

/**
 * إرسال رسالة واتساب (واجهة افتراضية - يمكن ربطها بـ API حقيقي)
 */
async function sendWhatsAppMessage(phone, message) {
  try {
    const apiKey = process.env.WHATSAPP_API_KEY;
    const phoneId = process.env.WHATSAPP_PHONE_ID;

    if (!apiKey || !phoneId) {
      console.warn('⚠️ WhatsApp credentials not configured. Message not sent.');
      return;
    }

    // يمكن استبدال هذا الكود بالتكامل الفعلي مع واتساب API
    console.log(`📱 WhatsApp to ${phone}: ${message}`);

    // مثال للاتصال بـ WhatsApp Business API:
    // const response = await fetch(`https://graph.facebook.com/v18.0/${phoneId}/messages`, {
    //   method: 'POST',
    //   headers: {
    //     'Authorization': `Bearer ${apiKey}`,
    //     'Content-Type': 'application/json',
    //   },
    //   body: JSON.stringify({
    //     messaging_product: 'whatsapp',
    //     to: phone,
    //     type: 'text',
    //     text: { body: message },
    //   }),
    // });
  } catch (error) {
    console.error('❌ WhatsApp send error:', error);
  }
}

/**
 * إرسال بريد إلكتروني (واجهة افتراضية)
 */
async function sendEmailNotification(email, message, orderId) {
  try {
    // يمكن استبدال هذا الكود بالتكامل الفعلي مع SendGrid أو أي خدمة بريد
    console.log(`📧 Email to ${email}: ${message}`);
  } catch (error) {
    console.error('❌ Email send error:', error);
  }
}

/**
 * مزامنة مع نظام Onyx Pro (واجهة افتراضية)
 */
async function syncWithOnyx(orderId) {
  try {
    const onyxApiKey = process.env.ONYX_API_KEY;
    if (!onyxApiKey) {
      console.warn('⚠️ Onyx API key not configured. Sync skipped.');
      return;
    }

    console.log(`🔄 Syncing order ${orderId} with Onyx Pro...`);
    // يمكن استبدال هذا الكود بالتكامل الفعلي مع Onyx API
    // await fetch('https://api.onyxpro.com/v1/orders', { ... });

    // تحديث حالة المزامنة في قاعدة البيانات
    await supabase
      .from('orders')
      .update({
        onyx_sync_status: 'synced',
        onyx_synced_at: new Date().toISOString(),
      })
      .eq('id', orderId);
  } catch (error) {
    console.error('❌ Onyx sync error:', error);
  }
}
