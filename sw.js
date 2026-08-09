const CACHE_NAME = 'organizador-escolar-v1';

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  self.clients.claim();
});

// Passa todo pedido direto pra rede (sem cache agressivo) — só precisa existir
// para o navegador considerar o app "instalável". Importante: só intercepta
// pedidos GET (carregar páginas/arquivos estáticos). Pedidos de envio de dados
// (POST/PATCH/DELETE, como enviar um arquivo) passam direto, sem interceptação —
// interceptar esses pedidos é uma causa comum de falha ao enviar arquivos
// em apps instalados no celular.
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request))
  );
});
