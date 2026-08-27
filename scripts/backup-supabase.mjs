// ============================================================
// scripts/backup-supabase.mjs
// بيسحب كل صفوف جدول mazareta_kv من Supabase (عن طريق REST API بنفس
// الطريقة اللي kv.js بيستخدمها) ويحفظها كملف JSON محلي.
// بيتشغّل يوميًا عن طريق GitHub Actions (شوف backup-supabase.yml).
//
// فايدة إضافية: الطلب ده نفسه بيعتبر "نشاط" على مشروع Supabase، فبيمنع
// إيقافه التلقائي بسبب عدم الاستخدام (auto-pause بعد أسبوع سكون).
// ============================================================

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('لازم تحدد SUPABASE_URL و SUPABASE_SERVICE_KEY في GitHub Secrets');
  process.exit(1);
}

async function main() {
  const url = `${SUPABASE_URL}/rest/v1/mazareta_kv?select=key,value,updated_at&order=key.asc`;
  const res = await fetch(url, {
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
    },
  });

  if (!res.ok) {
    console.error('فشل جلب البيانات من Supabase:', res.status, await res.text());
    process.exit(1);
  }

  const rows = await res.json();

  const fs = await import('node:fs/promises');
  await fs.mkdir('backups', { recursive: true });

  // نسخة "آخر باك أب" — دايمًا بتتحدّث وبتفضل موجودة
  await fs.writeFile('backups/latest.json', JSON.stringify(rows, null, 2));

  // نسخة يومية بالتاريخ — عشان نقدر نرجع لأي يوم في آخر أسبوع
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  await fs.writeFile(`backups/${today}.json`, JSON.stringify(rows, null, 2));

  console.log(`تم حفظ ${rows.length} صف بنجاح (backups/${today}.json)`);

  // تنظيف: نحتفظ بآخر 7 نسخ يومية بس عشان الريبو ميكبرش من غير داعي
  const files = (await fs.readdir('backups')).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f));
  files.sort();
  const toDelete = files.slice(0, Math.max(0, files.length - 7));
  for (const f of toDelete) {
    await fs.unlink(`backups/${f}`);
    console.log(`اتمسحت نسخة قديمة: ${f}`);
  }
}

main().catch((e) => {
  console.error('خطأ غير متوقع:', e);
  process.exit(1);
});
