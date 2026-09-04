// ============================================================
// functions/api/form.js  —  Cloudflare Pages Function
// المسار في الريبو: functions/api/form.js  →  بيتخدم على /api/form
//
// بيقرا بلوب "فورم الأداء الحديث" (xG/xA/دقايق آخر جولات لكل لاعب) اللي بيكتبه
// وركر mazareta-form-refresh في Supabase تحت المفتاح form:latest، ويرجّعه للتطبيق.
// نسخة طبق الأصل من api/eo.js — قراءة من Supabase بس + كاش على الـ edge.
//
// التطبيق بيقرا الشكل ده: { "form": { "233": {"xg90":..,"xa90":..,"mins":..,"starts":..,"n":..}, ... } }
// ولو البلوب فاضي (الوركر لسه ماشتغلش) بيرجع لإحصائيات الموسم عادي — فمفيش أي ضرر.
// ============================================================

const KV_KEY = 'form:latest';

// نفس رابط Supabase المكتوب في eo.js / odds.js
const SUPABASE_URL = 'https://mizlabuyvllveverurai.supabase.co';

// الفورم بيتحدّث مرة يوميًا (من الوركر)، فطزاجة نص ساعة كفاية جدًا وبتقلّل قراءات Supabase.
const EDGE_FRESH_SECONDS = 1800;     // 30 دقيقة "طزاجة"
const EDGE_STORE_SECONDS = 21600;    // 6 ساعات شبكة أمان لو Supabase وقعت لحظيًا

const IN_FLIGHT = new Map(); // قفل single-flight على مستوى الـ isolate

function jsonResponse(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}

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

  // value المفروض يكون object فيه {form:{...}}. لو مفيش، بنرجّع بلوب فاضي (التطبيق بيتعامل معاه).
  let body;
  if (value == null) body = '{"form":{}}';
  else if (typeof value === 'string') body = value;        // متخزّن كنص JSON
  else body = JSON.stringify(value);                        // متخزّن كـ jsonb object

  const response = new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=' + EDGE_STORE_SECONDS,
      'X-Cached-At': String(Date.now()),
      'X-Form-Source': 'supabase',
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
    return jsonResponse({ form: {}, error: 'إعدادات السيرفر ناقصة (SUPABASE_SERVICE_KEY)' }, 500);
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
    return jsonResponse({ form: {}, error: 'تعذّر جلب الفورم', detail: String(err) }, (err && err.status) || 502);
  }
}
