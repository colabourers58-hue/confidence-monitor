/* Web Worker: on-device song recognition. Plain JavaScript, no libraries, no network
 * beyond reading its own files (which the service worker serves offline).
 *
 * Works as a classic worker or a module worker (app.js tries {type:'module'} first).
 *
 * In:  {type:'load', base}            base = URL of this folder (ending in '/')
 *      {type:'match', pcm, win, at, track, top}
 *          pcm = Float32Array, mono, 16 kHz; at = caller's clock when the window ended (echoed);
 *          track (optional) = {song_id, at, tol}: is the window where it should start in this
 *            song (s, lyric timeline)? top (optional) = {at, tol}: the same question for
 *            whichever song wins this window (is it the top of that song?)
 * Out: {type:'progress', loaded, total}   bytes of index read so far
 *      {type:'ready', refs, bytes, ms, format, decide}
 *          decide = manifest.decide: threshold overrides for decide.js (null = server defaults)
 *      {type:'result', song_id, ref_id, via, live, duration, offset_sec, rec_offset_sec, votes,
 *                      runner_up, margin, hits, track_votes, track_offset, top_votes, top_offset,
 *                      ms, win, at}
 *          song_id is the base song id (other recordings report their song), or null.
 *          offset_sec = where the window STARTS, on the song's lyric timeline.
 *          track_* / top_* = null unless asked.
 *      {type:'error', message}
 * Every 'match' gets exactly one 'result', even before the index is ready.
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
    importScripts(base + 'engine.js');
    if (self.FPEngine) return Promise.resolve(self.FPEngine);
  } catch (e) { /* module worker: importScripts is not allowed */ }
  return fetch(base + 'engine.js').then(function (r) {
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
      self.postMessage({ type: 'ready', refs: man.refs.length, bytes: total, ms: Math.round(now() - t0),
                         format: man.format, decide: man.decide || null });
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

self.onmessage = function (ev) {
  var m = ev.data || {};
  if (m.type === 'load') { load(m.base || './'); return; }
  if (m.type === 'match') {
    var t0 = now(), pcm = m.pcm, win = m.win;
    if (!(pcm instanceof Float32Array)) pcm = pcm ? new Float32Array(pcm) : new Float32Array(0);
    if (win == null) win = pcm.length / 16000;
    if (!IDX) { self.postMessage(result({ error: 'not ready' }, m, win, t0)); return; }
    var out;
    try { out = E.match(IDX, pcm, { track: m.track || null, top: m.top || null }); delete out.hashes; }
    catch (err) { out = { error: String(err && err.message || err) }; }
    self.postMessage(result(out, m, win, t0));
  }
};
