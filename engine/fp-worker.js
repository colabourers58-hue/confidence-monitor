/* Web Worker: on-device song recognition. Plain JavaScript, no libraries, no network
 * beyond reading its own files (which the service worker serves offline).
 *
 * Works as a classic worker or a module worker (app.js tries {type:'module'} first).
 *
 * In:  {type:'load', base}            base = URL of this folder (ending in '/')
 *      {type:'match', pcm, win, at, track, top, key, keys}
 *          pcm = Float32Array, mono, 16 kHz; at = caller's clock when the window ended (echoed);
 *          key (optional) = semitones the room is from the recording (a transposed track): the
 *            main answer and track/top are asked at this key; keys (optional) = other keys to
 *            try in the same look (same peaks, re-hashed): their answers come back in `alts`
 *          track (optional) = {song_id, at, tol}: is the window where it should start in this
 *            song (s, lyric timeline)? top (optional) = {at, tol}: the same question for
 *            whichever song wins this window (is it the top of that song?)
 * Out: {type:'progress', loaded, total}   bytes of index read so far
 *      {type:'ready', refs, bytes, ms, format, decide}
 *          decide = manifest.decide: threshold overrides for decide.js (null = server defaults)
 *      {type:'result', song_id, ref_id, via, live, duration, offset_sec, rec_offset_sec, votes,
 *                      runner_up, margin, hits, track_votes, track_offset, track_ref, top_votes,
 *                      top_offset, cands, key, alts: [{key, song_id, ... the same, no track_*}],
 *                      ms, win, at}
 *          song_id is the base song id (other recordings report their song), or null.
 *          offset_sec = where the window STARTS, on the song's lyric timeline.
 *          track_* / top_* = null unless asked.
 *      {type:'error', message}
 * Every 'match' gets exactly one 'result', even before the index is ready.
 *
 * Room memory (engine.js createRoom / learn): the worker keeps the last looks' hashes.
 * In:  {type:'learn', at, song_id, lyric_offset, ref_id?}  the look that ended at `at` was heard
 *          confidently on track, its window starting at lyric_offset on the song's lyric timeline
 *          (ref_id = the recording the room is playing, if known); or {type:'learn', at, ref_id,
 *          offset_sec} with the window start on that recording's own timeline. Learns that look,
 *          and fills in the looks before it that verifiably sit on the same clock.
 *      {type:'forget'}   wipe this device's room memory
 *      {type:'flush'}    save now (the page is being hidden)
 * Out: {type:'room', songs, postings, bytes, persist, added?, looks?, ms?}
 *          after loading, each learn that added something, and forget. persist = false when this
 *          browser won't store it (private mode): learning then lasts until the page closes.
 * Saved per device in IndexedDB ('prompter-room', one record per song, refs stored by name).
 *
 * This message protocol is the contract with app.js. The engine behind it is swappable: any
 * engine.js that exports createIndex(manifest, blob) and match(idx, pcm, {track, top}) returning
 * the result fields above, plus its own manifest.json + shards, drops in (see README.md).
 */
'use strict';
var E = null, IDX = null, loading = null;
var now = function () { return (self.performance && performance.now) ? performance.now() : Date.now(); };

function getEngine(base) {
  if (self.FPEngine) return Promise.resolve(self.FPEngine);
  try {                                             // classic worker
    importScripts(base + 'engine.js' + (self.location.search || ''));   // ?v=<publish stamp>: this worker's own engine
    if (self.FPEngine) return Promise.resolve(self.FPEngine);
  } catch (e) { /* module worker: importScripts is not allowed */ }
  return fetch(base + 'engine.js' + (self.location.search || '')).then(function (r) {
    if (!r.ok) throw new Error('engine.js: HTTP ' + r.status);
    return r.text();
  }).then(function (src) {
    var mod = { exports: {} };
    (new Function('module', 'exports', src))(mod, mod.exports);
    return mod.exports;
  });
}

function readShard(url, into, offset, expect, onBytes) {
  // a download that stops delivering (weak signal) must not leave it deaf forever: after 30 s with no
  // bytes it is dropped, which reports an error, and app.js starts the load again (stored files come back at once)
  var ac = typeof AbortController === 'function' ? new AbortController() : null, timer = null;
  var arm = function () { clearTimeout(timer); if (ac) timer = setTimeout(function () { ac.abort(); }, 30000); };
  arm();
  return fetch(url, ac ? { signal: ac.signal } : {}).then(function (r) {
    if (!r.ok) throw new Error(url + ': HTTP ' + r.status);
    if (r.body && r.body.getReader) {
      var reader = r.body.getReader(), got = 0;
      var pump = function () {
        arm();
        return reader.read().then(function (s) {
          if (s.done) return got;
          if (got + s.value.byteLength > expect) throw new Error(url + ': larger than the manifest says');
          into.set(s.value, offset + got); got += s.value.byteLength; onBytes(s.value.byteLength);
          return pump();
        });
      };
      return pump();
    }
    clearTimeout(timer); if (ac) timer = setTimeout(function () { ac.abort(); }, 600000);   // no streaming here: the whole file, 10 min
    return r.arrayBuffer().then(function (ab) {
      if (ab.byteLength > expect) throw new Error(url + ': larger than the manifest says');
      into.set(new Uint8Array(ab), offset); onBytes(ab.byteLength);
      return ab.byteLength;
    });
  }).then(function (n) {
    clearTimeout(timer);
    if (n !== expect) throw new Error(url + ': ' + n + ' bytes, expected ' + expect);
  }, function (err) {
    clearTimeout(timer);
    throw (ac && ac.signal.aborted) ? new Error(url + ': the connection stopped delivering') : err;
  });
}

function load(base) {
  if (loading) return loading;
  if (base && base.charAt(base.length - 1) !== '/') base += '/';
  var t0 = now();
  loading = getEngine(base).then(function (eng) {
    E = eng;
    return fetch(base + 'manifest.json').then(function (r) {
      if (!r.ok) throw new Error('manifest.json: HTTP ' + r.status);
      return r.json();
    });
  }).then(function (man) {
    var total = man.total_bytes, blob = new Uint8Array(total), loaded = 0, lastPost = 0, offset = 0;
    self.postMessage({ type: 'progress', loaded: 0, total: total });
    var onBytes = function (n) {
      loaded += n;
      var t = now();
      if (t - lastPost > 100 || loaded === total) { lastPost = t; self.postMessage({ type: 'progress', loaded: loaded, total: total }); }
    };
    var chain = Promise.resolve();
    man.shards.forEach(function (s) {                // in order; each lands at its own offset
      var at = offset; offset += s.bytes;
      chain = chain.then(function () { return readShard(base + s.file, blob, at, s.bytes, onBytes); });
    });
    return chain.then(function () {
      if (offset !== total) throw new Error('shards add up to ' + offset + ' bytes, manifest says ' + total);
      IDX = E.createIndex(man, blob);
      ROOM = E.createRoom ? E.createRoom(IDX) : null;
      self.postMessage({ type: 'ready', refs: man.refs.length, bytes: total, ms: Math.round(now() - t0),
                         format: man.format, decide: man.decide || null });
      loadRoom();
      setTimeout(function () { loadFP2(base); }, 1500);   // the learned second opinion: never delays the landmarks
    });
  }).catch(function (err) {
    loading = null;                                  // allow a retry with another 'load'
    self.postMessage({ type: 'error', message: String(err && err.message || err) });
  });
  return loading;
}

function result(fields, m, win, t0) {
  var r = { type: 'result', song_id: null, ref_id: null, via: null, live: false, duration: null,
            offset_sec: null, rec_offset_sec: null, votes: 0, runner_up: 0, margin: 0, hits: 0,
            track_votes: m.track ? 0 : null, track_offset: null, top_votes: m.top ? 0 : null, top_offset: null };
  for (var k in fields) if (Object.prototype.hasOwnProperty.call(fields, k)) r[k] = fields[k];
  r.type = 'result'; r.win = win; r.at = m.at == null ? null : m.at; r.ms = Math.round(now() - t0);
  return r;
}

// ---------------------------------------------------------------- room memory storage
var ROOM = null, roomReady = false, persist = false, saveT = 0, DB = null;
var DB_NAME = 'prompter-room', STORE = 'songs';
function openDB() {
  return new Promise(function (res, rej) {
    var t = setTimeout(function () { rej(new Error('IndexedDB did not answer')); }, 4000);   // some browsers hang
    try {
      var rq = self.indexedDB.open(DB_NAME, 1);
      rq.onupgradeneeded = function () { rq.result.createObjectStore(STORE, { keyPath: 'song_id' }); };
      rq.onsuccess = function () { clearTimeout(t); res(rq.result); };
      rq.onerror = function () { clearTimeout(t); rej(rq.error || new Error('IndexedDB open failed')); };
      rq.onblocked = function () { clearTimeout(t); rej(new Error('IndexedDB blocked')); };
    } catch (e) { clearTimeout(t); rej(e); }
  });
}
function tx(mode, fn) {
  return new Promise(function (res, rej) {
    var t = DB.transaction(STORE, mode), st = t.objectStore(STORE), out = fn(st);
    t.oncomplete = function () { res(out && out.result); };
    t.onerror = t.onabort = function () { rej(t.error || new Error('IndexedDB transaction failed')); };
  });
}
function roomMsg(extra) {
  var s = IDX && E.roomStats ? E.roomStats(IDX) : { songs: 0, postings: 0, bytes: 0 };
  var m = { type: 'room', songs: s.songs, postings: s.postings, bytes: s.bytes, persist: persist, ready: roomReady };
  for (var k in extra || {}) m[k] = extra[k];
  self.postMessage(m);
}
function loadRoom() {
  if (!ROOM) return;
  var t0 = now();
  (self.indexedDB ? openDB() : Promise.reject(new Error('no IndexedDB')))
    .then(function (db) { DB = db; return tx('readonly', function (st) { return st.getAll(); }); })
    .then(function (recs) {
      persist = true;
      var r = E.roomImport(IDX, recs || []);
      E.roomDirty(IDX);                               // just loaded: nothing to save
      roomReady = true; roomMsg({ loaded: r, ms: Math.round(now() - t0) });
    })
    .catch(function (err) {                           // private mode etc: learn for this session only
      persist = false; DB = null; roomReady = true;
      roomMsg({ error: String(err && err.message || err) });
    });
}
function save() {
  clearTimeout(saveT); saveT = 0;
  if (!IDX || !DB) { if (IDX) E.roomDirty(IDX); return Promise.resolve(); }
  var songs = E.roomDirty(IDX);
  if (!songs.length) return Promise.resolve();
  var recs = songs.map(function (s) { return E.roomExport(IDX, s); });
  return tx('readwrite', function (st) {
    recs.forEach(function (r) { if (r.h.length) st.put(r); else st.delete(r.song_id); });
  }).catch(function (err) {                           // quota, or storage taken away: keep learning in memory
    persist = false; roomMsg({ error: String(err && err.message || err) });
  });
}
function saveSoon() { if (!saveT) saveT = setTimeout(save, 15000); }

// ---------------------------------------------------------------- learned fingerprint (fp2)
// A second opinion for big reverberant rooms and live singing over the backing track (app/fp2.py,
// app/RECOGNIZER.md). Loads after the landmarks, runs only when the landmarks aren't already sure,
// and mirrors server.py FP2=1: one look above its own gate may take the screen, its candidates go
// into the same evidence piles (scaled to landmark votes), its track evidence keeps a song on track.
// Anything failing (no network for the runtime, no index, a slow device) leaves the landmarks alone.
var FP2 = { lib: null, idx: null, sess: null, ort: null, off: false, ms: 0, n: 0, skip: false, why: null };
// ONNX Runtime Web, served from this site (web/vendor/, pinned in web/vendor.json; app/build_vendor.py):
// never a CDN, so nothing here needs a third-party origin, online or offline
var ORT_BASE = new URL('../vendor/ort-1.20.1/', self.location.href).href;
function fp2Status(why) { FP2.why = why; self.postMessage({ type: 'fp2', ready: !!FP2.sess && !FP2.off, why: why, ms: Math.round(FP2.ms) }); }
function loadOrt() {
  if (self.ort) return Promise.resolve(self.ort);
  try { importScripts(ORT_BASE + 'ort.wasm.min.js'); if (self.ort) return Promise.resolve(self.ort); } catch (e) { /* module worker */ }
  return import(ORT_BASE + 'ort.wasm.min.mjs').then(function (m) { return m.default || m; });
}
function loadFP2Lib(base) {
  if (self.FP2Lib) return Promise.resolve(self.FP2Lib);
  return fetch(base + 'fp2.js' + (self.location.search || '')).then(function (r) {
    if (!r.ok) throw new Error('fp2.js: HTTP ' + r.status);
    return r.text();
  }).then(function (src) { var mod = { exports: {} }; (new Function('module', 'exports', src))(mod, mod.exports); return mod.exports; });
}
function loadFP2(base) {
  if (FP2.lib || FP2.off) return;
  var man, lib, t0 = now();
  loadFP2Lib(base).then(function (l) { lib = l; return fetch(base + 'fp2/manifest.json'); })
    .then(function (r) { if (!r.ok) throw new Error('fp2/manifest.json: HTTP ' + r.status); return r.json(); })
    .then(function (m) {
      man = m;
      var blob = new Uint8Array(man.total_bytes), offset = 0, chain = Promise.resolve();
      man.shards.forEach(function (s) { var at = offset; offset += s.bytes;
        chain = chain.then(function () { return readShard(base + 'fp2/' + s.file, blob, at, s.bytes, function () {}); }); });
      return chain.then(function () { return blob; });
    })
    .then(function (blob) {
      FP2.idx = lib.createFP2(man, blob, E.rfftMag); FP2.lib = lib;
      return loadOrt();
    })
    .then(function (ort) {
      FP2.ort = ort;
      ort.env.wasm.numThreads = 1; ort.env.wasm.wasmPaths = ORT_BASE;
      return ort.InferenceSession.create(base + 'fp2/' + man.model.file + (self.location.search || ''), { executionProviders: ['wasm'] });
    })
    .then(function (sess) {
      var P = FP2.idx.P, n = 31, z = new Float32Array(n * P.nmel * P.segf), t1 = now();
      return sess.run({ mel: new FP2.ort.Tensor('float32', z, [n, P.nmel, P.segf]) }).then(function () {
        var t2 = now();
        return sess.run({ mel: new FP2.ort.Tensor('float32', z, [n, P.nmel, P.segf]) }).then(function () {
          var ms = now() - t2;
          if (ms > 1500) { FP2.off = true; fp2Status('too slow: ' + Math.round(ms) + ' ms a look'); return; }
          FP2.sess = sess; FP2.ms = ms; fp2Status('ready in ' + Math.round(now() - t0) + ' ms');
        });
      });
    })
    .catch(function (err) { FP2.off = true; fp2Status(String(err && err.message || err)); });
}
function fp2Wanted(out, m, pcm) {
  if (!FP2.sess || FP2.off || pcm.length < 32000) return false;
  var G = FP2.idx.G;
  if (out.song_id && out.votes >= G.lm_strong_votes && out.margin >= G.lm_strong_margin) return false;   // landmarks sure
  if (m.track && (out.track_votes || 0) >= G.lm_track_min) return false;                               // on track already
  if (FP2.ms > 350) { FP2.skip = !FP2.skip; if (FP2.skip) return false; }                              // slow device: every other look
  return true;
}
function fp2Run(pcm, m) {
  var t0 = now(), lib = FP2.lib, idx = FP2.idx, f = lib.features(idx, pcm);
  if (!f) return Promise.resolve(null);
  return FP2.sess.run({ mel: new FP2.ort.Tensor('float32', f.P, [f.n, idx.P.nmel, idx.P.segf]) }).then(function (o) {
    var emb = o[FP2.sess.outputNames[0]].data;
    var a = lib.answer(idx, lib.search(idx, emb, f.qf), emb, f.qf, { track: m.track || null });
    var ms = now() - t0; FP2.ms = FP2.n ? 0.8 * FP2.ms + 0.2 * ms : ms; FP2.n++;
    if (FP2.ms > 1500) { FP2.off = true; fp2Status('too slow: ' + Math.round(FP2.ms) + ' ms a look'); }
    a.ms = Math.round(ms);
    return a;
  });
}
function fp2Merge(out, a, m) {
  var G = FP2.idx.G, sc = G.lm_scale, r1 = function (x) { return Math.round(x * 10) / 10; };
  out.fp2 = { song_id: a.song_id, votes: a.votes, margin: a.margin, offset_sec: a.offset_sec, track_votes: a.track_votes, ms: a.ms };
  // only candidates with some weight join the piles: in noise the network keeps finding the same
  // few 'hub' places at 9-16 votes, and those would add up across looks (acc_floor, fp2 votes)
  // LOCK-ONLY (30 Sep 16:20): fp2's weak candidates added up across looks named wrong songs while an
  // unknown song played (Destiny, 4 wrong songs). Only a single strong fp2 look may take the screen.
  if (false) out.cands = (out.cands || []).concat(a.cands.filter(function (c) { return c.votes >= (G.acc_floor || 0); }).map(function (c) {
    return { song_id: c.song_id, ref_id: c.ref_id, votes: r1(c.votes * sc), live: c.live, offset_sec: c.offset_sec, via: 'fp2' };
  })).sort(function (x, y) { return y.votes - x.votes; });
  if (m.track && a.track_votes != null && a.track_votes >= G.track_min) {
    out.track_votes = Math.max(out.track_votes || 0, G.lm_track_min);
    if (out.track_offset == null) out.track_offset = a.track_offset;
  }
  if (!out.song_id && a.song_id && a.votes >= G.min_votes && a.margin >= G.min_margin) {
    out.song_id = a.song_id; out.ref_id = a.ref_id; out.via = 'fp2'; out.live = a.live; out.duration = a.duration;
    out.offset_sec = a.offset_sec; out.rec_offset_sec = a.rec_offset_sec;
    out.votes = r1(a.votes * sc); out.runner_up = r1(a.runner_up * sc); out.margin = a.margin;
  }
  return out;
}

self.onmessage = function (ev) {
  var m = ev.data || {};
  if (m.type === 'load') { load(m.base || './'); return; }
  if (m.type === 'learn') {
    if (!ROOM || !roomReady) return;
    var t1 = now(), got = ROOM.learn(m, Date.now());
    if (got.added) { saveSoon(); roomMsg({ added: got.added, looks: got.looks, ref_id: got.ref_id, ms: Math.round(now() - t1) }); }
    return;
  }
  if (m.type === 'forget') {
    if (!IDX || !E.roomClear) return;
    E.roomClear(IDX); ROOM && ROOM.forget(); E.roomDirty(IDX);
    (DB ? tx('readwrite', function (st) { st.clear(); }) : Promise.resolve())
      .catch(function () {}).then(function () { roomMsg({ forgot: true }); });
    return;
  }
  if (m.type === 'flush') { save(); return; }
  if (m.type === 'room') { roomMsg(); return; }
  if (m.type === 'match') {
    var t0 = now(), pcm = m.pcm, win = m.win;
    if (!(pcm instanceof Float32Array)) pcm = pcm ? new Float32Array(pcm) : new Float32Array(0);
    if (win == null) win = pcm.length / 16000;
    if (!IDX) { self.postMessage(result({ error: 'not ready' }, m, win, t0)); return; }
    var out;
    try {
      out = E.match(IDX, pcm, { track: m.track || null, top: m.top || null, key: m.key || 0, keys: m.keys || null });
      delete out.hashes;
      if (ROOM && out.peaks && m.at != null) ROOM.saw(m.at, win, out.peaks);   // room memory may learn from it
      delete out.peaks;
    }
    catch (err) { out = { error: String(err && err.message || err) }; }
    if (!out.error && fp2Wanted(out, m, pcm)) {
      fp2Run(pcm, m).then(function (a) { if (a) fp2Merge(out, a, m); })
        .catch(function (err) { out.fp2_error = String(err && err.message || err); })
        .then(function () { self.postMessage(result(out, m, win, t0)); });
      return;
    }
    self.postMessage(result(out, m, win, t0));
  }
};
