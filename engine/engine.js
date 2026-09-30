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

  /** KEY CHANGES. A band that plays the backing track transposed moves every peak's frequency by
   *  the same ratio (tempo kept), so almost no hash survives. key = how many semitones the room is
   *  above the recording (-2 = two lower): the query's peak bins are scaled back by 2^(-key/12)
   *  (same peaks, same order, re-hashed). Peaks pushed off the spectrum are dropped. */
  function keyPeaks(pk, key) {
    if (!key) return pk;
    var r = Math.pow(2, -key / 12), f = [], t = [];
    for (var j = 0; j < pk.f.length; j++) {
      var nf = Math.floor(pk.f[j] * r + 0.5);          // round half up (fingerprint.py does the same)
      if (nf >= 0 && nf < NBIN) { f.push(nf); t.push(pk.t[j]); }
    }
    return { f: Int32Array.from(f), t: Int32Array.from(t) };
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
    var tolF = track.tol / SEC_PER_FRAME, bins = [], brefs = [], recent = 0;
    for (j = 0; j < n; j++) {
      var d = ho[j] - expv[hr[j]];                    // NaN for other refs: never within tol
      if (Math.abs(d) <= tolF) { bins.push(Math.floor(d / 2)); brefs.push(hr[j]); if (hq && hq[j] >= recentFrom) recent++; }
    }
    if (!bins.length) return { votes: 0, offset: null, recent: hq ? 0 : null, ref: null };
    // the recording the best place was heard in (the one the room is playing): most hashes in that bin
    var t = topTwo(bins.slice());
    var per = Object.create(null), bestR = -1, bestC = 0;
    for (j = 0; j < bins.length; j++) if (bins[j] === t.bin) { var c = per[brefs[j]] = (per[brefs[j]] || 0) + 1; if (c > bestC) { bestC = c; bestR = brefs[j]; } }
    return { votes: t.votes, offset: round3(track.at + t.bin * 2 * SEC_PER_FRAME), recent: hq ? recent : null,
             ref: bestR >= 0 ? idx.refs[bestR].ref_id : null };
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
   *    a learned one heard there again is marked as heard in this hearing (it has proved itself);
   *  - bounded: SONG_CAP per song, TOTAL_CAP in all. A posting's age is the HEARING it was last
   *    heard in (a hearing = one play of the song; a new one starts after NEW_HEARING s without
   *    learning that song). A song over its cap loses the postings its older hearings had and its
   *    newer ones never heard again (one-off noise); if this hearing alone fills it, it stops
   *    learning more (the start of a song is what matters most, and that is learnt first).
   *    Over TOTAL_CAP, the songs learnt longest ago go first. */
  var ROOM = { TOTAL_CAP: 1500000, SONG_CAP: 80000, HASH_CAP: 6, REPEAT_MAX: 2, NEAR: 1,
               REFINE: 4, REFINE_MIN: 3, HIST: 128, BACKFILL_MIN: 4, BACKFILL_SEC: 48,
               STRIDE: 0.7, BACKFILL_MS: 25, NEW_HEARING: 120,
               REPEAT_SHARE: 0.8, REPEAT_GAP: 3, REPEAT_MAX_PLACES: 3, UNIQUE_RATIO: 1.25 };
  var FRAME_BITS = 18, FRAME_MASK = (1 << FRAME_BITS) - 1, REF_LIMIT = 1 << (32 - FRAME_BITS);
  // ages[i] = hearing << 4 | (key + 8): the hearing it was last heard in, and the key the room was
  // in then (its hashes are stored as heard, so they vote only for a match asked at that key)
  var ageKey = function (a) { return (a & 15) - 8; }, ageHearing = function (a) { return a >>> 4; };
  var packAge = function (hearing, key) { return ((hearing << 4) | ((key + 8) & 15)) >>> 0; };

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
  /** Make room in one song for `need` more postings: drop the hearings before `hearing`, oldest
   *  first (what they learnt and no later hearing heard again). Returns how many now fit. */
  function makeRoom(idx, songId, need, hearing) {
    var L = roomOf(idx), S = L.songs[songId], i;
    if (!S || S.n + need <= ROOM.SONG_CAP) return need;
    var g = idx.refGroup[idx.refs.findIndex(function (r) { return r.song_id === songId; })], per = Object.create(null);
    for (i = 0; i < L.n; i++) if (idx.refGroup[L.vals[i] >>> FRAME_BITS] === g && ageHearing(L.ages[i]) < hearing) { var hg = ageHearing(L.ages[i]); per[hg] = (per[hg] || 0) + 1; }
    var old = Object.keys(per).map(Number).sort(function (a, b) { return a - b; }), cut = -1, n = S.n;
    for (i = 0; i < old.length && n + need > ROOM.SONG_CAP; i++) { cut = old[i]; n -= per[old[i]]; }
    if (cut >= 0) {
      filterRoom(L, function (v, a) { return idx.refGroup[v >>> FRAME_BITS] !== g || ageHearing(a) > cut; });
      recount(idx);
    }
    return Math.max(0, Math.min(need, ROOM.SONG_CAP - ((L.songs[songId] || { n: 0 }).n)));
  }
  /** TOTAL_CAP: drop the songs learnt longest ago (never the one being learnt). */
  function enforceCaps(idx, songId) {
    var L = roomOf(idx), i;
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
   *  opts.verify = n: only learn if at least n of the look's hashes are already at this place in
   *  the SHIPPED index (learned postings can't vouch: a look overlapping one just learnt would
   *  always agree with it). Used to fill in looks from before the decision to learn.
   *  Returns {added, support (all), shipped (shipped only), delta, refreshed}. */
  function learn(idx, q, refIdx, frameOffset, opts) {
    opts = opts || {};
    var L = roomOf(idx), out = { added: 0, support: 0, shipped: 0, delta: 0, places: 0 }, key = opts.key || 0;
    // qs: the look's hashes at the key the song was locked in (what the SHIPPED index can vouch for);
    // q itself (as heard) is what is stored, tagged with that key
    var qs = key ? (opts.keyed || q) : q;
    if (!q || !q.h || !q.h.length || refIdx < 0 || refIdx >= idx.nref || refIdx >= REF_LIMIT) return out;
    if (idx.excluded && idx.excluded[refIdx]) return out;
    var nq = q.h.length, mult = multiplicity(q.h), cur = new Cursor(idx), j, e, dd;
    var r0 = idx.refStart[refIdx], r1 = idx.refStart[refIdx + 1], R = ROOM.REFINE;
    var dcount = Object.create(null), scount = Object.create(null), binCnt = Object.create(null), binLast = Object.create(null);
    var sOff = new Array(qs.h.length), lOff = new Array(nq), lIdx = new Array(nq);
    // where the shipped index has these hashes in this recording (window-start frames), anywhere
    for (j = 0; j < qs.h.length; j++) {
      var gg = -1, len = seek(idx, cur, qs.h[j]), so = null, seen0 = null;
      for (e = 0; e < len; e++) {
        gg += cur.next() + 1;                         // postings ascend: past this recording, stop
        if (gg < r0) continue;
        if (gg >= r1) break;
        var off = gg - r0 - qs.t[j];
        (so = so || []).push(off);
        var b = off >> 1;
        if (binLast[b] !== j) { binLast[b] = j; binCnt[b] = (binCnt[b] || 0) + 1; }
        var d0 = off - frameOffset;
        if (d0 >= -R && d0 <= R && !(seen0 = seen0 || Object.create(null))[d0]) { seen0[d0] = 1; scount[d0] = (scount[d0] || 0) + 1; dcount[d0] = (dcount[d0] || 0) + 1; }
      }
      sOff[j] = so;
    }
    // learned postings of this recording at this key (as heard)
    for (j = 0; j < nq; j++) {
      if (!L.n) break;
      var lo = lowerBound(L.keys, L.n, q.h[j] >>> 0), hi = upperBound(L.keys, L.n, q.h[j] >>> 0), lo2 = null, li = null, seen1 = null;
      for (e = lo; e < hi; e++) {
        if ((L.vals[e] >>> FRAME_BITS) !== refIdx || ageKey(L.ages[e]) !== key) continue;
        var lo_ = (L.vals[e] & FRAME_MASK) - q.t[j];
        (lo2 = lo2 || []).push(lo_); (li = li || []).push(e);
        var d2 = lo_ - frameOffset;
        if (d2 >= -R && d2 <= R && !(seen1 = seen1 || Object.create(null))[d2]) { seen1[d2] = 1; dcount[d2] = (dcount[d2] || 0) + 1; }
      }
      lOff[j] = lo2; lIdx[j] = li;
    }
    // the exact place: the 3-frame stretch most hashes agree on (ties -> nearest 0), then the
    // single frame inside it most of them sit on
    var best = 0, bestD = 0;
    for (dd = -R + 1; dd <= R - 1; dd++) {
      var c = (dcount[dd - 1] || 0) + (dcount[dd] || 0) + (dcount[dd + 1] || 0);
      if (c > best || (c === best && Math.abs(dd) < Math.abs(bestD))) { best = c; bestD = dd; }
    }
    var mid = bestD;
    for (dd = mid - 1; dd <= mid + 1; dd++)
      if ((dcount[dd] || 0) > (dcount[bestD] || 0) || ((dcount[dd] || 0) === (dcount[bestD] || 0) && Math.abs(dd) < Math.abs(bestD))) bestD = dd;
    out.support = best;
    var sbest = 0;
    for (dd = -R + 1; dd <= R - 1; dd++) sbest = Math.max(sbest, (scount[dd - 1] || 0) + (scount[dd] || 0) + (scount[dd + 1] || 0));
    out.shipped = sbest;
    if (opts.verify && sbest < opts.verify) return out;
    var delta = best >= ROOM.REFINE_MIN ? bestD : 0, place = frameOffset + delta;
    out.delta = delta;
    // A REPEATED SECTION (a chorus, an intro that comes back, a song played twice on a concert
    // recording) sounds the same at every copy, so the clock could be at any of them. What is learnt
    // goes to every copy the shipped index vouches for as well as this one: the memory must never
    // make one copy win that the recording itself can't tell apart.
    var places = [place], need = Math.max(ROOM.BACKFILL_MIN, ROOM.REPEAT_SHARE * sbest), cands = [];
    var sup3 = function (b) { return (binCnt[b - 1] || 0) + (binCnt[b] || 0) + (binCnt[b + 1] || 0); };
    var here = Math.max(sup3((place >> 1) - 1), sup3(place >> 1), sup3((place >> 1) + 1)), elsewhere = 0;
    for (var bs in binCnt) {
      var bb = +bs, sup = sup3(bb);
      if (Math.abs(2 * bb - place) >= ROOM.REPEAT_GAP / SEC_PER_FRAME && sup > elsewhere) elsewhere = sup;
      if (sup >= need && Math.abs(2 * bb - place) >= ROOM.REPEAT_GAP / SEC_PER_FRAME &&
          binCnt[bb] >= (binCnt[bb - 1] || 0) && binCnt[bb] > (binCnt[bb + 1] || 0)) cands.push({ f: 2 * bb, sup: sup });
    }
    cands.sort(function (a, b) { return b.sup - a.sup; });
    for (e = 0; e < cands.length && places.length <= ROOM.REPEAT_MAX_PLACES; e++)
      if (places.every(function (p) { return Math.abs(p - cands[e].f) >= ROOM.REPEAT_GAP / SEC_PER_FRAME; })) places.push(cands[e].f);
    out.places = places.length;
    // opts.unambiguous: only learn if the recording itself says this is the place (the clock was not
    // placed from the top of the song, so it could be at the wrong copy of a repeated section, and a
    // memory that learnt there would make that mistake stick)
    out.ambiguous = elsewhere >= ROOM.BACKFILL_MIN && elsewhere * ROOM.UNIQUE_RATIO > here;
    if (opts.unambiguous && out.ambiguous) { out.places = 0; return out; }
    // this hearing of the song: its postings (new, or heard here again) carry its number as their age
    var sid = idx.refs[refIdx].song_id, S = L.songs[sid] || (L.songs[sid] = { n: 0, last: 0, hearing: 0 });
    var tnow = opts.now != null ? opts.now : Date.now();
    if (!S.hearing || tnow - S.last > ROOM.NEW_HEARING * 1000) S.hearing = L.seq++;
    var hearing = S.hearing, age = packAge(hearing, key);
    S.last = tnow;
    var near = function (arr, p) { if (arr) for (var k = 0; k < arr.length; k++) if (Math.abs(arr[k] - p) <= ROOM.NEAR) return true; return false; };
    var bk = [], bv = [], ba = [], batch = Object.create(null);
    for (var pi = 0; pi < places.length; pi++) {
      var P = places[pi];
      for (j = 0; j < nq; j++) {
        // learned postings heard here again: this hearing has proved them
        if (lOff[j]) for (e = 0; e < lOff[j].length; e++)
          if (Math.abs(lOff[j][e] - P) <= ROOM.NEAR && L.ages[lIdx[j][e]] !== age) { L.ages[lIdx[j][e]] = age; out.refreshed = (out.refreshed || 0) + 1; L.dirty[sid] = true; }
        if (mult[j] > ROOM.REPEAT_MAX) continue;                   // a hum or tone, not the song
        var fr = P + q.t[j];
        if (fr < 0 || fr > FRAME_MASK) continue;
        if ((qs === q && near(sOff[j], P)) || near(lOff[j], P)) continue;   // already here: nothing to learn
        var h = q.h[j] >>> 0;
        if (L.n && upperBound(L.keys, L.n, h) - lowerBound(L.keys, L.n, h) >= ROOM.HASH_CAP) continue;
        var bkey = h + ':' + fr;
        if (batch[bkey]) continue;
        batch[bkey] = 1;
        bk.push(h); bv.push(((refIdx << FRAME_BITS) | fr) >>> 0); ba.push(age);
      }
    }
    var fit = makeRoom(idx, sid, bk.length, hearing);   // over SONG_CAP: older hearings go; this one keeps its start
    if (fit < bk.length) { bk.length = fit; bv.length = fit; ba.length = fit; }
    mergeBatch(L, bk, bv, ba);
    out.added = bk.length;
    S = L.songs[sid] || (L.songs[sid] = { n: 0, last: tnow, hearing: hearing });
    if (bk.length) {
      S.n += bk.length; L.dirty[sid] = true;
      enforceCaps(idx, sid);
    }
    if (!S.n) delete L.songs[sid];
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
        K[n] = x.h[j]; V[n] = ((gr << FRAME_BITS) | (x.v[j] & FRAME_MASK)) >>> 0; A[n] = x.a ? x.a[j] : packAge(0, 0);
        if (ageHearing(A[n]) > maxAge) maxAge = ageHearing(A[n]);
        n++; got++;
      }
      if (got) { var S = L.songs[x.song_id] || (L.songs[x.song_id] = { n: 0, last: 0, hearing: 0 }); S.last = Math.max(S.last, x.last || 0); out.songs++; out.postings += got; }
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
    enforceCaps(idx, null);
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
      /** After each match: keep this look's peaks (match()'s res.peaks); at = when the window ended. */
      saw: function (at, win, pk) {
        if (!pk) return;
        hist.push({ at: at, win: win, pk: pk, learned: null });
        while (hist.length > ROOM.HIST || (hist.length && at - hist[0].at > ROOM.BACKFILL_SEC + 2)) hist.shift();
      },
      /** m = {at, song_id, lyric_offset, ref_id?, from_top?, key?} (lyric_offset = window start on
       *  the lyric timeline; key = semitones the room is from the recording) or {at, ref_id,
       *  offset_sec} (window start in that recording).
       *  from_top: the song began at its top when the music started, so every look since then is
       *  this song: they are filled in without needing the shipped index to vouch for each one. */
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
        // windows overlap (5 s every 0.75 s): one look in STRIDE seconds covers all of the audio
        var H = hist[cur], start = H.at - H.win, lastAt = -1e9, t0 = Date.now();
        for (i = cur; i >= 0; i--) if (hist[i].learned === ref) { lastAt = Math.max(lastAt, hist[i].at); }
        var todo = [];
        if (H.at - lastAt >= ROOM.STRIDE) todo.push(cur);
        // fill in the looks before (the intro, heard before the lock), a few per call, OLDEST first
        // (they are the next to leave the history), each STRIDE apart, and only where the index
        // already agrees with this clock
        var prev = -1e9;
        for (i = 0; i < cur; i++) {
          var h0 = hist[i];
          if (H.at - h0.at > ROOM.BACKFILL_SEC) continue;
          if (off + (h0.at - h0.win - start) + h0.win <= 0) continue;   // wholly before the recording starts
          if (h0.learned === ref) { prev = h0.at; continue; }
          if (h0.at - prev < ROOM.STRIDE) continue;
          todo.push(i); prev = h0.at;
        }
        if (todo[0] === cur) todo.push(todo.shift());    // the look itself last: the fill-ins are older
        var key = m.key || 0, fan = (idx.params && idx.params.fan) || FAN;
        for (var k = 0; k < todo.length; k++) {
          var h = hist[todo[k]], isCur = todo[k] === cur;
          if (!isCur && k > 0 && Date.now() - t0 > ROOM.BACKFILL_MS) continue;   // the rest next time
          var o = off + (h.at - h.win - start);            // this look's window start, same clock
          var q0 = hashes(h.pk, fan);                      // stored as heard...
          var got = learn(idx, q0, ref, Math.round(o / SEC_PER_FRAME), { now: now, key: key,
                          keyed: key ? hashes(keyPeaks(h.pk, key), fan) : null,   // ...checked at the song's key
                          verify: isCur || m.from_top ? 0 : ROOM.BACKFILL_MIN, unambiguous: !m.from_top });
          h.learned = ref;                                 // tried: never re-examined for this recording
          if (isCur || m.from_top || got.shipped >= ROOM.BACKFILL_MIN) { res.looks++; res.added += got.added; }
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
    var p = idx.params, fan = p.fan || FAN, key = opts.key || 0;
    var sp = spectro(pcm), pk = peaks(sp.S, sp.n, p.density || DENSITY);
    var q0 = hashes(pk, fan);                         // as heard (learned postings are stored as heard)
    var res = matchKey(idx, key ? hashes(keyPeaks(pk, key), fan) : q0, q0, key, opts);
    res.peaks = pk;                                   // the worker keeps them: room memory learns from them
    // other keys, from the same peaks (a band playing the track transposed)
    if (opts.keys && opts.keys.length) {
      res.alts = [];
      for (var a = 0; a < opts.keys.length; a++) {
        var k = opts.keys[a];
        if (k === key || res.alts.some(function (x) { return x.key === k; })) continue;
        var ra = matchKey(idx, hashes(keyPeaks(pk, k), fan), q0, k, { top: opts.top, minVotes: opts.minVotes });
        delete ra.track_votes; delete ra.track_offset; delete ra.track_recent; delete ra.track_ref;
        res.alts.push(ra);
      }
    }
    return res;
  }

  /** match() at one key: q = the query's hashes at that key (for the shipped index), q0 = as heard
   *  (for learned postings, which only vote when they were learnt at this same key). */
  function matchKey(idx, q, q0, key, opts) {
    var p = idx.params, minVotes = opts.minVotes || p.min_votes || 12, maxHits = p.max_hits || 8000000;
    var res = { song_id: null, ref_id: null, via: null, offset_sec: null, rec_offset_sec: null, votes: 0,
                runner_up: 0, margin: 0, hits: 0, hashes: q.h.length, live: false, duration: null, cands: [], key: key,
                track_votes: opts.track ? 0 : null, track_offset: null, track_recent: opts.track ? 0 : null, track_ref: null,
                top_votes: opts.top ? 0 : null, top_offset: null };
    if (q.h.length === 0 && q0.h.length === 0) return res;
    var cur = new Cursor(idx), nq = q.h.length, lens = new Int32Array(nq), pos = new Float64Array(nq), total = 0, j;
    for (j = 0; j < nq; j++) { lens[j] = seek(idx, cur, q.h[j]); pos[j] = cur.pos; total += lens[j]; }
    // learned postings (room memory): counted exactly like shipped ones. A hash repeating within
    // this look (a hum) doesn't use them.
    var L = idx.learned, llo = null, lhi = null, n0 = q0.h.length;
    if (L && L.n) {
      var mult = multiplicity(q0.h);
      llo = new Int32Array(n0); lhi = new Int32Array(n0);
      for (j = 0; j < n0; j++) {
        if (mult[j] > ROOM.REPEAT_MAX) continue;
        var hu = q0.h[j] >>> 0;
        llo[j] = lowerBound(L.keys, L.n, hu); lhi[j] = upperBound(L.keys, L.n, hu); total += lhi[j] - llo[j];
      }
    }
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
    if (llo) for (j = 0; j < n0; j++) {
      var qt2 = q0.t[j];
      for (var e2 = llo[j]; e2 < lhi[j]; e2++) {
        var lv = L.vals[e2], lr = lv >>> FRAME_BITS;
        if ((excl && excl[lr]) || ageKey(L.ages[e2]) !== key) continue;
        var loff = (lv & FRAME_MASK) - qt2;
        hr[n] = lr; ho[n] = loff; hq[n] = qt2; if (qt2 > qmax) qmax = qt2;
        keys[n++] = lr * 100000 + (loff >> 1) + 40000;
      }
    }
    if (n === 0) return res;
    if (opts.track) {
      // recentFrom: hashes from the last 2 s of the window. Right after a song change most of the
      // window is still the old song; its last seconds are not, so they can't vouch for it.
      var tk = trackCount(idx, hr, ho, n, opts.track, hq, qmax - Math.round(2.0 / SEC_PER_FRAME));
      res.track_votes = tk.votes; res.track_offset = tk.offset; res.track_recent = tk.recent; res.track_ref = tk.ref;
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
    hashes: hashes, fingerprint: fingerprint, keyPeaks: keyPeaks, createIndex: createIndex, lookup: lookup, verify: verify,
    match: match, trackRefs: trackRefs,
    ROOM: ROOM, learn: learn, createRoom: createRoom, roomExport: roomExport, roomImport: roomImport,
    roomClear: roomClear, roomStats: roomStats, roomDirty: roomDirty, recipe: recipe
  };
});
