// ============================================================
// functions/api/odds.js  —  Cloudflare Pages Function (بروكسي أودز البريميرليج)
// المسار في الريبو: functions/api/odds.js  →  بيتخدم على /api/odds (نفس اللينك القديم)
// المفتاح بيتقرأ من متغيّر البيئة ODDS_API_KEY (Cloudflare → Pages → Settings → Variables)
// تكلفة الطلب = الأسواق × المناطق = (h2h,totals=2) × (uk=1) = 2 نقطة.
// ============================================================
export async function onRequest(context) {
  const KEY = context.env.ODDS_API_KEY;
  if (!KEY) {
    return new Response(JSON.stringify({ error: 'ODDS_API_KEY is not set in Cloudflare variables' }), {
      status: 500, headers: { 'Content-Type': 'application/json' }
    });
  }
  const url = 'https://api.the-odds-api.com/v4/sports/soccer_epl/odds'
            + '?apiKey=' + KEY
            + '&regions=uk'
            + '&markets=h2h,totals'
            + '&oddsFormat=decimal';
  try {
    const r = await fetch(url);
    if (!r.ok) {
      return new Response(JSON.stringify({ error: 'upstream odds error', status: r.status }), {
        status: 502, headers: { 'Content-Type': 'application/json' }
      });
    }
    const body = await r.text(); // بنمرّر الرد زي ما هو
    return new Response(body, {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        // كاش على حافة Cloudflare 6 ساعات (يطابق الكاش المشترك في التطبيق) — توفير إضافي للباقة
        'Cache-Control': 's-maxage=21600, stale-while-revalidate=3600'
      }
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: 'odds fetch failed' }), {
      status: 502, headers: { 'Content-Type': 'application/json' }
    });
  }
}
