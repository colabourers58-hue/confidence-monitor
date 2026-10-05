/* Prompter's offline store (Joel: "if it doesn't work 100% of the time, it doesn't work").

   - Every publish lists every file the app needs in offline.json (app/stamp_site.sh): path, size,
     SHA-256 and which part of the app it belongs to. Nothing the app needs comes from another site:
     the runtimes are in vendor/ (app/build_vendor.py).
   - The page asks this worker to save the newest published version ('save'). Every file is checked
     (size and checksum) as it is stored. A version counts as saved only when ALL its files are in.
     If the download is cut off, the next try carries on where it stopped.
   - The big files (song index, learned fingerprint, speech model, runtimes: ~230 MB) are stored by
     their checksum in one store that every version shares ('cm-blobs'), so an update downloads only
     the files that actually changed. Each version's small files (code, songs, manifests) are in
     'cm-shell-<version>'.
   - Which version runs ('cm-meta' › current) changes only when the page says so ('use'): between
     songs, not listening, or as Prompter opens. Until then the version already on the device keeps
     running, online or offline. Files only older versions needed are removed only after a switch.
   - This script itself does not change from one publish to the next (the version is data, not
     code), so publishing never puts the browser's service-worker update machinery in the way.
     If this file IS changed, the new one waits until Prompter is next opened (no skipWaiting: a
     waiting worker told to skip while the page was busy left a reload hanging in tests, 2 Oct).
   Never served from here: sw.js, version.json, offline.json (always the network). */
const SW_CODE = 2;                       // change only when this file changes
const BLOBS = 'cm-blobs', META = 'cm-meta';
const SCOPE = new URL(self.registration.scope);
const at = p => new URL(p, SCOPE).href;
const shellOf = v => 'cm-shell-' + v;
const MARK = at('__offline-complete');   // in a version's shell store: its offline.json, written once ALL its files are in
const STATE = at('__state');             // in META: {current}
const blobKey = h => at('__blob/' + h);
const TYPES = {js: 'text/javascript', mjs: 'text/javascript', json: 'application/json', webmanifest: 'application/manifest+json',
               html: 'text/html; charset=utf-8', wasm: 'application/wasm', png: 'image/png', woff2: 'font/woff2', mp4: 'video/mp4'};
const typeOf = p => TYPES[(p.split('.').pop() || '').toLowerCase()] || 'application/octet-stream';
const hex = b => Array.from(new Uint8Array(b), x => x.toString(16).padStart(2, '0')).join('');
const err = e => String(e && e.message || e);

/* ---------- what is saved ---------- */
let STATE_MEMO = null;
async function state(){
  if(STATE_MEMO) return STATE_MEMO;
  const r = await (await caches.open(META)).match(STATE);
  return (STATE_MEMO = r ? await r.json() : {current: null});
}
async function setState(s){ STATE_MEMO = s; await (await caches.open(META)).put(STATE, new Response(JSON.stringify(s), {headers: {'content-type': 'application/json'}})); }
const FILES = new Map();                 // version -> Map(path -> file), from its completed list
async function filesOf(v){
  if(!v) return null;
  if(FILES.has(v)) return FILES.get(v);
  if(!(await caches.has(shellOf(v)))) return null;
  const r = await (await caches.open(shellOf(v))).match(MARK);
  if(!r) return null;
  const m = new Map((await r.json()).files.map(f => [f.p, f]));
  FILES.set(v, m); return m;
}

/* ---------- saving a version ---------- */
let job = null, saving = null, lastPost = 0;
async function stored(f, shell, blobs){
  const r = f.big ? await blobs.match(blobKey(f.h)) : await shell.match(at(f.p));
  return !!r && r.headers.get('x-cm-sha256') === f.h;
}
async function verified(buf, f){ return buf.byteLength === f.b && hex(await crypto.subtle.digest('SHA-256', buf)) === f.h; }
// download one file, never hanging: a connection that stops delivering for 30 s is dropped (the next try
// carries on), so a weak signal can't leave the save stuck forever. Read straight into a buffer of the
// listed size, so a 40 MB file needs 40 MB of memory, not twice that.
async function download(url, mode, size){
  const ac = typeof AbortController === 'function' ? new AbortController() : null;
  let timer = null;
  const arm = ms => { clearTimeout(timer); if(ac) timer = setTimeout(() => ac.abort(), ms); };
  arm(30000);
  try{
    const res = await fetch(new Request(url, ac ? {cache: mode, signal: ac.signal} : {cache: mode}));
    if(!res.ok) throw new Error('HTTP ' + res.status);
    if(!res.body || !res.body.getReader){ arm(600000); return await res.arrayBuffer(); }
    const rd = res.body.getReader(), out = new Uint8Array(size);
    let n = 0;
    for(;;){
      arm(30000);
      const r = await rd.read();
      if(r.done) break;
      if(n + r.value.byteLength > size) throw new Error(`larger than listed (${size} bytes)`);
      out.set(r.value, n); n += r.value.byteLength;
    }
    return n === size ? out.buffer : out.buffer.slice(0, n);
  }catch(e){ throw ac && ac.signal.aborted ? new Error('the connection stopped delivering') : e; }
  finally{ clearTimeout(timer); }
}
async function saveOne(f, shell, blobs){
  if(await stored(f, shell, blobs)) return;
  let buf = null, why = 'not found';
  // a copy an older Prompter kept (its stores used plain names): reused if it is byte-for-byte the same
  try{ const old = await caches.match(f.p, {ignoreSearch: true}); if(old){ const b = await old.arrayBuffer(); if(await verified(b, f)) buf = b; } }catch(e){}
  // the browser's own cache may hold the copy the page just downloaded; if that is stale, straight from the server
  for(const mode of ['default', 'reload', 'reload']){
    if(buf) break;
    try{
      const b = await download(at(f.p), mode, f.b);
      if(await verified(b, f)) buf = b; else why = `wrong size or checksum (${b.byteLength} bytes)`;
    }catch(e){ why = err(e); }
  }
  if(!buf) throw new Error(f.p + ': ' + why);
  const res = new Response(buf, {headers: {'content-type': typeOf(f.p), 'content-length': String(f.b), 'x-cm-sha256': f.h}});
  await (f.big ? blobs.put(blobKey(f.h), res) : shell.put(at(f.p), res));
}
async function post(force){
  const now = Date.now(); if(!force && now - lastPost < 500) return; lastPost = now;
  try{ for(const c of await self.clients.matchAll({includeUncontrolled: true, type: 'window'})) c.postMessage({type: 'cm-offline', job}); }catch(e){}
}
// Save the newest published version, every file, checked. Resolves to its version once ALL of it is in.
function saveNewest(){
  if(saving) return saving;
  saving = (async () => {
    const man = await (await fetch(at('offline.json'), {cache: 'no-store'})).json();
    const v = man.version;                 // (even if marked complete: every file is checked again, so anything lost is put back)
    const shell = await caches.open(shellOf(v)), blobs = await caches.open(BLOBS);
    const files = man.files.slice().sort((a, b) => (a.big - b.big) || (a.b - b.b));   // the app itself first, then the big files
    job = {version: v, bytes: files.reduce((s, f) => s + f.b, 0), done: 0, files: files.length, error: null, complete: false};
    post(true);
    for(const f of files){                 // one at a time: a 40 MB file is held in memory while it is checked
      try{ await saveOne(f, shell, blobs); }
      catch(e){ const why = err(e); job.error = (/quota|space/i.test(why) ? 'this device is out of storage space: ' : '') + why; post(true); throw e; }
      job.done += f.b; post();
    }
    for(const f of files) if(!(await stored(f, shell, blobs))) throw new Error(f.p + ' was not kept (storage full?)');
    await shell.put(MARK, new Response(JSON.stringify(man), {headers: {'content-type': 'application/json'}}));
    // the first version saved on this device runs at once (there was nothing to run offline before)
    const s = await state();
    if(!s.current || !(await filesOf(s.current))) await setState({current: v});
    job.complete = true; post(true);
    return v;
  })().finally(() => { saving = null; });
  return saving;
}
// Switch to a saved version, then drop everything only older versions needed (the page that asked reloads
// straight away; nothing from before is needed after that)
async function use(v){
  if(!(await filesOf(v))) throw new Error(v + ' is not completely saved');
  await setState({current: v});
  const keepV = new Set([v]);
  if(job && !job.complete) keepV.add(job.version);                  // a save in progress
  for(const k of await caches.keys()){
    if(k === BLOBS || k === META || (k.startsWith('cm-shell-') && keepV.has(k.slice(9)))) continue;
    if(/^cm-/.test(k)){ await caches.delete(k); FILES.delete(k.slice(9)); }   // older versions, and the old store names
  }
  if(job && !job.complete) return;          // its big files aren't all listed anywhere yet: tidy them next time
  const keepB = new Set();
  for(const f of (await filesOf(v)).values()) if(f.big) keepB.add(blobKey(f.h));
  const blobs = await caches.open(BLOBS);
  for(const r of await blobs.keys()) if(!keepB.has(r.url)) await blobs.delete(r);
}

self.addEventListener('install', () => {});           // nothing to do: versions are saved on request
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('message', e => {
  const m = e.data || {}, port = e.ports && e.ports[0];
  const reply = x => { try{ port && port.postMessage(x); }catch(_){} };
  if(m.type === 'status') e.waitUntil(state().then(s => reply({sw: SW_CODE, current: s.current, job})));
  else if(m.type === 'save') e.waitUntil(saveNewest().then(v => reply({ok: true, version: v}), x => { if(job) job.error = err(x); reply({ok: false, error: err(x)}); post(true); }));
  else if(m.type === 'use') e.waitUntil(use(m.version).then(() => reply({ok: true}), x => reply({ok: false, error: err(x)})));
});

/* ---------- serving ---------- */
// a media element asks for byte ranges (Safari always does for video): answer from the stored copy
async function ranged(res, range){
  const buf = await res.arrayBuffer(), n = buf.byteLength, m = /bytes=(\d*)-(\d*)/.exec(range || '');
  if(!m) return new Response(buf, {headers: res.headers});
  let a = m[1] === '' ? Math.max(0, n - Number(m[2])) : Number(m[1]);
  let b = m[1] !== '' && m[2] !== '' ? Math.min(n - 1, Number(m[2])) : n - 1;
  if(a > b || a >= n) return new Response(null, {status: 416, headers: {'content-range': `bytes */${n}`}});
  return new Response(buf.slice(a, b + 1), {status: 206, headers: {'content-type': res.headers.get('content-type'),
    'content-range': `bytes ${a}-${b}/${n}`, 'content-length': String(b - a + 1), 'accept-ranges': 'bytes'}});
}
async function serve(req, url, rel){
  // the version asked for (?v=, stamped on the app's own references) if it is saved, else the current one
  const v = url.searchParams.get('v');
  let files = v && /^\d{12}$/.test(v) ? await filesOf(v) : null, ver = v;
  if(!files){ ver = (await state()).current; files = await filesOf(ver); }
  const f = files && files.get(rel);
  if(f){
    const hit = f.big ? await (await caches.open(BLOBS)).match(blobKey(f.h)) : await (await caches.open(shellOf(ver))).match(at(f.p));
    if(hit) return req.headers.has('range') ? ranged(hit, req.headers.get('range')) : hit;
  }
  return fetch(req).catch(() => Response.error());   // nothing saved for it: the network, as if this weren't here
}
// Every file of the running version comes from the store, online or offline: what runs is always one
// whole, saved version, never new code paired with old data.
self.addEventListener('fetch', e => {
  if(e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if(url.origin !== SCOPE.origin || !url.pathname.startsWith(SCOPE.pathname)) return;
  let rel = decodeURIComponent(url.pathname.slice(SCOPE.pathname.length));
  if(rel === 'sw.js' || rel === 'version.json' || rel === 'offline.json') return;
  if(e.request.mode === 'navigate'){ if(rel !== '' && rel !== 'index.html') return; rel = 'index.html'; }
  if(rel === '') rel = 'index.html';
  e.respondWith(serve(e.request, url, rel));
});
