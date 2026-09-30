/* What to show, decided on this device: a port of server.py's listening decisions, so the iPad
 * with no Mac behaves exactly as the Mac does. Pure logic: no DOM, no timers, no audio. Every
 * call takes the time (seconds on any steady clock), so Node tests can replay a service.
 *
 * Mapping to server.py:
 *   heard()   the /hear bookkeeping (listen.active, last_loud, music_since)
 *   track()   the tracking question asked with each window (track_spec(), TRACK_TOL)
 *   top()     place_from_top()'s question, asked in the same look: does the top of the song fit?
 *   result()  the rest of /hear: place_from_top(), on track? -> consider_live() / consider(),
 *             and the confidence
 *   tick()    maybe_release(), which the server runs on every /state poll
 *   hold()    an operator (or ?demo=) putting a song up by hand
 *   words()   asr_job() / consider_words(): the browser's own speech recognition heard words
 *             (app.js runs it only while wantWords() says so, and searches with lyricsearch.js)
 *
 * ONE MODE: ALWAYS SCROLL (Joel, 30 Sep). When the song is known but the place only roughly
 * (sung words, a live or differently-arranged recording), the clock starts from the best
 * estimate and scrolls like any other song; later sung words re-anchor it. There is no static
 * block of words any more, except for a song whose lines have no timings at all (a clock is
 * impossible there; one song, 'untimed').
 *   estimate from words: the line was being sung just now, so now = its start + half its length
 *     (the time to the next cue, capped at LINE_MAX): started_at = at - (cue.t + half).
 *   estimate from a live recording: its offset mapped onto the lyric timeline by the ratio of
 *     the two durations: started_at = heardAt - (offset_sec + win) * dur / live_dur.
 *   re-anchoring: a later words match of a line in the SAME song (the copy of a repeated line
 *     nearest the clock) moves the clock only if the clock is more than WORDS_OUT outside that
 *     line (its start to its end, allowing for the words having been sung a moment ago).
 *   Studio fingerprints keep tracking and correcting as before; for a live recording, more
 *   matches of it keep the song up but never move the clock (only words do).
 *
 * Results are the worker's: {song_id, ref_id, via, live, duration, offset_sec, votes, margin,
 * track_votes, top_votes, top_offset}. server.py canonical() is done by the engine from the
 * index's refs[] (song_id, shift, live, aligned), so offset_sec is already on the song's lyric
 * timeline and `live` already covers recordings in a different arrangement. The one piece of
 * canonical() left here is the song's 'untimed' flag (songs.json `flags`, if present).
 *
 * One deliberate difference from server.py: LOUD_MISS_SEC counts from when the music came
 * back (music_since), not only from the last confirmation. In server.py a quiet bridge longer
 * than 20 s releases the song the instant the music resumes (last_confirm is already 20 s old
 * and the first loud window has too little music in it to confirm anything), then relocks a
 * few windows later: a blank flash. Found by decide.test.mjs ('quiet bridge').
 */
export const DEFAULTS = {
  MIN_VOTES: 12, MIN_MARGIN: 1.3, STRONG_VOTES: 25,   // believable()
  LOCK_VOTES: 40, LOCK_MARGIN: 2.0,  // one window this strong locks with no second opinion
  RESYNC_SEC: 1.2,       // only move the clock if we are further out than this
  AGREE_SEC: 0.75,       // two windows must place the song within this of each other
  CANDIDATE_TTL: 12,     // forget an unconfirmed candidate after this long
  MUSIC_LEVEL: 0.015,    // mic RMS above this means music is playing in the room
  LOUD_MISS_SEC: 20,     // music playing, yet this song unconfirmed this long: something else is on
  SILENCE_SEC: 30,       // the room has been quiet this long: the music has stopped
  END_GRACE: 2.5,        // past the song's end by this much: let it go
  TRACK_TOL: 0.6,        // seconds either side of where we expect to be
  TRACK_MIN: 5,          // hashes at the expected place = still on track
  CHALLENGE_N: 3,        // agreeing windows needed to move off a song that was on track
  OFF_TRACK_SEC: 2.5,    // and the current place must have gone unheard this long
  CHALLENGE_GAP: 2.0,    // a challenger's windows must follow each other within this
  CHALLENGE_WITHIN: 20,  // the challenge rule applies while the song was on track this recently
  LIVE_VOTES: 18,        // a live recording needs this many votes to put its song up
  // start from the top: in church a song almost always starts at its beginning, right when
  // the music starts, so a song recognised soon after the music began is placed at its top
  // unless the top clearly doesn't fit
  QUIET_GAP: 4.0,        // this much quiet before sound = the music (re)started
  // ...where "sound" is RELATIVE to the room: a soft intro in a quiet room is the music starting,
  // long before it reaches MUSIC_LEVEL (Build Your House on a Rock locked 6.4 s ahead because the
  // top-of-song question was never asked). The room's floor is learnt from quiet looks only, so
  // a soft verse never counts as quiet and never restarts the music.
  START_MIN: 0.004,      // sound is at least this loud...
  START_RATIO: 2.5,      // ...and this many times the room's own floor
  FLOOR_LOOKS: 13,       // the floor: the quietest tenth of the last this-many quiet looks (~10 s)
  // start from the top even without a music start: nothing up (for FRESH_SEC), and a place of the
  // same song near its top (a start within TOPC_SEC) fits TOP_SHARE as well as the best place
  FRESH_SEC: 20,
  TOPC_SEC: 25,
  TOP_SEC: 45,           // "the music started recently" means within this long
  TOP_TOL: 3.0,          // seconds of slack around where the top should be
  TOP_MIN: 6,            // hashes needed at the top of the song
  TOP_SHARE: 0.35,       // ...and at least this share of the best place's hashes
  MID_AGREE_N: 3,        // looks that must agree before starting mid-song after a fresh start
  // ADDING UP THE EVIDENCE. One look that is only partly sure is thrown away by the rules above.
  // But in a car or a big echoey hall every look is partly sure, and ten of them quietly
  // agreeing on the same song AT THE SAME PLACE is proof: chance hits scatter across songs and
  // places, the real song keeps landing in one spot. So weak looks are kept and added up.
  ACC_FLOOR: 4,          // a look this weak still counts as evidence
  ACC_SEC: 15,           // evidence older than this is forgotten
  ACC_TOL: 0.6,          // looks agree when they put the song's start within this of each other
  ACC_VOTES: 30,         // this much agreeing evidence...
  ACC_LOOKS: 3,          // ...from at least this many looks...
  ACC_MARGIN: 2.0,       // ...and this many times more than any other song's best pile = it's this song
  SEARCH_AFTER: 10,      // music this long with no song up: search mode (and ask the words too)
  // SUNG WORDS (words()). The same thresholds as server.py consider_words().
  WORDS_SCORE: 26,       // lyricsearch score to name a song from words alone
  WORDS_GRAMS: 2,        // ...with at least this many of its 3-grams heard
  WORDS_ANCHOR: 12,      // a line of the song already up must score this to move its clock
  WORDS_OUT: 1.5,        // move the clock only if it is further than this outside the heard line
  WORDS_RECENT: 4,       // the heard line was sung within this long before the words arrived
  LINE_MAX: 8,           // a line lasts until the next cue, at most this long
  WORDS_POOL: 9,         // the words searched are the last this-many seconds of what was heard
  WORDS_AGREE: 3,        // a fingerprint candidate this close (s) to a words clock keeps the song up
};

export function createDecider(songs, opts) {
  const C = Object.assign({}, DEFAULTS, opts || {});
  const song = typeof songs === 'function' ? songs : id => songs[id];
  const S = {
    song_id: null,      // what is up
    started_at: null,   // clock time when position 0 happened
    driver: null,       // 'ear' | 'live' | 'words' | 'hand': who put this song up ('live' and
                        // 'words' = the clock is an estimate that sung words keep correcting)
    mode: 'timed',      // always 'timed'; 'words' (a static block at `anchor`) only for a song with no timings
    anchor: null,
    auto: true,         // let the listener take the screen when it is confident
    active: false,      // a listener is sending windows
    last_confirm: 0,    // when we last actually HEARD the song on screen
    on_track_at: 0,     // when a look last found us exactly where we think we are
    last_loud: -1e9,    // when the room last had music-level sound in it
    last_sound: -1e9,   // when the room last had sound clearly above its own floor
    floor: null,        // the room's own noise floor (mic RMS), learnt from quiet looks
    music_since: null,  // when the current stretch of music began (after a quiet gap)
    up_at: -1e9,        // when a song was last on screen
    last_match: null, conf: 0, conf_at: 0, rev: 0,
  };
  const PENDING = {song_id: null, started: null, at: 0, n: 0};
  const CHALLENGE = {song_id: null, started: null, n: 0, at: 0};
  let EVIDENCE = [];     // weak looks: {song_id, start, votes, at}
  let QUIET = [];        // recent quiet levels, for the floor
  const bump = () => { S.rev++; };
  const flag = (id, f) => ((song(id) || {}).flags || []).includes(f);

  function believable(m) {
    if (!m || !m.song_id || !song(m.song_id)) return false;
    if (m.votes >= C.STRONG_VOTES) return true;
    return m.votes >= C.MIN_VOTES && m.margin >= C.MIN_MARGIN;
  }
  // a live recording, or a song whose words have no timings yet, can't follow a clock
  const isLive = m => !!(m && (m.live || flag(m.song_id, 'untimed')));

  function take(id, started, now) {
    Object.assign(S, {song_id: id, started_at: started, last_confirm: now, on_track_at: now,
                      driver: 'ear', mode: 'timed', anchor: null});
    PENDING.song_id = null; bump();
  }
  function clear() {
    Object.assign(S, {song_id: null, started_at: null, driver: null, mode: 'timed', anchor: null});
    PENDING.song_id = null; bump();
  }

  /** A window is being sent. level = mic RMS; at = when the window ended. */
  function heard(level, at) {
    S.active = true;
    const thr = Math.max(C.START_MIN, C.START_RATIO * (S.floor || 0));
    if (level > thr) {
      if (at - S.last_sound > C.QUIET_GAP) S.music_since = at - 0.75;   // began since the last look
      S.last_sound = at;
    } else if (level < C.MUSIC_LEVEL) {        // a quiet look: it teaches the floor
      QUIET.push(level); if (QUIET.length > C.FLOOR_LOOKS) QUIET.shift();
      const q = QUIET.slice().sort((a, b) => a - b);
      S.floor = q[Math.floor(0.1 * (q.length - 1))];
    }
    if (level >= C.MUSIC_LEVEL) S.last_loud = at;
    if (S.song_id != null) S.up_at = at;
    // music has been going for a while and nothing is up: search mode
    S.searching = S.song_id == null && S.music_since != null && at - S.last_loud < 3 && at - S.music_since > C.SEARCH_AFTER;
  }

  /** The evidence piles: one song, one start time, several looks. The biggest, and the biggest
   *  of any other song. only = look at this song's piles alone. */
  function piles(only) {
    const pile = (id, st) => EVIDENCE.filter(e => e.song_id === id && Math.abs(e.start - st) <= C.ACC_TOL);
    let bestSum = 0, bestPile = null;
    for (const e of EVIDENCE) {
      if (only && e.song_id !== only) continue;
      const p = pile(e.song_id, e.start), sum = p.reduce((a, x) => a + x.votes, 0);
      if (sum > bestSum) { bestSum = sum; bestPile = p; }
    }
    if (!bestPile) return null;
    const winner = bestPile[0].song_id;
    let rival = 0;
    for (const e of EVIDENCE) if (e.song_id !== winner)
      rival = Math.max(rival, pile(e.song_id, e.start).reduce((a, x) => a + x.votes, 0));
    return {song_id: winner, pile: bestPile, votes: bestSum, rival, looks: new Set(bestPile.map(e => e.look)).size,
            start: bestPile.reduce((a, e) => a + e.start * e.votes, 0) / bestSum};      // vote-weighted start
  }

  /** Keep a weak look and see whether the pile for its song and place now proves it. */
  function accumulate(r, heardAt, win, now) {
    EVIDENCE = EVIDENCE.filter(e => now - e.at <= C.ACC_SEC);
    if (!r) return false;
    // every candidate of this look (the engine's dozen best places), not just its winner
    const cands = (r.cands && r.cands.length) ? r.cands : (r.song_id ? [r] : []);
    const seen = new Set();
    for (const c of cands) {
      if (!c.song_id || c.votes < C.ACC_FLOOR || c.live || flag(c.song_id, 'untimed')) continue;
      const start = heardAt - win - c.offset_sec, key = c.song_id + '@' + Math.round(start / C.ACC_TOL);
      if (seen.has(key)) continue;                  // the same place via two copies of one master counts once
      seen.add(key);
      // full: the whole window was music (a window straddling the music start sees too little of
      // the song to tell a phrase at the top from the same phrase repeated later)
      const full = S.music_since == null || heardAt - win >= S.music_since;
      EVIDENCE.push({song_id: c.song_id, start, votes: c.votes, at: now, look: heardAt, full});
    }
    const P = piles();
    S.acc = P && {song_id: P.song_id, votes: P.votes, looks: P.looks, rival: P.rival, start: P.start, at: now};
    if (!P) return false;
    const winner = P.song_id, mine = P.pile, sum = P.votes, looks = P.looks, rival = P.rival;
    if (sum < C.ACC_VOTES || looks < C.ACC_LOOKS || mine.length < C.ACC_LOOKS || sum < C.ACC_MARGIN * Math.max(rival, 1) || !S.auto) return false;
    // already up at this very place (a words estimate the fingerprints now confirm): hand it to the ear
    if (S.song_id === winner && S.started_at != null && Math.abs(S.started_at - P.start) < C.RESYNC_SEC) {
      Object.assign(S, {driver: 'ear', last_confirm: now, on_track_at: now}); EVIDENCE = []; bump();
      return false;
    }
    // START FROM THE TOP applies to added-up evidence too (it once locked 6.4 s ahead on a repeated
    // intro phrase): prefer this song's pile at its top when that fits TOP_SHARE as well, and don't
    // take a place away from the top on looks that didn't hear enough of the song to tell
    let st = P.start, how = `added up ${looks} looks`;
    if (S.song_id == null) {
      const ms = S.music_since, near = st0 => {
        const p = EVIDENCE.filter(e => e.song_id === winner && Math.abs(e.start - st0) <= C.ACC_TOL);
        return {votes: p.reduce((a, e) => a + e.votes, 0), start: p.length ? p.reduce((a, e) => a + e.start * e.votes, 0) / p.reduce((a, e) => a + e.votes, 0) : st0};
      };
      if (ms != null && heardAt - ms <= C.TOP_SEC && Math.abs(P.start - ms) > C.TOP_TOL) {
        // the song's top = it began with the music: the best pile within TOP_TOL of that
        let top = null;
        for (const e of EVIDENCE) if (e.song_id === winner && Math.abs(e.start - ms) <= C.TOP_TOL) {
          const n = near(e.start); if (!top || n.votes > top.votes) top = n;
        }
        if (top && top.votes >= C.TOP_SHARE * sum) { st = top.start; how += ', from the top'; }
        else if (new Set(mine.filter(e => e.full).map(e => e.look)).size < C.ACC_LOOKS) return false;   // wait for whole looks
      } else if ((ms == null || heardAt - ms > C.TOP_SEC) && now - S.up_at > C.FRESH_SEC) {
        // no music start to go by: the latest-starting pile of this song that could be its top
        let top = null;
        for (const e of EVIDENCE) if (e.song_id === winner && e.start > P.start + C.TOP_TOL && e.start >= heardAt - C.TOPC_SEC && e.start <= heardAt) {
          const n = near(e.start); if (n.votes >= C.TOP_SHARE * sum && (!top || n.start > top.start)) top = n;
        }
        if (top) { st = top.start; how += ', from the top'; }
      }
    }
    r = Object.assign({}, r, {song_id: winner, ref_id: (cands.find(c => c.song_id === winner) || {}).ref_id || r.ref_id});
    Object.assign(S, {song_id: r.song_id, started_at: st, paused_at: null, last_confirm: now, on_track_at: now,
                      driver: 'ear', mode: 'timed', anchor: null, searching: false});
    S.last_match = {song_id: r.song_id, offset: heardAt - win - st, votes: sum, margin: sum / Math.max(rival, 1),
                    at: heardAt, via: r.ref_id && r.ref_id.includes('::') ? r.ref_id : null, how};
    EVIDENCE = []; PENDING.song_id = null;
    return true;
  }

  /** What to ask the engine along with this window: {song_id, at, tol} or null. */
  function track(at, win) {
    if (S.driver !== 'ear' || !S.song_id || S.mode !== 'timed' || S.started_at == null) return null;
    return {song_id: S.song_id, at: at - win - S.started_at, tol: C.TRACK_TOL};
  }

  /** place_from_top()'s question for the engine: {at, tol} (lyric timeline), or null when the
   *  music has been going a while. */
  function top(at, win) {
    const ms = S.music_since;
    if (ms == null || at - ms > C.TOP_SEC) return null;
    return {at: (at - win) - ms + 1.0, tol: C.TOP_TOL};
  }

  /** server.py place_from_top(): prefer the top of the song over a later place that sounds
   *  the same, if the music started recently and this song isn't already up. */
  function placeFromTop(m, heardAt, win, now) {
    if (S.song_id === m.song_id) return m;
    const ms = S.music_since;
    if (ms != null && heardAt - ms <= C.TOP_SEC) {
      const exp = (heardAt - win) - ms;          // where this window starts if the song began with the music
      if (Math.abs(m.offset_sec - exp) <= C.TOP_TOL) return Object.assign({}, m, {top: true});
      if ((m.top_votes || 0) >= Math.max(C.TOP_MIN, C.TOP_SHARE * m.votes) && m.top_offset != null)
        return Object.assign({}, m, {offset_sec: m.top_offset, top: true, moved_from: m.offset_sec});
      return Object.assign({}, m, {top: false});
    }
    // no music start to go by (it crept in, or the level never said so): nothing is up and nothing
    // was lately, so a song being found now most likely began lately, at its top. The earliest
    // place of this song among the look's candidates that could be the top, if it fits well enough.
    if (S.song_id == null && now - S.up_at > C.FRESH_SEC && m.cands) {
      let best = null;
      for (const c of m.cands)
        if (c.song_id === m.song_id && !c.live && c.offset_sec >= -win && c.offset_sec <= C.TOPC_SEC - win &&
            c.offset_sec < m.offset_sec - C.TOP_TOL && c.votes >= C.TOP_SHARE * m.votes && (!best || c.offset_sec < best.offset_sec)) best = c;
      if (best) return Object.assign({}, m, {offset_sec: best.offset_sec, top: true, moved_from: m.offset_sec});
    }
    return m;
  }

  /** server.py consider(): act on a fingerprint match. True if the screen changed. */
  function consider(m, heardAt, win, now) {
    if (!believable(m)) return false;
    // offset_sec is where the WINDOW STARTS inside the recording, and the window ended at heardAt
    const started = heardAt - (m.offset_sec + win);
    // already locked on this song and still in step: note that we can still hear it
    if (S.song_id === m.song_id && S.started_at != null && Math.abs(S.started_at - started) < C.RESYNC_SEC) {
      S.last_confirm = now; PENDING.song_id = null;
      // an estimated clock (words, a live recording) that a studio recording now confirms: the ear has it
      if (S.driver === 'words' || S.driver === 'live') { Object.assign(S, {driver: 'ear', on_track_at: now}); bump(); }
      return false;
    }
    // something is up and was on track recently: a different song, or a different place in
    // this song (the other chorus), has to keep saying so, window after window
    if (S.song_id != null && S.driver === 'ear' && now - S.on_track_at < C.CHALLENGE_WITHIN) {
      const fresh = now - CHALLENGE.at < C.CHALLENGE_GAP;
      if (fresh && CHALLENGE.song_id === m.song_id && Math.abs(CHALLENGE.started - started) < C.AGREE_SEC)
        Object.assign(CHALLENGE, {n: CHALLENGE.n + 1, at: now, started: (CHALLENGE.started + started) / 2});
      else Object.assign(CHALLENGE, {song_id: m.song_id, started, n: 1, at: now});
      if (CHALLENGE.n >= C.CHALLENGE_N && now - S.on_track_at >= C.OFF_TRACK_SEC && S.auto) {
        take(m.song_id, CHALLENGE.started, now);
        CHALLENGE.song_id = null; CHALLENGE.n = 0;
        return true;
      }
      return false;
    }
    // the music just started but this isn't the top of the song: possible (they started at a
    // later section) but unusual, so it has to keep saying so, look after look
    if (m.top === false) {
      if (now - PENDING.at < C.CANDIDATE_TTL && PENDING.song_id === m.song_id &&
          Math.abs(PENDING.started - started) < C.AGREE_SEC) {
        PENDING.n++; PENDING.at = now;
        if (PENDING.n >= C.MID_AGREE_N && S.auto) {
          const st = (started + PENDING.started) / 2;
          PENDING.n = 0;
          take(m.song_id, st, now);
          return true;
        }
        return false;
      }
      Object.assign(PENDING, {song_id: m.song_id, started, at: now, n: 1});
      return false;
    }
    // a very strong match needs no second opinion
    if (m.votes >= C.LOCK_VOTES && m.margin >= C.LOCK_MARGIN && S.auto) { take(m.song_id, started, now); return true; }
    // does this confirm what we saw last time?
    if (now - PENDING.at < C.CANDIDATE_TTL && PENDING.song_id === m.song_id &&
        Math.abs(PENDING.started - started) < C.AGREE_SEC) {
      PENDING.song_id = null;
      if (!S.auto) return false;
      take(m.song_id, (started + PENDING.started) / 2, now);
      return true;
    }
    Object.assign(PENDING, {song_id: m.song_id, started, at: now, n: 1});
    return false;
  }

  const isSec = c => !!(c.s || c.section);
  // a song whose lines carry timings can run a clock; one with none can only be shown as a block
  const hasTimes = s => !flag(s.id, 'untimed') && (s.cues || []).some(c => !isSec(c) && c.t != null);
  /** Half of line k: the time to the next cue, capped at LINE_MAX. Mid-line is the best guess of
   *  where the singing is when a line has just been recognised. */
  function half(s, k) {
    const c = s.cues;
    for (let j = k + 1; j < c.length; j++) if (c[j].t != null && c[j].t > c[k].t) return Math.min(C.LINE_MAX, c[j].t - c[k].t) / 2;
    return C.LINE_MAX / 2;
  }
  /** How far (s) the song position `pos` is outside line k, allowing the line to have been sung
   *  up to `recent` seconds ago. 0 = the clock agrees with the words. */
  function outside(s, k, pos, recent) {
    const t = s.cues[k].t, end = t + 2 * half(s, k);
    return Math.max(0, t - pos, pos - (end + recent));
  }
  /** Every copy of line k (a repeated chorus line), as cue indexes. */
  const copies = (s, k) => s.cues.map((c, j) => j).filter(j => !isSec(s.cues[j]) && s.cues[j].t != null && s.cues[j].text === s.cues[k].text);

  /** server.py consider_live(): a live recording (or a different arrangement) was recognised.
   *  Its timing differs from the studio clock the cues were written to, so the clock starts
   *  from its offset mapped onto the lyric timeline, and sung words correct it from there. */
  function considerLive(m, heardAt, win, now) {
    if (!believable(m) || m.votes < C.LIVE_VOTES) return false;
    const sid = m.song_id, s = song(sid);
    // already up: hearing it again keeps it up, but never moves the clock (only words do)
    if ((S.driver === 'live' || S.driver === 'words') && S.song_id === sid) { S.last_confirm = now; return false; }
    const dur = s.duration || 0, rdur = m.duration || dur || 1, k = dur ? dur / rdur : 1;
    PENDING.song_id = null;
    if (!hasTimes(s)) {                  // no timings: the one case left for a block of words
      const cues = s.cues || [], tEst = m.offset_sec * k;
      let anchor = 0;
      for (let j = 0; j < cues.length; j++) if (!isSec(cues[j])) { anchor = j; break; }
      cues.forEach((c, j) => { if (!isSec(c) && c.t != null && c.t <= tEst) anchor = j; });
      Object.assign(S, {song_id: sid, started_at: null, driver: 'live', mode: 'words', anchor, last_confirm: now});
    } else {
      Object.assign(S, {song_id: sid, started_at: heardAt - (m.offset_sec + win) * k, paused_at: null, driver: 'live',
                        mode: 'timed', anchor: null, last_confirm: now, on_track_at: now});
    }
    bump();
    return true;
  }

  /** Sung or spoken words (asr_job() / consider_words()). text = the last ~9 s of what was heard,
   *  recent = the last few seconds of it (which line is being sung NOW), at = when they were heard,
   *  ix = a lyricsearch.js index. True if the screen changed. */
  function words(text, recent, at, now, ix) {
    if (!ix || !text) return false;
    if (S.song_id == null) {               // the 'thinking' glow: how close the words are to a song
      const pk = ix.peek(text);
      if (pk > 0) { S.conf = Math.max(now - S.conf_at < 3 ? S.conf : 0, 0.9 * pk); S.conf_at = now; }
    }
    if (S.driver === 'hand' || (S.driver === 'ear' && S.song_id != null)) return false;   // a real track is up: leave it
    // a song is up on an estimated clock: where in THIS song are they singing?
    if (S.song_id != null) {
      const s = song(S.song_id), L = ix.song_lines(recent || text, S.song_id);
      if (L.length && L[0].score >= C.WORDS_ANCHOR) {
        S.last_confirm = now;
        if (S.started_at == null) {        // a block (no timings): move its highlight
          if (S.anchor !== L[0].cue) { S.anchor = L[0].cue; bump(); return true; }
          return false;
        }
        // the lines that fit about as well as the best (a repeated chorus is several): the copy nearest the clock
        const pos = at - S.started_at;
        let best = null;
        for (const x of L) if (x.score >= 0.9 * L[0].score && s.cues[x.cue].t != null) {
          const d = outside(s, x.cue, pos, C.WORDS_RECENT);
          if (!best || d < best.d) best = {cue: x.cue, d};
        }
        if (!best || best.d <= C.WORDS_OUT) return false;
        S.started_at = at - (s.cues[best.cue].t + half(s, best.cue));
        S.last_words = {cue: best.cue, at, moved: true};
        bump();
        return true;
      }
      if (S.driver === 'live') return false;      // the recording named this song; words alone don't overrule it
    }
    const r = ix.search(text, C.WORDS_SCORE, C.WORDS_GRAMS);
    if (!r || !song(r.song_id) || r.song_id === S.song_id || !S.auto) return false;
    const s = song(r.song_id);
    PENDING.song_id = null;
    S.last_match = {song_id: r.song_id, offset: null, votes: 0, margin: r.margin, at, via: null,
                    how: 'from the sung words', line: r.line, score: r.score};
    if (!hasTimes(s) || s.cues[r.cue].t == null) {   // no timings: the one case left for a block of words
      Object.assign(S, {song_id: r.song_id, started_at: null, paused_at: null, driver: 'words', mode: 'words',
                        anchor: r.cue, last_confirm: now, searching: false});
      bump(); return true;
    }
    // which line is being sung right now: the newest words, if they name a line of this song
    let cue = r.cue;
    const L = recent ? ix.song_lines(recent, r.song_id) : [];
    if (L.length && L[0].score >= C.WORDS_ANCHOR && s.cues[L[0].cue].t != null) cue = L[0].cue;
    let started = at - (s.cues[cue].t + half(s, cue)), driver = 'words';
    // cross-check with the fingerprints: a pile of evidence for this song, from 2+ looks, that puts
    // the song at this line: its clock is measured, not estimated, so take it
    const P = piles(r.song_id);
    if (P && P.looks >= 2 && P.votes >= 2 * C.ACC_FLOOR &&
        copies(s, r.cue).some(j => outside(s, j, at - P.start, C.WORDS_POOL) <= C.WORDS_OUT)) {
      started = P.start; driver = 'ear'; S.last_match.how = `sung words + ${P.looks} looks agree`;
    }
    Object.assign(S, {song_id: r.song_id, started_at: started, paused_at: null, driver, mode: 'timed', anchor: null,
                      last_confirm: now, on_track_at: now, searching: false});
    S.last_words = {cue, at, moved: false};
    if (driver === 'ear') EVIDENCE = [];
    bump();
    return true;
  }

  /** The engine's answer for a window that ended at heardAt (the /hear handler). */
  function result(r, heardAt, win, now) {
    let m = r && r.song_id && r.votes >= C.MIN_VOTES ? r : null;
    if (m && !isLive(m)) m = placeFromTop(m, heardAt, win, now);
    const liveHit = !!(m && isLive(m) && believable(m));
    let conf = 0;
    if (m) conf = Math.min(1, m.votes / 30) * (believable(m) ? 0.85 : 0.55);
    if (PENDING.song_id) conf = Math.max(conf, 0.7);
    S.conf = S.song_id == null ? Math.max(conf, now - S.conf_at < 3 ? S.conf * 0.8 : conf) : 0;
    S.conf_at = now;
    const onTrack = r != null && r.track_votes != null && r.track_votes >= C.TRACK_MIN;
    let changed = false;
    if (liveHit && !onTrack) changed = considerLive(m, heardAt, win, now);
    if (m) S.last_match = {song_id: m.song_id, offset: m.offset_sec, votes: m.votes, margin: m.margin, at: heardAt,
                           via: m.ref_id && m.ref_id.includes('::') ? m.ref_id : null,
                           top: m.top, moved_from: m.moved_from};
    if (onTrack) {
      // still exactly where we think we are: that is all we need to know
      S.last_confirm = S.on_track_at = now;
      CHALLENGE.song_id = null; CHALLENGE.n = 0; PENDING.song_id = null;
    } else if (!liveHit) changed = consider(m, heardAt, win, now);
    // an estimated clock (words): a fingerprint candidate of this song at this place keeps it up
    if (S.driver === 'words' && S.started_at != null && r && r.cands)
      for (const c of r.cands) if (c.song_id === S.song_id && !c.live && c.votes >= C.ACC_FLOOR &&
                                   Math.abs(heardAt - win - c.offset_sec - S.started_at) <= C.WORDS_AGREE) { S.last_confirm = now; break; }
    // weak evidence keeps adding up while nothing is up, or while the clock is only an estimate
    const estimated = S.driver === 'words' || S.driver === 'live';
    if (!changed && (S.song_id == null || estimated)) changed = accumulate(r, heardAt, win, now);
    else if (S.song_id != null && !estimated) EVIDENCE = [];
    bump();
    return changed;
  }

  /** server.py maybe_release(): a song the room no longer has must come off. True if released. */
  function tick(now) {
    if (!['ear', 'live', 'words'].includes(S.driver) || S.song_id == null) return false;
    const dur = (song(S.song_id) || {}).duration || 0;
    if (S.started_at != null && dur && now - S.started_at > dur + C.END_GRACE) { clear(); return true; }
    if (!S.active) return false;
    // a pause, a quiet bridge or an a cappella moment is silence, not a different song. (Sound means
    // music-level OR clearly above the room's floor: a soft song is not silence.)
    const lastHeard = Math.max(S.last_loud, S.last_sound), musicNow = now - lastHeard < 3.0;
    if (musicNow && now - Math.max(S.last_confirm, S.music_since) < C.LOUD_MISS_SEC) return false;
    if (!musicNow && now - lastHeard < C.SILENCE_SEC) return false;
    clear();
    return true;
  }

  /** Put a song up by hand (demo / operator). driver 'hand' is never released automatically. */
  function hold(fields, now) {
    Object.assign(S, {driver: 'hand', mode: 'timed', anchor: null, started_at: null}, fields,
                  {last_confirm: now, on_track_at: now});
    PENDING.song_id = null; CHALLENGE.song_id = null; CHALLENGE.n = 0; bump();
  }

  /** Should the device be listening for sung words? While searching (music, nothing up), and
   *  while the song up has only an estimated clock (words, a live recording) that words correct.
   *  Never while a fingerprint clock or a hand-held song is up. */
  const wantWords = () => S.song_id == null ? !!S.searching : (S.driver === 'words' || S.driver === 'live');

  return {state: S, config: C, heard, track, top, result, tick, hold, words, wantWords, stop: clear, believable,
          listening: on => { S.active = !!on; }};
}
