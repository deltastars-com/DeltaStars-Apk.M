// ══════════════════════════════════════════════════════════════
// netlify/functions/contact-form.ts
// Enhanced contact form handler with advanced security features.
// Features: Rate limiting via Upstash Redis, input sanitization, anti-spam, security headers.
// ══════════════════════════════════════════════════════════════

import { Handler } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';
import { Redis } from '@upstash/redis';

// ── Supabase setup ──────────────────────────────────────────
const supabaseUrl = process.env.VITE_SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.VITE_SUPABASE_ANON_KEY;
const supabase = supabaseUrl && supabaseServiceKey ? createClient(supabaseUrl, supabaseServiceKey) : null;

// ── Upstash Redis client ──────────────────────────────────────
let redis: Redis | null = null;
function getRedis(): Redis | null {
  if (redis) return redis;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  redis = new Redis({ url, token });
  return redis;
}

// ── Rate limiting ────────────────────────────────────────────
async function checkRateLimit(key: string, limit: number, windowMs: number): Promise<{ allowed: boolean; remaining: number; resetAt: number }> {
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
      const count = results[0] as number;
      const ttl = results[2] as number;
      return { allowed: count <= limit, remaining: Math.max(0, limit - count), resetAt: ttl > 0 ? now + ttl : resetAt };
    } catch (e) {
      console.error('Redis rate limit error:', e);
    }
  }

  // In-memory fallback (ephemeral in serverless)
  const memoryStore = (globalThis as any).__rateLimitStore || ((globalThis as any).__rateLimitStore = new Map());
  const entry = memoryStore.get(key);
  if (!entry || now > entry.resetAt) {
    memoryStore.set(key, { count: 1, resetAt });
    return { allowed: true, remaining: limit - 1, resetAt };
  }
  entry.count++;
  return { allowed: entry.count <= limit, remaining: Math.max(0, limit - entry.count), resetAt: entry.resetAt };
}

// ── Input validation & sanitization ──────────────────────────
const isValidEmail = (email: string): boolean => {
  const regex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
  return regex.test(email) && email.length <= 254;
};

const isValidLength = (text: string, maxLength: number = 2000): boolean => {
  return text.length > 0 && text.length <= maxLength;
};

const sanitizeInput = (text: string): string => {
  return text
    .replace(/[<>]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
    .replace(/\\/g, '')
    .replace(/`/g, '')
    .trim()
    .slice(0, 2000);
};

// ── Security headers ─────────────────────────────────────────
const securityHeaders: Record<string, string> = {
  'Content-Type': 'application/json',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Cache-Control': 'no-store, no-cache, must-revalidate',
  'Access-Control-Allow-Origin': 'https://deltastars.store',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// ── Email notification (optional) ────────────────────────────
async function sendEmailNotification(data: {
  name: string;
  email: string;
  subject: string;
  message: string;
}): Promise<void> {
  const sendgridKey = process.env.SENDGRID_API_KEY;
  const contactEmail = process.env.CONTACT_EMAIL || 'info@deltastars-ksa.com';
  if (!sendgridKey) return;

  try {
    await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${sendgridKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        personalizations: [{
          to: [{ email: contactEmail }],
          subject: `📩 رسالة جديدة من ${data.name}: ${data.subject}`,
        }],
        from: { email: 'noreply@deltastars.store', name: 'دلتا ستارز' },
        reply_to: { email: data.email, name: data.name },
        content: [{
          type: 'text/html',
          value: `
            <h2>📬 رسالة جديدة من نموذج الاتصال</h2>
            <p><strong>الاسم:</strong> ${data.name}</p>
            <p><strong>البريد:</strong> ${data.email}</p>
            <p><strong>الموضوع:</strong> ${data.subject}</p>
            <p><strong>الرسالة:</strong></p>
            <div style="background:#f5f5f5;padding:16px;border-radius:8px;">${data.message}</div>
            <hr/>
            <p style="color:#999;font-size:12px;">تم الإرسال من نموذج الاتصال في متجر دلتا ستارز</p>
          `,
        }],
      }),
    });
  } catch (error) {
    console.error('Email send error:', error);
  }
}

// ── Main handler ─────────────────────────────────────────────
export const handler: Handler = async (event) => {
  // CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: securityHeaders, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: { ...securityHeaders, Allow: 'POST' }, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  // Rate limiting
  const clientIP = event.headers['x-forwarded-for']?.split(',')[0] || event.headers['client-ip'] || 'unknown';
  const rateLimit = await checkRateLimit(`contact:${clientIP}`, 3, 300000); // 3 per 5 minutes
  if (!rateLimit.allowed) {
    const retryAfter = Math.ceil((rateLimit.resetAt - Date.now()) / 1000);
    return {
      statusCode: 429,
      headers: { ...securityHeaders, 'Retry-After': String(retryAfter) },
      body: JSON.stringify({ error: 'تم تجاوز الحد المسموح. يرجى المحاولة بعد دقائق.', retryAfter }),
    };
  }

  // Parse body
  let body: Record<string, any> = {};
  try {
    if (event.headers['content-type']?.includes('application/json')) {
      body = JSON.parse(event.body || '{}');
    } else {
      const params = new URLSearchParams(event.body || '');
      body = Object.fromEntries(params);
    }
  } catch {
    return { statusCode: 400, headers: securityHeaders, body: JSON.stringify({ error: 'Invalid request body' }) };
  }

  const { name, email, subject, message, website, confirm_email } = body;

  // Honeypot (anti-bot)
  if (website || confirm_email) {
    console.warn('Spam detected: honeypot field filled');
    return { statusCode: 200, headers: securityHeaders, body: JSON.stringify({ message: 'تم استلام رسالتك بنجاح' }) };
  }

  // Validate required fields
  if (!name || !email || !subject || !message) {
    return { statusCode: 400, headers: securityHeaders, body: JSON.stringify({ error: 'جميع الحقول مطلوبة' }) };
  }

  if (!isValidEmail(email)) {
    return { statusCode: 400, headers: securityHeaders, body: JSON.stringify({ error: 'البريد الإلكتروني غير صحيح' }) };
  }

  if (!isValidLength(name, 100) || !isValidLength(subject, 200) || !isValidLength(message, 2000)) {
    return { statusCode: 400, headers: securityHeaders, body: JSON.stringify({ error: 'بعض الحقول تجاوزت الحد المسموح' }) };
  }

  const cleanName = sanitizeInput(name);
  const cleanEmail = sanitizeInput(email);
  const cleanSubject = sanitizeInput(subject);
  const cleanMessage = sanitizeInput(message);

  // Store in Supabase
  if (supabase) {
    try {
      const { error: insertError } = await supabase.from('contact_submissions').insert({
        name: cleanName,
        email: cleanEmail,
        subject: cleanSubject,
        message: cleanMessage,
        ip_address: clientIP,
        user_agent: event.headers['user-agent'] || null,
        created_at: new Date().toISOString(),
      });
      if (insertError) {
        console.error('Supabase insert error:', insertError);
      }
    } catch (error) {
      console.error('Supabase insert error:', error);
    }
  }

  // Send email notification
  await sendEmailNotification({ name: cleanName, email: cleanEmail, subject: cleanSubject, message: cleanMessage });

  return {
    statusCode: 200,
    headers: securityHeaders,
    body: JSON.stringify({ success: true, message: 'تم استلام رسالتك بنجاح. سنتواصل معك قريباً.' }),
  };
};
