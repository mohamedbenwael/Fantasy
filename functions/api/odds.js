// ============================================================
// functions/api/odds.js  —  Cloudflare Pages Function (النسخة الجديدة)
// المسار في الريبو: functions/api/odds.js  →  بيتخدم على /api/odds
//
// ▲ الفرق عن النسخة القديمة:
// النسخة القديمة كانت بتنادي the-odds-api مباشرة (مع كاش SWR على الـ edge). المشكلة:
// القفل كان per-isolate مش global، فكل isolate في كل موقع (colo) كان ممكن يعمل نداء
// لوحده لما الكاش يقدُم → استهلاك نقط الباقة (500/شهر بس) ممكن يعدّي الحد فجأة
// من غير ما تاخد بالك، والأودز تختفي من التطبيق.
//
// النسخة دي: /api/odds مبيكلّمش the-odds-api خالص. Worker منفصل (Cron كل 6 ساعات)
// بيجيب الأودز مرة واحدة عالميًا ويخزّنها في Supabase (المفتاح fpl_odds_cache_v1).
// /api/odds بيقرأ من Supabase بس، مع كاش على الـ edge عشان يقلّل قراءات Supabase
// (يحمي الـ egress). فمهما وصل عدد المستخدمين، نداءات the-odds-api = ثابتة (من الـ Worker).
//
// شكل الرد لسه نفسه بالظبط (Array من المباريات) — فالفرونت إند مش محتاج أي تعديل.
// ============================================================

const KV_KEY = 'fpl_odds_cache_v1';

// رابط Supabase مكتوب مباشرة زي ما هو في kv.js — عشان منحتاجش نضيف متغيّر SUPABASE_URL
// في إعدادات الـ Pages (اللي محتاجينه بس هو SUPABASE_SERVICE_KEY، وهو موجود أصلاً).
const SUPABASE_URL = 'https://mizlabuyvllveverurai.supabase.co';

// كاش على مستوى الـ edge — الأودز الأصلية بتتحدّث كل 6 ساعات بس، فـ 15 دقيقة كاش
// بتقلّل قراءات Supabase لأقصى درجة من غير ما البيانات تبقى قديمة فعليًا.
const EDGE_FRESH_SECONDS = 900;      // 15 دقيقة "طزاجة"
const EDGE_STORE_SECONDS = 6 * 3600; // 6 ساعات شبكة أمان لو Supabase وقعت لحظيًا

const IN_FLIGHT = new Map(); // قفل single-flight على مستوى الـ isolate

function jsonResponse(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}

// بيقرأ قيمة الأودز المخزّنة من Supabase، يبنيها كـ Response، يخزّنها في كاش الـ edge، ويرجّعها.
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

  // value المفروض يكون نص JSON لـ Array. لو مفيش أي قيمة (الـ Worker لسه ماشتغلش)
  // بنرجّع Array فاضي — الفرونت إند بيتعامل مع ده تلقائيًا (بيرجع للموديل العادي بدون أودز).
  const body = (typeof value === 'string' && value.length) ? value : '[]';

  const response = new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=' + EDGE_STORE_SECONDS,
      'X-Cached-At': String(Date.now()),
      'X-Odds-Source': 'supabase',
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
    return jsonResponse({ error: 'إعدادات السيرفر ناقصة (SUPABASE_SERVICE_KEY)' }, 500);
  }

  const reqUrl = new URL(req.url);
  const cache = caches.default;
  const cacheKey = new Request(reqUrl.origin + reqUrl.pathname, { method: 'GET' });
  const lockKeyStr = reqUrl.origin + reqUrl.pathname;

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
    return jsonResponse({ error: 'تعذّر جلب الأودز', detail: String(err) }, (err && err.status) || 502);
  }
}
