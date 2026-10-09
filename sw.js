/* Service worker mínimo: permite instalar o app no celular. Não guarda dados em cache. */
self.addEventListener('install',()=>self.skipWaiting());
self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));
self.addEventListener('fetch',()=>{});
