self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
// Pass-through — offline core already works via SQLite; this just enables PWA installability.
self.addEventListener('fetch', () => {});
