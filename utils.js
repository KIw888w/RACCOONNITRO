'use strict';

// ---------- เวลาไทย (UTC+7) ----------
const TZ = 7 * 3600 * 1000;
const TH_DAYS = ['อาทิตย์', 'จันทร์', 'อังคาร', 'พุธ', 'พฤหัสบดี', 'ศุกร์', 'เสาร์'];
const TH_MONTHS = [
  'มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน',
  'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม',
];
const pad = (n) => String(n).padStart(2, '0');

function thParts(ms) {
  const d = new Date(ms + TZ);
  return {
    y: d.getUTCFullYear(), mo: d.getUTCMonth(), d: d.getUTCDate(),
    h: d.getUTCHours(), mi: d.getUTCMinutes(), wd: d.getUTCDay(),
  };
}

// แสดงเวลาแบบสั้น: 22/11 23:00
function fmtDate(ms) {
  const p = thParts(ms);
  return `${p.d}/${p.mo + 1} ${pad(p.h)}:${pad(p.mi)}`;
}

function toArabic(s) {
  return String(s).replace(/[๐-๙]/g, (c) => String('๐๑๒๓๔๕๖๗๘๙'.indexOf(c)));
}

/**
 * รับเวลาปิดได้หลายแบบ
 *   23:00            -> วันนี้ (ถ้าผ่านไปแล้วจะเป็นพรุ่งนี้)
 *   22/11 23:00      -> วันที่ 22/11 ปีนี้
 *   22/11/2569 23:00 -> รองรับปี พ.ศ. และ ค.ศ.
 *   +30m / +2h / +1d -> นับจากตอนนี้ (นาที/ชั่วโมง/วัน)
 * คืนค่าเป็น timestamp (ms) หรือ null ถ้าอ่านไม่ออก
 */
function parseEndTime(text, now = Date.now()) {
  const s = toArabic(String(text).trim().toLowerCase()).replace(/\s+/g, ' ');

  let m = s.match(/^\+\s*(\d+(?:\.\d+)?)\s*(นาที|ชั่วโมง|ชม|วัน|m|h|d|น)?$/);
  if (m) {
    const n = parseFloat(m[1]);
    const u = m[2] || 'm';
    const mult = ['h', 'ชม', 'ชั่วโมง'].includes(u) ? 3600000 : ['d', 'วัน'].includes(u) ? 86400000 : 60000;
    return now + Math.round(n * mult);
  }

  m = s.match(/^(?:(\d{1,2})[\/\-.](\d{1,2})(?:[\/\-.](\d{4}))?\s+)?(\d{1,2})[:.](\d{2})$/);
  if (!m) return null;
  const [, dd, mo, yy, hh, mi] = m;
  const h = +hh;
  const min = +mi;
  if (h > 23 || min > 59) return null;

  const np = thParts(now);
  if (dd === undefined) {
    let t = Date.UTC(np.y, np.mo, np.d, h, min) - TZ;
    if (t <= now) t += 86400000;
    return t;
  }

  const d = +dd;
  const mon = +mo - 1;
  let y = yy ? +yy : np.y;
  if (y > 2400) y -= 543;
  if (mon < 0 || mon > 11 || d < 1 || d > 31) return null;
  const t = Date.UTC(y, mon, d, h, min) - TZ;
  const chk = thParts(t);
  if (chk.d !== d || chk.mo !== mon) return null; // วันที่ไม่มีจริง เช่น 31/2
  return t;
}

// ---------- ราคา ----------
const UNIT = { k: 1e3, 'พัน': 1e3, 'หมื่น': 1e4, 'แสน': 1e5, m: 1e6, 'ล้าน': 1e6 };
const U = 'k|m|พัน|หมื่น|แสน|ล้าน';
const NUM_WORDS = { 'หนึ่ง': 1, 'สอง': 2, 'สาม': 3, 'สี่': 4, 'ห้า': 5, 'หก': 6, 'เจ็ด': 7, 'แปด': 8, 'เก้า': 9, 'สิบ': 10 };

// คำนำหน้า / ท้ายประโยค ที่ลูกค้าชอบพิมพ์ติดมา
const PREFIX = '(?:(?:บิด|bid|ขอ|ราคา|ที่|นำ)\\s*)*฿?\\s*';
const CORE = `\\d[\\d.,]*(?:\\s*(?:${U})\\s*[\\d.,]*)*`;
const TAIL = '\\s*(บาท|฿|บ|thb)?\\s*(?:(?:ครับ|ค่ะ|คะ|คับ|ค่า|นะ|จ้า|จ้ะ|ด้วย|เลย)\\s*)*';
const FULL = new RegExp(`^${PREFIX}(${CORE})${TAIL}$`, 'i');

function normalize(text) {
  let s = String(text).trim().toLowerCase();
  s = s.replace(/[０-９]/g, (c) => String(c.charCodeAt(0) - 0xff10)); // เลขเต็มความกว้าง
  s = toArabic(s); // เลขไทย
  // เลขคำไทย เช่น ห้าหมื่น สามแสน หนึ่งล้านห้าแสน
  s = s.replace(/(หนึ่ง|สอง|สาม|สี่|ห้า|หก|เจ็ด|แปด|เก้า|สิบ)(?=\s*(?:พัน|หมื่น|แสน|ล้าน))/g, (w) => String(NUM_WORDS[w]));
  return s.replace(/\s+/g, ' ').trim();
}

// แปลงข้อความตัวเลข: 1,500 | 1.5 | 1,5 (ทศนิยมแบบคอมม่า)
function num(t) {
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(t)) return parseFloat(t.replace(/,/g, ''));
  if (/^\d+,\d{1,2}$/.test(t)) return parseFloat(t.replace(',', '.'));
  if (/^\d+(\.\d+)?$/.test(t)) return parseFloat(t);
  return NaN;
}

// 10k | 1.5m | 5แสน | 1ล้าน5แสน | 2k5 (=2.5k) | 1m25 (=1.25m) | 2หมื่น5 (=25,000)
function parseUnitExpr(core) {
  const re = new RegExp(`(\\d[\\d,]*(?:\\.\\d+)?)\\s*(${U})\\s*`, 'iy');
  let pos = 0, total = 0, last = 0, got = false;
  for (;;) {
    re.lastIndex = pos;
    const m = re.exec(core);
    if (!m) break;
    const n = num(m[1]);
    if (Number.isNaN(n)) return null;
    last = UNIT[m[2].toLowerCase()];
    total += n * last;
    pos = re.lastIndex;
    got = true;
  }
  if (!got) return null;
  const rest = core.slice(pos).trim();
  if (rest) {
    if (!/^\d+$/.test(rest)) return null;
    total += parseFloat(`0.${rest}`) * last; // เลขท้ายหน่วย = เศษของหน่วยนั้น
  }
  const v = Math.round(total);
  return v > 0 && Number.isSafeInteger(v) ? v : null;
}

// คืน { explicit } ถ้ามีหน่วยชัดเจน หรือ { token } ถ้าเป็นเลขเปล่า
function analyze(text) {
  const m = normalize(text).match(FULL);
  if (!m) return null;
  const core = m[1].replace(/[.,]+$/, '').trim();
  const baht = !!m[2];
  if (new RegExp(`(?:${U})`, 'i').test(core)) {
    const v = parseUnitExpr(core);
    return v === null ? null : { explicit: v, baht };
  }
  return { token: core, baht };
}

const isInt = (v) => Math.abs(v - Math.round(v)) < 1e-6;

// เลขเปล่า -> ตัวเลือกราคาที่เป็นไปได้หลายสเกล
function bareCandidates(token) {
  let c = [];
  if (/^\d{1,3}([.,]\d{3})+$/.test(token)) {
    // 10.000 / 100,000 / 1.500.000 (คั่นหลักพัน)
    c.push({ v: Number(token.replace(/[.,]/g, '')), scaled: false });
    if (/^\d{1,3}[.,]\d{3}$/.test(token)) c.push({ v: Number(token.replace(/[.,]/g, '')) * 1e3, scaled: true }); // 1.100 / 1,100 = 1.1 ล้าน ก็ได้
  } else {
    const x = num(token);
    if (!Number.isFinite(x)) return [];
    const integer = !/[.,]/.test(token);
    if (integer && token.length >= 7) {
      c.push({ v: x, scaled: false });
    } else if (integer && token.length >= 4) {
      c.push({ v: x, scaled: false }, { v: x * 1e3, scaled: true }); // 1100 ที่ตู้ล้าน = 1.1 ล้าน
    } else {
      c.push({ v: x, scaled: false }, { v: x * 1e3, scaled: true }, { v: x * 1e6, scaled: true });
    }
  }
  c = c.filter((o) => isInt(o.v) && o.v > 0 && Number.isSafeInteger(Math.round(o.v)));
  return c.map((o) => ({ v: Math.round(o.v), scaled: o.scaled }));
}

function pick(cands, ctx) {
  let c = cands;
  if (ctx.limit) c = c.filter((o) => !o.scaled || o.v <= ctx.limit);
  if (!c.length) return null;
  if (!ctx.ref) return c[0].v;
  let best = c[0], bestD = Infinity;
  for (const o of c) {
    const d = Math.abs(Math.log(o.v / ctx.ref));
    if (d < bestD) { bestD = d; best = o; }
  }
  return best.v;
}

function isBidLike(text) {
  return FULL.test(normalize(text));
}

/**
 * อ่านราคาที่ลูกค้าบิด (พิมพ์สั้นได้) โดยดูบริบท
 *   ctx.ref   = ราคานำปัจจุบัน (หรือราคาเปิดถ้ายังไม่มีคนบิด)
 *   ctx.limit = เพดานของเลขที่ถูกขยายสเกลเอง (กัน "1" กลายเป็น 1 ล้านแล้วทุบโต๊ะ)
 * คืนราคาเต็ม หรือ null ถ้าไม่ใช่การบิด
 */
function parseBid(text, ctx = {}) {
  const a = analyze(text);
  if (!a) return null;
  if (a.explicit != null) return a.explicit;
  return pick(bareCandidates(a.token), ctx);
}

/**
 * อ่านราคาที่แอดมินกรอกตอนเปิดตู้
 *  - เปิดประมูล: ต้องมีหน่วย (250k) หรือเลขเต็ม (250000 / 250.000) หรือลงท้าย "บาท"
 *  - บิดทีละ / ทุบโต๊ะ: พิมพ์สั้นได้ โดยเทียบกับราคาเปิด (ctx.ref)
 * คืน { value } หรือ { error }
 */
function parseAdminPrice(text, ctx = {}) {
  const a = analyze(text);
  if (!a) return { error: 'อ่านราคาไม่ออก' };
  if (a.explicit != null) return { value: a.explicit };
  const cands = bareCandidates(a.token);
  if (!cands.length) return { error: 'อ่านราคาไม่ออก' };
  if (a.baht) return { value: cands[0].v }; // 100บาท = 100 บาทตรงๆ
  if (ctx.ref) {
    const v = pick(cands, ctx);
    return v ? { value: v } : { error: 'อ่านราคาไม่ออก' };
  }
  const lit = cands.find((o) => !o.scaled);
  if (lit && lit.v >= 1000) return { value: lit.v }; // เลขเต็ม เช่น 250000 / 250.000
  return { error: 'ใส่หน่วยด้วย เช่น 250k หรือ 250000 (เลขสั้นๆ ไม่มีราคาให้เทียบ)' };
}

const trimNum = (n, dp) => String(parseFloat(n.toFixed(dp)));

// 250000 -> 250k , 1500000 -> 1.5m , 1234 -> 1,234
function formatPrice(n) {
  if (n >= 1e6 && n % 1000 === 0) return `${trimNum(n / 1e6, 3)}m`;
  if (n >= 1e3 && n % 100 === 0 && n < 1e6) return `${trimNum(n / 1e3, 1)}k`;
  return n.toLocaleString('en-US');
}

module.exports = { parseBid, parseAdminPrice, isBidLike, formatPrice, parseEndTime, fmtDate, thParts };
