// ============================================================
// functions/api/odds.js  —  Cloudflare Pages Function (بروكسي أودز البريميرليج)
// المسار في الريبو: functions/api/odds.js  →  بيتخدم على /api/odds (نفس اللينك القديم)
// المفتاح بيتقرأ من متغيّر البيئة ODDS_API_KEY (Cloudflare → Pages → Settings → Variables)
// تكلفة الطلب = الأسواق × المناطق = (h2h,totals=2) × (uk=1) = 2 نقطة.
//
// التعديل: استخدام صريح لـ Cloudflare Cache API (caches.default) بنفس منطق
// fpl.js بالظبط — عشان نضمن إن الكاش شغّال فعلياً على مستوى الـ edge، ومش
// معتمدين بس على Cache-Control header اللي ممكن Cloudflare ميحترمهوش تلقائيًا
// لردود الـ Functions. من غير ده، كل زيارة تقريبًا ممكن تضرب the-odds-api.com
// مباشرة، وباقة الفري بتاعتها محدودة جداً وهتخلص بسرعة مع أي حركة حقيقية.
// ============================================================

const CACHE_SECONDS = 21600; // 6 ساعات — نفس المدة القديمة

function jsonResponse(obj, status, extraHeaders) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: Object.assign(
      { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      extraHeaders || {}
    ),
  });
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

  // مفتاح الكاش = رابط الطلب بتاعنا زي ما هو (من غير الـ API key عشان محدش
  // يقدر يشوفه لو حد شاف الـ cache key بأي شكل — مش هيحصل عادي، بس أسلم)
  const reqUrl = new URL(req.url);
  const cache = caches.default;
  const cacheKey = new Request(reqUrl.origin + reqUrl.pathname, { method: 'GET' });

  try {
    const cached = await cache.match(cacheKey);
    if (cached) {
      // HIT — رجّع النسخة المخزنة من غير ما نكلم the-odds-api خالص
      const hitHeaders = new Headers(cached.headers);
      hitHeaders.set('X-Cache-Status', 'HIT');
      return new Response(cached.body, { status: cached.status, headers: hitHeaders });
    }
  } catch (e) {
    // لو حصل أي خطأ في القراءة من الكاش، كمّل عادي زي إنه MISS
  }

  const url = 'https://api.the-odds-api.com/v4/sports/soccer_epl/odds'
            + '?apiKey=' + KEY
            + '&regions=uk'
            + '&markets=h2h,totals'
            + '&oddsFormat=decimal';

  try {
    const r = await fetch(url);
    if (!r.ok) {
      // ردود الخطأ ماتتخزنش في الكاش عشان ميفضلش الخطأ متكرر لكل الزوار
      return jsonResponse({ error: 'upstream odds error', status: r.status }, 502);
    }
    const body = await r.text(); // بنمرّر الرد زي ما هو

    const response = new Response(body, {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': `public, max-age=${CACHE_SECONDS}`,
        'X-Cache-Status': 'MISS',
      },
    });

    // بنخزن نسخة في الكاش من غير ما نستنى (waitUntil بتخلي ده يحصل في الخلفية
    // ومايأخرش الرد اللي راجع للزائر دلوقتي)
    context.waitUntil(cache.put(cacheKey, response.clone()));

    return response;
  } catch (e) {
    return jsonResponse({ error: 'odds fetch failed' }, 502);
  }
}
