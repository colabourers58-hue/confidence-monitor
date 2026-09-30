/* Keeps the whole app on the device. First visit stores everything; after that it
   never needs a network. Bump VERSION to push an update the next time it is online. */
const VERSION = 'cm-202609301812';   // stamped by publish_site.sh
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
    for(const f of ['decide.js', 'lyricsearch.js', 'words.js', 'mention.js', 'data/titles.json', 'data/preached.json', 'asrtext.js']){ try{ await c.add(f); }catch(err){} }
    try{
      const m = await (await fetch('engine/manifest.json', {cache:'no-store'})).json();
      const files = ['engine/manifest.json', 'engine/fp-worker.js', 'engine/engine.js',
                     ...(m.shards || []).map(s => 'engine/' + (s.file || s))];
      // the engine's code straight from the server (a copy minutes old would pair an old engine with a new app)
      for(const f of files){ try{ await c.add(f.endsWith('.js') ? new Request(f, {cache:'reload'}) : f); }catch(err){} }
    }catch(err){}
    // the learned fingerprint (engine/fp2) and its runtime: optional, each file on its own
    try{
      const m2 = await (await fetch('engine/fp2/manifest.json', {cache:'no-store'})).json();
      const f2 = ['engine/fp2/manifest.json', 'engine/fp2.js', 'engine/fp2/' + m2.model.file, ...(m2.shards || []).map(s => 'engine/fp2/' + s.file)];
      for(const f of f2){ try{ await c.add(f.endsWith('.js') ? new Request(f, {cache:'reload'}) : f); }catch(err){} }
      for(const f of ORT_FILES){ try{ await c.add(new Request(ORT_BASE + f, {mode:'cors'})); }catch(err){} }
    }catch(err){}
    // the on-device speech model: kept once, across versions (only what isn't there yet is fetched)
    try{
      const a = await caches.open(ASR_CACHE);
      const man = await (await fetch('asr/manifest.json', {cache:'no-store'})).json();
      await c.add(new Request('asr/asr-worker.js', {cache:'reload'})).catch(() => {});
      await c.put('asr/manifest.json', new Response(JSON.stringify(man), {headers: {'Content-Type': 'application/json'}}));
      for(const f of man.files){ if(!(await a.match('asr/' + f.file))) try{ await a.add('asr/' + f.file); }catch(err){} }
      for(const f of TF_FILES){ if(!(await a.match(TF_BASE + f))) try{ await a.add(new Request(TF_BASE + f, {mode:'cors'})); }catch(err){} }
    }catch(err){}
    self.skipWaiting();
  })());
});
self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for(const k of await caches.keys()) if(k !== VERSION && k !== ASR_CACHE) await caches.delete(k);
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
      const hit = await c.match(e.request, {ignoreSearch:true});
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
