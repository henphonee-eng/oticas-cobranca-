/* Service worker: permite instalar o app e receber avisos no celular. Não guarda dados em cache. */
self.addEventListener('install',()=>self.skipWaiting());
self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));
self.addEventListener('fetch',()=>{});
self.addEventListener('push',e=>{
  let d={};try{d=e.data?e.data.json():{}}catch(x){d={title:'Aviso',body:e.data?e.data.text():''}}
  e.waitUntil(self.registration.showNotification(d.title||'Adm Óticas',{body:d.body||'',tag:d.tag||undefined,renotify:true,icon:'/icons/adm-icon-192.png',badge:'/icons/adm-icon-192.png',data:{url:d.url||'/adm'}}));
});
self.addEventListener('notificationclick',e=>{
  e.notification.close();const url=(e.notification.data&&e.notification.data.url)||'/adm';
  e.waitUntil(self.clients.matchAll({type:'window',includeUncontrolled:true}).then(cs=>{for(const c of cs){if(c.url.includes(url.split('?')[0])&&'focus' in c){c.navigate(url);return c.focus()}}return self.clients.openWindow(url)}));
});
