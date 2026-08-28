// Service Worker — بيخلي الموقع "قابل للتثبيت" (شرط أساسي لتغليفه كتطبيق أندرويد)
// + بيستقبل إشعارات Push حقيقية حتى لو التطبيق مقفول
//
// ملاحظة عن التعديل: رفعنا رقم النسخة (v2) عشان أول ما الـ SW الجديد يتفعّل يمسح
// الكاش القديم، فالتليفون يجيب نسخة index.html الجديدة من الشبكة بدل ما يفضل ماسك
// نسخة قديمة. وكمان وسّعنا استثناء الكاش ليشمل كل /api/ (مش /api/fpl بس) — عشان
// أي بيانات لايف (النقط/الماتشات) متتخزنش أبدًا وتفضل حيّة على طول.
const CACHE_NAME = 'mazareta-fpl-v2';
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

  // متعملش كاش لأي طلب API — لازم يفضل لايف دايمًا (النقط/الماتشات/اللاعب اللي بيلعب)
  if (event.request.url.includes('/api/')) return;

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

// ===== إشعارات Push — استقبال حدث جديد من السيرفر =====
// - التطبيق مفتوح وظاهر قدام المستخدم → نسيبه لصوت/تنبيه الأحداث اللي جوه التطبيق
//   (من غير بانر نظام مكرر). آمن لأن فيه نافذة ظاهرة، فكروم مش هيعرض إشعار افتراضي.
// - مقفول / في الخلفية / الموبايل مقفّل → بانر النظام الكامل + اهتزاز حسب نوع الحدث.
self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch (e) {
    payload = { title: 'المزاريطة فانتازي', body: event.data ? event.data.text() : '' };
  }

  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const visible = wins.some((c) => c.visibilityState === 'visible');

    if (visible) {
      // التطبيق مفتوح وظاهر — سيبه لصوت الأحداث اللي جوه التطبيق، وبلاش بانر مكرر
      wins.forEach((c) => { try { c.postMessage({ type: 'mz-push', data: payload }); } catch (e) {} });
      return;
    }

    const kind = payload.kind;
    const vibrate = payload.vibrate || (
      kind === 'goal'   ? [80, 40, 120, 40, 180] :
      kind === 'red'    ? [200, 80, 200] :
      kind === 'csleak' ? [60, 40, 60] :
                          [80, 40, 80]
    );

    await self.registration.showNotification(payload.title || 'المزاريطة فانتازي', {
      body: payload.body || '',
      icon: payload.icon || '/icon-192.png',
      badge: payload.badge || '/icon-192.png',
      dir: 'rtl',
      lang: 'ar',
      tag: payload.tag || undefined,       // لو فيه tag، الإشعارات الجديدة بتستبدل القديمة بدل ما تتكوم
      renotify: !!payload.tag,
      data: { url: payload.url || '/' },   // نستخدمه لما اليوزر يدوس على الإشعار
      vibrate,
    });
  })());
});

// ===== لما اليوزر يدوس على الإشعار — نفتحله التطبيق (أو نركز على تاب مفتوح أصلاً) =====
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || '/';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      for (const client of windowClients) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          return client.focus();
        }
      }
      if (clients.openWindow) return clients.openWindow(targetUrl);
    })
  );
});

// ===== لو الاشتراك انتهت صلاحيته (نادر) — نحاول نجدده تلقائيًا =====
// التطبيق (index.html) هيحدّث النسخة الجديدة عند أول فتح بعد كده
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(
    self.registration.pushManager
      .subscribe(event.oldSubscription ? event.oldSubscription.options : { userVisibleOnly: true })
      .catch(() => {})
  );
});
