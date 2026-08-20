// ══════════════════════════════════════════════════════════════
// Rate Limiter Utility using Upstash Redis
// Works in serverless environments (Netlify Functions)
// ══════════════════════════════════════════════════════════════

import { Redis } from '@upstash/redis';

// Upstash Redis client
let redis: Redis | null = null;

function getRedis(): Redis | null {
  if (redis) return redis;
  
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  
  if (!url || !token) {
    console.warn('⚠️ Upstash Redis not configured. Using in-memory fallback (not recommended for production).');
    return null;
  }
  
  redis = new Redis({ url, token });
  return redis;
}

// In-memory fallback for development
const memoryStore = new Map<string, { count: number; resetAt: number }>();

/**
 * Check rate limit for a given key
 * @param key - Unique identifier (e.g., IP, phone number)
 * @param limit - Max requests allowed
 * @param windowMs - Time window in milliseconds
 * @returns { allowed: boolean, remaining: number, resetAt: number }
 */
export async function checkRateLimit(
  key: string,
  limit: number,
  windowMs: number
): Promise<{ allowed: boolean; remaining: number; resetAt: number }> {
  const redisClient = getRedis();
  const windowSec = Math.ceil(windowMs / 1000);
  const now = Date.now();
  const resetAt = now + windowMs;

  if (redisClient) {
    // Use Upstash Redis with sliding window
    try {
      const multi = redisClient.multi();
      multi.incr(`ratelimit:${key}`);
      multi.pexpire(`ratelimit:${key}`, windowMs);
      multi.pttl(`ratelimit:${key}`);
      
      const results = await multi.exec();
      const count = results[0] as number;
      const ttl = results[2] as number;
      
      return {
        allowed: count <= limit,
        remaining: Math.max(0, limit - count),
        resetAt: ttl > 0 ? now + ttl : resetAt,
      };
    } catch (error) {
      console.error('Redis rate limit error:', error);
      // Fall through to memory store
    }
  }

  // In-memory fallback (ephemeral in serverless)
  const entry = memoryStore.get(key);
  if (!entry || now > entry.resetAt) {
    memoryStore.set(key, { count: 1, resetAt });
    return { allowed: true, remaining: limit - 1, resetAt };
  }
  
  entry.count++;
  return {
    allowed: entry.count <= limit,
    remaining: Math.max(0, limit - entry.count),
    resetAt: entry.resetAt,
  };
}

/**
 * Create a rate limit response
 */
export function rateLimitResponse(
  retryAfterMs: number,
  message: string = 'تم تجاوز الحد المسموح. يرجى المحاولة لاحقاً.'
): Response {
  const retryAfterSec = Math.ceil(retryAfterMs / 1000);
  return new Response(
    JSON.stringify({ error: message, retryAfter: retryAfterSec }),
    {
      status: 429,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Retry-After': String(retryAfterSec),
        'X-RateLimit-RetryAfter': String(retryAfterSec),
      },
    }
  );
}

/**
 * Get client IP from request headers
 */
export function getClientIP(headers: Headers): string {
  return (
    headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    headers.get('x-real-ip') ||
    headers.get('cf-connecting-ip') ||
    'unknown'
  );
}
