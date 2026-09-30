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

  // ---------------------------------------------------------------- room memory (learned postings)
  /* The shipped index holds the official recordings as they sound clean. In a real room (reverb,
   * the PA's EQ, this phone's mic, a crowd, singers over the track) most of those hashes never
   * survive, so a look finds few votes. But once the app is locked and on track it knows exactly
   * which recording and which second each look covers, and that look's own hashes are then "how
   * this song sounds HERE, through THIS mic". Stored as extra postings for that recording at that
   * place, they match directly the next time the song plays in this room.
   *
   * The learned postings live apart from the read-only shipped index, in three parallel typed
   * arrays sorted by hash (keys = hash, vals = ref << 18 | frame, ages = learn number), and
   * match() counts them exactly like shipped ones: same keys, same votes, same candidates, same
   * track and top. Lookup is a binary search per query hash (~600 per look).
   *
   * Guards (what keeps room noise from ever voting):
   *  - a hash that repeats within one look (a hum, a feedback tone: the same pair at every frame)
   *    is never learned, and its learned postings are not used when it repeats in a query;
   *  - one hash holds at most HASH_CAP learned postings;
   *  - a hash the index already has at this place (shipped or learned, +-1 frame) is not added;
   *  - bounded: SONG_CAP per song (its oldest learning goes first), TOTAL_CAP in all (the song
   *    learnt longest ago goes first). */
  var ROOM = { TOTAL_CAP: 1500000, SONG_CAP: 60000, HASH_CAP: 6, REPEAT_MAX: 2, NEAR: 1,
               REFINE: 4, REFINE_MIN: 3, HIST: 48, BACKFILL_MIN: 4, BACKFILL_SEC: 40 };
  var FRAME_BITS = 18, FRAME_MASK = (1 << FRAME_BITS) - 1, REF_LIMIT = 1 << (32 - FRAME_BITS);

  function roomOf(idx) {
    if (!idx.learned) idx.learned = { keys: new Uint32Array(0), vals: new Uint32Array(0), ages: new Uint32Array(0),
                                      n: 0, seq: 1, songs: Object.create(null), dirty: Object.create(null) };
    return idx.learned;
  }
  function lowerBound(a, n, x) { var lo = 0, hi = n; while (lo < hi) { var mid = (lo + hi) >>> 1; if (a[mid] < x) lo = mid + 1; else hi = mid; } return lo; }
  function upperBound(a, n, x) { var lo = 0, hi = n; while (lo < hi) { var mid = (lo + hi) >>> 1; if (a[mid] <= x) lo = mid + 1; else hi = mid; } return lo; }
  function ensureCap(L, need) {
    if (L.keys.length >= need) return;
    var cap = Math.max(need, Math.min(Math.ceil(L.keys.length * 1.5) + 4096, ROOM.TOTAL_CAP + 200000));
    if (cap < need) cap = need;
    var k = new Uint32Array(cap), v = new Uint32Array(cap), a = new Uint32Array(cap);
    k.set(L.keys.subarray(0, L.n)); v.set(L.vals.subarray(0, L.n)); a.set(L.ages.subarray(0, L.n));
    L.keys = k; L.vals = v; L.ages = a;
  }
  /** Keep only postings where keep(val, age) is true (order, so sorting, is preserved). */
  function filterRoom(L, keep) {
    var w = 0;
    for (var i = 0; i < L.n; i++) if (keep(L.vals[i], L.ages[i])) { L.keys[w] = L.keys[i]; L.vals[w] = L.vals[i]; L.ages[w] = L.ages[i]; w++; }
    L.n = w;
  }
  function songOfVal(idx, v) { return idx.refs[v >>> FRAME_BITS].song_id; }
  function recount(idx) {
    var L = roomOf(idx), c = Object.create(null), i;
    for (i = 0; i < L.n; i++) { var s = songOfVal(idx, L.vals[i]); c[s] = (c[s] || 0) + 1; }
    for (var s2 in L.songs) { if (!c[s2]) { delete L.songs[s2]; L.dirty[s2] = true; } else if (L.songs[s2].n !== c[s2]) { L.songs[s2].n = c[s2]; L.dirty[s2] = true; } }
  }
  /** SONG_CAP: drop this song's oldest learning. TOTAL_CAP: drop the songs learnt longest ago. */
  function enforceCaps(idx, songId) {
    var L = roomOf(idx), S = L.songs[songId], g, i;
    if (S && S.n > ROOM.SONG_CAP) {
      g = idx.refGroup[idx.refs.findIndex(function (r) { return r.song_id === songId; })];
      var ages = [];
      for (i = 0; i < L.n; i++) if (idx.refGroup[L.vals[i] >>> FRAME_BITS] === g) ages.push(L.ages[i]);
      ages.sort(function (a, b) { return a - b; });
      var cut = ages[ages.length - Math.floor(0.85 * ROOM.SONG_CAP)];   // keep the newest 85%
      filterRoom(L, function (v, a) { return idx.refGroup[v >>> FRAME_BITS] !== g || a >= cut; });
      recount(idx);
    }
    if (L.n > ROOM.TOTAL_CAP) {
      var order = Object.keys(L.songs).filter(function (s) { return s !== songId; })
        .sort(function (a, b) { return L.songs[a].last - L.songs[b].last; });
      var drop = Object.create(null), left = L.n;
      for (i = 0; i < order.length && left > 0.9 * ROOM.TOTAL_CAP; i++) { drop[order[i]] = true; left -= L.songs[order[i]].n; }
      filterRoom(L, function (v) { return !drop[songOfVal(idx, v)]; });
      recount(idx);
    }
  }
  /** Merge a batch (unsorted) of postings into the sorted arrays, in place from the back. */
  function mergeBatch(L, bk, bv, ba) {
    var b = bk.length; if (!b) return;
    var ord = new Array(b); for (var i = 0; i < b; i++) ord[i] = i;
    ord.sort(function (x, y) { return bk[x] - bk[y]; });
    ensureCap(L, L.n + b);
    var p = L.n - 1, q = b - 1, w = L.n + b - 1;
    while (q >= 0) {
      if (p >= 0 && L.keys[p] > bk[ord[q]]) { L.keys[w] = L.keys[p]; L.vals[w] = L.vals[p]; L.ages[w] = L.ages[p]; p--; }
      else { L.keys[w] = bk[ord[q]]; L.vals[w] = bv[ord[q]]; L.ages[w] = ba[ord[q]]; q--; }
      w--;
    }
    L.n += b;
  }

  /** How many times each query hash occurs in this look (a hum or tone repeats at every frame). */
  function multiplicity(h) {
    var s = Int32Array.from(h).sort(), out = new Int32Array(h.length);
    for (var j = 0; j < h.length; j++) out[j] = upperBound(s, s.length, h[j]) - lowerBound(s, s.length, h[j]);
    return out;
  }

  /** Learn one look: q = its hashes {h, t} (t = anchor frame in the window), refIdx = the recording
   *  it covers, frameOffset = where the window starts in that recording (frames). The place is
   *  first refined to the frame from the postings the index already has near it.
   *  opts.verify = n: only learn if at least n of the look's hashes are already at this place
   *  (used to fill in looks from before the decision to learn). Returns {added, support, delta}. */
  function learn(idx, q, refIdx, frameOffset, opts) {
    opts = opts || {};
    var L = roomOf(idx), out = { added: 0, support: 0, delta: 0 };
    if (!q || !q.h || !q.h.length || refIdx < 0 || refIdx >= idx.nref || refIdx >= REF_LIMIT) return out;
    if (idx.excluded && idx.excluded[refIdx]) return out;
    var nq = q.h.length, mult = multiplicity(q.h), cur = new Cursor(idx), j, e;
    var r0 = idx.refStart[refIdx], r1 = idx.refStart[refIdx + 1], near = new Array(nq), dcount = Object.create(null);
    // what the index already has for these hashes, near where this look should be in this recording
    for (j = 0; j < nq; j++) {
      var exp = frameOffset + q.t[j], ds = null;
      var len = seek(idx, cur, q.h[j]), g = -1;
      for (e = 0; e < len; e++) {
        g += cur.next() + 1;
        if (g < r0 || g >= r1) continue;
        var d = g - r0 - exp;
        if (d >= -ROOM.REFINE && d <= ROOM.REFINE) (ds = ds || []).push(d);
      }
      if (L.n) {
        var lo = lowerBound(L.keys, L.n, q.h[j] >>> 0), hi = upperBound(L.keys, L.n, q.h[j] >>> 0);
        for (e = lo; e < hi; e++) {
          if ((L.vals[e] >>> FRAME_BITS) !== refIdx) continue;
          var d2 = (L.vals[e] & FRAME_MASK) - exp;
          if (d2 >= -ROOM.REFINE && d2 <= ROOM.REFINE) (ds = ds || []).push(d2);
        }
      }
      near[j] = ds;
      if (ds) { var seen = Object.create(null); for (e = 0; e < ds.length; e++) if (!seen[ds[e]]) { seen[ds[e]] = 1; dcount[ds[e]] = (dcount[ds[e]] || 0) + 1; } }
    }
    // the exact place: the frame deviation most hashes agree on (with its neighbours; ties -> nearest 0)
    var best = 0, bestD = 0;
    for (var dd = -ROOM.REFINE + 1; dd <= ROOM.REFINE - 1; dd++) {
      var c = (dcount[dd - 1] || 0) + (dcount[dd] || 0) + (dcount[dd + 1] || 0);
      if (c > best || (c === best && Math.abs(dd) < Math.abs(bestD))) { best = c; bestD = dd; }
    }
    out.support = best;
    if (opts.verify && best < opts.verify) return out;
    var delta = best >= ROOM.REFINE_MIN ? bestD : 0;
    out.delta = delta;
    var bk = [], bv = [], ba = [], age = L.seq++, batch = Object.create(null);
    for (j = 0; j < nq; j++) {
      if (mult[j] > ROOM.REPEAT_MAX) continue;                     // a hum or tone, not the song
      var fr = frameOffset + delta + q.t[j];
      if (fr < 0 || fr > FRAME_MASK) continue;
      var have = near[j], dup = false;
      if (have) for (e = 0; e < have.length; e++) if (Math.abs(have[e] - delta) <= ROOM.NEAR) { dup = true; break; }
      if (dup) continue;                                           // already here: nothing to learn
      var h = q.h[j] >>> 0;
      if (L.n && upperBound(L.keys, L.n, h) - lowerBound(L.keys, L.n, h) >= ROOM.HASH_CAP) continue;
      var bkey = h + ':' + fr;
      if (batch[bkey]) continue;
      batch[bkey] = 1;
      bk.push(h); bv.push(((refIdx << FRAME_BITS) | fr) >>> 0); ba.push(age);
    }
    mergeBatch(L, bk, bv, ba);
    out.added = bk.length;
    if (bk.length) {
      var sid = idx.refs[refIdx].song_id, S = L.songs[sid] || (L.songs[sid] = { n: 0, last: 0 });
      S.n += bk.length; S.last = opts.now != null ? opts.now : Date.now(); L.dirty[sid] = true;
      enforceCaps(idx, sid);
    }
    return out;
  }

  /** The hash recipe learned postings depend on: a different recognizer can't reuse them. */
  function recipe(idx) {
    var p = idx.params || {};
    return [idx.manifest.format, p.sr, p.nfft, p.hop, p.neigh_freq, p.neigh_time, p.percentile, p.density, p.fan, p.dt_min, p.dt_max].join('/');
  }

  /** One song's learning, for storage: refs by NAME (a re-exported index renumbers them). */
  function roomExport(idx, songId) {
    var L = roomOf(idx), refs = [], local = Object.create(null), h = [], v = [], a = [];
    for (var i = 0; i < L.n; i++) {
      var r = L.vals[i] >>> FRAME_BITS, f = idx.refs[r];
      if (f.song_id !== songId) continue;
      if (!(r in local)) { local[r] = refs.length; refs.push(f.ref_id); }
      h.push(L.keys[i]); v.push(((local[r] << FRAME_BITS) | (L.vals[i] & FRAME_MASK)) >>> 0); a.push(L.ages[i]);
    }
    var S = L.songs[songId];
    return { song_id: songId, recipe: recipe(idx), refs: refs, last: S ? S.last : 0,
             h: Uint32Array.from(h), v: Uint32Array.from(v), a: Uint32Array.from(a) };
  }

  /** Load stored songs (roomExport records). Records of another recipe, and postings of
   *  recordings no longer in the index, are skipped. Returns {songs, postings, skipped}. */
  function roomImport(idx, records) {
    var L = roomOf(idx), byId = Object.create(null), r, i, out = { songs: 0, postings: 0, skipped: 0 }, rec = recipe(idx);
    for (r = 0; r < idx.nref; r++) byId[idx.refs[r].ref_id] = r;
    var total = L.n;
    (records || []).forEach(function (x) { if (x && x.recipe === rec && x.h) total += x.h.length; });
    var K = new Uint32Array(total), V = new Uint32Array(total), A = new Uint32Array(total), n = 0, maxAge = L.seq - 1;
    for (i = 0; i < L.n; i++) { K[n] = L.keys[i]; V[n] = L.vals[i]; A[n] = L.ages[i]; n++; }
    (records || []).forEach(function (x) {
      if (!x || x.recipe !== rec || !x.h) { out.skipped++; return; }
      var map = (x.refs || []).map(function (id) { var k = byId[id]; return k == null || k >= REF_LIMIT || (idx.excluded && idx.excluded[k]) ? -1 : k; });
      var got = 0;
      for (var j = 0; j < x.h.length; j++) {
        var gr = map[x.v[j] >>> FRAME_BITS];
        if (gr == null || gr < 0) continue;
        K[n] = x.h[j]; V[n] = ((gr << FRAME_BITS) | (x.v[j] & FRAME_MASK)) >>> 0; A[n] = x.a ? x.a[j] : 0;
        if (A[n] > maxAge) maxAge = A[n];
        n++; got++;
      }
      if (got) { var S = L.songs[x.song_id] || (L.songs[x.song_id] = { n: 0, last: 0 }); S.last = Math.max(S.last, x.last || 0); out.songs++; out.postings += got; }
    });
    // radix sort by hash (keys < 2^26): two passes of 13 bits, stable
    var K2 = new Uint32Array(n), V2 = new Uint32Array(n), A2 = new Uint32Array(n);
    [0, 13].forEach(function (shift, pass) {
      var src = pass ? [K2, V2, A2] : [K, V, A], dst = pass ? [K, V, A] : [K2, V2, A2], cnt = new Uint32Array(8193);
      for (var i2 = 0; i2 < n; i2++) cnt[((src[0][i2] >>> shift) & 8191) + 1]++;
      for (var b = 0; b < 8192; b++) cnt[b + 1] += cnt[b];
      for (i2 = 0; i2 < n; i2++) {
        var w = cnt[(src[0][i2] >>> shift) & 8191]++;
        dst[0][w] = src[0][i2]; dst[1][w] = src[1][i2]; dst[2][w] = src[2][i2];
      }
    });
    L.keys = K; L.vals = V; L.ages = A; L.n = n; L.seq = maxAge + 1;
    recount(idx);
    L.dirty = Object.create(null);
    Object.keys(L.songs).forEach(function (s) { enforceCaps(idx, s); });
    return out;
  }

  function roomClear(idx) {
    var L = roomOf(idx);
    Object.keys(L.songs).forEach(function (s) { L.dirty[s] = true; });
    L.keys = new Uint32Array(0); L.vals = new Uint32Array(0); L.ages = new Uint32Array(0); L.n = 0; L.songs = Object.create(null);
  }
  function roomStats(idx) {
    var L = roomOf(idx);
    return { songs: Object.keys(L.songs).length, postings: L.n, bytes: L.keys.length * 12 };
  }
  /** Songs whose learning changed since the last call (to save or delete). */
  function roomDirty(idx) { var L = roomOf(idx), d = Object.keys(L.dirty); L.dirty = Object.create(null); return d; }

  /** The worker's side of learning: remembers the last looks' hashes, and on a learn request
   *  learns that look and fills in the looks before it (the song's intro, heard before the lock)
   *  that verifiably sit at the same place on the same clock. */
  function createRoom(idx) {
    var hist = [];
    var refIndex = Object.create(null);
    for (var r = 0; r < idx.nref; r++) refIndex[idx.refs[r].ref_id] = r;
    // the recording a song's learning goes to when the caller doesn't name one: the one the lyric
    // timeline is written against (shift 0), preferring the ref named like the song
    function primary(songId) {
      var best = -1, bs = -1;
      for (var k = 0; k < idx.nref; k++) {
        var f = idx.refs[k];
        if (f.song_id !== songId || f.live || f.excluded) continue;
        var s = (f.ref_id === songId ? 2 : 0) + (Math.abs(f.shift || 0) < 0.001 ? 4 : 0) + (f.aligned !== false ? 1 : 0);
        if (s > bs) { bs = s; best = k; }
      }
      return best;
    }
    return {
      /** After each match: keep this look's hashes (q = {h, t}); at = when the window ended. */
      saw: function (at, win, q) {
        if (!q) return;
        hist.push({ at: at, win: win, q: q, learned: null });
        if (hist.length > ROOM.HIST) hist.shift();
      },
      /** m = {at, song_id, lyric_offset, ref_id?} (lyric_offset = window start on the lyric
       *  timeline) or {at, ref_id, offset_sec} (window start in that recording). */
      learn: function (m, now) {
        var res = { added: 0, looks: 0, ref_id: null };
        var cur = null;
        for (var i = hist.length - 1; i >= 0; i--) if (hist[i].at === m.at) { cur = i; break; }
        if (cur == null) return res;
        var ref = m.ref_id != null && refIndex[m.ref_id] != null ? refIndex[m.ref_id] : -1, off;
        if (m.lyric_offset != null) {
          var f = ref >= 0 ? idx.refs[ref] : null;
          if (!f || f.song_id !== m.song_id || f.live || f.aligned === false || f.excluded) ref = primary(m.song_id);
          if (ref < 0) return res;
          off = m.lyric_offset + (idx.refs[ref].shift || 0);
        } else off = m.offset_sec;
        if (ref < 0 || off == null || !isFinite(off)) return res;
        res.ref_id = idx.refs[ref].ref_id;
        var H = hist[cur], start = H.at - H.win;
        for (i = cur; i >= 0; i--) {
          var h = hist[i];
          if (h.learned === ref) continue;
          if (H.at - h.at > ROOM.BACKFILL_SEC) break;
          var o = off + (h.at - h.win - start);          // this look's window start, same clock
          if (o + h.win <= 0) break;                       // wholly before the recording starts
          var got = learn(idx, h.q, ref, Math.round(o / SEC_PER_FRAME), { now: now, verify: i === cur ? 0 : ROOM.BACKFILL_MIN });
          h.learned = ref;                                 // tried: never re-examined for this recording
          if (i === cur || got.support >= ROOM.BACKFILL_MIN) { res.looks++; res.added += got.added; }
        }
        return res;
      },
      forget: function () { hist.length = 0; }
    };
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
