// ══════════════════════════════════════════════════════════════
// Netlify Function: POST /api/analytics/predict
// AI-powered analytics: sales predictions, demand forecasting,
// customer insights, product recommendations.
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

// ── Simple Moving Average ──
function sma(data, period) {
  const result = [];
  for (let i = period - 1; i < data.length; i++) {
    const slice = data.slice(i - period + 1, i + 1);
    result.push(slice.reduce((a, b) => a + b, 0) / period);
  }
  return result;
}

// ── Linear Regression ──
function linearRegression(x, y) {
  const n = x.length;
  if (n === 0) return { slope: 0, intercept: 0 };
  const sumX = x.reduce((a, b) => a + b, 0);
  const sumY = y.reduce((a, b) => a + b, 0);
  const sumXY = x.reduce((a, b, i) => a + b * y[i], 0);
  const sumX2 = x.reduce((a, b) => a + b * b, 0);
  const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX) || 0;
  const intercept = (sumY - slope * sumX) / n;
  return { slope, intercept };
}

export default async (request) => {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: SECURITY_HEADERS });
  if (request.method !== 'POST') return json(405, { error: 'Method Not Allowed' });

  let body;
  try { body = await request.json(); } catch { return json(400, { error: 'بيانات غير صالحة' }); }

  const { action, orders = [], products = [], dateRange } = body;

  // ── ACTION: sales-forecast — Predict future sales ──
  if (action === 'sales-forecast') {
    const dailyRevenue = orders.map(o => ({
      date: o.createdAt ? new Date(o.createdAt).toISOString().split('T')[0] : '',
      revenue: o.total || 0,
    }));

    // Group by date
    const grouped = {};
    dailyRevenue.forEach(d => { grouped[d.date] = (grouped[d.date] || 0) + d.revenue; });
    const dates = Object.keys(grouped).sort();
    const values = dates.map(d => grouped[d]);
    const xVals = dates.map((_, i) => i);

    const { slope, intercept } = linearRegression(xVals, values);
    const avgDaily = values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : 0;

    // Predict next 7 days
    const predictions = [];
    for (let i = 1; i <= 7; i++) {
      const futureIndex = xVals.length + i - 1;
      const predicted = Math.max(0, Math.round((slope * futureIndex + intercept) * 100) / 100);
      const futureDate = new Date();
      futureDate.setDate(futureDate.getDate() + i);
      predictions.push({
        date: futureDate.toISOString().split('T')[0],
        predicted,
        confidence: Math.max(50, 95 - i * 5),
      });
    }

    const trend = slope > 0 ? 'rising' : slope < 0 ? 'falling' : 'stable';

    return json(200, {
      success: true,
      forecast: {
        averageDailyRevenue: Math.round(avgDaily * 100) / 100,
        trend,
        trendStrength: Math.abs(slope).toFixed(2),
        predictions,
        summary: {
          next7DaysTotal: predictions.reduce((a, p) => a + p.predicted, 0),
          bestDay: predictions.reduce((a, p) => p.predicted > a.predicted ? p : a, predictions[0]),
          growthRate: values.length > 1 ? (((values[values.length - 1] - values[0]) / values[0]) * 100).toFixed(1) + '%' : 'N/A',
        },
      },
      insight: trend === 'rising'
        ? '📈 الإيرادات في ارتفاع! استمر في تقديم عروض مميزة.'
        : trend === 'falling'
        ? '📉 هناك هبوط في الإيرادات. يُنصح بمراجعة استراتيجية التسويق.'
        : '📊 الإيرادات مستقرة. حافظ على هذا الأداء.',
    });
  }

  // ── ACTION: demand-forecast — Predict product demand ──
  if (action === 'demand-forecast') {
    const productDemand = {};
    orders.forEach(o => {
      (o.items || []).forEach(item => {
        const name = item.name || item.name_ar || 'غير معروف';
        productDemand[name] = (productDemand[name] || 0) + (item.quantity || 1);
      });
    });

    const sorted = Object.entries(productDemand)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 10);

    return json(200, {
      success: true,
      topProducts: sorted.map(([name, qty]) => ({
        name,
        totalSold: qty,
        avgDaily: (qty / Math.max(1, (dateRange?.days || 30))).toFixed(1),
        demandLevel: qty > 100 ? 'high' : qty > 30 ? 'medium' : 'low',
      })),
      recommendations: sorted.slice(0, 5).map(([name]) => ({
        product: name,
        action: 'increase_stock',
        reason: 'طلب مرتفع',
      })),
    });
  }

  // ── ACTION: customer-insights — Analyze customer behavior ──
  if (action === 'customer-insights') {
    const customerMap = {};
    orders.forEach(o => {
      const name = o.customerName || o.customer?.name || 'عميل مجهول';
      if (!customerMap[name]) customerMap[name] = { orders: 0, totalSpent: 0, lastOrder: null };
      customerMap[name].orders++;
      customerMap[name].totalSpent += o.total || 0;
      if (!customerMap[name].lastOrder || new Date(o.createdAt) > new Date(customerMap[name].lastOrder)) {
        customerMap[name].lastOrder = o.createdAt;
      }
    });

    const customers = Object.entries(customerMap)
      .map(([name, data]) => ({ name, ...data, avgOrder: Math.round(data.totalSpent / data.orders * 100) / 100 }))
      .sort((a, b) => b.totalSpent - a.totalSpent);

    return json(200, {
      success: true,
      totalCustomers: customers.length,
      returningCustomers: customers.filter(c => c.orders > 1).length,
      topCustomers: customers.slice(0, 10),
      segments: {
        vip: customers.filter(c => c.totalSpent > 1000).length,
        regular: customers.filter(c => c.totalSpent > 200 && c.totalSpent <= 1000).length,
        newCustomers: customers.filter(c => c.orders === 1).length,
      },
      insight: `${customers.filter(c => c.orders > 1).length} عميل عائد من أصل ${customers.length} — معدل الاحتفاظ: ${((customers.filter(c => c.orders > 1).length / Math.max(1, customers.length)) * 100).toFixed(0)}%`,
    });
  }

  // ── ACTION: dashboard-stats — Admin dashboard statistics ──
  if (action === 'dashboard-stats') {
    const totalRevenue = orders.reduce((sum, o) => sum + (o.total || 0), 0);
    const completedOrders = orders.filter(o => o.status === 'delivered');
    const pendingOrders = orders.filter(o => o.status === 'pending');
    const cancelledOrders = orders.filter(o => o.status === 'cancelled');
    const today = new Date().toISOString().split('T')[0];
    const todayOrders = orders.filter(o => (o.createdAt || '').startsWith(today));
    const todayRevenue = todayOrders.reduce((sum, o) => sum + (o.total || 0), 0);

    return json(200, {
      success: true,
      stats: {
        totalRevenue,
        totalOrders: orders.length,
        completedOrders: completedOrders.length,
        pendingOrders: pendingOrders.length,
        cancelledOrders: cancelledOrders.length,
        completionRate: orders.length > 0 ? ((completedOrders.length / orders.length) * 100).toFixed(1) + '%' : '0%',
        averageOrderValue: orders.length > 0 ? Math.round(totalRevenue / orders.length * 100) / 100 : 0,
        today: {
          orders: todayOrders.length,
          revenue: todayRevenue,
        },
      },
      products: {
        total: products.length,
        inStock: products.filter(p => p.in_stock !== false).length,
        outOfStock: products.filter(p => p.in_stock === false).length,
      },
    });
  }

  return json(400, { error: 'إجراء غير معروف' });
};
