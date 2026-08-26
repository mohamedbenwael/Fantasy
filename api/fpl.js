// ============================================================
// functions/api/fpl.js  —  Cloudflare Pages Function
// بروكسي بين الموقع والـ API الرسمي لفانتازي البريميرليج (fantasy.premierleague.com)
// المسار في الريبو: functions/api/fpl.js  →  بيتخدم على /api/fpl (نفس اللينك القديم)
// (نفس منطق نسخة Vercel بالظبط — اتحوّل بس لصيغة Cloudflare: onRequest + Response)
//
// أمثلة الاستخدام:
//   /api/fpl?type=bootstrap
//   /api/fpl?type=fixtures    |  /api/fpl?type=fixtures&event=5
//   /api/fpl?type=live&event=5
//   /api/fpl?type=entry&id=123456
//   /api/fpl?type=picks&id=123456&event=5
//   /api/fpl?type=standings&id=987&page=1
// ============================================================

const BASE = 'https://fantasy.premierleague.com/api';

const CACHE_SECONDS = {
  bootstrap: 120,
  fixtures: 300,
  live: 60,
  entry: 60,
  picks: 300,
  standings: 120,
};

const UPSTREAM_TIMEOUT_MS = 8000;

// رد JSON موحّد مع هيدر CORS
function jsonResponse(obj, status, extraHeaders) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: Object.assign(
      { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      extraHeaders || {}
    ),
  });
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, Object.assign({}, options, { signal: controller.signal }));
  } finally {
    clearTimeout(timer);
  }
}

export async function onRequest(context) {
  const req = context.request;

  // preflight (احتياطي — عادةً مش محتاجينه لأن الطلب same-origin)
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

  const reqUrl = new URL(req.url);
  const type  = reqUrl.searchParams.get('type');
  const event = reqUrl.searchParams.get('event');
  const id    = reqUrl.searchParams.get('id');
  const page  = reqUrl.searchParams.get('page');

  let target;
  let cacheBucket = 'bootstrap';

  if (type === 'bootstrap') {
    target = `${BASE}/bootstrap-static/`;
    cacheBucket = 'bootstrap';
  } else if (type === 'fixtures') {
    target = event ? `${BASE}/fixtures/?event=${encodeURIComponent(event)}` : `${BASE}/fixtures/`;
    cacheBucket = 'fixtures';
  } else if (type === 'live') {
    if (!event) return jsonResponse({ error: 'محتاج تحدد رقم الجولة: ?type=live&event=5' }, 400);
    target = `${BASE}/event/${encodeURIComponent(event)}/live/`;
    cacheBucket = 'live';
  } else if (type === 'entry') {
    if (!id) return jsonResponse({ error: 'محتاج تحدد رقم الفريق: ?type=entry&id=123456' }, 400);
    target = `${BASE}/entry/${encodeURIComponent(id)}/`;
    cacheBucket = 'entry';
  } else if (type === 'picks') {
    if (!id || !event) return jsonResponse({ error: 'محتاج تحدد رقم الفريق ورقم الجولة: ?type=picks&id=123456&event=5' }, 400);
    target = `${BASE}/entry/${encodeURIComponent(id)}/event/${encodeURIComponent(event)}/picks/`;
    cacheBucket = 'picks';
  } else if (type === 'standings') {
    if (!id) return jsonResponse({ error: 'محتاج تحدد رقم الدوري: ?type=standings&id=987654' }, 400);
    const pageNum = page ? encodeURIComponent(page) : '1';
    target = `${BASE}/leagues-classic/${encodeURIComponent(id)}/standings/?page_standings=${pageNum}`;
    cacheBucket = 'standings';
  } else {
    return jsonResponse({ error: "نوع غير معروف. استخدم type=bootstrap أو type=fixtures أو type=live أو type=entry أو type=picks أو type=standings" }, 400);
  }

  try {
    const upstream = await fetchWithTimeout(target, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9,ar;q=0.8',
        'Referer': 'https://fantasy.premierleague.com/',
      },
    }, UPSTREAM_TIMEOUT_MS);

    if (!upstream.ok) {
      return jsonResponse({ error: 'فشل الاتصال بـ FPL API', status: upstream.status }, upstream.status);
    }

    const body = await upstream.text(); // بنمرّر الـ JSON زي ما هو
    const secs = CACHE_SECONDS[cacheBucket] || 120;
    return jsonResponse(JSON.parse(body), 200, {
      'Cache-Control': `s-maxage=${secs}, stale-while-revalidate=${secs * 5}`,
    });
  } catch (err) {
    const timedOut = err && err.name === 'AbortError';
    return jsonResponse({
      error: timedOut
        ? 'FPL API ماردتش خلال الوقت المسموح (Timeout). جرب تاني كمان شوية'
        : 'تعذّر جلب البيانات من FPL',
      detail: String(err),
    }, 504);
  }
}
