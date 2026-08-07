/* Service Worker — PDF Magic Converter
   ให้เปิดใช้แบบออฟไลน์ได้หลังโหลดครั้งแรก (app shell + ไลบรารี CDN + โมเดล OCR) */
const CACHE = 'pdf-magic-v2';
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
  // แคชเฉพาะไฟล์แอปตัวเอง + ไลบรารี/โมเดลจาก CDN ที่เชื่อถือได้
  const cacheable =
    url.origin === location.origin ||
    ['cdnjs.cloudflare.com', 'unpkg.com', 'cdn.jsdelivr.net',
     'fonts.googleapis.com', 'fonts.gstatic.com',
     'tessdata.projectnaptha.com'].includes(url.hostname);
  if (!cacheable) return;

  // stale-while-revalidate: ตอบจากแคชทันที แล้วอัปเดตเบื้องหลัง
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
