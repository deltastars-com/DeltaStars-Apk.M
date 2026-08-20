// ══════════════════════════════════════════════════════════════
// Netlify Function: GET /api/health
// Health check endpoint — verifies all critical service
// configurations without exposing secrets or API keys.
// Used by monitoring, uptime checkers, and the frontend
// to show system status.
// ══════════════════════════════════════════════════════════════

const securityHeaders = {
  'Content-Type': 'application/json; charset=utf-8',
  'X-Content-Type-Options': 'nosniff',
  'Cache-Control': 'no-store, no-cache, must-revalidate',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

const json = (status, obj) =>
  new Response(JSON.stringify(obj), { status, headers: securityHeaders });

/**
 * Check if an environment variable is set (not empty).
 * Never prints the value — only reports configured/not-configured.
 */
function checkEnv(name) {
  const val = process.env[name];
  return val ? 'configured' : 'missing';
}

// ══════════════════════════════════════════════════════════════
// MAIN HANDLER
// ══════════════════════════════════════════════════════════════
export default async (request) => {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: securityHeaders });
  }

  if (request.method !== 'GET') {
    return json(405, { error: 'Method Not Allowed' });
  }

  const startTime = Date.now();

  // ── Check service configurations ──
  const services = {
    supabase: {
      url: checkEnv('VITE_SUPABASE_URL'),
      anonKey: checkEnv('VITE_SUPABASE_ANON_KEY'),
      serviceKey: checkEnv('SUPABASE_SERVICE_ROLE_KEY'),
    },
    moyasar: {
      secretKey: checkEnv('MOYASAR_SECRET_KEY'),
      webhookSecret: checkEnv('MOYASAR_WEBHOOK_SECRET'),
      publicKey: checkEnv('VITE_MOYASAR_PUBLIC_KEY'),
    },
    authentica: {
      apiSecret: checkEnv('AUTHENTICA_API_SECRET'),
    },
    gemini: {
      apiKey: checkEnv('GEMINI_API_KEY') !== 'missing'
        ? checkEnv('GEMINI_API_KEY')
        : checkEnv('VITE_GEMINI_API_KEY'),
    },
    upstashRedis: {
      url: checkEnv('UPSTASH_REDIS_REST_URL'),
      token: checkEnv('UPSTASH_REDIS_REST_TOKEN'),
    },
    whatsapp: {
      apiKey: checkEnv('WHATSAPP_API_KEY'),
      phoneId: checkEnv('WHATSAPP_PHONE_ID'),
    },
  };

  // ── Overall status ──
  const allConfigured = (
    services.supabase.url === 'configured' &&
    services.supabase.anonKey === 'configured' &&
    services.moyasar.secretKey === 'configured' &&
    services.authentica.apiSecret === 'configured'
  );

  const partialConfigured = (
    services.gemini.apiKey === 'configured' ||
    services.upstashRedis.url === 'configured' ||
    services.whatsapp.apiKey === 'configured'
  );

  const status = allConfigured ? 'healthy' : partialConfigured ? 'degraded' : 'critical';

  return json(200, {
    status,
    version: process.env.npm_package_version || '3.2.0',
    timestamp: new Date().toISOString(),
    latencyMs: Date.now() - startTime,
    services,
    features: {
      aiAssistant: services.gemini.apiKey === 'configured' ? 'active' : 'local-only',
      rateLimiting: services.upstashRedis.url === 'configured' ? 'distributed' : 'in-memory',
      notifications: services.whatsapp.apiKey === 'configured' ? 'whatsapp' : 'database-only',
      payments: services.moyasar.secretKey === 'configured' ? 'active' : 'inactive',
      otp: services.authentica.apiSecret === 'configured' ? 'active' : 'inactive',
      database: services.supabase.url === 'configured' ? 'connected' : 'disconnected',
    },
  });
};
