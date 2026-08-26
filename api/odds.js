// ============================================================
// api/odds.js  —  بروكسي أودز البريميرليج (the-odds-api)
// حطّ الملف ده في مجلد "api" في مشروعك على Vercel، فيبقى متاح على /api/odds
// ------------------------------------------------------------
// ليه بروكسي؟ عشان (1) نخبّي المفتاح فمحدش يشوفه من المتصفح، (2) نتفادى مشاكل CORS،
// (3) نكاش الرد على مستوى Vercel كمان (طبقة حماية تانية للباقة المجانية).
// المفتاح بيتقرأ من متغيّر البيئة ODDS_API_KEY (Vercel → Settings → Environment Variables).
// تكلفة كل طلب فعلي = عدد الأسواق × عدد المناطق = (h2h,totals=2) × (uk=1) = 2 نقطة.
// ============================================================
export default async function handler(req, res) {
  const KEY = process.env.ODDS_API_KEY;
  if (!KEY) {
    res.status(500).json({ error: 'ODDS_API_KEY is not set in environment variables' });
    return;
  }
  const url = 'https://api.the-odds-api.com/v4/sports/soccer_epl/odds'
            + '?apiKey=' + KEY
            + '&regions=uk'
            + '&markets=h2h,totals'
            + '&oddsFormat=decimal';
  try {
    const r = await fetch(url);
    if (!r.ok) {
      res.status(502).json({ error: 'upstream odds error', status: r.status });
      return;
    }
    const data = await r.json();
    // كاش على حافة Vercel لمدة 6 ساعات (يطابق الكاش المشترك في التطبيق) — طبقة توفير إضافية.
    res.setHeader('Cache-Control', 's-maxage=21600, stale-while-revalidate=3600');
    res.status(200).json(data);
  } catch (e) {
    res.status(502).json({ error: 'odds fetch failed' });
  }
}
