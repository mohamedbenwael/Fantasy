// ============================================================
// functions/api/fpl.js  —  Cloudflare Pages Function
// بروكسي بين الموقع والـ API الرسمي لفانتازي البريميرليج (fantasy.premierleague.com)
// المسار في الريبو: functions/api/fpl.js  →  بيتخدم على /api/fpl
//
// ============================================================
// ليه اتعدّل الملف ده (بعد اختبار k6 كشف مشكلة حقيقية):
// -----------------------------------------------------------
// الكود القديم كان بيعمل: لو الكاش فاضي (MISS)، كل طلب بيعمل fetch مستقل
// لـ FPL API. المشكلة: لما الكاش بينتهي (بعد CACHE_SECONDS) ويوصل عدد كبير
// من الطلبات في نفس اللحظة (زي اختبار الضغط)، كل الطلبات دي بتشوف MISS
// في نفس اللحظة (لسه محدش سجّل حاجة)، فكلهم بيعملوا fetch لـ FPL API مرة
// واحدة → مئات الطلبات المتزامنة لسيرفر FPL، اللي بيبطّئ/يرفض الرد.
// ده اللي فسّر نجاح bootstrap 22% بس تحت ضغط 300 مستخدم.
//
// الحل الجديد (Stale-While-Revalidate):
// 1. بنسيب النسخة القديمة متخزنة في الكاش لمدة أطول بكتير من فترة "الصلاحية"
//    الفعلية (EDGE_STORE_SECONDS)، وبنسجل وقت التخزين في هيدر X-Cached-At.
// 2. لو الطلب جه والكاش لسه "طازة" (أصغر من CACHE_SECONDS) → بنرجعها فورًا.
// 3. لو الكاش "قديم" بس لسه موجود (خلال EDGE_STORE_SECONDS) → **برضو بنرجعها
//    فورًا** للمستخدم (بدل ما نسيبه يستنى)، وفي الخلفية بس (waitUntil) بنبعت
//    طلب واحد يحدّث الكاش — مش كل الطلبات بتعمل ده، فيه قفل (IN_FLIGHT) بيمنع
//    التكرار على مستوى نفس الـ isolate.
// 4. لو مفيش كاش خالص (أول مرة أو الكاش اتمسح) → بنستخدم نفس القفل عشان
//    الطلبات المتزامنة اللي بتوصل لنفس الـ isolate تشارك fetch واحد بدل ما
//    كل واحدة تعمل fetch منفصل.
// النتيجة العملية: تحت ضغط عالي، شبه كل الطلبات بتاخد رد فوري من الكاش
// (طازة أو قديم شوية)، وعدد الطلبات الفعلية اللي بتوصل لـ FPL API بيقل
// من "مئات في نفس اللحظة" لـ "واحد أو اتنين كل فترة تحديث".
// ============================================================

const BASE = 'https://fantasy.premierleague.com/api';

// مدة "الطزاجة" — قبلها بنرجع الكاش من غير ما نفكر نحدّثه خالص.
const CACHE_SECONDS = {
  bootstrap: 120,
  fixtures: 25,   // كان 60 ثم 300 — نزّلناه لـ25 عشان النتيجة ودقيقة الماتش يتحدّثوا بنفس سرعة نقط اللاعبين (اللايف) بالظبط، ومايحصلش إن النقط تتحرك والنتيجة تفضل قدام
  live: 25,       // كان 60 — نقط اللاعبين تتحدّث أسرع لما الفانتازي تنزّلها
  entry: 60,
  picks: 300,
  standings: 120,
};

// مدة التخزين الفعلية على الـ edge (أطول بكتير من الطزاجة) — الهدف إن
// النسخة القديمة تفضل موجودة كـ "شبكة أمان" لحد ما التحديث في الخلفية ينجح،
// حتى لو التحديث فشل مرة أو اتنين (مشكلة مؤقتة في FPL API مثلاً).
const EDGE_STORE_SECONDS = {
  bootstrap: 3600,   // ساعة
  // fixtures و live نزّلنا شبكة الأمان بتاعتهم لدقيقتين بس: من غير كده لو التحديث في
  // الخلفية فشل على data-center معيّن (مثلاً FPL رفض الطلب من الكولو ده)، الكولو ده
  // ممكن يفضل يرجّع نسخة قديمة لحد ساعة/١٠ دقايق — وده اللي بيخلي جهاز يشوف الدقيقة ٢٢
  // وجهاز تاني على كولو مختلف يشوف الدقيقة ١٣. بحد أقصى دقيقتين أي كولو بيجيب نسخة طازة.
  fixtures: 120,
  live: 120,
  entry: 1800,
  picks: 3600,
  standings: 1800,
};

const UPSTREAM_TIMEOUT_MS = 8000;

// قفل بسيط على مستوى الـ isolate (مش موزّع/global، بس بيقلل التكرار
// بشكل كبير عشان Cloudflare غالبًا بتوجّه طلبات متتالية/متقاربة لنفس الـ isolate)
const IN_FLIGHT = new Map(); // cacheKeyString -> Promise<Response>

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

// بتجيب نسخة جديدة من FPL، تبنيها كـ Response، تخزنها في الكاش، وترجعها.
// دايمًا await على cache.put هنا (مش waitUntil) عشان نضمن إن أي طلب جاي
// فورًا بعد كده يلاقي الكاش محدّث فعلاً، مش يدخل في نفس السباق تاني.
async function fetchFreshAndStore(target, cache, cacheKey, secs, edgeStoreSecs) {
  const upstream = await fetchWithTimeout(target, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'en-US,en;q=0.9,ar;q=0.8',
      'Referer': 'https://fantasy.premierleague.com/',
    },
  }, UPSTREAM_TIMEOUT_MS);

  if (!upstream.ok) {
    throw Object.assign(new Error('upstream not ok'), { status: upstream.status });
  }

  const body = await upstream.text(); // بنمرّر الـ JSON زي ما هو (من غير parse/stringify تاني)

  const response = new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      // max-age كبيرة على مستوى الـ edge — الطزاجة الفعلية بنتحكم فيها إحنا
      // بمقارنة X-Cached-At، مش بانتهاء الكاش نفسه
      'Cache-Control': `public, max-age=${edgeStoreSecs}`,
      'X-Cached-At': String(Date.now()),
      'X-Cache-Status': 'MISS',
    },
  });

  await cache.put(cacheKey, response.clone());
  return response;
}

// بتلف حوالين fetchFreshAndStore بقفل single-flight عشان الطلبات المتزامنة
// (سواء أول مرة، أو تحديث خلفي) تشارك نفس الـ promise بدل ما تكرر الـ fetch.
function fetchFreshWithLock(lockKeyStr, target, cache, cacheKey, secs, edgeStoreSecs) {
  const existing = IN_FLIGHT.get(lockKeyStr);
  if (existing) return existing;

  const p = fetchFreshAndStore(target, cache, cacheKey, secs, edgeStoreSecs).finally(() => {
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

  const secs = CACHE_SECONDS[cacheBucket] || 120;
  const edgeStoreSecs = EDGE_STORE_SECONDS[cacheBucket] || 1800;

  const cache = caches.default;
  const cacheKey = new Request(reqUrl.toString(), { method: 'GET' });
  const lockKeyStr = reqUrl.toString();

  // ===== خطوة 1: شوف لو فيه نسخة متخزنة أصلاً (طازة أو قديمة) =====
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

    if (ageSeconds < secs) {
      // طازة — رجّعها فورًا، مفيش أي داعي نكلم FPL
      const freshHeaders = new Headers(cached.headers);
      freshHeaders.set('X-Cache-Status', 'HIT');
      return new Response(cached.body, { status: cached.status, headers: freshHeaders });
    }

    // قديمة بس لسه موجودة: رجّعها فورًا للمستخدم (تجربة أسرع بكتير من الانتظار)
    // وابعت تحديث في الخلفية — بالقفل، عشان مايتكررش مع كل طلب واصل دلوقتي
    context.waitUntil(
      fetchFreshWithLock(lockKeyStr, target, cache, cacheKey, secs, edgeStoreSecs).catch(() => {
        // لو التحديث في الخلفية فشل، محدش هياخد error — النسخة القديمة
        // هتفضل موجودة وهنجرب تاني في الطلب اللي بعده
      })
    );

    const staleHeaders = new Headers(cached.headers);
    staleHeaders.set('X-Cache-Status', 'STALE');
    return new Response(cached.body, { status: cached.status, headers: staleHeaders });
  }

  // ===== خطوة 2: مفيش كاش خالص (أول مرة / اتمسح) — لازم نستنى رد حقيقي =====
  // بنستخدم نفس القفل عشان الطلبات المتزامنة اللي وصلت لنفس الـ isolate
  // في نفس اللحظة تشارك fetch واحد بدل ما كل واحدة تضرب FPL لوحدها.
  try {
    const response = await fetchFreshWithLock(lockKeyStr, target, cache, cacheKey, secs, edgeStoreSecs);
    return response.clone();
  } catch (err) {
    const timedOut = err && err.name === 'AbortError';
    const status = (err && err.status) || 504;
    return jsonResponse({
      error: timedOut
        ? 'FPL API ماردتش خلال الوقت المسموح (Timeout). جرب تاني كمان شوية'
        : 'تعذّر جلب البيانات من FPL',
      detail: String(err),
    }, status === 200 ? 502 : status);
  }
}
