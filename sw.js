/* Service Worker — PDF Magic Converter
   ให้เปิดใช้แบบออฟไลน์ได้หลังโหลดครั้งแรก (app shell + ไลบรารี CDN + โมเดล OCR) */
const CACHE = 'pdf-magic-v4';
const SHELL = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-512.png',
  './apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // API ของเซิร์ฟเวอร์กลาง (สถานะโควตา) ต้องสดเสมอ ห้ามแคช
  if (url.pathname.includes('/api/')) return;
  // แคชเฉพาะไฟล์แอปตัวเอง + ไลบรารี/โมเดลจาก CDN ที่เชื่อถือได้
  const cacheable =
    url.origin === location.origin ||
    ['cdnjs.cloudflare.com', 'unpkg.com', 'cdn.jsdelivr.net',
     'fonts.googleapis.com', 'fonts.gstatic.com',
     'tessdata.projectnaptha.com'].includes(url.hostname);
  if (!cacheable) return;

  // หน้าเว็บ: network-first — แก้บั๊กแล้วผู้ใช้ได้ของใหม่ทันที ไม่ต้องรอเปิดรอบสอง (ออฟไลน์ค่อยใช้แคช)
  if (req.mode === 'navigate') {
    e.respondWith(
      // cache:'no-cache' = บังคับถามเซิร์ฟเวอร์เสมอ (ไม่งั้น HTTP cache ของเบราว์เซอร์อาจส่งหน้าเก่าให้อีกชั้น)
      fetch(req.url, { cache: 'no-cache' }).then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      }).catch(() => caches.match(req).then((hit) => hit || caches.match('./index.html')))
    );
    return;
  }

  // ที่เหลือ (ไลบรารี/โมเดล/ไอคอน): stale-while-revalidate ตอบจากแคชทันที แล้วอัปเดตเบื้องหลัง
  e.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(req);
      const fetching = fetch(req)
        .then((res) => {
          if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone());
          return res;
        })
        .catch(() => cached);
      return cached || fetching;
    })
  );
});
