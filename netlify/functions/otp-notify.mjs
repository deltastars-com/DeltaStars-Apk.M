// Netlify Function: POST /api/otp/notify
// Order-status notification endpoint. Authentica is an OTP/verification service
// (not a generic SMS gateway), so customer order-status messages are delivered
// client-side via WhatsApp deep links (see smsService.sendWhatsAppNotification).
// This endpoint always responds with a non-blocking success so the checkout flow
// is never interrupted, and stays available for a future SMS-gateway integration.
const json = (status, obj) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });

export default async (req) => {
  if (req.method !== "POST") return json(405, { success: false, error: "Method not allowed" });

  let body = {};
  try { body = await req.json(); } catch { /* empty body */ }

  const { phone, orderId, status } = body;
  if (!phone || !orderId || !status) {
    return json(400, { success: false, error: "بيانات ناقصة" });
  }
  return json(200, { success: true, message: "تم تسجيل إشعار حالة الطلب" });
};
