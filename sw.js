/* Keeps the whole app on the device. First visit stores everything; after that it
   never needs a network. Bump VERSION to push an update the next time it is online. */
const VERSION = 'cm-202610010732';   // stamped by publish_site.sh
// ONNX Runtime Web (runs the learned fingerprint in engine/fp-worker.js), from its CDN, kept offline
const ORT_BASE = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/';
const ORT_FILES = ['ort.wasm.min.js', 'ort.wasm.min.mjs', 'ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm'];
// The on-device speech model (asr/, app/build_asr.py) and transformers.js with its runtime, from
// jsDelivr: ~66 MB, kept in a cache of their own that a new app version does NOT throw away (the
// files are pinned and never change), so the words are heard with no internet from then on
const ASR_CACHE = 'cm-asr-tiny.en-2575352';
const TF_BASE = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1/dist/';
const TF_FILES = ['transformers.min.js', 'ort-wasm-simd-threaded.jsep.mjs', 'ort-wasm-simd-threaded.jsep.wasm'];
const SHELL = ['./', 'index.html', 'app.js', 'orb.js', 'manifest.webmanifest', 'manifest-ios.webmanifest', 'icon-512.png', 'icon-192.png',
               'data/songs.json', 'fonts/inter-600.woff2', 'fonts/inter-800.woff2', 'awake.mp4'];
self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const c = await caches.open(VERSION);
    // straight from the server, never from the browser's own cache (it can hold a copy that's minutes old)
    await c.addAll(SHELL.map(u => new Request(u, {cache:'reload'})));
    // the offline-only files one by one, so a host without them (the Mac serves none of
    // them) can't fail the install
    for(const f of ['decide.js', 'lyricsearch.js', 'words.js', 'mention.js', 'data/titles.json', 'data/preached.json', 'data/loops.json', 'asrtext.js']){ try{ await c.add(f); }catch(err){} }
    // the engine's code (small) straight from the server: a copy minutes old would pair an old engine
    // with a new app. The BIG files (index shards, the learned fingerprint, the speech model, the
    // runtimes: ~180 MB) are NOT fetched here: a browser gives an install about 5 minutes, and on a
    // slow connection that isn't enough, so the install failed and nothing worked offline. The page
    // fetches them through this worker after it takes control (app.js keepOffline()), with no limit.
    for(const f of ['engine/manifest.json', 'engine/fp-worker.js', 'engine/engine.js', 'engine/fp2.js', 'asr/asr-worker.js', 'asr/manifest.json'])
      try{ await c.add(new Request(f, {cache:'reload'})); }catch(err){}
    // the song index (and the learned fingerprint) for THIS version before it takes over, so an update
    // never leaves the device without the index, but never longer than ~3.5 min: past that the
    // install would be killed, so the rest is left to the page (keepOffline())
    const big = (async () => {
      try{
        const m = await (await fetch('engine/manifest.json', {cache:'no-store'})).json();
        for(const x of m.shards || []){ const f = 'engine/' + (x.file || x);
          if(!(await c.match(f))){ const old = await caches.match(f); if(old) await c.put(f, old); else try{ await c.add(f); }catch(err){} } }
        const m2 = await (await fetch('engine/fp2/manifest.json', {cache:'no-store'})).json();
        for(const f of ['engine/fp2/manifest.json', 'engine/fp2/' + m2.model.file, ...(m2.shards || []).map(x => 'engine/fp2/' + x.file)])
          if(!(await c.match(f))) try{ await c.add(new Request(f, {cache:'reload'})); }catch(err){}
      }catch(err){}
    })();
    await Promise.race([big, new Promise(r => setTimeout(r, 210000))]);
    self.skipWaiting();
  })());
});
self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    // keep the previous version's cache too until this one has its big files (app.js keepOffline()
    // fetches them after this takes control): offline in between, they are still there
    const old = (await caches.keys()).filter(k => k !== VERSION && k !== ASR_CACHE && /^cm-\d/.test(k)).sort();
    for(const k of await caches.keys()) if(k !== VERSION && k !== ASR_CACHE && k !== old[old.length - 1]) await caches.delete(k);
    self.clients.claim();
  })());
});
// Online: always the newest app, so a refresh shows the latest version.
// Offline: the stored copy, so it still works with no signal at all.
// The recognition data never changes between versions, so it is served from storage first.
self.addEventListener('fetch', e => {
  if(e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  const ortFile = url.href.startsWith(ORT_BASE);
  // the speech model and its runtime: from their own cache first, stored there the first time
  if(url.href.startsWith(TF_BASE) || (url.origin === location.origin && url.pathname.includes('/asr/models/'))){
    e.respondWith((async () => {
      const a = await caches.open(ASR_CACHE);
      const hit = await a.match(e.request, {ignoreSearch:true});
      if(hit) return hit;
      const res = await fetch(e.request);
      if(res.ok) a.put(e.request, res.clone());
      return res;
    })());
    return;
  }
  if(url.origin !== location.origin && !ortFile) return;
  const immutable = (url.pathname.includes('/engine/') && !url.pathname.endsWith('manifest.json')) || ortFile;
  e.respondWith((async () => {
    const c = await caches.open(VERSION);
    if(immutable){
      let hit = await c.match(e.request, {ignoreSearch:true});
      // a content-named file (an index shard, a pinned runtime) kept by the previous version: reuse it
      if(!hit && !url.searchParams.has('v') && (hit = await caches.match(e.request, {ignoreSearch:true}))) c.put(e.request, hit.clone());
      if(hit) return hit;
    }
    try{
      // big immutable files (index shards, the runtime) get all the time they need
      const res = immutable ? await fetch(e.request) : await Promise.race([
        fetch(e.request, {cache:'no-store'}),
        new Promise((_, rej) => setTimeout(() => rej(new Error('slow')), 3500))]);
      if(res.ok && (url.origin === location.origin || ortFile)) c.put(e.request, res.clone());
      return res;
    }catch(err){
      return (await c.match(e.request, {ignoreSearch:true})) || (await c.match('index.html')) || Response.error();
    }
  })());
});
