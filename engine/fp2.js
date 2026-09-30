/* The learned fingerprint (app/fp2.py) in the browser. Plain JS; the network itself runs in
 * ONNX Runtime Web (fp-worker.js loads it); everything else is here:
 *
 *   16 kHz -> 8 kHz (scipy resample_poly(x, 1, 2): 41-tap Kaiser FIR) -> Hann 1024 / hop 256 power
 *   spectrum -> 64 mel bands -> log(+1e-6) -> 1.12 s patches (32 frames) every 4 frames, aligned to
 *   the END of the window -> embed(patches) -> per patch, the 16 nearest IVF cells of the int8 index
 *   -> hits vote for (recording, offset) -> the best 24 re-scored exactly over the whole window.
 *
 * createFP2(manifest, blob) -> idx;  features(idx, pcm16k) -> {P, qf, n}
 * search(idx, emb, qf, {track}) -> {song_id, ref_id, offset_sec (lyric timeline), rec_offset_sec,
 *        votes, runner_up, margin, live, duration, cands, track_votes, track_offset}
 * Same numbers as fp2.match() (votes = 10 x sum of max(0, sim - base) over the window).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FP2 = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function rhe(x) {                                  // numpy round: half to even
    var r = Math.round(x);
    if (Math.abs(x % 1) === 0.5 && r % 2 !== 0) r -= 1;
    return r;
  }

  function createFP2(man, blob, rfftMag) {
    var P = man.params, sec = man.sections, D = P.dim, nl = P.nlist;
    var buf = blob.buffer, off0 = blob.byteOffset;
    function f32(name) { var s = sec[name]; return new Float32Array(buf, off0 + s[0], s[1] / 4); }
    var C = f32('C'), MELW = f32('MELW'), FIR = f32('FIR');
    var LS = new Int32Array(buf, off0 + sec.list_start[0], nl + 1);
    var E = new Int8Array(buf, off0 + sec.E[0], sec.E[1]);
    var R = new Uint16Array(buf, off0 + sec.R[0], man.n), T = new Uint16Array(buf, off0 + sec.T[0], man.n);
    var N = man.n, i, j;
    // the int8 rows were unit vectors: renormalise (as fp2.load does)
    var inv = new Float32Array(N);
    for (i = 0; i < N; i++) {
      var s2 = 0, b = i * D;
      for (j = 0; j < D; j++) s2 += E[b + j] * E[b + j];
      inv[i] = s2 > 0 ? 1 / Math.sqrt(s2) : 0;
    }
    // (recording, frame / db_hop) -> row, a dense table per recording
    var hop = P.db_hop, nref = man.refs.length, maxT = new Int32Array(nref);
    for (i = 0; i < N; i++) if (T[i] > maxT[R[i]]) maxT[R[i]] = T[i];
    var base = new Int32Array(nref + 1);
    for (i = 0; i < nref; i++) base[i + 1] = base[i] + Math.floor(maxT[i] / hop) + 1;
    var slot = new Int32Array(base[nref]).fill(-1);
    for (i = 0; i < N; i++) slot[base[R[i]] + T[i] / hop] = i;
    // songs, for "runner-up = another song"
    var gid = new Int32Array(nref), songs = Object.create(null), ng = 0;
    for (i = 0; i < nref; i++) { var sg = man.refs[i].song_id; if (!(sg in songs)) songs[sg] = ng++; gid[i] = songs[sg]; }
    // mel bands as [first bin, weights...]
    var nb = P.nfft / 2 + 1, bands = [];
    for (var m = 0; m < P.nmel; m++) {
      var lo = -1, hi = -1;
      for (j = 0; j < nb; j++) if (MELW[j * P.nmel + m] > 0) { if (lo < 0) lo = j; hi = j; }
      var w = new Float32Array(Math.max(0, hi - lo + 1));
      for (j = lo; j <= hi; j++) w[j - lo] = MELW[j * P.nmel + m];
      bands.push({ lo: lo, w: w });
    }
    var hann = new Float32Array(P.nfft);
    for (i = 0; i < P.nfft; i++) hann[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (P.nfft - 1));
    return { man: man, P: P, S: man.search, G: man.gates, D: D, nl: nl, C: C, LS: LS, E: E, R: R, T: T, inv: inv,
             base: base, slot: slot, maxT: maxT, gid: gid, bands: bands, FIR: FIR, hann: hann, rfftMag: rfftMag,
             refs: man.refs, byId: man.refs.reduce(function (a, r, k) { a[r.ref_id] = k; return a; }, Object.create(null)) };
  }

  /** log-mel patches of a 16 kHz window: P = Float32Array(n * 64 * 32) laid out (n, 64, 32). */
  function features(idx, pcm) {
    var P = idx.P, h = idx.FIR, nt = h.length, half = (nt - 1) >> 1;
    var n8 = Math.ceil(pcm.length / 2), x8 = new Float32Array(n8), i, j, k;
    for (i = 0; i < n8; i++) {                        // y[i] = sum_j h[j] x[2i + j - half], zero outside
      var acc = 0, c = 2 * i - half;
      for (j = 0; j < nt; j++) { k = c + j; if (k >= 0 && k < pcm.length) acc += h[j] * pcm[k]; }
      x8[i] = acc;
    }
    var F = 1 + Math.floor((n8 - P.nfft) / P.hop);
    if (F < P.segf) return null;
    var M = new Float32Array(F * P.nmel), frame = new Float32Array(P.nfft), mag = new Float32Array(P.nfft / 2 + 1);
    for (var f = 0; f < F; f++) {
      var o = f * P.hop;
      for (j = 0; j < P.nfft; j++) frame[j] = x8[o + j] * idx.hann[j];
      idx.rfftMag(frame, mag);
      for (var m = 0; m < P.nmel; m++) {
        var b = idx.bands[m], s = 0;
        for (j = 0; j < b.w.length; j++) { var v = mag[b.lo + j]; s += v * v * b.w[j]; }
        M[f * P.nmel + m] = Math.log(s + P.log_eps);
      }
    }
    var starts = [];
    for (var st = F - P.segf; st >= 0; st -= P.qhop) starts.push(st);
    starts.reverse();
    var n = starts.length, out = new Float32Array(n * P.nmel * P.segf);
    for (i = 0; i < n; i++)
      for (var mm = 0; mm < P.nmel; mm++)
        for (var t = 0; t < P.segf; t++) out[(i * P.nmel + mm) * P.segf + t] = M[(starts[i] + t) * P.nmel + mm];
    return { P: out, qf: Int32Array.from(starts), n: n };
  }

  function rowAt(idx, ref, g) {
    if (g < 0 || g % idx.P.db_hop) return -1;
    var k = g / idx.P.db_hop;
    if (k > idx.maxT[ref] / idx.P.db_hop) return -1;
    return idx.slot[idx.base[ref] + k];
  }

  function dotRow(idx, row, q, qo) {
    var E = idx.E, b = row * idx.D, s = 0;
    for (var j = 0; j < idx.D; j++) s += E[b + j] * q[qo + j];
    return s * idx.inv[row];
  }

  /** exact score of (ref, offset in frames): sum over segments of max(0, sim - base) */
  function rescore(idx, emb, qf, ref, off) {
    var S = idx.S, hop = idx.P.db_hop, sc = 0;
    for (var i = 0; i < qf.length; i++) {
      var f = qf[i] + off, g = rhe(f / hop) * hop;
      if (Math.abs(f - g) > S.tol || g < 0) continue;
      var row = rowAt(idx, ref, g);
      if (row < 0) continue;
      var s = dotRow(idx, row, emb, i * idx.D) - S.base;
      if (s > 0) sc += s;
    }
    return sc;
  }

  function search(idx, emb, qf, opt) {
    opt = opt || {};
    var S = idx.S, D = idx.D, nl = idx.nl, n = qf.length, i, j, c, r;
    var votes = new Map(), cs = new Float32Array(nl);
    var excl = opt.exclude || null;
    for (i = 0; i < n; i++) {
      var qo = i * D;
      for (c = 0; c < nl; c++) { var s = 0, cb = c * D; for (j = 0; j < D; j++) s += idx.C[cb + j] * emb[qo + j]; cs[c] = s; }
      var probes = topK(cs, S.nprobe);
      // this segment's sims over its cells, then keep the ones near its best
      var rows = [], sims = [], best = -1;
      for (var p = 0; p < probes.length; p++) {
        c = probes[p];
        for (r = idx.LS[c]; r < idx.LS[c + 1]; r++) {
          var sm = dotRow(idx, r, emb, qo);
          if (sm > S.theta) { rows.push(r); sims.push(sm); if (sm > best) best = sm; }
        }
      }
      var thr = Math.max(S.theta, best - S.delta);
      for (j = 0; j < rows.length; j++) {
        if (sims[j] <= thr) continue;
        var ref = idx.R[rows[j]];
        if (excl && excl[ref]) continue;
        var ob = rhe((idx.T[rows[j]] - qf[i]) / 4);
        var key = ref * 1000000 + ob + 500000;
        votes.set(key, (votes.get(key) || 0) + sims[j] - S.base);
      }
    }
    if (!votes.size) return null;
    var keys = Array.from(votes.keys()), v2 = keys.map(function (k) {
      return votes.get(k) + (votes.get(k + 1) || 0) + (votes.get(k - 1) || 0);
    });
    var ord = keys.map(function (_, k) { return k; }).sort(function (a, b) { return v2[b] - v2[a]; }).slice(0, S.kcand);
    var res = [];
    for (var o = 0; o < ord.length; o++) {
      var kk = keys[ord[o]], rf = Math.floor(kk / 1000000), obb = kk % 1000000 - 500000, bs = 0, boff = obb * 4;
      for (var d = -2; d <= 2; d++) { var sc = rescore(idx, emb, qf, rf, obb * 4 + d); if (sc > bs) { bs = sc; boff = obb * 4 + d; } }
      res.push({ sc: bs, ref: rf, off: boff });
    }
    res.sort(function (a, b) { return b.sc - a.sc; });
    var keep = [];                                   // one (ref, place) per 0.5 s
    for (o = 0; o < res.length; o++) {
      if (keep.some(function (k) { return k.ref === res[o].ref && Math.abs(k.off - res[o].off) < 16; })) continue;
      keep.push(res[o]);
    }
    return keep;
  }

  function topK(a, k) {
    var idxs = [], vals = [];
    for (var i = 0; i < a.length; i++) {
      var v = a[i];
      if (idxs.length < k) { idxs.push(i); vals.push(v); if (idxs.length === k) sortDesc(); continue; }
      if (v <= vals[k - 1]) continue;
      var p = k - 1; while (p > 0 && vals[p - 1] < v) { vals[p] = vals[p - 1]; idxs[p] = idxs[p - 1]; p--; }
      vals[p] = v; idxs[p] = i;
    }
    function sortDesc() {
      var o = idxs.map(function (x, j) { return j; }).sort(function (x, y) { return vals[y] - vals[x]; });
      idxs = o.map(function (j) { return idxs[j]; }); vals = o.map(function (j) { return vals[j]; });
    }
    return idxs;
  }

  var FRAME = 256 / 8000;
  function r3(x) { return Math.round(x * 1000) / 1000; }

  /** fingerprint.match()-shaped answer, mapped onto the lyric timeline like engine.js */
  function answer(idx, res, emb, qf, opt) {
    var scale = idx.S.scale, refs = idx.refs, out = { song_id: null, ref_id: null, votes: 0, runner_up: 0, margin: 0,
      offset_sec: null, rec_offset_sec: null, live: false, duration: null, cands: [], track_votes: null, track_offset: null };
    var timed = function (k) { var f = refs[k]; return !f.live && f.aligned !== false; };
    if (res && res.length) {
      var b = res[0], g = idx.gid[b.ref], runner = 0;
      for (var i = 1; i < res.length; i++) if (idx.gid[res[i].ref] !== g && res[i].sc > runner) runner = res[i].sc;
      if (!timed(b.ref))                             // a studio recording of the same song nearly as good: take it
        for (i = 1; i < res.length; i++)
          if (idx.gid[res[i].ref] === g && timed(res[i].ref) && res[i].sc >= 0.8 * b.sc) { b = res[i]; break; }
      var f = refs[b.ref];
      out.song_id = f.song_id; out.ref_id = f.ref_id; out.live = !timed(b.ref); out.duration = f.duration;
      out.rec_offset_sec = r3(b.off * FRAME); out.offset_sec = r3(b.off * FRAME - (f.shift || 0));
      out.votes = r3(b.sc * scale); out.runner_up = r3(runner * scale);
      out.margin = Math.round(100 * b.sc / Math.max(runner, 0.05)) / 100;
      out.cands = res.slice(0, 12).filter(function (x) { return x.sc > 0; }).map(function (x) {
        var fr = refs[x.ref];
        return { song_id: fr.song_id, ref_id: fr.ref_id, votes: r3(x.sc * scale), live: !timed(x.ref),
                 offset_sec: r3(x.off * FRAME - (fr.shift || 0)) };
      });
    }
    var tr = opt && opt.track;
    if (tr) {                                        // {song_id, at (lyric timeline, window start), tol}
      var best = 0, bestD = 0, t = Math.round((tr.tol || 0.6) / FRAME);
      for (var k = 0; k < refs.length; k++) {
        var rf = refs[k];
        if (rf.song_id !== tr.song_id || !timed(k)) continue;
        var e = Math.round((tr.at + (rf.shift || 0)) / FRAME);
        for (var d = -t; d <= t; d++) { var sc = rescore(idx, emb, qf, k, e + d); if (sc > best) { best = sc; bestD = d; } }
      }
      out.track_votes = r3(best * scale); out.track_offset = best > 0 ? r3(tr.at + bestD * FRAME) : null;
    }
    return out;
  }

  return { createFP2: createFP2, features: features, search: search, answer: answer, rescore: rescore };
}));
