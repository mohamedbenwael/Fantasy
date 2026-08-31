// ============================================================
// functions/api/eo.js  —  Cloudflare Pages Function
// المسار في الريبو: functions/api/eo.js  →  بيتخدم على /api/eo
//
// بيقرا بلوب الملكية الفعّالة (EO) اللي كتبه وركر mazareta-eo-refresh في Supabase
// تحت المفتاح eo:latest، ويرجّعه للتطبيق. نفس فكرة /api/odds بالظبط:
// القراءة من Supabase بس + كاش على الـ edge عشان نحمي الـ egress.
//
// ملحوظة: الرابط مكتوب جوّه الكود زي odds.js — عشان Pages عندها SUPABASE_SERVICE_KEY بس
// (مش عندها SUPABASE_URL). المفتاح السرّي موجود أصلاً في إعدادات الموقع.
// ============================================================

const KV_KEY = 'eo:latest';

// نفس رابط Supabase المكتوب في odds.js
const SUPABASE_URL = 'https://mizlabuyvllveverurai.supabase.co';

// كاش على مستوى الـ edge — الـ EO بتتحدّث كل 20 دقيقة (من الوركر)، فـ 5 دقايق طزاجة كافية
// وبتقلّل قراءات Supabase. أثناء اللايف ده يبقى أحدث بكتير من الأودز.
const EDGE_FRESH_SECONDS = 300;      // 5 دقايق "طزاجة"
const EDGE_STORE_SECONDS = 3600;     // ساعة شبكة أمان لو Supabase وقعت لحظيًا

const IN_FLIGHT = new Map(); // قفل single-flight على مستوى الـ isolate

function jsonResponse(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}

// بيقرأ بلوب الـ EO من Supabase، يبنيه كـ Response، يخزّنه في كاش الـ edge، ويرجّعه.
async function readFromSupabaseAndStore(env, cache, cacheKey) {
  const url = SUPABASE_URL + '/rest/v1/mazareta_kv?key=eq.' + encodeURIComponent(KV_KEY) + '&select=value';
  const res = await fetch(url, {
    headers: {
      apikey: env.SUPABASE_SERVICE_KEY,
      Authorization: 'Bearer ' + env.SUPABASE_SERVICE_KEY,
    },
  });
  if (!res.ok) {
    throw Object.assign(new Error('supabase read failed'), { status: 502 });
  }
  const rows = await res.json();
  const value = Array.isArray(rows) && rows.length > 0 ? rows[0].value : null;

  // value المفروض يكون object فيه {gw, eo, cap, ...}. لو مفيش (الوركر لسه ماشتغلش)
  // بنرجّع object فاضي — التطبيق بيتعامل معاه (بيرجع لنسبة الملكية العادية).
  let body;
  if (value == null) body = '{"eo":{},"cap":{}}';
  else if (typeof value === 'string') body = value;        // متخزّن كنص JSON
  else body = JSON.stringify(value);                        // متخزّن كـ jsonb object

  const response = new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=' + EDGE_STORE_SECONDS,
      'X-Cached-At': String(Date.now()),
      'X-EO-Source': 'supabase',
    },
  });

  await cache.put(cacheKey, response.clone());
  return response;
}

function readWithLock(lockKeyStr, env, cache, cacheKey) {
  const existing = IN_FLIGHT.get(lockKeyStr);
  if (existing) return existing;
  const p = readFromSupabaseAndStore(env, cache, cacheKey).finally(() => {
    IN_FLIGHT.delete(lockKeyStr);
  });
  IN_FLIGHT.set(lockKeyStr, p);
  return p;
}

export async function onRequest(context) {
  const req = context.request;
  const env = context.env;

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

  if (!env.SUPABASE_SERVICE_KEY) {
    return jsonResponse({ eo: {}, cap: {}, error: 'إعدادات السيرفر ناقصة (SUPABASE_SERVICE_KEY)' }, 500);
  }

  const reqUrl = new URL(req.url);
  const cache = caches.default;
  const CACHE_VERSION = 'v1';
  const cacheKeyUrl = reqUrl.origin + reqUrl.pathname + '?__cv=' + CACHE_VERSION;
  const cacheKey = new Request(cacheKeyUrl, { method: 'GET' });
  const lockKeyStr = cacheKeyUrl;

  // ===== شوف كاش الـ edge الأول =====
  let cached;
  try { cached = await cache.match(cacheKey); } catch (e) { cached = undefined; }

  if (cached) {
    const cachedAtStr = cached.headers.get('X-Cached-At');
    const cachedAt = cachedAtStr ? parseInt(cachedAtStr, 10) : 0;
    const ageSeconds = cachedAt ? (Date.now() - cachedAt) / 1000 : Infinity;

    if (ageSeconds < EDGE_FRESH_SECONDS) {
      const h = new Headers(cached.headers);
      h.set('X-Cache-Status', 'HIT');
      return new Response(cached.body, { status: cached.status, headers: h });
    }

    // قديمة شوية بس موجودة: رجّعها فورًا، وحدّث من Supabase في الخلفية (بقفل)
    context.waitUntil(
      readWithLock(lockKeyStr, env, cache, cacheKey).catch(() => {})
    );
    const h = new Headers(cached.headers);
    h.set('X-Cache-Status', 'STALE');
    return new Response(cached.body, { status: cached.status, headers: h });
  }

  // ===== مفيش كاش — اقرأ من Supabase (بقفل عشان الطلبات المتزامنة تشارك قراءة واحدة) =====
  try {
    const response = await readWithLock(lockKeyStr, env, cache, cacheKey);
    return response.clone();
  } catch (err) {
    return jsonResponse({ eo: {}, cap: {}, error: 'تعذّر جلب الـ EO', detail: String(err) }, (err && err.status) || 502);
  }
}
