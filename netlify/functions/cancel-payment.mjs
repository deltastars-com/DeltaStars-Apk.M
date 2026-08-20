// ================================================================
// netlify/functions/cancel-payment.mjs
// إلغاء طلب دفع معلق عبر بوابة ميسر (Moyasar)
// ================================================================

// --------------------------------------------
// 1. إعدادات ميسر الأساسية
// --------------------------------------------

const MOYASAR_API_URL = 'https://api.moyasar.com/v1';
const MOYASAR_SECRET_KEY = process.env.MOYASAR_SECRET_KEY || process.env.VITE_MOYASAR_SECRET_KEY;

if (!MOYASAR_SECRET_KEY) {
  console.error('❌ MOYASAR_SECRET_KEY is not set in environment variables.');
}

// --------------------------------------------
// 2. دالة مساعدة لإرجاع استجابة JSON
// --------------------------------------------

const jsonResponse = (status, data) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

// --------------------------------------------
// 3. الدالة الرئيسية
// --------------------------------------------

export default async (request) => {
  // 3.1 التحقق من طريقة الطلب
  if (request.method !== 'POST') {
    return jsonResponse(405, { error: 'Method Not Allowed' });
  }

  // 3.2 قراءة البيانات المرسلة من العميل
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(400, { error: 'Invalid JSON payload' });
  }

  const { paymentId } = body;

  if (!paymentId) {
    return jsonResponse(400, { error: 'Missing paymentId' });
  }

  // 3.3 التحقق من وجود المفتاح السري
  if (!MOYASAR_SECRET_KEY) {
    console.error('❌ Moyasar secret key is missing.');
    return jsonResponse(500, { error: 'Payment service is not configured.' });
  }

  try {
    // 3.4 إلغاء الدفع عبر Moyasar API
    console.log(`🗑️ Cancelling payment: ${paymentId}`);

    // أولاً: جلب حالة الدفع للتأكد من أنه معلق
    const getResponse = await fetch(`${MOYASAR_API_URL}/payments/${paymentId}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${MOYASAR_SECRET_KEY}`,
        'Content-Type': 'application/json',
      },
    });

    const paymentData = await getResponse.json();

    if (!getResponse.ok) {
      return jsonResponse(getResponse.status, {
        error: paymentData.message || 'فشل في جلب بيانات الدفع',
      });
    }

    // التحقق من أن الدفع في حالة قابلة للإلغاء (pending أو initiated)
    if (paymentData.status !== 'pending' && paymentData.status !== 'initiated') {
      return jsonResponse(400, {
        error: `Cannot cancel payment with status: ${paymentData.status}`,
      });
    }

    // إلغاء الدفع (لا توجد واجهة مباشرة للإلغاء في Moyasar v1،
    // لذلك نقوم بتحديث حالة الدفع يدوياً أو استخدام واجهة الاسترداد)
    // ملاحظة: Moyasar قد لا تدعم الإلغاء المباشر، لذا يمكن استخدام refund أو void.
    // نستخدم void إذا كان الدفع غير محتجز، أو refund إذا كان محتجزاً.
    let cancelUrl;
    if (paymentData.status === 'pending') {
      // يمكن إلغاء عن طريق void
      cancelUrl = `${MOYASAR_API_URL}/payments/${paymentId}/void`;
    } else {
      // يمكن استرداد المبلغ
      cancelUrl = `${MOYASAR_API_URL}/payments/${paymentId}/refund`;
    }

    const cancelResponse = await fetch(cancelUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${MOYASAR_SECRET_KEY}`,
        'Content-Type': 'application/json',
      },
    });

    const cancelData = await cancelResponse.json();

    if (!cancelResponse.ok) {
      console.error('❌ Moyasar cancellation error:', cancelData);
      return jsonResponse(cancelResponse.status, {
        error: cancelData.message || 'فشل في إلغاء الدفع',
        details: cancelData,
      });
    }

    console.log(`✅ Payment cancelled: ${paymentId}`);
    return jsonResponse(200, {
      success: true,
      message: 'تم إلغاء الدفع بنجاح',
      paymentId,
      status: cancelData.status,
    });
  } catch (error) {
    console.error('❌ Error cancelling payment:', error);
    return jsonResponse(500, {
      error: 'Internal server error',
      message: error.message,
    });
  }
};
