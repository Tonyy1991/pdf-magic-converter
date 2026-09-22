/* PDF Magic Converter — static server + Gemini OCR proxy
   key เก็บใน env GEMINI_KEYS (คั่นคอมมา) ไม่อยู่ในโค้ด ไม่ถูกส่งให้เบราว์เซอร์ */
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const KEYS = (process.env.GEMINI_KEYS || '').split(',').map(s => s.trim()).filter(Boolean);
const MODELS = ['gemini-flash-latest', 'gemini-3.5-flash', 'gemini-3.1-flash-lite'];
const API = 'https://generativelanguage.googleapis.com/v1beta/models';
const CALL_TIMEOUT_MS = 90000;   // เพดานต่อการเรียก Gemini 1 ครั้ง
const WAIT_BUDGET_MS = 100000;   // รอโควตารายนาทีฟื้นได้นานสุดเท่านี้ต่อ 1 คำขอ
const OVERLOAD_SKIP_MS = 120000; // โมเดลตอบ 503 (ล้นฝั่ง Google) → ข้ามโมเดลนั้น "ทุก key" นานเท่านี้
const ALLOW_ORIGINS = [
  'https://tonyy1991.github.io',
  'https://pdf-magic-converter-production.up.railway.app',
  'https://pdf-magic-converter.up.railway.app',
  'http://localhost:8017',
];
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json',
};

const PROMPT = `Transcribe this scanned Thai document page accurately.
Return ONLY JSON: {"blocks":[ ...one object per element, in reading order... ]}
Two element types:
1. Paragraph: {"type":"paragraph","text":"...","align":"left|center|right","indent":true|false}
2. Table:     {"type":"table","rows":[["header1","header2"],["cell1","cell2"]]}
Rules:
- If the page contains a TABLE (grid lines or clearly columnar data), you MUST return it as a "table" element with every row and every cell in order — never flatten a table into paragraphs.
- Every table row must have the same number of cells as its header row (use "" for empty cells).
- Merge wrapped lines of the same paragraph or same cell into one string (do not split by visual line).
- "align" reflects visual alignment; "indent" true when the paragraph has a first-line indent.
- IGNORE rubber stamps, handwritten signatures, logos, and watermark artifacts entirely.
- If the page is a form filled in by hand, DO transcribe the handwritten field values (names, dates, numbers, reasons) — only signatures are ignored.
- Never return an empty "blocks" list when any text on the page is legible.
- Preserve Thai numerals and original spelling exactly as printed. Do not translate.`;

// rate limit ง่าย ๆ: 60 ครั้ง / 10 นาที ต่อ IP กันคนลากโควตา
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter(t => now - t < 600000);
  arr.push(now);
  hits.set(ip, arr);
  return arr.length > 60;
}

/* ---------- แปลงคำตอบ Gemini ให้เหลือ 2 ทรงเสมอ (โค้ดชุดเดียวกับ normalizeAiBlocks ใน index.html) ----------
   Gemini (โดยเฉพาะรุ่น lite) ตอบได้สารพัดทรง: ห่อชั้นนอกด้วยชื่ออื่น, ตารางเป็น array เปล่า ๆ,
   แถวเป็น object, ฟอร์มเป็น {label,value} ฯลฯ — เดิมทรงที่ไม่รู้จักถูก "ทิ้งเงียบ ๆ" จนได้ blocks ว่าง */
const para = (t, src) => ({ type: 'paragraph', text: t,
  align: src && (src.align === 'center' || src.align === 'right') ? src.align : 'left',
  indent: !!(src && src.indent) });
const isPrim = (v) => v === null || typeof v !== 'object';
const isGrid = (a) => Array.isArray(a) && a.length > 0 && a.every(r => Array.isArray(r) && r.every(isPrim));
const cellText = (c) => c == null ? '' :
  typeof c === 'object' ? String(c.text ?? c.value ?? Object.values(c).filter(isPrim).join(' ')).trim() : String(c).trim();
function tableBlock(rows) {
  const clean = rows.map(r => r.map(cellText)).filter(r => r.some(Boolean));
  if (!clean.length) return [];
  const n = Math.max(...clean.map(r => r.length));
  return [{ type: 'table', rows: clean.map(r => r.concat(Array(n - r.length).fill(''))) }];
}
function tableRows(x) {
  let rows = ['rows', 'data', 'body', 'cells', 'table'].map(k => x[k]).find(Array.isArray);
  if (!rows) return null;
  let head = ['header', 'headers', 'head', 'columns'].map(k => x[k]).find(Array.isArray);
  // แถวเป็น object ล้วน ({"ลำดับ":"1","รายการ":"…"}) → ใช้ชื่อคีย์เป็นหัวตาราง
  if (!head && rows.length && rows.every(r => r && typeof r === 'object' && !Array.isArray(r) && !Array.isArray(r.cells))) {
    head = Object.keys(rows[0]);
  }
  rows = rows.map(r => Array.isArray(r) ? r : r && typeof r === 'object' ? (Array.isArray(r.cells) ? r.cells : Object.values(r)) : [r]);
  return head && head.length && !Array.isArray(head[0]) ? [head, ...rows] : rows;
}
function normalizeBlocks(x) {
  if (x == null || typeof x === 'boolean') return [];
  if (typeof x !== 'object') { const t = String(x).trim(); return t ? [para(t)] : []; }
  if (Array.isArray(x)) return isGrid(x) && x.some(r => r.length > 1) ? tableBlock(x) : x.flatMap(normalizeBlocks);
  if (Array.isArray(x.blocks)) return normalizeBlocks(x.blocks);
  const type = String(x.type || '').toLowerCase();
  if (type === 'table') { const rows = tableRows(x); if (rows) return tableBlock(rows); }
  for (const k of ['rows', 'data', 'body', 'cells', 'table']) {
    if (isGrid(x[k])) return tableBlock(tableRows(x));
  }
  if (isPrim(x.text) && x.text != null) { const t = String(x.text).trim(); return t ? [para(t, x)] : []; }
  if (x.cols !== undefined) {   // สคีมาเก่า
    const t = (Array.isArray(x.cols) ? x.cols : [x.cols]).map(cellText).filter(Boolean).join('\t');
    return t ? [para(t, x)] : [];
  }
  // ห่อชั้นนอกที่ไม่รู้จัก (blocks/elements/content/page/…) → มุดลงไปหาเนื้อหา
  const nested = Object.values(x).filter(v => v && typeof v === 'object');
  if (nested.length) return nested.flatMap(normalizeBlocks);
  // วัตถุปลายทางที่ไม่รู้จัก เช่น {label,value} → เก็บข้อความไว้ดีกว่าทิ้ง
  const META = ['type', 'align', 'indent', 'style', 'level', 'id', 'role'];
  const t = Object.entries(x).filter(([k, v]) => !META.includes(k) && v != null && typeof v !== 'boolean')
    .map(([, v]) => String(v).trim()).filter(Boolean).join(' ');
  return t ? [para(t, x)] : [];
}
/* คำตอบโดนตัดกลางทาง (MAX_TOKENS) → ถอยไปที่บล็อกสุดท้ายที่ปิดครบ แล้วปิดวงเล็บให้ */
function parseAiJson(text) {
  const t = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  if (!t) return null;
  try { return JSON.parse(t); } catch { /* ลองซ่อมด้านล่าง */ }
  let i = t.lastIndexOf('}');
  for (let n = 0; i > 0 && n < 40; n++, i = t.lastIndexOf('}', i - 1)) {
    for (const tail of [']}', ']', '']) {
      try { return JSON.parse(t.slice(0, i + 1) + tail); } catch { /* ถอยต่อ */ }
    }
  }
  return null;
}

/* ---------- สถานะโควตาราย key × model (ในหน่วยความจำ — รีสตาร์ตแล้วเริ่มนับใหม่) ----------
   เรียงแบบ "โมเดลเก่งสุดก่อน ทุก key" แล้วค่อยถอยไปโมเดลสำรอง (เดิมไล่ทีละ key ทำให้ตกไป lite เร็วเกิน) */
const combos = [];
MODELS.forEach(model => KEYS.forEach((key, ki) => combos.push({
  key, ki, model, deadUntil: 0, why: '', ok: 0, empty: 0, r429: 0, streak429: 0, r503: 0, err: 0, lastStatus: 0, lastAt: 0,
})));
const noThinkCfg = new Set();   // โมเดลที่ไม่รับ thinkingBudget:0 → เรียกแบบไม่ส่ง thinkingConfig
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function nextPacificMidnight() {   // โควตารายวันของ Gemini รีเซ็ตเที่ยงคืนเวลา Pacific (= 14:00–15:00 น. ไทย)
  const now = new Date();
  const p = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hourCycle: 'h23',
    hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(now);
  const v = (t) => +p.find(x => x.type === t).value;
  return now.getTime() + (86400 - (v('hour') * 3600 + v('minute') * 60 + v('second'))) * 1000;
}
function kill(list, ms, why) {
  const until = Date.now() + ms;
  // ต่อเวลาพักได้อย่างเดียว ไม่ย่นให้สั้นลง (เช่น key ที่หมดโควตารายวันอยู่ ไม่ควรถูก 503 ของ key อื่นมาปลุกก่อนเวลา)
  for (const c of list) if (until > c.deadUntil) { c.deadUntil = until; c.why = why; }
}

/* เรียก Gemini 1 ครั้ง → คืน {kind:'ok'|'empty'|'rpd'|'rpm'|'bad-key'|'no-model'|'bad-request'|'upstream'|'blocked'|'parse'} */
async function callGemini(c, b64) {
  const gen = { response_mime_type: 'application/json', temperature: 0, maxOutputTokens: 32768 };
  // ปิด thinking: งาน OCR ไม่ต้องคิดยาว (หน้าตารางแน่นเคยทำให้คิดวนจน timeout)
  const sentThink = !noThinkCfg.has(c.model);
  if (sentThink) gen.thinkingConfig = { thinkingBudget: 0 };
  let res;
  try {
    res = await fetch(`${API}/${c.model}:generateContent?key=${encodeURIComponent(c.key)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ inline_data: { mime_type: 'image/jpeg', data: b64 } }, { text: PROMPT }] }],
        generationConfig: gen,
      }),
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
  } catch {
    c.err++; c.lastStatus = 0; c.lastAt = Date.now();
    kill([c], 15000, 'upstream');
    return { kind: 'upstream', status: 0 };
  }
  c.lastStatus = res.status; c.lastAt = Date.now();

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const e = body.error || {};
    const msg = String(e.message || '');
    const details = Array.isArray(e.details) ? e.details : [];
    if (res.status === 429) {
      c.r429++; c.streak429++;
      const ids = details.flatMap(d => d.violations || []).map(v => String(v.quotaId || ''));
      const retry = details.map(d => d.retryDelay).find(Boolean) || (msg.match(/retry in ([\d.]+)s/i) || [])[1];
      // โดน 429 ติดกัน 4 ครั้งโดยไม่เคยผ่านเลย = น่าจะหมดรายวัน แม้ Google ไม่ได้บอกตรง ๆ
      if (ids.some(id => /PerDay/i.test(id)) || /per\s*day/i.test(msg) || c.streak429 >= 4) {
        kill([c], 30 * 60000, 'rpd');   // หมดโควตารายวัน: พัก 30 นาทีแล้วค่อยแหย่ใหม่ (เผื่อรีเซ็ตแล้ว)
        return { kind: 'rpd', status: 429 };
      }
      kill([c], Math.min(65000, Math.max(5000, (parseFloat(retry) || 20) * 1000)), 'rpm');
      return { kind: 'rpm', status: 429 };
    }
    // 503 / UNAVAILABLE = Google บอกว่าโมเดลนี้ล้น — เป็นทั้งโมเดล ไม่ใช่ราย key → ข้ามโมเดลนี้ทุก key 2 นาที
    // (เดิมพักแค่ key×โมเดลนั้น 15 วิ ทำให้เอกสารหลายหน้าเสียเวลารอ 503 ซ้ำทุกหน้า หน้าละ ~18 วิ)
    if (res.status === 503 || e.status === 'UNAVAILABLE' || /overloaded/i.test(msg)) {
      c.r503++;
      kill(combos.filter(x => x.model === c.model), OVERLOAD_SKIP_MS, 'overloaded');
      return { kind: 'overloaded', status: res.status };
    }
    c.err++;
    if (res.status === 404) { kill(combos.filter(x => x.model === c.model), 6 * 3600000, 'no-model'); return { kind: 'no-model', status: 404 }; }
    if (res.status === 400 && sentThink && /think/i.test(msg)) {
      noThinkCfg.add(c.model);        // โมเดลนี้ปิด thinking ไม่ได้ → ลองใหม่ทันทีแบบไม่ส่ง thinkingConfig
      return callGemini(c, b64);
    }
    const keyProblem = res.status === 403 || /api[ _]?key/i.test(msg) ||
      details.some(d => /API_KEY|PERMISSION|SERVICE_DISABLED|CONSUMER/i.test(String(d.reason || '')));
    if (keyProblem) { kill(combos.filter(x => x.ki === c.ki), 6 * 3600000, 'bad-key'); return { kind: 'bad-key', status: res.status }; }
    if (res.status === 400) { kill([c], 10 * 60000, 'bad-request'); return { kind: 'bad-request', status: 400, msg: msg.slice(0, 160) }; }
    kill([c], 15000, 'upstream');     // 5xx อื่น ๆ (500 internal ฯลฯ) พักเฉพาะ key×โมเดลนี้สั้น ๆ
    return { kind: 'upstream', status: res.status };
  }

  const data = await res.json().catch(() => null);
  const cand = data?.candidates?.[0];
  const finish = cand?.finishReason || data?.promptFeedback?.blockReason || '';
  const text = (cand?.content?.parts || []).map(p => p.text || '').join('');
  if (!text.trim()) { c.err++; return { kind: 'blocked', status: 200, finish }; }
  const json = parseAiJson(text);
  if (json === null) { c.err++; return { kind: 'parse', status: 200, finish }; }
  const blocks = normalizeBlocks(json);
  c.streak429 = 0; c.why = '';
  if (!blocks.length) { c.empty++; return { kind: 'empty', status: 200, finish }; }
  c.ok++;
  return { kind: 'ok', status: 200, finish, blocks };
}

async function ocr(b64) {
  const t0 = Date.now();
  const tries = [];
  const skip = new Set();        // combo ที่ไม่ต้องลองซ้ำในคำขอนี้
  const emptyModels = new Set(); // โมเดลที่ตอบว่า "หน้านี้ไม่มีข้อความ"
  const meta = (extra) => ({ ms: Date.now() - t0, tries, ...extra });

  // ยังมีสิทธิ์ลอง: ไม่ถูกตัดทิ้งในคำขอนี้ และถ้าพักอยู่ต้องเป็นการพักชั่วคราว (รายนาที/ล่มชั่วคราว)
  const retryable = (c) => !skip.has(c) && !emptyModels.has(c.model) &&
    !(c.deadUntil > Date.now() && c.why !== 'rpm' && c.why !== 'upstream');

  for (let pass = 0; pass < 4; pass++) {
    for (const c of combos) {
      if (skip.has(c) || emptyModels.has(c.model) || c.deadUntil > Date.now()) continue;
      const t = Date.now();
      const r = await callGemini(c, b64);
      tries.push({ model: c.model, key: c.ki + 1, kind: r.kind, status: r.status, ms: Date.now() - t, finish: r.finish || undefined, msg: r.msg });
      if (r.kind === 'ok') return { blocks: r.blocks, meta: meta({ model: c.model, key: c.ki + 1 }) };
      if (r.kind === 'empty') {
        // ฝั่งเว็บกรองหน้าว่างออกก่อนส่งแล้ว → "ว่าง" คือน่าสงสัย ให้โมเดลอื่นยืนยันอีก 1 ตัว
        emptyModels.add(c.model);
        if (emptyModels.size >= 2) return { blocks: [], meta: meta({ empty: true }) };
      } else if (r.kind !== 'rpm' && r.kind !== 'upstream') {
        skip.add(c);
      }
    }
    // ลองครบรอบแล้วยังไม่ได้: ถ้ามีตัวที่แค่ติดโควตารายนาที/ล่มชั่วคราว และจะฟื้นทันเวลา → รอแล้ววนใหม่
    const pending = combos.filter(retryable);
    if (!pending.length) break;
    const wake = Math.min(...pending.map(c => Math.max(c.deadUntil, Date.now())));
    if (wake - t0 > WAIT_BUDGET_MS) break;
    await sleep(wake - Date.now() + 300);
  }

  if (emptyModels.size) return { blocks: [], meta: meta({ empty: true }) };
  // ไม่มีตัวไหนอ่านได้ → บอกสาเหตุที่ "ฟื้นเร็วสุด" ก่อน ผู้ใช้จะได้รู้ว่าต้องรอครู่เดียว ไม่ใช่รอรีเซ็ตรายวัน
  const now = Date.now();
  const dead = (w) => combos.filter(c => c.deadUntil > now && c.why === w);
  const rpm = dead('rpm'), over = dead('overloaded').concat(dead('upstream')), rpd = dead('rpd');
  const err = new Error(rpm.length ? 'quota' : over.length ? 'overloaded' : rpd.length ? 'quota' : 'upstream');
  err.status = err.message === 'quota' ? 429 : err.message === 'overloaded' ? 503 : 502;
  err.payload = {
    error: err.message,
    // day = โควตารายวันหมด (รอรีเซ็ต), minute = แค่ถี่เกินไป รอไม่กี่วินาที
    scope: rpm.length ? 'minute' : 'day',
    // overloaded: อีกกี่วินาทีโมเดลแรกจะถูกลองใหม่
    retryInSec: over.length ? Math.ceil((Math.min(...over.map(c => c.deadUntil)) - now) / 1000) : 0,
    resetAt: nextPacificMidnight(),
    meta: meta({}),
  };
  throw err;
}

/* สถานะโควตาแบบไม่เปลืองโควตา: สรุปจากการเรียกจริงที่ผ่านมา (ไม่เปิดเผย key) */
function health() {
  const now = Date.now();
  const list = combos.map(c => ({
    key: c.ki + 1, model: c.model,
    state: c.deadUntil > now ? c.why : (c.lastAt ? 'ok' : 'unknown'),
    retryInSec: c.deadUntil > now ? Math.ceil((c.deadUntil - now) / 1000) : 0,
    lastStatus: c.lastStatus, lastAgoSec: c.lastAt ? Math.round((now - c.lastAt) / 1000) : null,
    ok: c.ok, empty: c.empty, r429: c.r429, r503: c.r503, err: c.err,
  }));
  const usable = list.filter(c => ['ok', 'unknown', 'rpm', 'upstream'].includes(c.state));
  const overloaded = list.filter(c => c.state === 'overloaded');
  return {
    // overloaded = Google ล้นทุกโมเดล (ฟื้นเองใน 2 นาที ไม่ใช่โควตาหมด) — แยกจาก exhausted ให้หน้าเว็บบอกผู้ใช้ถูก
    status: !KEYS.length ? 'no_keys' : usable.length ? (usable.length < list.length ? 'degraded' : 'ok')
      : overloaded.length ? 'overloaded' : 'exhausted',
    keys: KEYS.length, models: MODELS, usable: usable.length, total: list.length,
    overloaded: overloaded.length,
    overloadedRetryInSec: overloaded.length ? Math.min(...overloaded.map(c => c.retryInSec)) : 0,
    resetAt: nextPacificMidnight(), uptimeMin: Math.round(process.uptime() / 60), combos: list,
  };
}

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin || '';
  if (ALLOW_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }
  if (req.method === 'OPTIONS') { res.end(); return; }

  if (req.method === 'GET' && (req.url || '').split('?')[0] === '/api/health') {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify(health()));
    return;
  }

  if (req.method === 'POST' && req.url === '/api/ocr') {
    const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress;
    res.setHeader('Content-Type', 'application/json');
    if (rateLimited(ip)) { res.statusCode = 429; res.end(JSON.stringify({ error: 'rate_limited', scope: 'ip' })); return; }
    if (!KEYS.length) { res.statusCode = 503; res.end(JSON.stringify({ error: 'no_server_keys' })); return; }
    const chunks = [];
    let size = 0;
    req.on('data', c => { size += c.length; if (size > 8 * 1024 * 1024) req.destroy(); chunks.push(c); });
    req.on('end', async () => {
      try {
        const { image } = JSON.parse(Buffer.concat(chunks).toString());
        if (!image || typeof image !== 'string') throw new Error('bad request');
        const result = await ocr(image);
        console.log(JSON.stringify({ at: new Date().toISOString(), result: result.blocks.length ? 'ok' : 'empty', blocks: result.blocks.length, ...result.meta }));
        res.end(JSON.stringify(result));
      } catch (e) {
        console.log(JSON.stringify({ at: new Date().toISOString(), result: e.message, ...(e.payload?.meta || {}) }));
        res.statusCode = e.status === 429 || e.status === 503 ? e.status : 502;
        res.end(JSON.stringify(e.payload || { error: e.message || 'ocr_failed' }));
      }
    });
    return;
  }

  // static files
  const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  const safe = path.normalize(urlPath).replace(/^([.]{2}[\/\\])+/, '');
  let fp = path.join(__dirname, safe === '/' || safe === '\\' ? 'index.html' : safe);
  if (!fp.startsWith(__dirname)) { res.statusCode = 403; res.end(); return; }
  if (!fs.existsSync(fp) || fs.statSync(fp).isDirectory()) { res.statusCode = 404; res.end('not found'); return; }
  res.setHeader('Content-Type', MIME[path.extname(fp).toLowerCase()] || 'application/octet-stream');
  // หน้าเว็บ + service worker ต้องสดเสมอ ไม่งั้นแก้บั๊กแล้วผู้ใช้ยังเห็นของเก่า
  if (/\.(html|js|json)$/i.test(fp)) res.setHeader('Cache-Control', 'no-cache');
  fs.createReadStream(fp).pipe(res);
});

if (require.main === module) {
  server.listen(PORT, () => console.log(`up on ${PORT}, keys: ${KEYS.length}`));
}
module.exports = { normalizeBlocks, parseAiJson, ocr, health, combos };
