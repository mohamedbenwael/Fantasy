/**
 * /api/eo  —  Cloudflare Pages Function  (حطّه في: functions/api/eo.js)
 * ------------------------------------------------------------------
 * بيقرا بلوب الـEO (اللي كتبه وركر mazareta-eo-refresh) من Supabase ويرجّعه للتطبيق.
 * زي /api/odds بالظبط: القراءة من Supabase بس + كاش على الـedge، فترافيك اليوزرز
 * مايضربش أي API خارجي. لو الـ/api بتاعك مش Pages Functions، اعمل نفس اللي في ملف الأودز.
 *
 * Env المطلوبة (نفس بتوع الأودز): SUPABASE_URL, SUPABASE_SERVICE_KEY, (اختياري) KV_TABLE
 */
export async function onRequest(context) {
  const { env } = context;
  const table = env.KV_TABLE || 'mazareta_kv';
  try {
    const url = `${env.SUPABASE_URL}/rest/v1/${table}?key=eq.eo:latest&select=value`;
    const res = await fetch(url, {
      headers: {
        'apikey': env.SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`,
        'Accept': 'application/json'
      },
      cf: { cacheTtl: 300, cacheEverything: true }   // كاش 5 دقايق على الـedge
    });
    if (!res.ok) return json({ eo:{}, cap:{} }, 200, 60);
    const rows = await res.json();
    const value = (rows && rows[0] && rows[0].value) || { eo:{}, cap:{} };
    // كاش 5 دقايق للمتصفح/الـedge، مع stale-while-revalidate عشان السرعة أثناء اللايف
    return json(value, 200, 300);
  } catch (e) {
    return json({ eo:{}, cap:{}, error: String(e && e.message || e) }, 200, 60);
  }
}

function json(obj, status = 200, maxAge = 300) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': `public, max-age=${maxAge}, s-maxage=${maxAge}, stale-while-revalidate=120`
    }
  });
}
