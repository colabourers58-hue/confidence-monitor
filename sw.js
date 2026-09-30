/* Keeps the whole app on the device. First visit stores everything; after that it
   never needs a network. Bump VERSION to push an update the next time it is online. */
const VERSION = 'cm-202609301145';   // stamped by publish_site.sh
const SHELL = ['./', 'index.html', 'app.js', 'orb.js', 'manifest.webmanifest', 'icon-512.png',
               'data/songs.json', 'fonts/inter-600.woff2', 'fonts/inter-800.woff2', 'awake.mp4'];
self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const c = await caches.open(VERSION);
    // straight from the server, never from the browser's own cache (it can hold a copy that's minutes old)
    await c.addAll(SHELL.map(u => new Request(u, {cache:'reload'})));
    // the offline-only files one by one, so a host without them (the Mac serves none of
    // them) can't fail the install
    for(const f of ['decide.js', 'lyricsearch.js', 'words.js']){ try{ await c.add(f); }catch(err){} }
    try{
      const m = await (await fetch('engine/manifest.json', {cache:'no-store'})).json();
      const files = ['engine/manifest.json', 'engine/fp-worker.js', 'engine/engine.js',
                     ...(m.shards || []).map(s => 'engine/' + (s.file || s))];
      for(const f of files){ try{ await c.add(f); }catch(err){} }
    }catch(err){}
    self.skipWaiting();
  })());
});
self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for(const k of await caches.keys()) if(k !== VERSION) await caches.delete(k);
    self.clients.claim();
  })());
});
// Online: always the newest app, so a refresh shows the latest version.
// Offline: the stored copy, so it still works with no signal at all.
// The recognition data never changes between versions, so it is served from storage first.
self.addEventListener('fetch', e => {
  if(e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  const immutable = url.pathname.includes('/engine/') && !url.pathname.endsWith('manifest.json');
  e.respondWith((async () => {
    const c = await caches.open(VERSION);
    if(immutable){
      const hit = await c.match(e.request, {ignoreSearch:true});
      if(hit) return hit;
    }
    try{
      const res = await Promise.race([
        fetch(e.request, {cache:'no-store'}),
        new Promise((_, rej) => setTimeout(() => rej(new Error('slow')), 3500))]);
      if(res.ok && url.origin === location.origin) c.put(e.request, res.clone());
      return res;
    }catch(err){
      return (await c.match(e.request, {ignoreSearch:true})) || (await c.match('index.html')) || Response.error();
    }
  })());
});
