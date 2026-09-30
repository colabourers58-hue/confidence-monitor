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
 * Not ported: lyric search from sung words (driver 'words'); there is no speech model on the
 * device, so a live recording is shown as a block at the line its offset suggests.
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
  QUIET_GAP: 4.0,        // this much quiet before loud sound = the music (re)started
  TOP_SEC: 45,           // "the music started recently" means within this long
  TOP_TOL: 3.0,          // seconds of slack around where the top should be
  TOP_MIN: 6,            // hashes needed at the top of the song
  TOP_SHARE: 0.35,       // ...and at least this share of the best place's hashes
  MID_AGREE_N: 3,        // looks that must agree before starting mid-song after a fresh start
};

export function createDecider(songs, opts) {
  const C = Object.assign({}, DEFAULTS, opts || {});
  const song = typeof songs === 'function' ? songs : id => songs[id];
  const S = {
    song_id: null,      // what is up
    started_at: null,   // clock time when position 0 happened
    driver: null,       // 'ear' | 'live' | 'hand': who put this song up
    mode: 'timed',      // 'timed' follows the clock; 'words' is a static block at `anchor`
    anchor: null,
    auto: true,         // let the listener take the screen when it is confident
    active: false,      // a listener is sending windows
    last_confirm: 0,    // when we last actually HEARD the song on screen
    on_track_at: 0,     // when a look last found us exactly where we think we are
    last_loud: 0,       // when the room last had music-level sound in it
    music_since: 0,     // when the current stretch of music began (after a quiet gap)
    last_match: null, conf: 0, conf_at: 0, rev: 0,
  };
  const PENDING = {song_id: null, started: null, at: 0, n: 0};
  const CHALLENGE = {song_id: null, started: null, n: 0, at: 0};
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
    if (level >= C.MUSIC_LEVEL) {
      if (at - S.last_loud > C.QUIET_GAP) S.music_since = at - 0.75;   // began since the last look
      S.last_loud = at;
    }
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
    if (!ms || at - ms > C.TOP_SEC) return null;
    return {at: (at - win) - ms + 1.0, tol: C.TOP_TOL};
  }

  /** server.py place_from_top(): prefer the top of the song over a later place that sounds
   *  the same, if the music started recently and this song isn't already up. */
  function placeFromTop(m, heardAt, win) {
    const ms = S.music_since;
    if (S.song_id === m.song_id || !ms || heardAt - ms > C.TOP_SEC) return m;
    const exp = (heardAt - win) - ms;          // where this window starts if the song began with the music
    if (Math.abs(m.offset_sec - exp) <= C.TOP_TOL) return Object.assign({}, m, {top: true});
    if ((m.top_votes || 0) >= Math.max(C.TOP_MIN, C.TOP_SHARE * m.votes) && m.top_offset != null)
      return Object.assign({}, m, {offset_sec: m.top_offset, top: true, moved_from: m.offset_sec});
    return Object.assign({}, m, {top: false});
  }

  /** server.py consider(): act on a fingerprint match. True if the screen changed. */
  function consider(m, heardAt, win, now) {
    if (!believable(m)) return false;
    // offset_sec is where the WINDOW STARTS inside the recording, and the window ended at heardAt
    const started = heardAt - (m.offset_sec + win);
    // already locked on this song and still in step: note that we can still hear it
    if (S.song_id === m.song_id && S.started_at != null && Math.abs(S.started_at - started) < C.RESYNC_SEC) {
      S.last_confirm = now; PENDING.song_id = null;
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

  /** server.py consider_live() with no words: show the song as a block at the line its
   *  offset suggests (live timing differs from the studio clock the cues were written to). */
  function considerLive(m, now) {
    if (!believable(m) || m.votes < C.LIVE_VOTES) return false;
    const sid = m.song_id, s = song(sid);
    if (S.driver === 'live' && S.song_id === sid) { S.last_confirm = now; return false; }
    const cues = s.cues || [], isSec = c => !!(c.s || c.section);
    const dur = s.duration || 0, rdur = m.duration || dur || 1;
    const tEst = m.offset_sec * (dur ? dur / rdur : 1);
    let anchor = 0;
    for (let k = 0; k < cues.length; k++) if (!isSec(cues[k])) { anchor = k; break; }
    cues.forEach((c, k) => { if (!isSec(c) && c.t != null && c.t <= tEst) anchor = k; });
    PENDING.song_id = null;
    Object.assign(S, {song_id: sid, started_at: null, driver: 'live', mode: 'words', anchor, last_confirm: now});
    bump();
    return true;
  }

  /** The engine's answer for a window that ended at heardAt (the /hear handler). */
  function result(r, heardAt, win, now) {
    let m = r && r.song_id && r.votes >= C.MIN_VOTES ? r : null;
    if (m && !isLive(m)) m = placeFromTop(m, heardAt, win);
    const liveHit = !!(m && isLive(m) && believable(m));
    let conf = 0;
    if (m) conf = Math.min(1, m.votes / 30) * (believable(m) ? 0.85 : 0.55);
    if (PENDING.song_id) conf = Math.max(conf, 0.7);
    S.conf = S.song_id == null ? Math.max(conf, now - S.conf_at < 3 ? S.conf * 0.8 : conf) : 0;
    S.conf_at = now;
    const onTrack = r != null && r.track_votes != null && r.track_votes >= C.TRACK_MIN;
    let changed = false;
    if (liveHit && !onTrack) changed = considerLive(m, now);
    if (m) S.last_match = {song_id: m.song_id, offset: m.offset_sec, votes: m.votes, margin: m.margin, at: heardAt,
                           via: m.ref_id && m.ref_id.includes('::') ? m.ref_id : null,
                           top: m.top, moved_from: m.moved_from};
    if (onTrack) {
      // still exactly where we think we are: that is all we need to know
      S.last_confirm = S.on_track_at = now;
      CHALLENGE.song_id = null; CHALLENGE.n = 0; PENDING.song_id = null;
    } else if (!liveHit) changed = consider(m, heardAt, win, now);
    bump();
    return changed;
  }

  /** server.py maybe_release(): a song the room no longer has must come off. True if released. */
  function tick(now) {
    if (!['ear', 'live'].includes(S.driver) || S.song_id == null) return false;
    const dur = (song(S.song_id) || {}).duration || 0;
    if (S.started_at != null && dur && now - S.started_at > dur + C.END_GRACE) { clear(); return true; }
    if (!S.active) return false;
    // a pause, a quiet bridge or an a cappella moment is silence, not a different song
    const musicNow = now - S.last_loud < 3.0;
    if (musicNow && now - Math.max(S.last_confirm, S.music_since) < C.LOUD_MISS_SEC) return false;
    if (!musicNow && now - S.last_loud < C.SILENCE_SEC) return false;
    clear();
    return true;
  }

  /** Put a song up by hand (demo / operator). driver 'hand' is never released automatically. */
  function hold(fields, now) {
    Object.assign(S, {driver: 'hand', mode: 'timed', anchor: null, started_at: null}, fields,
                  {last_confirm: now, on_track_at: now});
    PENDING.song_id = null; CHALLENGE.song_id = null; CHALLENGE.n = 0; bump();
  }

  return {state: S, config: C, heard, track, top, result, tick, hold, stop: clear, believable,
          listening: on => { S.active = !!on; }};
}
