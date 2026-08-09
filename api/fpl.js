// /api/fpl.js
// بروكسي بسيط بين الموقع والـ API الرسمي لفانتازي البريميرليج (fantasy.premierleague.com)
// السبب إننا محتاجين البروكسي ده: الـ API الرسمي مقفول بـ CORS ومينفعش نناديه
// مباشرة من كود جافاسكريبت شغال في المتصفح. السيرفر ده (Vercel Serverless Function)
// بيعمل fetch للـ API الرسمي ويرجّع نفس الـ JSON للموقع.
//
// أمثلة استخدام:
//   /api/fpl?type=bootstrap                -> بيانات كل اللاعبين + الأندية + الجولات
//   /api/fpl?type=fixtures                 -> كل مباريات الموسم
//   /api/fpl?type=fixtures&event=5         -> مباريات الجولة رقم 5 بس
//   /api/fpl?type=live&event=5             -> نقاط كل اللاعبين لحظيًا في الجولة رقم 5
//   /api/fpl?type=entry&id=123456          -> بيانات فريق معين (اسم المدير، الرتبة العامة...)
//   /api/fpl?type=picks&id=123456&event=5  -> اختيارات فريق معين في جولة معينة

const BASE = 'https://fantasy.premierleague.com/api';

const CACHE_SECONDS = {
  bootstrap: 120,
  fixtures: 300,
  live: 60,
  entry: 60,
  picks: 300,
};

module.exports = async function handler(req, res) {
  const { type, event, id } = req.query;

  let url;
  let cacheBucket = 'bootstrap';

  if (type === 'bootstrap') {
    url = `${BASE}/bootstrap-static/`;
    cacheBucket = 'bootstrap';
  } else if (type === 'fixtures') {
    url = event ? `${BASE}/fixtures/?event=${encodeURIComponent(event)}` : `${BASE}/fixtures/`;
    cacheBucket = 'fixtures';
  } else if (type === 'live') {
    if (!event) {
      res.status(400).json({ error: 'محتاج تحدد رقم الجولة: ?type=live&event=5' });
      return;
    }
    url = `${BASE}/event/${encodeURIComponent(event)}/live/`;
    cacheBucket = 'live';
  } else if (type === 'entry') {
    if (!id) {
      res.status(400).json({ error: 'محتاج تحدد رقم الفريق: ?type=entry&id=123456' });
      return;
    }
    url = `${BASE}/entry/${encodeURIComponent(id)}/`;
    cacheBucket = 'entry';
  } else if (type === 'picks') {
    if (!id || !event) {
      res.status(400).json({ error: 'محتاج تحدد رقم الفريق ورقم الجولة: ?type=picks&id=123456&event=5' });
      return;
    }
    url = `${BASE}/entry/${encodeURIComponent(id)}/event/${encodeURIComponent(event)}/picks/`;
    cacheBucket = 'picks';
  } else {
    res.status(400).json({ error: "نوع غير معروف. استخدم type=bootstrap أو type=fixtures أو type=live أو type=entry أو type=picks" });
    return;
  }

  try {
    const upstream = await fetch(url, {
      headers: {
        // لازم الـ User-Agent يبقى شبه متصفح حقيقي، لأن FPL بترفض أي حاجة
        // شكلها بوت أو سكريبت (زي أي اسم مخصص فيه "compatible; ...").
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9,ar;q=0.8',
        'Referer': 'https://fantasy.premierleague.com/',
      },
    });

    if (!upstream.ok) {
      res.status(upstream.status).json({ error: 'فشل الاتصال بـ FPL API', status: upstream.status });
      return;
    }

    const data = await upstream.json();
    const secs = CACHE_SECONDS[cacheBucket] || 120;

    res.setHeader('Cache-Control', `s-maxage=${secs}, stale-while-revalidate=${secs * 5}`);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.status(200).json(data);
  } catch (err) {
    res.status(502).json({ error: 'تعذّر جلب البيانات من FPL', detail: String(err) });
  }
}
