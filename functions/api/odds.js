// ============================================================
// functions/api/odds.js  —  Cloudflare Pages Function (بروكسي أودز البريميرليج)
// المسار في الريبو: functions/api/odds.js  →  بيتخدم على /api/odds
// المفتاح بيتقرأ من متغيّر البيئة ODDS_API_KEY (Cloudflare → Pages → Settings → Variables)
// تكلفة الطلب = الأسواق × المناطق = (h2h,totals=2) × (uk=1) = 2 نقطة.
//
// نفس تعديل fpl.js بالظبط (stale-while-revalidate + قفل single-flight):
// باقة الفري بتاعة the-odds-api.com محدودة جدًا (عدد نقط شهري صغير)، فأي
// تكرار للـ fetch تحت ضغط ممكن يخلّص الباقة بسرعة شديدة أو يسبب رفض مؤقت.
// الحل: نسيب النسخة القديمة تتقدّم فورًا لأي طلب، وتحديث واحد بس في الخلفية.
// ============================================================

const CACHE_SECONDS = 21600;        // 6 ساعات — مدة الطزاجة الفعلية
const EDGE_STORE_SECONDS = 6 * 21600; // 36 ساعة — شبكة أمان لو التحديث فشل شوية

const IN_FLIGHT = new Map(); // isolate-level single-flight lock

function jsonResponse(obj, status, extraHeaders) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: Object.assign(
      { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      extraHeaders || {}
    ),
  });
}

async function fetchFreshAndStore(url, cache, cacheKey) {
  const r = await fetch(url);
  if (!r.ok) {
    throw Object.assign(new Error('upstream odds error'), { status: r.status });
  }
  const body = await r.text();

  const response = new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': `public, max-age=${EDGE_STORE_SECONDS}`,
      'X-Cached-At': String(Date.now()),
      'X-Cache-Status': 'MISS',
    },
  });

  await cache.put(cacheKey, response.clone());
  return response;
}

function fetchFreshWithLock(lockKeyStr, url, cache, cacheKey) {
  const existing = IN_FLIGHT.get(lockKeyStr);
  if (existing) return existing;

  const p = fetchFreshAndStore(url, cache, cacheKey).finally(() => {
    IN_FLIGHT.delete(lockKeyStr);
  });
  IN_FLIGHT.set(lockKeyStr, p);
  return p;
}

export async function onRequest(context) {
  const req = context.request;

  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': '*',
      },
    });
  }

  const KEY = context.env.ODDS_API_KEY;
  if (!KEY) {
    return jsonResponse({ error: 'ODDS_API_KEY is not set in Cloudflare variables' }, 500);
  }

  const reqUrl = new URL(req.url);
  const cache = caches.default;
  const cacheKey = new Request(reqUrl.origin + reqUrl.pathname, { method: 'GET' });
  const lockKeyStr = reqUrl.origin + reqUrl.pathname;

  const url = 'https://api.the-odds-api.com/v4/sports/soccer_epl/odds'
            + '?apiKey=' + KEY
            + '&regions=uk'
            + '&markets=h2h,totals'
            + '&oddsFormat=decimal';

  let cached;
  try {
    cached = await cache.match(cacheKey);
  } catch (e) {
    cached = undefined;
  }

  if (cached) {
    const cachedAtStr = cached.headers.get('X-Cached-At');
    const cachedAt = cachedAtStr ? parseInt(cachedAtStr, 10) : 0;
    const ageSeconds = cachedAt ? (Date.now() - cachedAt) / 1000 : Infinity;

    if (ageSeconds < CACHE_SECONDS) {
      const freshHeaders = new Headers(cached.headers);
      freshHeaders.set('X-Cache-Status', 'HIT');
      return new Response(cached.body, { status: cached.status, headers: freshHeaders });
    }

    // قديمة بس موجودة — رجّعها فورًا، وحدّث في الخلفية بقفل عشان محدش يكرر
    // نداء لـ the-odds-api.com ويحرق نقط الباقة من غير داعي
    context.waitUntil(
      fetchFreshWithLock(lockKeyStr, url, cache, cacheKey).catch(() => {})
    );

    const staleHeaders = new Headers(cached.headers);
    staleHeaders.set('X-Cache-Status', 'STALE');
    return new Response(cached.body, { status: cached.status, headers: staleHeaders });
  }

  try {
    const response = await fetchFreshWithLock(lockKeyStr, url, cache, cacheKey);
    return response.clone();
  } catch (e) {
    return jsonResponse({ error: 'odds fetch failed', detail: String(e) }, (e && e.status) || 502);
  }
}
