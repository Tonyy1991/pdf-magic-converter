/* PDF Magic Converter — static server + Gemini OCR proxy
   key เก็บใน env GEMINI_KEYS (คั่นคอมมา) ไม่อยู่ในโค้ด ไม่ถูกส่งให้เบราว์เซอร์ */
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const KEYS = (process.env.GEMINI_KEYS || '').split(',').map(s => s.trim()).filter(Boolean);
const MODELS = ['gemini-flash-latest', 'gemini-3.5-flash', 'gemini-3.1-flash-lite'];
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

function flatten(x) {
  if (Array.isArray(x)) return x.flatMap(flatten);
  if (x && typeof x === 'object') {
    if (x.blocks) return flatten(x.blocks);
    if (x.type === 'table' && Array.isArray(x.rows)) return [x];
    if (x.type === 'paragraph' || x.text !== undefined) return [x];
    if (x.cols !== undefined) return [x];
  }
  return [];
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function ocr(b64) {
  // ชน RPM ของ free tier → รอแล้วลองใหม่ สูงสุด 3 รอบ (0s, 20s, 35s)
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await sleep(attempt === 1 ? 20000 : 35000);
    try {
      return await ocrOnce(b64);
    } catch (e) {
      if (e.status !== 429 || attempt === 2) throw e;
    }
  }
}

async function ocrOnce(b64) {
  let lastStatus = 0;
  for (const key of KEYS) {
    for (const model of MODELS) {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [
              { inline_data: { mime_type: 'image/jpeg', data: b64 } },
              { text: PROMPT },
            ]}],
            generationConfig: { response_mime_type: 'application/json', temperature: 0 },
          }),
        }
      );
      lastStatus = res.status;
      if (res.status === 404) continue;              // โมเดลถัดไป
      if (res.status === 429) continue;                 // โมเดลถัดไป (โควตาแยกรายโมเดล)
      if (res.status === 400 || res.status === 403) break; // key ถัดไป
      if (!res.ok) continue;
      const data = await res.json();
      const text = (data.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('');
      try {
        return { blocks: flatten(JSON.parse(text.replace(/^```json\s*/i, '').replace(/```\s*$/, ''))) };
      } catch { continue; }
    }
  }
  const err = new Error(lastStatus === 429 ? 'quota' : 'upstream');
  err.status = lastStatus;
  throw err;
}

http.createServer(async (req, res) => {
  const origin = req.headers.origin || '';
  if (ALLOW_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }
  if (req.method === 'OPTIONS') { res.end(); return; }

  if (req.method === 'POST' && req.url === '/api/ocr') {
    const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress;
    if (rateLimited(ip)) { res.statusCode = 429; res.end(JSON.stringify({ error: 'rate_limited' })); return; }
    if (!KEYS.length) { res.statusCode = 503; res.end(JSON.stringify({ error: 'no_server_keys' })); return; }
    const chunks = [];
    let size = 0;
    req.on('data', c => { size += c.length; if (size > 8 * 1024 * 1024) req.destroy(); chunks.push(c); });
    req.on('end', async () => {
      try {
        const { image } = JSON.parse(Buffer.concat(chunks).toString());
        if (!image || typeof image !== 'string') throw new Error('bad request');
        const result = await ocr(image);
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(result));
      } catch (e) {
        res.statusCode = e.status === 429 ? 429 : 502;
        res.end(JSON.stringify({ error: e.message || 'ocr_failed' }));
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
  fs.createReadStream(fp).pipe(res);
}).listen(PORT, () => console.log(`up on ${PORT}, keys: ${KEYS.length}`));
