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

const BASE = 'https://fantasy.premierleague.com/api';

// كام ثانية نخلي الـ CDN بتاع Vercel يحتفظ بنسخة مخزنة من كل نوع رد
// (بيقلل الضغط على سيرفر الفانتازي الرسمي ويخلي موقعك أسرع)
const CACHE_SECONDS = {
  bootstrap: 120,   // الأسعار والنقط بتتغير خلال المباريات، فتحديث كل دقيقتين كافي
  fixtures: 300,
  live: 60,         // وقت المباريات الفعلي محتاج تحديث أسرع شوية
};

module.exports = async function handler(req, res) {
  const { type, event } = req.query;

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
  } else {
    res.status(400).json({ error: "نوع غير معروف. استخدم type=bootstrap أو type=fixtures أو type=live" });
    return;
  }

  try {
    const upstream = await fetch(url, {
      headers: {
        // بعض الأحيان الـ FPL API بيرفض الطلبات اللي مفهاش user-agent واضح
        'User-Agent': 'Mozilla/5.0 (compatible; MazaretaFantasy/1.0)',
        'Accept': 'application/json',
      },
    });

    if (!upstream.ok) {
      res.status(upstream.status).json({ error: 'فشل الاتصال بـ FPL API', status: upstream.status });
      return;
    }

    const data = await upstream.json();
    const secs = CACHE_SECONDS[cacheBucket] || 120;

    // تخزين مؤقت على مستوى الـ CDN — يقلل عدد الطلبات الفعلية لسيرفر FPL
    res.setHeader('Cache-Control', `s-maxage=${secs}, stale-while-revalidate=${secs * 5}`);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.status(200).json(data);
  } catch (err) {
    res.status(502).json({ error: 'تعذّر جلب البيانات من FPL', detail: String(err) });
  }
}
