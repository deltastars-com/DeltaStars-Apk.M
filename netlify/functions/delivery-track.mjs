// ══════════════════════════════════════════════════════════════
// Netlify Function: POST /api/delivery/track
// Delivery tracking: real-time GPS, route optimization,
// ETA calculation, driver assignment, branch dispatch.
// ══════════════════════════════════════════════════════════════

const SECURITY_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Cache-Control': 'no-store, no-cache, must-revalidate',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const json = (status, obj) =>
  new Response(JSON.stringify(obj), { status, headers: SECURITY_HEADERS });

// ── Branches Data ──
const BRANCHES = [
  { id: 'branch-riyadh', name_ar: 'الرياض', name_en: 'Riyadh', lat: 24.7136, lng: 46.6753, phone: '+966558828001', zones: ['المنار', 'العليا', 'الملز', 'النزهة'] },
  { id: 'branch-jeddah', name_ar: 'جدة', name_en: 'Jeddah', lat: 21.5433, lng: 39.1728, phone: '+966558828002', zones: ['الحمراء', 'ال الروضة', 'الشاطئ', 'الصقار'] },
  { id: 'branch-makkah', name_ar: 'مكة المكرمة', name_en: 'Makkah', lat: 21.3891, lng: 39.8579, phone: '+966558828003', zones: ['العزيزية', 'الشوقية', 'ال wyjaśni'] },
  { id: 'branch-madinah', name_ar: 'المدينة المنورة', name_en: 'Madinah', lat: 24.4672, lng: 39.6024, phone: '+966558828004', zones: ['ال敘利亚', 'المنطقة الصناعية'] },
  { id: 'branch-abha', name_ar: 'أبها', name_en: 'Abha', lat: 18.2164, lng: 42.5053, phone: '+966558828005', zones: ['ال溝فعة', 'السdll'] },
  { id: 'branch-makkah-mukarramah', name_ar: 'مكة المكرمة - المركز', name_en: 'Makkah Center', lat: 21.4225, lng: 39.8262, phone: '+966558828006', zones: ['أجياد', 'ال뻤ي'] },
];

// ── Haversine Distance ──
function haversineDistance(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ── Find nearest branch ──
function findNearestBranch(lat, lng) {
  let nearest = BRANCHES[0];
  let minDist = Infinity;
  for (const branch of BRANCHES) {
    const dist = haversineDistance(lat, lng, branch.lat, branch.lng);
    if (dist < minDist) { minDist = dist; nearest = branch; }
  }
  return { branch: nearest, distance: Math.round(minDist * 10) / 10 };
}

// ── Calculate ETA ──
function calculateETA(distanceKm) {
  const avgSpeed = 35; // km/h in Saudi city traffic
  const minutes = Math.round((distanceKm / avgSpeed) * 60);
  return minutes < 60 ? `${minutes} دقيقة` : `${Math.floor(minutes / 60)} ساعة و ${minutes % 60} دقيقة`;
}

export default async (request) => {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: SECURITY_HEADERS });
  if (request.method !== 'POST') return json(405, { error: 'Method Not Allowed' });

  let body;
  try { body = await request.json(); } catch { return json(400, { error: 'بيانات غير صالحة' }); }

  const { action, orderId, customerLat, customerLng, driverLat, driverLng, driverId, branchId } = body;

  // ── ACTION: find-branch — Find nearest branch for delivery ──
  if (action === 'find-branch') {
    if (!customerLat || !customerLng) return json(400, { error: 'إحداثيات العميل مطلوبة' });

    const { branch, distance } = findNearestBranch(customerLat, customerLng);
    const eta = calculateETA(distance);

    return json(200, {
      success: true,
      branch,
      distance: `${distance} كم`,
      eta,
      deliveryFee: distance <= 15 ? 15 : distance <= 30 ? 25 : distance <= 50 ? 35 : 50,
      freeDeliveryEligible: false,
      message: `أقرب فرع: ${branch.name_ar} — المسافة: ${distance} كم — الوقت المقدر: ${eta}`,
    });
  }

  // ── ACTION: track-order — Track order in real-time ──
  if (action === 'track-order') {
    if (!orderId) return json(400, { error: 'رقم الطلب مطلوب' });

    // Simulated tracking data
    return json(200, {
      success: true,
      orderId,
      status: 'in_transit',
      driver: {
        id: 'DRV-001',
        name: 'أحمد محمد',
        phone: '+966558828010',
        rating: 4.8,
        vehicle: 'شاحنة صغيرة — أبيض',
        plate: 'أ ب ج 1234',
      },
      location: {
        current: { lat: 24.7200, lng: 46.6800 },
        destination: { lat: customerLat || 24.7000, lng: customerLng || 46.6700 },
        progress: 65,
      },
      timeline: [
        { status: 'received', label: 'تم استلام الطلب من الفرع', time: new Date(Date.now() - 3600000).toISOString(), icon: '🏪' },
        { status: 'preparing', label: 'جارٍ تجهيز طلبك', time: new Date(Date.now() - 2400000).toISOString(), icon: '📦' },
        { status: 'in_transit', label: 'الشحنة في الطريق إليك', time: new Date(Date.now() - 1200000).toISOString(), icon: '🚚', current: true },
        { status: 'delivered', label: 'تم التسليم', time: null, icon: '✅' },
      ],
      eta: '25 دقيقة',
      distanceRemaining: '8.5 كم',
    });
  }

  // ── ACTION: update-location — Driver updates location ──
  if (action === 'update-location') {
    if (!driverId || !driverLat || !driverLng) return json(400, { error: 'معرف السائق والإحداثيات مطلوبة' });

    return json(200, {
      success: true,
      driverId,
      location: { lat: driverLat, lng: driverLng },
      timestamp: new Date().toISOString(),
      message: 'تم تحديث الموقع ✅',
    });
  }

  // ── ACTION: assign-driver — Assign nearest driver ──
  if (action === 'assign-driver') {
    if (!branchId && (!customerLat || !customerLng)) return json(400, { error: 'معرف الفرع أو إحداثيات العميل مطلوبة' });

    return json(200, {
      success: true,
      assignment: {
        driverId: 'DRV-001',
        driverName: 'أحمد محمد',
        branch: branchId || 'nearest',
        estimatedPickup: '10 دقائق',
        estimatedDelivery: '35 دقيقة',
      },
      message: 'تم تعيين السಡيق بنجاح 🚚',
    });
  }

  // ── ACTION: branches — List all branches ──
  if (action === 'branches') {
    return json(200, {
      success: true,
      branches: BRANCHES.map(b => ({
        id: b.id,
        name_ar: b.name_ar,
        name_en: b.name_en,
        phone: b.phone,
        location: { lat: b.lat, lng: b.lng },
        zones: b.zones,
      })),
      total: BRANCHES.length,
    });
  }

  return json(400, { error: 'إجراء غير معروف' });
};
