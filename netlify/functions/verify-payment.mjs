// ================================================================
// netlify/functions/verify-payment.mjs
// التحقق من حالة الدفع عبر بوابة ميسر (Moyasar)
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
  if (request.method !== 'GET') {
    return jsonResponse(405, { error: 'Method Not Allowed' });
  }

  // 3.2 استخراج paymentId من معاملات URL
  const url = new URL(request.url);
  const paymentId = url.searchParams.get('paymentId');

  if (!paymentId) {
    return jsonResponse(400, { error: 'Missing paymentId parameter' });
  }

  // 3.3 التحقق من وجود المفتاح السري
  if (!MOYASAR_SECRET_KEY) {
    console.error('❌ Moyasar secret key is missing.');
    return jsonResponse(500, { error: 'Payment service is not configured.' });
  }

  try {
    // 3.4 جلب حالة الدفع من Moyasar
    console.log(`🔍 Verifying payment: ${paymentId}`);

    const response = await fetch(`${MOYASAR_API_URL}/payments/${paymentId}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${MOYASAR_SECRET_KEY}`,
        'Content-Type': 'application/json',
      },
    });

    const data = await response.json();

    // 3.5 معالجة الخطأ من Moyasar
    if (!response.ok) {
      console.error('❌ Moyasar API error:', data);
      return jsonResponse(response.status, {
        error: data.message || 'فشل في التحقق من الدفع',
        details: data,
      });
    }

    // 3.6 إرجاع البيانات للعميل
    console.log(`✅ Payment status: ${data.status}`);
    return jsonResponse(200, {
      id: data.id,
      status: data.status,
      amount: data.amount / 100,
      currency: data.currency,
      description: data.description,
      transaction_id: data.transaction_id || null,
      metadata: data.metadata,
      created_at: data.created_at,
      updated_at: data.updated_at,
    });
  } catch (error) {
    console.error('❌ Error verifying payment:', error);
    return jsonResponse(500, {
      error: 'Internal server error',
      message: error.message,
    });
  }
};
