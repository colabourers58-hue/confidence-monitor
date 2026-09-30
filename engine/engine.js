/* Audio fingerprint engine: a plain-JavaScript port of app/fingerprint.py.
 *
 * No dependencies, no network. Loaded by fp-worker.js and by the Node tests (require).
 *
 * Pipeline (same as fingerprint.py):
 *   16 kHz mono -> Hann-windowed frames (NFFT 1024, HOP 256) -> |rfft| -> log1p
 *   -> 11 x 19 max filter (mode 'nearest') -> candidates = local max above the 70th percentile
 *   -> keep the strongest 28 per second -> sort by time (within a frame: weakest first)
 *   -> pair each peak with the next 4 peaks, 1 <= dt <= 63 frames
 *   -> hash = (f1<<15)|(f2<<6)|dt -> look up -> vote on (reference, offset // 2).
 *
 * Two places where fingerprint.py's result depends on numpy internals, made deterministic
 * here: when thinning, ties in strength keep the earlier candidate in (bin, frame) order
 * (numpy's argpartition leaves ties in an unspecified order), and peaks that share a frame
 * are ordered weakest first (fingerprint.py leaves them in whatever order argpartition
 * produced). The order matters: about half of all peaks share a frame with others (onsets
 * make vertical columns), pairs inside a frame are rejected (dt = 0), so the order decides
 * which peaks of a column get paired. Measured against the shipped index on 40 references
 * (35,020 query hashes), votes at the true offset, clean / degraded clips:
 *   fingerprint.py's own order 5647 / 2759, weakest first 5724 / 2803,
 *   highest bin first 5637 / 2778, lowest bin first 5337 / 2617, strongest first 5292 / 2594.
 *
 * The index format (fp-index/2) is described in manifest.json and export_index.py.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FPEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var SR = 16000, NFFT = 1024, HOP = 256, NBIN = NFFT / 2 + 1;
  var NEIGH_F = 11, NEIGH_T = 19, PCT = 70;
  var DENSITY = 28, FAN = 4, DT_MIN = 1, DT_MAX = 63;
  var SEC_PER_FRAME = HOP / SR;

  // ---------------------------------------------------------------- FFT
  // Real FFT of length NFFT through one complex radix-2 FFT of length NFFT/2.
  var M = NFFT / 2, LOGM = Math.round(Math.log(M) / Math.LN2), i;
  var bitrev = new Uint16Array(M);
  for (i = 0; i < M; i++) {
    var r = 0, v = i;
    for (var b = 0; b < LOGM; b++) { r = (r << 1) | (v & 1); v >>= 1; }
    bitrev[i] = r;
  }
  var cosM = new Float64Array(M / 2), sinM = new Float64Array(M / 2);
  for (i = 0; i < M / 2; i++) { cosM[i] = Math.cos(2 * Math.PI * i / M); sinM[i] = -Math.sin(2 * Math.PI * i / M); }
  var cosN = new Float64Array(M + 1), sinN = new Float64Array(M + 1);
  for (i = 0; i <= M; i++) { cosN[i] = Math.cos(2 * Math.PI * i / NFFT); sinN[i] = -Math.sin(2 * Math.PI * i / NFFT); }
  var HANN = new Float32Array(NFFT);            // np.hanning(NFFT).astype(float32): symmetric
  for (i = 0; i < NFFT; i++) HANN[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (NFFT - 1));
  var zr = new Float64Array(M), zi = new Float64Array(M);

  /** |rfft(frame)| of a length-NFFT real frame into mag[0 .. NBIN). */
  function rfftMag(frame, mag) {
    var k, j, size, half, step, start;
    for (k = 0; k < M; k++) { j = bitrev[k]; zr[j] = frame[2 * k]; zi[j] = frame[2 * k + 1]; }
    for (size = 2; size <= M; size <<= 1) {
      half = size >> 1; step = M / size;
      for (start = 0; start < M; start += size) {
        for (k = 0; k < half; k++) {
          var wr = cosM[k * step], wi = sinM[k * step], a = start + k, c = a + half;
          var tr = zr[c] * wr - zi[c] * wi, ti = zr[c] * wi + zi[c] * wr;
          zr[c] = zr[a] - tr; zi[c] = zi[a] - ti; zr[a] += tr; zi[a] += ti;
        }
      }
    }
    // X[k] = E[k] + W^k O[k];  E = (Z[k] + conj Z[M-k]) / 2,  O = (Z[k] - conj Z[M-k]) / 2i
    for (k = 0; k <= M; k++) {
      var k1 = k % M, k2 = (M - k) % M;
      var ar = zr[k1], ai = zi[k1], br = zr[k2], bi = -zi[k2];
      var er = 0.5 * (ar + br), ei = 0.5 * (ai + bi), dr = 0.5 * (ar - br), di = 0.5 * (ai - bi);
      var or_ = di, oi = -dr;
      var xr = er + or_ * cosN[k] - oi * sinN[k], xi = ei + or_ * sinN[k] + oi * cosN[k];
      mag[k] = Math.sqrt(xr * xr + xi * xi);
    }
  }

  // ---------------------------------------------------------------- spectrogram
  /** log1p magnitude spectrogram, Float32Array laid out [bin * n + frame]. */
  function spectro(x) {
    if (x.length < NFFT) return { S: new Float32Array(0), n: 0 };
    var n = 1 + Math.floor((x.length - NFFT) / HOP);
    var S = new Float32Array(NBIN * n), frame = new Float32Array(NFFT), mag = new Float64Array(NBIN);
    for (var t = 0; t < n; t++) {
      var o = t * HOP;
      for (var j = 0; j < NFFT; j++) frame[j] = x[o + j] * HANN[j];   // float32 product, as numpy
      rfftMag(frame, mag);
      for (var f = 0; f < NBIN; f++) S[f * n + t] = Math.log1p(Math.fround(mag[f]));
    }
    return { S: S, n: n };
  }

  // ---------------------------------------------------------------- peaks
  /** scipy.ndimage.maximum_filter(S, size=(11, 19), mode='nearest'), done separably. */
  function maxFilter(S, n) {
    var tmp = new Float32Array(S.length), out = new Float32Array(S.length);
    var rf = (NEIGH_F - 1) >> 1, rt = (NEIGH_T - 1) >> 1, f, t, j, m, lo, hi, row, v;
    for (f = 0; f < NBIN; f++) {                       // along frequency (edges repeat)
      lo = f - rf < 0 ? 0 : f - rf; hi = f + rf > NBIN - 1 ? NBIN - 1 : f + rf;
      row = f * n;
      for (t = 0; t < n; t++) {
        m = S[lo * n + t];
        for (j = lo + 1; j <= hi; j++) { v = S[j * n + t]; if (v > m) m = v; }
        tmp[row + t] = m;
      }
    }
    for (f = 0; f < NBIN; f++) {                       // along time (edges repeat)
      row = f * n;
      for (t = 0; t < n; t++) {
        lo = t - rt < 0 ? 0 : t - rt; hi = t + rt > n - 1 ? n - 1 : t + rt;
        m = tmp[row + lo];
        for (j = lo + 1; j <= hi; j++) { v = tmp[row + j]; if (v > m) m = v; }
        out[row + t] = m;
      }
    }
    return out;
  }

  /** k-th smallest (0-based) value, partially sorting `a` in place (Hoare quickselect). */
  function select(a, k) {
    var lo = 0, hi = a.length - 1;
    while (hi > lo) {
      var pivot = a[(lo + hi) >> 1], p = lo, q = hi;
      while (p <= q) {
        while (a[p] < pivot) p++;
        while (a[q] > pivot) q--;
        if (p <= q) { var tmp = a[p]; a[p] = a[q]; a[q] = tmp; p++; q--; }
      }
      if (k <= q) hi = q; else if (k >= p) lo = p; else return a[k];
    }
    return a[k];
  }

  /** np.percentile(S, p), default 'linear' method (numpy's lerp form included). */
  function percentile(S, p) {
    var N = S.length, idx = (p / 100) * (N - 1), lo = Math.floor(idx), frac = idx - lo;
    var a = new Float32Array(S);
    var vlo = select(a, lo);
    if (frac === 0 || lo + 1 >= N) return vlo;
    var vhi = Infinity;                                // the next order statistic
    for (var j = lo + 1; j < N; j++) if (a[j] < vhi) vhi = a[j];
    var d = vhi - vlo;
    return frac >= 0.5 ? vhi - d * (1 - frac) : vlo + d * frac;
  }

  /** Peaks thinned to ~density per second, sorted by frame; within a frame weakest first. */
  function peaks(S, n, density) {
    if (n === 0) return { f: new Int32Array(0), t: new Int32Array(0) };
    var mx = maxFilter(S, n), thr = percentile(S, PCT);
    var cf = [], ct = [], cv = [], f, t, row, v, j;
    for (f = 0; f < NBIN; f++) {                       // row-major, like np.nonzero
      row = f * n;
      for (t = 0; t < n; t++) {
        v = S[row + t];
        if (v === mx[row + t] && v > thr) { cf.push(f); ct.push(t); cv.push(v); }
      }
    }
    var count = cf.length, keep = Math.trunc(density * n * SEC_PER_FRAME);
    var idx = [];
    for (j = 0; j < count; j++) idx.push(j);
    if (count > keep && keep > 0) {
      idx.sort(function (a, b) { return cv[b] - cv[a] || a - b; });
      idx.length = keep;
    }
    idx.sort(function (a, b) { return ct[a] - ct[b] || cv[a] - cv[b] || cf[a] - cf[b]; });
    var pf = new Int32Array(idx.length), pt = new Int32Array(idx.length);
    for (j = 0; j < idx.length; j++) { pf[j] = cf[idx[j]]; pt[j] = ct[idx[j]]; }
    return { f: pf, t: pt };
  }

  /** Pair peaks into hashes: {h: Int32Array, t: Int32Array (anchor frame)}. */
  function hashes(pk, fan) {
    var n = pk.f.length, h = [], at = [];
    for (var k = 1; k <= fan; k++) {
      if (n <= k) break;
      for (var j = 0; j + k < n; j++) {
        var dt = pk.t[j + k] - pk.t[j];
        if (dt >= DT_MIN && dt <= DT_MAX) { h.push((pk.f[j] << 15) | (pk.f[j + k] << 6) | dt); at.push(pk.t[j]); }
      }
    }
    return { h: Int32Array.from(h), t: Int32Array.from(at) };
  }

  function fingerprint(x, density, fan) {
    var sp = spectro(x);
    return hashes(peaks(sp.S, sp.n, density || DENSITY), fan || FAN);
  }

  // ---------------------------------------------------------------- index (fp-index/2)
  /** manifest: parsed manifest.json; blob: Uint8Array holding all shards concatenated. */
  function createIndex(manifest, blob) {
    if (manifest.format !== 'fp-index/2') throw new Error('unknown index format ' + manifest.format);
    if (blob.byteLength !== manifest.total_bytes)
      throw new Error('index is ' + blob.byteLength + ' bytes, manifest says ' + manifest.total_bytes);
    var sec = {};
    manifest.sections.forEach(function (s) { sec[s.name] = s; });
    var NB = manifest.nbuckets, bb = sec.bucket_bits;
    var bucketBits = new Uint32Array(NB + 1), dv = new DataView(blob.buffer, blob.byteOffset + bb.offset, 4 * (NB + 1));
    for (var b = 0; b <= NB; b++) bucketBits[b] = dv.getUint32(4 * b, true);
    var st = sec.stream;
    if (bucketBits[NB] !== st.bits) throw new Error('bucket table does not match the stream');
    var refs = manifest.refs, refStart = new Int32Array(refs.length + 1);
    for (var r = 0; r < refs.length; r++) refStart[r] = refs[r].start;
    refStart[refs.length] = 0x7fffffff;               // sentinel
    // recordings of one song share a group: the runner-up must be a DIFFERENT song, because the
    // same master on two collections is agreement, not competition (server.py: match(group=GROUP))
    var gid = Object.create(null), refGroup = new Int32Array(refs.length), ng = 0;
    for (r = 0; r < refs.length; r++) {
      var sg = refs[r].song_id;
      if (!(sg in gid)) gid[sg] = ng++;
      refGroup[r] = gid[sg];
    }
    // unauthorised recordings still in the index never vote (fingerprint.set_exclude)
    var excluded = null;
    for (r = 0; r < refs.length; r++) if (refs[r].excluded) { (excluded = excluded || new Uint8Array(refs.length))[r] = 1; }
    return {
      manifest: manifest, params: manifest.params, refs: refs, refStart: refStart, nref: refs.length,
      refGroup: refGroup, trackCache: Object.create(null), excluded: excluded,
      NB: NB, U: manifest.universe, bucketBits: bucketBits,
      B: new Uint8Array(blob.buffer, blob.byteOffset + st.offset, st.bytes)
    };
  }

  // Bit reading, MSB first. Reads past the end see zeros (typed arrays give undefined -> 0).
  function peek32(B, pos) {                           // 32 bits starting at the byte of `pos`, shifted
    var j = pos >>> 3;
    return ((B[j] << 24) | (B[j + 1] << 16) | (B[j + 2] << 8) | B[j + 3]) << (pos & 7);
  }
  function riceK(n, U) { var k = 0; while (n * Math.pow(2, k + 1) <= U) k++; return k; }

  // A tiny cursor so the decoder can return several values without allocating.
  function Cursor(idx) { this.B = idx.B; this.U = idx.U; this.pos = 0; this.n = 0; this.k = 0; this.dt = 0; }
  Cursor.prototype.header = function () {             // dt, n (gamma), k
    var B = this.B, w = peek32(B, this.pos);
    this.dt = w >>> 26; this.pos += 6;
    w = peek32(B, this.pos);
    var L = Math.clz32(w);                            // n < 2^25, so L <= 24 fits the window
    this.pos += L;
    this.n = (peek32(B, this.pos) >>> (31 - L));      // L+1 bits
    this.pos += L + 1;
    this.k = riceK(this.n, this.U);
  };
  Cursor.prototype.next = function () {               // one Rice-coded gap value v
    var B = this.B, q = 0, w, z, k = this.k, low = 0;
    for (;;) {                                        // unary: count leading ones
      w = peek32(B, this.pos); z = Math.clz32(~w);
      if (z < 25) { q += z; this.pos += z + 1; break; }
      q += 25; this.pos += 25;
    }
    if (k) { low = peek32(B, this.pos) >>> (32 - k); this.pos += k; }
    return q * Math.pow(2, k) + low;
  };

  /** Seek the cursor to the posting list of hash h. Returns its length, or 0 if absent. */
  function seek(idx, cur, h) {
    var b = h >>> 6, dt = h & 63;
    if (b >= idx.NB) return 0;
    cur.pos = idx.bucketBits[b];
    var end = idx.bucketBits[b + 1];
    while (cur.pos < end) {
      cur.header();
      if (cur.dt === dt) return cur.n;
      if (cur.dt > dt) return 0;
      for (var j = 0; j < cur.n; j++) cur.next();     // skip this key's postings
    }
    return 0;
  }

  /** Global frames of hash h (ascending), for inspection and tests. */
  function lookup(idx, h) {
    var cur = new Cursor(idx), n = seek(idx, cur, h), out = new Float64Array(n), g = -1;
    for (var j = 0; j < n; j++) { g += cur.next() + 1; out[j] = g; }
    return out;
  }

  /** Decode the whole index; returns counts and the same checksums export_index.py wrote. */
  function verify(idx) {
    var cur = new Cursor(idx), keys = 0, postings = 0, a = 0, c = 0;
    for (var b = 0; b < idx.NB; b++) {
      cur.pos = idx.bucketBits[b];
      var end = idx.bucketBits[b + 1];
      while (cur.pos < end) {
        cur.header(); keys++;
        var h = (b << 6) | cur.dt, g = -1, hm = Math.imul(h, 0x9E3779B1), hl = (h & 0xFFFF) + 1;
        for (var j = 0; j < cur.n; j++) {
          g += cur.next() + 1;
          a = (a + ((hm ^ Math.imul(g, 0x85EBCA77)) >>> 0)) >>> 0;
          c = (c + (Math.imul(g, hl) >>> 0)) >>> 0;
        }
        postings += cur.n;
      }
      if (cur.pos !== end) throw new Error('bucket ' + b + ' overran its bits');
    }
    var m = idx.manifest, ok = keys === m.stats.distinct_hashes && postings === m.stats.postings &&
      a === m.checksum[0] && c === m.checksum[1];
    return { ok: ok, keys: keys, postings: postings, checksum: [a, c], expected: m.checksum };
  }

  /** Largest count of equal values plus the second largest (np.unique counts: c.max() + next),
   *  and the value with the largest count (the smallest such value on a tie, like np.argmax). */
  function topTwo(a) {
    a.sort(function (x, y) { return x - y; });
    var c1 = 0, c2 = 0, v1 = 0, run = 1;
    for (var j = 1; j <= a.length; j++) {
      if (j < a.length && a[j] === a[j - 1]) { run++; continue; }
      if (run > c1) { c2 = c1; c1 = run; v1 = a[j - 1]; } else if (run > c2) c2 = run;
      run = 1;
    }
    return { votes: c1 + c2, bin: v1 };
  }
  var round3 = function (x) { return Math.round(x * 1000) / 1000; };

  /** Refs that share a song's lyric timeline and so can vouch for a place in it (server.py
   *  track_spec(): TRACK_REFS[song] | {song}): authorised, non-live, not known to be a
   *  different arrangement; plus the ref named like the song. Indices into idx.refs. */
  function trackRefs(idx, songId) {
    var out = [];
    for (var r = 0; r < idx.nref; r++) {
      var rf = idx.refs[r];
      if (rf.ref_id === songId || (rf.song_id === songId && !rf.live && !rf.excluded && rf.aligned !== false)) out.push(r);
    }
    return out;
  }

  /** Tracking votes over the window's hits (hr = ref, ho = frame offset), fingerprint.match's
   *  track=(spec, tol, lyric_at). track = {song_id, at, tol}: at is on the lyric timeline and
   *  each ref is expected at at + its shift; or {refs: {ref_id: expected s in that ref}, at, tol}.
   *  Returns {votes, offset}: offset = where the best-fitting place is, on the lyric timeline. */
  function trackCount(idx, hr, ho, n, track, hq, recentFrom) {
    var expv = new Float64Array(idx.nref).fill(NaN), r, j;
    if (track.refs) {
      for (r = 0; r < idx.nref; r++) {
        var e = track.refs[idx.refs[r].ref_id];
        if (e != null) expv[r] = Math.fround(e / SEC_PER_FRAME);   // numpy keeps these float32
      }
    } else {
      var rs = idx.trackCache[track.song_id] || (idx.trackCache[track.song_id] = trackRefs(idx, track.song_id));
      for (j = 0; j < rs.length; j++) expv[rs[j]] = Math.fround((track.at + (idx.refs[rs[j]].shift || 0)) / SEC_PER_FRAME);
    }
    var tolF = track.tol / SEC_PER_FRAME, bins = [], recent = 0;
    for (j = 0; j < n; j++) {
      var d = ho[j] - expv[hr[j]];                    // NaN for other refs: never within tol
      if (Math.abs(d) <= tolF) { bins.push(Math.floor(d / 2)); if (hq && hq[j] >= recentFrom) recent++; }
    }
    if (!bins.length) return { votes: 0, offset: null, recent: hq ? 0 : null };
    var t = topTwo(bins);
    return { votes: t.votes, offset: round3(track.at + t.bin * 2 * SEC_PER_FRAME), recent: hq ? recent : null };
  }

  /** Match mono Float32Array PCM at 16 kHz. Mirrors server.py's use of fingerprint.match():
   *  match(x, group=GROUP, track=...) then canonical(). Excluded (unauthorised) refs never vote.
   *
   *  Returns song_id (the base song), ref_id, via, live (a live recording, or one known to be a
   *  different arrangement: no clock), offset_sec (where the window starts, on the song's lyric
   *  timeline: the recording position minus the ref's shift), rec_offset_sec (in the recording),
   *  votes, runner_up (best count for ANOTHER song), margin, hits, duration.
   *  opts.track = {song_id | refs, at, tol}: adds track_votes / track_offset (see trackCount).
   *    null when no track was asked, 0 / null when nothing fits.
   *  opts.top = {at, tol}: the same question for whichever song wins this window: top_votes /
   *    top_offset (server.py place_from_top(), without a second pass over the audio). */
  function match(idx, pcm, opts) {
    opts = opts || {};
    var p = idx.params, minVotes = opts.minVotes || p.min_votes || 12, maxHits = p.max_hits || 8000000;
    var q = fingerprint(pcm, p.density, p.fan);
    var res = { song_id: null, ref_id: null, via: null, offset_sec: null, rec_offset_sec: null, votes: 0,
                runner_up: 0, margin: 0, hits: 0, hashes: q.h.length, live: false, duration: null, cands: [],
                track_votes: opts.track ? 0 : null, track_offset: null, track_recent: opts.track ? 0 : null,
                top_votes: opts.top ? 0 : null, top_offset: null };
    if (q.h.length === 0) return res;
    var cur = new Cursor(idx), nq = q.h.length, lens = new Int32Array(nq), pos = new Float64Array(nq), total = 0, j;
    for (j = 0; j < nq; j++) { lens[j] = seek(idx, cur, q.h[j]); pos[j] = cur.pos; total += lens[j]; }
    res.hits = total;
    if (total === 0 || total > maxHits) return res;
    var keys = new Int32Array(total), hr = new Int32Array(total), ho = new Int32Array(total), hq = new Int32Array(total), qmax = 0;
    var n = 0, refStart = idx.refStart, excl = idx.excluded;
    for (j = 0; j < nq; j++) {
      var len = lens[j];
      if (!len) continue;
      cur.pos = pos[j]; cur.k = riceK(len, idx.U);
      var qt = q.t[j], g = -1, r = 0;
      for (var e = 0; e < len; e++) {
        g += cur.next() + 1;
        while (refStart[r + 1] <= g) r++;            // postings ascend, so refs only move forward
        if (excl && excl[r]) continue;
        var off = g - refStart[r] - qt;
        hr[n] = r; ho[n] = off; hq[n] = qt; if (qt > qmax) qmax = qt;
        keys[n++] = r * 100000 + (off >> 1) + 40000;   // >>1 floors, like //
      }
    }
    if (n === 0) return res;
    if (opts.track) {
      // recentFrom: hashes from the last 2 s of the window. Right after a song change most of the
      // window is still the old song; its last seconds are not, so they can't vouch for it.
      var tk = trackCount(idx, hr, ho, n, opts.track, hq, qmax - Math.round(2.0 / SEC_PER_FRAME));
      res.track_votes = tk.votes; res.track_offset = tk.offset; res.track_recent = tk.recent;
    }
    keys = keys.subarray(0, n);
    keys.sort();
    var best = 0, bestKey = 0, run = 1, pc = [], pk = [];
    for (j = 1; j <= n; j++) {                        // first highest count in key order = np.argmax
      if (j < n && keys[j] === keys[j - 1]) { run++; continue; }
      if (run > best) { best = run; bestKey = keys[j - 1]; }
      if (run >= 3) { pc.push(run); pk.push(keys[j - 1]); }       // every place with some support
      run = 1;
    }
    // the dozen best-supported (recording, place) pairs, for adding up evidence across looks:
    // in a hard room the right song is often 2nd-5th in any one look, but in the SAME place each time
    var order = pc.map(function (_, i) { return i; }).sort(function (a, b) { return pc[b] - pc[a]; }).slice(0, 12);
    res.cands = order.map(function (i) {
      var rr = Math.floor(pk[i] / 100000), f = idx.refs[rr], oq = pk[i] % 100000 - 40000;
      return { song_id: f.song_id, ref_id: f.ref_id, votes: pc[i], live: !!f.live || f.aligned === false || !!f.excluded,
               offset_sec: round3(oq * 2 * SEC_PER_FRAME - (f.shift || 0)) };
    });
    var ref = Math.floor(bestKey / 100000), bg = idx.refGroup[ref], second = 0;
    for (j = 1, run = 1; j <= n; j++) {               // runner-up: best count for another song
      if (j < n && keys[j] === keys[j - 1]) { run++; continue; }
      if (run > second && idx.refGroup[Math.floor(keys[j - 1] / 100000)] !== bg) second = run;
      run = 1;
    }
    // A live recording and a studio one can share the same audio (a concert album reusing the
    // track). When a studio version fits nearly as well, take it: its words follow the clock,
    // and a live match could only show a still block of words.
    var timed = function (r) { var f = idx.refs[r]; return !f.live && f.aligned !== false && !f.excluded; };
    if (!timed(ref)) {
      var tb = 0, tkey = 0;
      for (j = 1, run = 1; j <= n; j++) {
        if (j < n && keys[j] === keys[j - 1]) { run++; continue; }
        var rr = Math.floor(keys[j - 1] / 100000);
        if (run > tb && idx.refGroup[rr] === bg && timed(rr)) { tb = run; tkey = keys[j - 1]; }
        run = 1;
      }
      if (tb >= Math.max(minVotes, 0.8 * best)) { best = tb; bestKey = tkey; ref = Math.floor(tkey / 100000); }
    }
    res.votes = best; res.runner_up = second;
    res.margin = Math.round(best / Math.max(second, 1) * 100) / 100;
    if (best < minVotes) return res;
    var offQ = bestKey % 100000 - 40000, rf = idx.refs[ref];
    res.song_id = rf.song_id; res.ref_id = rf.ref_id; res.via = rf.via;
    res.live = !!rf.live || rf.aligned === false; res.duration = rf.duration;
    res.rec_offset_sec = round3(offQ * 2 * SEC_PER_FRAME);
    res.offset_sec = round3(res.rec_offset_sec - (rf.shift || 0));
    if (opts.top) {
      var tp = trackCount(idx, hr, ho, n, { song_id: rf.song_id, at: opts.top.at, tol: opts.top.tol });
      res.top_votes = tp.votes; res.top_offset = tp.offset;
    }
    return res;
  }

  return {
    SR: SR, NFFT: NFFT, HOP: HOP, NBIN: NBIN, DENSITY: DENSITY, FAN: FAN,
    rfftMag: rfftMag, spectro: spectro, maxFilter: maxFilter, percentile: percentile, peaks: peaks,
    hashes: hashes, fingerprint: fingerprint, createIndex: createIndex, lookup: lookup, verify: verify,
    match: match, trackRefs: trackRefs
  };
});
