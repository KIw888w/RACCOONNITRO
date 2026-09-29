import express from 'express';
import cors from 'cors';
import multer from 'multer';
import fs from 'fs';

const { TM_PHONE, EASYSLIP_TOKEN, PROMPTPAY_ID, PORT = 3000 } = process.env;
const RECEIVER_ACCOUNT = process.env.RECEIVER_ACCOUNT || PROMPTPAY_ID; // ใช้เช็กผู้รับในสลิป (ถ้าไม่ตั้ง จะใช้พร้อมเพย์ไอดีเดียวกัน)
if (!TM_PHONE) console.warn('⚠ ยังไม่ได้ตั้ง TM_PHONE ใน .env');
if (!EASYSLIP_TOKEN) console.warn('⚠ ยังไม่ได้ตั้ง EASYSLIP_TOKEN ใน .env');
if (!PROMPTPAY_ID) console.warn('⚠ ยังไม่ได้ตั้ง PROMPTPAY_ID ใน .env (ใช้สร้าง QR รับเงิน)');

// กันใช้ซ้ำ: เก็บรหัสซอง / เลขอ้างอิงสลิปที่ใช้แล้ว
const DB = './used.json';
const used = fs.existsSync(DB) ? JSON.parse(fs.readFileSync(DB, 'utf8')) : {};
const save = () => fs.writeFileSync(DB, JSON.stringify(used));

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public')); // วาง index.html ไว้ใน public/ จะเรียกเว็บ+API โดเมนเดียวกัน
/* ---------- 0) สร้าง PromptPay QR แบบล็อกยอดเงิน (EMVCo) ---------- */
const tlv = (id, v) => id + String(v.length).padStart(2, '0') + v;
function crc16(str) { // CRC-16/CCITT-FALSE
  let c = 0xFFFF;
  for (let i = 0; i < str.length; i++) {
    c ^= str.charCodeAt(i) << 8;
    for (let j = 0; j < 8; j++) c = (c & 0x8000) ? ((c << 1) ^ 0x1021) & 0xFFFF : (c << 1) & 0xFFFF;
  }
  return c.toString(16).toUpperCase().padStart(4, '0');
}
function promptPayPayload(id, amount) {
  const d = String(id).replace(/\D/g, '');
  let tag, val;
  if (d.length === 10 && d[0] === '0') { tag = '01'; val = '0066' + d.slice(1); } // เบอร์โทร
  else if (d.length === 13) { tag = '02'; val = d; }                                // เลขบัตรประชาชน / ภาษี
  else if (d.length === 15) { tag = '03'; val = d; }                                // e-Wallet ID
  else throw new Error('PROMPTPAY_ID ต้องเป็นเบอร์โทร 10 หลัก หรือเลข 13 หลัก');
  const body = tlv('00', '01') + tlv('01', '12') // 12 = QR แบบใช้ครั้งเดียว ระบุยอดเงิน
    + tlv('29', tlv('00', 'A000000677010111') + tlv(tag, val))
    + tlv('58', 'TH') + tlv('53', '764') + tlv('54', amount.toFixed(2)) + '6304';
  return body + crc16(body);
}
app.get('/api/promptpay-qr', (req, res) => {
  const baht = Number(req.query.baht);
  if (!PROMPTPAY_ID) return res.status(501).json({ ok: false, message: 'ร้านยังไม่ได้ตั้งค่าพร้อมเพย์ (PROMPTPAY_ID)' });
  if (!(baht >= 1 && baht <= 50000)) return res.status(400).json({ ok: false, message: 'ยอดเงินไม่ถูกต้อง' });
  try { res.json({ ok: true, baht, payload: promptPayPayload(PROMPTPAY_ID, Math.round(baht * 100) / 100) }); }
  catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });


// รับซองทรูมันนี่ตรงๆ ผ่านเว็บ gift.truemoney.com (ไม่ต้องพึ่งแพ็กเกจเสริม)
const TM_ERR = {
  VOUCHER_NOT_FOUND: 'ไม่พบซองนี้',
  VOUCHER_EXPIRED: 'ซองหมดอายุแล้ว',
  VOUCHER_OUT_OF_STOCK: 'ซองถูกรับไปหมดแล้ว',
  TARGET_USER_REDEEMED: 'เบอร์ร้านรับซองนี้ไปแล้ว',
  CANNOT_GET_OWN_VOUCHER: 'ไม่สามารถรับซองที่ส่งจากเบอร์ร้านเอง',
  INTERNAL_ERROR: 'ระบบทรูมันนี่ขัดข้อง ลองใหม่อีกครั้ง',
};
async function redeemAngpao(phone, code) {
  const r = await fetch(`https://gift.truemoney.com/campaign/vouchers/${code}/redeem`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
    },
    body: JSON.stringify({ mobile: String(phone), voucher_hash: code }),
  });
  const txt = await r.text();
  let j; try { j = JSON.parse(txt); } catch { throw new Error('ทรูมันนี่ไม่ตอบกลับตามปกติ (อาจถูกบล็อกจาก IP นี้) HTTP ' + r.status); }
  const st = j?.status?.code;
  if (st !== 'SUCCESS') throw new Error(TM_ERR[st] || j?.status?.message || ('รับซองไม่สำเร็จ ' + (st || r.status)));
  return { amount: Number(j?.data?.my_ticket?.amount_baht ?? j?.data?.voucher?.amount_baht ?? 0) };
}

/* ---------- 1) รับซองของขวัญ TrueMoney อัตโนมัติ ---------- */
app.post('/api/tm-redeem', async (req, res) => {
  let code = '';
  try { code = new URL(String(req.body.link || '')).searchParams.get('v') || ''; } catch {}
  if (!/^[A-Za-z0-9]{10,64}$/.test(code))
    return res.status(400).json({ ok: false, message: 'ลิงก์ซองไม่ถูกต้อง' });
  if (used['tm:' + code])
    return res.status(409).json({ ok: false, message: 'ซองนี้ถูกใช้ไปแล้ว' });

  used['tm:' + code] = Date.now(); save(); // จองไว้ก่อน กันกดซ้ำพร้อมกัน
  try {
    const r = await redeemAngpao(TM_PHONE, code);
    const amount = r.amount;
    if (!(amount > 0)) throw new Error(r?.message || 'รับซองไม่สำเร็จ');
    res.json({ ok: true, amount });
  } catch (e) {
    delete used['tm:' + code]; save(); // รับไม่สำเร็จ ปล่อยให้ลองใหม่ได้
    res.status(422).json({ ok: false, message: 'รับซองไม่สำเร็จ: ' + (e.message || 'ซองอาจหมดอายุ/ถูกรับแล้ว') });
  }
});

/* ---------- 2) ตรวจสลิปโอนเงิน / พร้อมเพย์ ---------- */
// ตรวจสลิปด้วย EasySlip API v1: POST https://developer.easyslip.com/api/v1/verify (multipart: file, checkDuplicate)
const ES_ERR = {
  slip_not_found: 'ไม่พบสลิปนี้ในระบบธนาคาร (อาจเป็นสลิปปลอม หรือเพิ่งโอนให้รอสักครู่)',
  qr_code_not_found: 'ไม่พบ QR บนสลิป กรุณาใช้รูปสลิปต้นฉบับที่ไม่ได้ครอป/ตัดต่อ',
  invalid_image: 'ไฟล์รูปไม่ถูกต้อง',
  duplicate_slip: 'สลิปนี้ถูกใช้ไปแล้ว',
  quota_exceeded: 'โควตาตรวจสลิปหมด',
};
// เลขบัญชีในสลิปถูกปิดบางหลัก (เช่น xxx-x-x1234-x) ใช้ x เป็นตัวแทนเมื่อเทียบกับเลขบัญชีร้าน (เทียบจากท้ายมาหน้า)
function accountMatches(masked, expected) {
  const a = String(masked || '').toLowerCase().replace(/[^0-9x]/g, '');
  const b = String(expected || '').replace(/[^0-9]/g, '');
  if (!a || !b) return false;
  const n = Math.min(a.length, b.length);
  let seen = 0;
  for (let i = 1; i <= n; i++) {
    const c = a[a.length - i];
    if (c === 'x') continue;
    if (c !== b[b.length - i]) return false;
    seen++;
  }
  return seen >= 3; // ต้องเห็นเลขจริงอย่างน้อย 3 หลักถึงจะเชื่อ
}

async function verifySlip(file) {
  if (!EASYSLIP_TOKEN) throw Object.assign(new Error('ยังไม่ได้ตั้ง EASYSLIP_TOKEN'), { status: 501 });
  const fd = new FormData();
  fd.append('file', new Blob([file.buffer], { type: file.mimetype || 'image/jpeg' }), 'slip.jpg');
  fd.append('checkDuplicate', 'true');
  const r = await fetch('https://developer.easyslip.com/api/v1/verify', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + EASYSLIP_TOKEN },
    body: fd,
  });
  const j = await r.json().catch(() => ({}));
  if (j.status !== 200 || !j.data) {
    const msg = ES_ERR[j.message] || ('ตรวจสลิปไม่ผ่าน' + (j.message ? ` (${j.message})` : ''));
    throw Object.assign(new Error(msg), { status: 422 });
  }
  const d = j.data, rc = d.receiver?.account || {};
  const receiverOk = accountMatches(rc.bank?.account, RECEIVER_ACCOUNT) || accountMatches(rc.proxy?.account, RECEIVER_ACCOUNT);
  return { transRef: d.transRef, amount: Number(d.amount?.amount || 0), receiverOk };
}

app.post('/api/slip-verify', upload.single('file'), async (req, res) => {
  const expected = Number(req.body.amount || 0);
  if (!req.file || !(expected > 0)) return res.status(400).json({ ok: false, message: 'ข้อมูลไม่ครบ' });
  try {
    const s = await verifySlip(req.file);
    if (!s.receiverOk) return res.json({ ok: false, message: 'บัญชีผู้รับในสลิปไม่ตรงกับร้าน' });
    if (used['slip:' + s.transRef]) return res.json({ ok: false, message: 'สลิปนี้ถูกใช้ไปแล้ว' });
    if (s.amount + 0.001 < expected) return res.json({ ok: false, message: `ยอดในสลิป ฿${s.amount} น้อยกว่าที่ต้องโอน ฿${expected}` });
    used['slip:' + s.transRef] = Date.now(); save();
    res.json({ ok: true, amount: s.amount, transRef: s.transRef });
  } catch (e) {
    res.status(e.status || 502).json({ ok: false, message: e.message || 'ตรวจสลิปไม่สำเร็จ' });
  }
});

app.listen(PORT, () => console.log('🚀 http://localhost:' + PORT));