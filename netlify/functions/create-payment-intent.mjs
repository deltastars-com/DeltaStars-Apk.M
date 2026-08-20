// ================================================================
// netlify/functions/create-payment-intent.mjs
// إنشاء طلب دفع عبر بوابة ميسر (Moyasar)
// يحافظ على سرية المفتاح السري ولا يعرضه في الواجهة الأمامية
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

  const {
    amount,          // المبلغ بالريال (سيتم تحويله إلى هللة)
    currency = 'SAR',
    description = 'طلب من متجر دلتا ستارز',
    metadata = {},
    callback_url,
  } = body;

  // 3.3 التحقق من وجود المبلغ
  if (!amount || amount <= 0) {
    return jsonResponse(400, { error: 'Invalid amount. Must be greater than 0.' });
  }

  // 3.4 التحقق من وجود المفتاح السري
  if (!MOYASAR_SECRET_KEY) {
    console.error('❌ Moyasar secret key is missing.');
    return jsonResponse(500, { error: 'Payment service is not configured.' });
  }

  // 3.5 تحويل المبلغ إلى هللة (Moyasar يتعامل مع أصغر وحدة نقدية)
  const amountInHalalas = Math.round(amount * 100);

  // 3.6 إعداد البيانات المرسلة إلى Moyasar
  const paymentData = {
    amount: amountInHalalas,
    currency,
    description,
    metadata: {
      ...metadata,
      source: 'deltastars_store',
      timestamp: new Date().toISOString(),
    },
    // رابط العودة بعد الدفع (يمكن أن يكون صفحة تأكيد أو صفحة فشل)
    callback_url: callback_url || `${process.env.URL || 'https://deltastars.store'}/payment/verify`,
    // طرق الدفع المسموحة
    payment_methods: ['creditcard', 'applepay', 'stcpay', 'mada'],
  };

  try {
    // 3.7 إرسال طلب إلى Moyasar API
    console.log('💰 Creating payment intent:', {
      amount: amountInHalalas,
      currency,
      description,
    });

    const response = await fetch(`${MOYASAR_API_URL}/payments`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${MOYASAR_SECRET_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(paymentData),
    });

    const data = await response.json();

    // 3.8 معالجة الخطأ من Moyasar
    if (!response.ok) {
      console.error('❌ Moyasar API error:', data);
      return jsonResponse(response.status, {
        error: data.message || 'فشل في إنشاء طلب الدفع',
        details: data,
      });
    }

    // 3.9 إرجاع البيانات للعميل (مع إزالة المفتاح السري)
    console.log(`✅ Payment created: ${data.id}`);
    return jsonResponse(200, {
      id: data.id,
      status: data.status,
      amount: data.amount / 100, // إعادة المبلغ بالريال
      currency: data.currency,
      description: data.description,
      payment_url: data.payment_url || null,
      transaction_id: data.transaction_id || null,
      metadata: data.metadata,
    });
  } catch (error) {
    console.error('❌ Error creating payment:', error);
    return jsonResponse(500, {
      error: 'Internal server error',
      message: error.message,
    });
  }
};
