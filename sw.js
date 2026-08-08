// Service Worker بسيط — بيخلي الموقع "قابل للتثبيت" (شرط أساسي لتغليفه كتطبيق أندرويد)
const CACHE_NAME = 'mazareta-fpl-v1';
const CORE_ASSETS = ['/'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(CORE_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// استراتيجية: جرب الشبكة الأول (عشان بيانات الفانتازي لازم تكون لايف)، ولو فشل استخدم الكاش
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  // متعملش كاش لطلبات الـ API — لازم تفضل لايف دايمًا
  if (event.request.url.includes('/api/fpl')) return;

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const clone = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
