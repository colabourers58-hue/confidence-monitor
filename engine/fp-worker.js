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
  return fetch(url).then(function (r) {
    if (!r.ok) throw new Error(url + ': HTTP ' + r.status);
    if (r.body && r.body.getReader) {
      var reader = r.body.getReader(), got = 0;
      var pump = function () {
        return reader.read().then(function (s) {
          if (s.done) return got;
          if (got + s.value.byteLength > expect) throw new Error(url + ': larger than the manifest says');
          into.set(s.value, offset + got); got += s.value.byteLength; onBytes(s.value.byteLength);
          return pump();
        });
      };
      return pump();
    }
    return r.arrayBuffer().then(function (ab) {
      if (ab.byteLength > expect) throw new Error(url + ': larger than the manifest says');
      into.set(new Uint8Array(ab), offset); onBytes(ab.byteLength);
      return ab.byteLength;
    });
  }).then(function (n) {
    if (n !== expect) throw new Error(url + ': ' + n + ' bytes, expected ' + expect);
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
    self.postMessage(result(out, m, win, t0));
  }
};
