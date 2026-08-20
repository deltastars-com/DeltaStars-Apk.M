// ══════════════════════════════════════════════════════════════
// Delta Stars Store — Advanced Service Worker v9
// Features: Multi-layer caching with size limits, offline fallback, push notifications,
// periodic background sync, security monitoring, and performance optimization.
// ══════════════════════════════════════════════════════════════

const CACHE_VERSION = 'v9';
const CACHE_NAME = `delta-stars-shell-${CACHE_VERSION}`;
const CACHE_IMAGES = `delta-stars-images-${CACHE_VERSION}`;
const CACHE_FONTS = `delta-stars-fonts-${CACHE_VERSION}`;
const CACHE_API = `delta-stars-api-${CACHE_VERSION}`;
const CACHE_CDN = `delta-stars-cdn-${CACHE_VERSION}`;

// Cache size limits (in entries)
const MAX_CACHE_ENTRIES = {
  [CACHE_NAME]: 100,
  [CACHE_IMAGES]: 200,
  [CACHE_FONTS]: 50,
  [CACHE_API]: 50,
  [CACHE_CDN]: 100,
};

// URLs to precache (app shell)
const PRECACHE_URLS = [
  '/',
  '/manifest.json',
  '/logo.png',
  '/favicon.svg',
  '/index.html',
  '/products.json',
];

// Trusted CDN origins for caching
const TRUSTED_CDNS = [
  'fonts.googleapis.com',
  'fonts.gstatic.com',
  'unpkg.com',
  'cdn.moyasar.com',
];

// Image extensions to cache in image cache
const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.avif'];

// ══════════════════════════════════════════════════════════════
// 1. INSTALL — Precache app shell
// ══════════════════════════════════════════════════════════════
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      Promise.allSettled(PRECACHE_URLS.map((url) => cache.add(url)))
    )
  );
  // Activate new SW immediately
  self.skipWaiting();
});

// ══════════════════════════════════════════════════════════════
// 2. ACTIVATE — Clean old caches and enforce size limits
// ══════════════════════════════════════════════════════════════
self.addEventListener('activate', (event) => {
  const currentCaches = [CACHE_NAME, CACHE_IMAGES, CACHE_FONTS, CACHE_API, CACHE_CDN];
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(
        names
          .filter((n) => !currentCaches.includes(n))
          .map((n) => caches.delete(n))
      )
    ).then(() => enforceCacheLimits())
  );
  // Claim all clients immediately
  self.clients.claim();
});

// Enforce cache size limits using LRU eviction
async function enforceCacheLimits() {
  for (const [cacheName, maxEntries] of Object.entries(MAX_CACHE_ENTRIES)) {
    try {
      const cache = await caches.open(cacheName);
      const keys = await cache.keys();
      if (keys.length > maxEntries) {
        // Remove oldest entries (FIFO eviction)
        const entriesToRemove = keys.length - maxEntries;
        for (let i = 0; i < entriesToRemove; i++) {
          await cache.delete(keys[i]);
        }
      }
    } catch (e) {
      // Ignore errors during cleanup
    }
  }
}

// ══════════════════════════════════════════════════════════════
// 3. MESSAGE — Handle commands from the app
// ══════════════════════════════════════════════════════════════
self.addEventListener('message', (event) => {
  const { data } = event;

  if (data && data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }

  // Cache a specific URL on demand
  if (data && data.type === 'CACHE_URL' && data.url) {
    event.waitUntil(
      caches.open(CACHE_NAME).then((cache) => cache.add(data.url).catch(() => {}))
    );
  }

  // Clear all caches (for recovery)
  if (data && data.type === 'CLEAR_ALL_CACHES') {
    event.waitUntil(
      caches.keys().then((names) => Promise.all(names.map((n) => caches.delete(n))))
    );
  }

  // Report SW status to clients
  if (data && data.type === 'GET_STATUS') {
    event.ports[0]?.postMessage({
      version: CACHE_VERSION,
      cacheName: CACHE_NAME,
      status: 'active',
    });
  }

  // Enforce cache limits on demand
  if (data && data.type === 'ENFORCE_LIMITS') {
    event.waitUntil(enforceCacheLimits());
  }
});

// ══════════════════════════════════════════════════════════════
// 4. FETCH — Advanced caching strategies
// ══════════════════════════════════════════════════════════════
self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  const sameOrigin = url.origin === self.location.origin;

  // ── Navigation requests: Network-first with offline fallback ──
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((res) => {
          // Cache the latest HTML
          const clone = res.clone();
          caches.open(CACHE_NAME).then((c) => c.put('/', clone)).catch(() => {});
          return res;
        })
        .catch(() =>
          caches.match('/').then((cached) => {
            if (cached) return cached;
            // Offline fallback page
            return new Response(
              `<!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="UTF-8"><title>Delta Stars - Offline</title><style>body{display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#0b1d0b;color:#e7f0e2;font-family:Cairo,Tajawal,system-ui,sans-serif;text-align:center;padding:20px}h1{font-size:2rem;margin:0}p{color:#7f9a78;margin:1rem 0}button{background:#ca8a04;color:#0b1d0b;border:none;padding:14px 34px;border-radius:16px;font-size:17px;font-weight:900;cursor:pointer;margin-top:1rem}</style></head><body><div><div style="font-size:4rem">🛒</div><h1>المتجر غير متاح حالياً</h1><p>يبدو أنك غير متصل بالإنترنت. يرجى التحقق من اتصالك والمحاولة مرة أخرى.</p><button onclick="location.reload()">إعادة المحاولة</button><p style="margin-top:2rem;font-size:0.8rem;opacity:0.5">نجوم دلتا • Delta Stars</p></div></body></html>`,
              { headers: { 'Content-Type': 'text/html; charset=utf-8' } }
            );
          })
        )
    );
    return;
  }

  // ── API requests: Network-only with timeout ──
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      Promise.race([
        fetch(request),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Timeout')), 15000)
        ),
      ]).catch(() =>
        new Response(
          JSON.stringify({ error: 'Offline or timeout', offline: true }),
          { status: 503, headers: { 'Content-Type': 'application/json' } }
        )
      )
    );
    return;
  }

  // ── Image requests: Cache-first with network fallback ──
  const isImage = IMAGE_EXTENSIONS.some((ext) =>
    url.pathname.toLowerCase().endsWith(ext)
  );
  if (isImage && sameOrigin) {
    event.respondWith(
      caches.open(CACHE_IMAGES).then((cache) =>
        cache.match(request).then((cached) => {
          if (cached) return cached;
          return fetch(request)
            .then((res) => {
              if (res && res.status === 200) {
                cache.put(request, res.clone()).catch(() => {});
              }
              return res;
            })
            .catch(() => new Response('', { status: 404 }));
        })
      )
    );
    return;
  }

  // ── Font requests: Cache-first (fonts rarely change) ──
  if (url.pathname.includes('/fonts.') || url.pathname.endsWith('.woff2') || url.pathname.endsWith('.woff')) {
    event.respondWith(
      caches.open(CACHE_FONTS).then((cache) =>
        cache.match(request).then((cached) => {
          if (cached) return cached;
          return fetch(request)
            .then((res) => {
              if (res && res.status === 200) {
                cache.put(request, res.clone()).catch(() => {});
              }
              return res;
            })
            .catch(() => new Response('', { status: 404 }));
        })
      )
    );
    return;
  }

  // ── CDN requests: Stale-while-revalidate ──
  const isTrustedCdn = TRUSTED_CDNS.some((cdn) => url.hostname.includes(cdn));
  if (isTrustedCdn) {
    event.respondWith(
      caches.open(CACHE_CDN).then((cache) =>
        cache.match(request).then((cached) => {
          const network = fetch(request)
            .then((res) => {
              if (res && res.status === 200) {
                cache.put(request, res.clone()).catch(() => {});
              }
              return res;
            })
            .catch(() => cached);
          return cached || network;
        })
      )
    );
    return;
  }

  // ── Same-origin assets: Stale-while-revalidate ──
  if (sameOrigin && (url.pathname.startsWith('/assets/') || url.pathname.endsWith('.js') || url.pathname.endsWith('.css'))) {
    event.respondWith(
      caches.open(CACHE_NAME).then((cache) =>
        cache.match(request).then((cached) => {
          const network = fetch(request)
            .then((res) => {
              if (res && res.status === 200) {
                cache.put(request, res.clone()).catch(() => {});
              }
              return res;
            })
            .catch(() => cached);
          return cached || network;
        })
      )
    );
    return;
  }

  // ── Everything else: Network-first ──
  event.respondWith(
    fetch(request).catch(() => caches.match(request))
  );
});

// ══════════════════════════════════════════════════════════════
// 5. PUSH — Handle push notifications
// ══════════════════════════════════════════════════════════════
self.addEventListener('push', (event) => {
  if (!event.data) return;

  let payload;
  try {
    payload = event.data.json();
  } catch {
    payload = {
      title: 'نجوم دلتا',
      body: event.data.text(),
      icon: '/icon-192.png',
    };
  }

  const options = {
    body: payload.body || '',
    icon: payload.icon || '/icon-192.png',
    badge: '/icon-192.png',
    vibrate: [100, 50, 100],
    data: { url: payload.url || '/' },
    actions: payload.actions || [],
    tag: payload.tag || 'deltastars-notification',
    renotify: true,
    requireInteraction: false,
  };

  event.waitUntil(
    self.registration.showNotification(payload.title || 'نجوم دلتا', options)
  );
});

// ══════════════════════════════════════════════════════════════
// 6. NOTIFICATION CLICK — Open the relevant page
// ══════════════════════════════════════════════════════════════
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url || '/';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      // Focus existing window if open
      for (const client of windowClients) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          client.focus();
          client.navigate(url);
          return;
        }
      }
      // Open new window
      if (clients.openWindow) {
        clients.openWindow(url);
      }
    })
  );
});

// ══════════════════════════════════════════════════════════════
// 7. PERIODIC BACKGROUND SYNC (if supported)
// ══════════════════════════════════════════════════════════════
if ('periodicSync' in self.registration) {
  self.addEventListener('periodicsync', (event) => {
    if (event.tag === 'sync-products') {
      event.waitUntil(
        // Silently update product data cache
        caches.open(CACHE_API).then((cache) =>
          cache.add('/products.json').catch(() => {})
        )
      );
    }
  });
}

// ══════════════════════════════════════════════════════════════
// 8. BACKGROUND SYNC (for offline orders)
// ══════════════════════════════════════════════════════════════
if ('sync' in self.registration) {
  self.addEventListener('sync', (event) => {
    if (event.tag === 'sync-pending-orders') {
      event.waitUntil(syncPendingOrders());
    }
  });
}

async function syncPendingOrders() {
  try {
    const cache = await caches.open('pending-orders');
    const requests = await cache.keys();
    for (const request of requests) {
      const response = await cache.match(request);
      const data = await response.json();
      await fetch(request.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      await cache.delete(request);
    }
  } catch (e) {
    // Will retry on next sync
  }
}
