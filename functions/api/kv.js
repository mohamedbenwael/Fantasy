// ============================================================
// functions/api/kv.js  —  Cloudflare Pages Function
// بروكسي سيرفري بين الموقع وجدول mazareta_kv في Supabase.
// المتصفح مبقاش يكلم Supabase مباشرة خالص — كل حاجة بتعدي من هنا،
// وهنا بس اللي معاه مفتاح service_role (السري) اللي بيتخطى RLS.
//
// المسار في الريبو: functions/api/kv.js  →  بيتخدم على /api/kv
//
// طريقة الاستخدام من الفرونت إند (POST body بصيغة JSON):
//   { action: "get",    key: "..." }
//   { action: "set",    key: "...", value: "..." }
//   { action: "delete", key: "..." }
//   { action: "list",   prefix: "..." }
// ============================================================

const SUPABASE_URL = 'https://mizlabuyvllveverurai.supabase.co';

// أقصى حجم مسموح بيه للقيمة الواحدة (300 كيلوبايت) — عشان محدش يقدر يبعت
// قيم ضخمة تضخّم قاعدة البيانات وتوصلها لحد الخطة الفري بسرعة.
const MAX_VALUE_BYTES = 300 * 1024;

// قايمة المفاتيح المسموح بيها بس — أي مفتاح تاني هيترفض. ده بيمنع حد إنه
// يستخدم الـ endpoint ده عشان يخزن حاجات غريبة مالهاش علاقة بالتطبيق.
// المفاتيح الشخصية (اللي بتنتهي بـ FPL ID) بتتفحص بالـ prefix بتاعها.
const ALLOWED_EXACT_KEYS = new Set([
  'fpl_cache_v2',        // LIVE_CACHE_KEY
  'fpl_odds_cache_v1',   // ODDS_CACHE_KEY
  'mazareta_admin_links',
]);

const ALLOWED_PREFIXES = [
  'mazareta_squad:',
  'mazareta_squad_next:',
  'public_entry:',
  'mazareta_manager:',
];

function isAllowedKey(key) {
  if (typeof key !== 'string' || key.length === 0 || key.length > 200) return false;
  if (ALLOWED_EXACT_KEYS.has(key)) return true;
  return ALLOWED_PREFIXES.some((p) => key.startsWith(p));
}

// ===== مفاتيح محمية — مسموح تُقرأ من هنا، بس تعديلها/حذفها ممنوع تمامًا =====
// mazareta_admin_links لازم تتغيّر بس عن طريق Edge Function المحمية بالـ PIN
// (save-admin-links)، مش عن طريق /api/kv مباشرة — وإلا أي حد عارف اسم المفتاح
// (وهو ظاهر أصلاً في كود الفرونت إند) يقدر يكتب فوقه من غير أي تحقق.
const WRITE_PROTECTED_KEYS = new Set(['mazareta_admin_links']);

// ===== مفاتيح تحتاج إثبات ملكية (owner token) قبل الكتابة/الحذف =====
// من غير الحماية دي، أي حد يعرف FPL ID بتاع حد تاني (رقم متسلسل عام)
// يقدر يكتب فوق تشكيلته المحفوظة. بنغلّف القيمة بـ owner token بيتولّد
// مرة واحدة على جهاز المستخدم ويتبعت مع كل عملية set/delete على المفتاح ده.
const OWNER_PROTECTED_PREFIXES = ['mazareta_squad:', 'mazareta_squad_next:', 'mazareta_manager:'];

function needsOwnerToken(key) {
  return OWNER_PROTECTED_PREFIXES.some((p) => key.startsWith(p));
}

function wrapValue(rawValue, ownerToken) {
  return JSON.stringify({ __kvOwner: 1, owner: ownerToken || null, data: rawValue });
}

// بيرجع { data, owner }. القيم القديمة (من قبل ما نضيف الحماية دي) مالهاش
// غلاف — بنتعامل معاها كإنها من غير owner (يعني أول set جديد عليها بيملكها).
function unwrapValue(storedValue) {
  try {
    const parsed = JSON.parse(storedValue);
    if (parsed && typeof parsed === 'object' && parsed.__kvOwner === 1) {
      return { data: parsed.data, owner: parsed.owner || null };
    }
  } catch (e) {}
  return { data: storedValue, owner: null };
}

function jsonResponse(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}

function supaHeaders(serviceKey) {
  return {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    'Content-Type': 'application/json',
  };
}

export async function onRequest(context) {
  const req = context.request;

  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
    });
  }

  if (req.method !== 'POST') {
    return jsonResponse({ error: 'الطريقة غير مسموحة، استخدم POST' }, 405);
  }

  const serviceKey = context.env.SUPABASE_SERVICE_KEY;
  if (!serviceKey) {
    return jsonResponse({ error: 'إعدادات السيرفر ناقصة (SUPABASE_SERVICE_KEY)' }, 500);
  }

  let body;
  try {
    body = await req.json();
  } catch (e) {
    return jsonResponse({ error: 'الطلب لازم يكون JSON صحيح' }, 400);
  }

  const { action, key, value, prefix } = body || {};

  try {
    // ===== GET =====
    if (action === 'get') {
      if (!isAllowedKey(key)) return jsonResponse({ error: 'مفتاح غير مسموح' }, 400);

      const url = `${SUPABASE_URL}/rest/v1/mazareta_kv?key=eq.${encodeURIComponent(key)}&select=value`;
      const res = await fetch(url, { headers: supaHeaders(serviceKey) });
      if (!res.ok) return jsonResponse({ error: 'فشل القراءة' }, 502);
      const rows = await res.json();
      const rawFound = Array.isArray(rows) && rows.length > 0 ? rows[0].value : null;
      // مفاتيح الملكية مخزّنة داخل غلاف {owner, data} — بنرجّع الـ data بس للفرونت إند
      const found = (rawFound != null && needsOwnerToken(key)) ? unwrapValue(rawFound).data : rawFound;
      return jsonResponse({ value: found });
    }

    // ===== SET (upsert) =====
    if (action === 'set') {
      if (!isAllowedKey(key)) return jsonResponse({ error: 'مفتاح غير مسموح' }, 400);
      if (WRITE_PROTECTED_KEYS.has(key)) {
        return jsonResponse({ error: 'هذا المفتاح محمي، لازم يتعدّل من مساره الآمن الخاص بيه فقط' }, 403);
      }
      if (typeof value !== 'string') return jsonResponse({ error: 'القيمة لازم تكون نص (JSON.stringify)' }, 400);
      if (new TextEncoder().encode(value).length > MAX_VALUE_BYTES) {
        return jsonResponse({ error: 'القيمة أكبر من الحجم المسموح' }, 413);
      }

      let storedValue = value;

      if (needsOwnerToken(key)) {
        const owner = typeof body.owner === 'string' ? body.owner.trim() : '';
        if (!owner) return jsonResponse({ error: 'محتاج owner token عشان تحفظ المفتاح ده' }, 400);

        // بنجيب القيمة الحالية (لو موجودة) عشان نتأكد إن اللي بيكتب هو نفسه صاحب أول نسخة
        const checkUrl = `${SUPABASE_URL}/rest/v1/mazareta_kv?key=eq.${encodeURIComponent(key)}&select=value`;
        const checkRes = await fetch(checkUrl, { headers: supaHeaders(serviceKey) });
        if (!checkRes.ok) return jsonResponse({ error: 'فشل التحقق قبل الحفظ' }, 502);
        const checkRows = await checkRes.json();
        const existingRaw = Array.isArray(checkRows) && checkRows.length > 0 ? checkRows[0].value : null;

        if (existingRaw != null) {
          const existing = unwrapValue(existingRaw);
          // لو القيمة القديمة ليها owner معروف ومش مطابق للتوكن الجديد → ارفض
          if (existing.owner && existing.owner !== owner) {
            return jsonResponse({ error: 'المفتاح ده متسجل لمستخدم تاني' }, 403);
          }
        }

        storedValue = wrapValue(value, owner);
      }

      const url = `${SUPABASE_URL}/rest/v1/mazareta_kv?on_conflict=key`;
      const res = await fetch(url, {
        method: 'POST',
        headers: Object.assign(supaHeaders(serviceKey), {
          Prefer: 'resolution=merge-duplicates,return=minimal',
        }),
        body: JSON.stringify({ key, value: storedValue, updated_at: new Date().toISOString() }),
      });
      if (!res.ok) {
        const detail = await res.text();
        return jsonResponse({ error: 'فشل الحفظ', detail }, 502);
      }
      return jsonResponse({ ok: true });
    }

    // ===== DELETE =====
    if (action === 'delete') {
      if (!isAllowedKey(key)) return jsonResponse({ error: 'مفتاح غير مسموح' }, 400);
      if (WRITE_PROTECTED_KEYS.has(key)) {
        return jsonResponse({ error: 'هذا المفتاح محمي، لا يمكن حذفه من هنا' }, 403);
      }

      if (needsOwnerToken(key)) {
        const owner = typeof body.owner === 'string' ? body.owner.trim() : '';
        if (!owner) return jsonResponse({ error: 'محتاج owner token عشان تحذف المفتاح ده' }, 400);

        const checkUrl = `${SUPABASE_URL}/rest/v1/mazareta_kv?key=eq.${encodeURIComponent(key)}&select=value`;
        const checkRes = await fetch(checkUrl, { headers: supaHeaders(serviceKey) });
        if (!checkRes.ok) return jsonResponse({ error: 'فشل التحقق قبل الحذف' }, 502);
        const checkRows = await checkRes.json();
        const existingRaw = Array.isArray(checkRows) && checkRows.length > 0 ? checkRows[0].value : null;
        if (existingRaw != null) {
          const existing = unwrapValue(existingRaw);
          if (existing.owner && existing.owner !== owner) {
            return jsonResponse({ error: 'المفتاح ده متسجل لمستخدم تاني' }, 403);
          }
        }
      }

      const url = `${SUPABASE_URL}/rest/v1/mazareta_kv?key=eq.${encodeURIComponent(key)}`;
      const res = await fetch(url, { method: 'DELETE', headers: supaHeaders(serviceKey) });
      if (!res.ok) return jsonResponse({ error: 'فشل الحذف' }, 502);
      return jsonResponse({ ok: true });
    }

    // ===== LIST =====
    if (action === 'list') {
      if (typeof prefix !== 'string' || prefix.length === 0) {
        return jsonResponse({ error: 'محتاج prefix' }, 400);
      }
      // نفس منطق الأمان: مسموح تسرد بس تحت البادئات المعروفة
      const allowed = ALLOWED_PREFIXES.some((p) => p.startsWith(prefix) || prefix.startsWith(p))
        || Array.from(ALLOWED_EXACT_KEYS).some((k) => k.startsWith(prefix));
      if (!allowed) return jsonResponse({ error: 'prefix غير مسموح' }, 400);

      const url = `${SUPABASE_URL}/rest/v1/mazareta_kv?key=like.${encodeURIComponent(prefix)}*&select=key`;
      const res = await fetch(url, { headers: supaHeaders(serviceKey) });
      if (!res.ok) return jsonResponse({ error: 'فشل السرد' }, 502);
      const rows = await res.json();
      return jsonResponse({ keys: (rows || []).map((r) => r.key) });
    }

    return jsonResponse({ error: 'action غير معروف. استخدم get/set/delete/list' }, 400);
  } catch (err) {
    return jsonResponse({ error: 'خطأ غير متوقع', detail: String(err) }, 500);
  }
}
