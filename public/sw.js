const CACHE_NAME = 'organizador-escolar-v1';

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  self.clients.claim();
});

// Passa todo pedido direto pra rede (sem cache agressivo) — só precisa existir
// para o navegador considerar o app "instalável".
self.addEventListener('fetch', (event) => {
  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request))
  );
});
