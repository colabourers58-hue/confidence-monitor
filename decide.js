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
  LOUD_MISS_SEC: 20,     // split the difference (1 Oct): 10 dropped right songs, 45 was too stubborn for real song changes
  SWITCH_MISS_SEC: 4,    // ...and only 4 (Joel: a song change is an emergency, ~5 s) if a DIFFERENT song is already building up evidence meanwhile
  LOUD_MISS_OLD: 45,     // (1 Oct: 10 dropped RIGHT songs when singing drowned the track and the orb kept coming back; Joel: roll with the timecode. A different song still takes over as soon as it's clearly heard) music playing, yet this song unconfirmed this long: something else is on (a new song takes over sooner, as soon as it is recognised)
  // ALWAYS VERIFYING. While a song is up, every look checks it is still this song at this place.
  // When that stops holding while music plays, the app is in DOUBT: the corner orb grows so the
  // stage can see it's working it out, and it hunts for the new song at once (adding up evidence).
  DOUBT_LOOKS: 2,        // (was 3) this many looks in a row off track, with music playing = doubt (about 2 s)
  SILENCE_SEC: 30,       // the room has been quiet this long: the music has stopped
  END_GRACE: 2.5,        // past the song's end by this much: let it go
  TRACK_TOL: 0.6,        // seconds either side of where we expect to be
  TRACK_MIN: 5,          // hashes at the expected place = still on track
  TRACK_RECENT_MIN: 1,   // ...of which at least this many from the window's last 2 s
  CHALLENGE_N: 3,        // agreeing windows needed to move to another place in THIS song (the other chorus)
  OFF_TRACK_SEC: 2.5,    // and the current place must have gone unheard this long
  CHALLENGE_SONG_N: 3,   // (2 flipped between wrong songs on an unknown song) a DIFFERENT song needs fewer (Joel: songs change on a whim; a minute is unacceptable)
  OFF_TRACK_SONG_SEC: 1.5,
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
  TOP_LOCK_VOTES: 14,    // at the top of a song just after the music started, one look this clear...
  TOP_LOCK_MARGIN: 1.8,  // ...and this far ahead of any other song locks at once
  // ADDING UP THE EVIDENCE. One look that is only partly sure is thrown away by the rules above.
  // But in a car or a big echoey hall every look is partly sure, and ten of them quietly
  // agreeing on the same song AT THE SAME PLACE is proof: chance hits scatter across songs and
  // places, the real song keeps landing in one spot. So weak looks are kept and added up.
  ACC_FLOOR: 4,          // a look this weak still counts as evidence
  ACC_SEC: 15,           // evidence older than this is forgotten
  ACC_TOL: 0.6,          // looks agree when they put the song's start within this of each other
  ACC_VOTES: 30,         // this much agreeing evidence...
  ACC_STRONG: 8,         // ...with at least one look this strong on its own (0 = off): unknown songs 2 -> 0 wrong of 43, same speed (30 Sep)
  ACC_LOOKS: 3,          // ...from at least this many looks...
  ACC_MARGIN: 2.0,       // ...and this many times more than any other song's best pile = it's this song
  SEARCH_AFTER: 4,       // (was 10) music this long with no song up: search mode (and ask the words too)
  // SUNG WORDS (words()). The same thresholds as server.py consider_words().
  WORDS_SCORE: 26,       // lyricsearch score to name a song from words alone
  WORDS_GRAMS: 2,        // ...with at least this many of its 3-grams heard
  WORDS_GRAMS_ALONE: 3,  // ...3 when no fingerprint evidence agrees ('I wish you were the best' x2 put I Wish up)
  WORDS_ANCHOR: 12,      // a line of the song already up must score this to move its clock
  WORDS_OUT: 1.5,        // move the clock only if it is further than this outside the heard line
  WORDS_RECENT: 4,       // the heard line was sung within this long before the words arrived
  LINE_MAX: 8,           // a line lasts until the next cue, at most this long
  WORDS_POOL: 9,         // the words searched are the last this-many seconds of what was heard
  WORDS_CONFIRM: 2,      // words alone must name the same song twice, at least this far apart...
  WORDS_CONFIRM_SEC: 20, // ...within this long (a harsh room makes speech recognition invent lines)
  WORDS_AGREE: 3,        // a fingerprint candidate this close (s) to a words clock keeps the song up
  // MENTIONED (titles(), and words() with no music). Joel: "all it should take for a song to be pulled
  // up is for the song to be mentioned: the title or lines from the song". A mentioned song goes up
  // HELD (S.cue, the clock stopped) while nothing else is up: a title at the song's top, a quoted
  // line at that line. The music then starts it (its fingerprints get a head start: PRIOR_*), or the
  // singing does (a later line of it heard), or another song clearly recognised replaces it.
  CUE_SEC: 180,          // a song called by its title waits this long for its music (from the last mention)
  HOLD_SEC: 60,          // a quoted line with nothing after it is held this long
  CANCEL_SEC: 15,        // held and the talking goes on (words that aren't this song) this long: let it go (0 = never)
  WORDS_ONCE: true,      // words alone: one sighting of a line is enough (else it must be seen twice, WORDS_CONFIRM)...
  WORDS_FRESH: 10,       // ...if this much of its evidence is not everyday preaching (lyricsearch fresh)
  PREACHED_GAP: 10,      // a line made of preached phrases must be heard again this long after (a new utterance)...
  PREACHED_WITHIN: 40,   // ...within this long
  TITLE_ANY_MIN: 99,     // a title of this many words or more pulls its song up even if it is a common phrase
  LINE_ALONE: 15,        // a words-only song with no further line and no music this long was a quote: hold its line
  CONTINUE_SEC: 30,      // "singing on" = a line up to this far (song time) after the one held
  MENTION_AGAIN: 60,     // a common title (3+ words) said twice within this long counts as meant
  MENTION_GAP: 10,       // a sighting this long after the last one is a new mention (the words pool lasts ~9 s)
  TITLE_EVIDENCE: 8,     // a common title: fingerprint evidence for that song this strong confirms it
  MUSIC_VOTES: 8,        // a look whose best match has this many votes = recorded music is playing...
  MUSIC_RECENT: 8,       // ...if within this long. Level alone can't tell a preacher from a band.
  PRIOR_VOTES: 8,        // the song held by name: one look this strong at its top starts it (others need 14)
  PRIOR_MARGIN: 1.2,     // ...this far ahead of every other song in that look
  PRIOR_ACC_VOTES: 16,   // added-up evidence for the held song: this much (others need 30)...
  PRIOR_ACC_LOOKS: 2,    // ...from this many looks (others 3)...
  PRIOR_ACC_MARGIN: 1.3, // ...and this far ahead of any other song's pile (others 2)
  // ROOM MEMORY (learn()). A look heard confidently on track is "how this song sounds in this room";
  // the engine stores its hashes so the song is found faster next time. Only from fingerprint locks
  // that have been proven for a while, never from a guess: a wrong lesson would make it worse.
  LEARN_VOTES: null,     // track hashes a look needs to be learnt from (null = 2 x TRACK_MIN)
  LEARN_LOOKS: 3,        // ...after this many looks in a row on track
  LEARN_AFTER: 6,        // ...and this long (s) after the fingerprints took the song
  // KEY CHANGES. Worship teams often play the backing track 1-3 semitones up or down. Every look is
  // asked at the song's key (0 until a song is up); when music has played KEY_AFTER s with nothing
  // up, other keys are tried too (from the same look's peaks). A song found at key k is locked AT k:
  // its tracking, doubt checks and room memory all use k. In doubt, 0 and k's neighbours are tried
  // (a song that modulates up for its last chorus).
  KEYS: [1, -1, 2, -2, 3, -3],   // the app turns these OFF (app.js createDecider opts) until measured on unknown songs
  KEY_AFTER: 2,
  KEY_STRICT: 1.5,       // a transposed answer needs this many times the votes an untransposed one does
  KEY_MARGIN: 1.6,       // ...and one look's transposed answer this margin over the next song
};

export function createDecider(songs, opts) {
  const C = Object.assign({}, DEFAULTS, opts || {});
  // songs whose backing track is one loop, the same chords start to finish (app/loopness.py, data/loops.json):
  // the music can say WHICH song but never WHERE. They start at the top when the beat comes in after quiet,
  // the music never moves the place, and only the singing moves the line (Joel, 30 Sep: Loyalty and Disloyalty)
  const LOOP = new Set(C.LOOPS || []);
  // versions of one song (God Did Not Condemn the World at 75 / 76 / 78 BPM): one family. Once one is up the app
  // never jumps to another version mid-song, and a fresh pick leans to the preferred one (Joel, 2 Oct: v23 = the 76)
  const FAMILY = {goddidnotcondemntheworld: 'gdnc', goddidnotcondemntheworld76: 'gdnc', goddidnotcondemntheworld78: 'gdnc'};
  const PREFER = {gdnc: 'goddidnotcondemntheworld76'};
  const fam = id => FAMILY[id] || id;
  const sameFam = (a, b) => a != null && b != null && fam(a) === fam(b);
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
    ear_at: null,       // when the fingerprints took (or confirmed) the song up; null = not theirs
    key: 0,             // semitones the room is from the recording, for the song up
    key_turn: 0,        // where the rotation through other keys is
    on_looks: 0,        // looks in a row that found us exactly on track
    last_match: null, conf: 0, conf_at: 0, rev: 0,
    cue: null,          // a MENTIONED song, held with its clock stopped while nothing is up:
                        // {song_id, kind: 'title'|'line', cue (line index or null), pos (song time shown), at, last, name, how}
    music_at: -1e9,     // when a look last heard recorded music (MUSIC_VOTES)
  };
  const PENDING = {song_id: null, started: null, at: 0, n: 0};
  const PRIOR = {started: null, at: -1e9, n: 0};   // the held song's own agreeing looks
  const MENT = new Map();                          // title key -> {occ, last, times}: when it was said
  const CHALLENGE = {song_id: null, started: null, n: 0, at: 0};
  let EVIDENCE = [];     // weak looks: {song_id, start, votes, at}
  let QUIET = [];        // recent quiet levels, for the floor
  let WORDS1 = {song_id: null, at: -1e9};   // the first hearing of a song from words alone
  const bump = () => { S.rev++; };
  const flag = (id, f) => ((song(id) || {}).flags || []).includes(f);

  function believable(m) {
    if (!m || !m.song_id || !song(m.song_id)) return false;
    if (m.votes >= C.STRONG_VOTES) return true;
    return m.votes >= C.MIN_VOTES && m.margin >= C.MIN_MARGIN;
  }
  // a live recording, or a song whose words have no timings yet, can't follow a clock
  const isLive = m => !!(m && (m.live || flag(m.song_id, 'untimed')));

  function take(id, started, now, key) {
    if (PREFER[fam(id)] && id !== PREFER[fam(id)] && song(PREFER[fam(id)])) {
      const to = PREFER[fam(id)], a = song(id), b = song(to);
      if (a && b && a.duration && b.duration && started != null) started = now - (now - started) * (b.duration / a.duration);
      id = to;
    }
    const loop = LOOP.has(id);
    if (loop && S.music_since != null && S.music_real && now - S.music_since <= C.TOP_SEC) started = S.music_since;
    Object.assign(S, {song_id: id, started_at: started, last_confirm: now, on_track_at: now, taken_at: now,
                      driver: loop ? 'live' : 'ear', mode: 'timed', anchor: null, ear_at: now, on_looks: 0, key: key || 0, cue: null});
    PENDING.song_id = null; bump();
  }
  function clear() {
    Object.assign(S, {song_id: null, started_at: null, taken_at: null, driver: null, mode: 'timed', anchor: null, ear_at: null, on_looks: 0, key: 0});
    PENDING.song_id = null; bump();
  }

  /** A window is being sent. level = mic RMS; at = when the window ended. */
  function heard(level, at) {
    S.active = true;
    const thr = Math.max(C.START_MIN, C.START_RATIO * (S.floor || 0));
    if (level > thr) {
      if (at - S.last_sound > C.QUIET_GAP){ S.music_since = at - 0.75;   // began since the last look
        S.music_real = !!S.quiet_heard; }                              // a real start: we heard the quiet before it

      S.last_sound = at;
    } else if (level < C.MUSIC_LEVEL) {        // a quiet look: it teaches the floor
      S.quiet_heard = true;
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
  function piles(only, keys) {
    // a pile = one song, at one key, at one start time. keys: undefined = any key; 0 = the recording's
    // own key only (its rival too: other keys' chance piles never compete with it, so trying other
    // keys costs a normal song nothing); 'other' = transposed piles only (their rival: any key)
    const pile = (id, st, k) => EVIDENCE.filter(e => e.song_id === id && (e.key || 0) === (k || 0) && Math.abs(e.start - st) <= C.ACC_TOL);
    const inK = e => keys === undefined || (keys === 0 ? !(e.key || 0) : !!(e.key || 0));
    let bestSum = 0, bestPile = null;
    for (const e of EVIDENCE) {
      if (only && e.song_id !== only) continue;
      if (!inK(e)) continue;
      const p = pile(e.song_id, e.start, e.key), sum = p.reduce((a, x) => a + x.votes, 0);
      if (sum > bestSum) { bestSum = sum; bestPile = p; }
    }
    if (!bestPile) return null;
    const winner = bestPile[0].song_id;
    let rival = 0;
    for (const e of EVIDENCE) if (e.song_id !== winner && (keys !== 0 || !(e.key || 0)))
      rival = Math.max(rival, pile(e.song_id, e.start, e.key).reduce((a, x) => a + x.votes, 0));
    return {song_id: winner, key: bestPile[0].key || 0, pile: bestPile, votes: bestSum, rival, looks: new Set(bestPile.map(e => e.look)).size,
            start: bestPile.reduce((a, e) => a + e.start * e.votes, 0) / bestSum};      // vote-weighted start
  }

  /** Keep a weak look and see whether the pile for its song and place now proves it. */
  function accumulate(r, heardAt, win, now) {
    EVIDENCE = EVIDENCE.filter(e => now - e.at <= C.ACC_SEC);
    if (!r) return false;
    // every candidate of this look (the engine's dozen best places), not just its winner, at every
    // key the look was asked at
    const candsOf = x => ((x.cands && x.cands.length) ? x.cands : (x.song_id ? [x] : [])).map(c => Object.assign({}, c, {key: x.key || 0}));
    const cands = [r, ...(r.alts || [])].flatMap(candsOf);
    const seen = new Set();
    for (const c of cands) {
      if (!c.song_id || c.votes < C.ACC_FLOOR || c.live || flag(c.song_id, 'untimed')) continue;
      const start = heardAt - win - c.offset_sec, key = c.song_id + '@' + Math.round(start / C.ACC_TOL) + '#' + c.key;
      if (seen.has(key)) continue;                  // the same place via two copies of one master counts once
      seen.add(key);
      // full: the whole window was music (a window straddling the music start sees too little of
      // the song to tell a phrase at the top from the same phrase repeated later)
      const full = S.music_since == null || heardAt - win >= S.music_since;
      EVIDENCE.push({song_id: c.song_id, key: c.key, start, votes: c.votes, at: now, look: heardAt, full});
    }
    // the recording's own key first, judged exactly as before; transposed piles only if that fails,
    // and more strictly (KEY_STRICT): six more keys are six more chances for a chance pile
    const passes = (P, x) => {
      if (!P) return false;
      const prior = S.song_id == null && S.cue && S.cue.song_id === P.song_id;
      const NV = prior ? C.PRIOR_ACC_VOTES : C.ACC_VOTES, NL = prior ? C.PRIOR_ACC_LOOKS : C.ACC_LOOKS, NM = prior ? C.PRIOR_ACC_MARGIN : C.ACC_MARGIN;
      return P.votes >= NV * x && P.looks >= NL && P.pile.length >= NL && P.votes >= NM * Math.max(P.rival, 1) &&
             (!C.ACC_STRONG || P.pile.some(e => e.votes >= C.ACC_STRONG));   // not only weak looks (chance piles were)
    };
    const P0 = piles(undefined, 0), PK = EVIDENCE.some(e => e.key) ? piles(undefined, 'other') : null;
    // ...but a transposed pile of ANOTHER song that is bigger still says the room may be in another key: wait
    const P = passes(P0, 1) && !(PK && PK.song_id !== P0.song_id && PK.votes >= P0.votes) ? P0 : passes(PK, C.KEY_STRICT) ? PK : null;
    const shown = P || (PK && (!P0 || PK.votes > P0.votes) ? PK : P0);
    S.acc = shown && {song_id: shown.song_id, key: shown.key, votes: shown.votes, looks: shown.looks, rival: shown.rival, start: shown.start, at: now};
    if (!P || !S.auto) return false;
    const winner = P.song_id, mine = P.pile, sum = P.votes, looks = P.looks, rival = P.rival, pkey = P.key || 0;
    const prior = S.song_id == null && S.cue && S.cue.song_id === winner, NL = prior ? C.PRIOR_ACC_LOOKS : C.ACC_LOOKS;
    // already up at this very place (a words estimate the fingerprints now confirm): hand it to the ear
    if (S.song_id === winner && S.started_at != null && Math.abs(S.started_at - P.start) < C.RESYNC_SEC) {
      Object.assign(S, {driver: 'ear', last_confirm: now, on_track_at: now, ear_at: now, on_looks: 0, key: pkey}); EVIDENCE = []; bump();
      return false;
    }
    // START FROM THE TOP applies to added-up evidence too (it once locked 6.4 s ahead on a repeated
    // intro phrase): prefer this song's pile at its top when that fits TOP_SHARE as well, and don't
    // take a place away from the top on looks that didn't hear enough of the song to tell
    let st = P.start, how = `added up ${looks} looks`;
    if (S.song_id == null) {
      const ms = S.music_since, near = st0 => {
        const p = EVIDENCE.filter(e => e.song_id === winner && (e.key || 0) === pkey && Math.abs(e.start - st0) <= C.ACC_TOL);
        return {votes: p.reduce((a, e) => a + e.votes, 0), start: p.length ? p.reduce((a, e) => a + e.start * e.votes, 0) / p.reduce((a, e) => a + e.votes, 0) : st0};
      };
      if (ms != null && heardAt - ms <= C.TOP_SEC && Math.abs(P.start - ms) > C.TOP_TOL) {
        // the song's top = it began with the music: the best pile within TOP_TOL of that
        let top = null;
        for (const e of EVIDENCE) if (e.song_id === winner && (e.key || 0) === pkey && Math.abs(e.start - ms) <= C.TOP_TOL) {
          const n = near(e.start); if (!top || n.votes > top.votes) top = n;
        }
        if (top && top.votes >= C.TOP_SHARE * sum) { st = top.start; how += ', from the top'; }
        else if (new Set(mine.filter(e => e.full).map(e => e.look)).size < NL) return false;   // wait for whole looks
      } else if ((ms == null || heardAt - ms > C.TOP_SEC) && now - S.up_at > C.FRESH_SEC) {
        // no music start to go by: the latest-starting pile of this song that could be its top
        let top = null;
        for (const e of EVIDENCE) if (e.song_id === winner && (e.key || 0) === pkey && e.start > P.start + C.TOP_TOL && e.start >= heardAt - C.TOPC_SEC && e.start <= heardAt) {
          const n = near(e.start); if (n.votes >= C.TOP_SHARE * sum && (!top || n.start > top.start)) top = n;
        }
        if (top) { st = top.start; how += ', from the top'; }
      }
    }
    // a looping song: added-up evidence only confirms it once it's up (never re-places it); fresh, it takes the top
    if (LOOP.has(winner)) {
      if (S.song_id === winner) { S.last_confirm = now; EVIDENCE = []; return false; }
    }
    if (S.song_id != null && sameFam(S.song_id, winner)) { S.last_confirm = now; EVIDENCE = []; return false; }
    if (LOOP.has(winner)) {
      if (S.music_since != null && S.music_real && heardAt - S.music_since <= C.TOP_SEC) { st = S.music_since; how += ', from the top (a looping song)'; }
    }
    r = Object.assign({}, r, {song_id: winner, ref_id: (cands.find(c => c.song_id === winner && c.key === pkey) || {}).ref_id || r.ref_id});
    if (pkey) how += `, played ${pkey > 0 ? '+' : ''}${pkey} semitone${Math.abs(pkey) === 1 ? '' : 's'}`;
    if (prior) how += ', called by name first';
    Object.assign(S, {song_id: r.song_id, started_at: st, paused_at: null, last_confirm: now, on_track_at: now, taken_at: now,
                      driver: LOOP.has(r.song_id) ? 'live' : 'ear', mode: 'timed', anchor: null, searching: false, ear_at: now, on_looks: 0, key: pkey, cue: null});
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
      // the look's own candidates: a place of this song at the top that fits TOP_SHARE as well
      let near = null;
      for (const c of m.cands || [])
        if (c.song_id === m.song_id && !c.live && Math.abs(c.offset_sec - exp) <= C.TOP_TOL &&
            c.votes >= Math.max(C.TOP_MIN, C.TOP_SHARE * m.votes) && (!near || c.votes > near.votes)) near = c;
      if (near) return Object.assign({}, m, {offset_sec: near.offset_sec, top: true, moved_from: m.offset_sec});
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
    // a looping song that's up: the music confirms it's still on, and never moves the place
    if (S.song_id === m.song_id && LOOP.has(m.song_id)) { S.last_confirm = now; PENDING.song_id = null; return false; }
    // another version of the song that's up: it's still this song. Confirm, never switch versions mid-song
    if (S.song_id != null && S.song_id !== m.song_id && sameFam(S.song_id, m.song_id)) { S.last_confirm = now; PENDING.song_id = null; return false; }
    // already locked on this song and still in step: note that we can still hear it
    const mk = m.key || 0;
    if (S.song_id === m.song_id && S.started_at != null && Math.abs(S.started_at - started) < C.RESYNC_SEC) {
      S.last_confirm = now; PENDING.song_id = null;
      // the same song and place at another key: the band changed key (a last-chorus lift). Follow it.
      if (mk !== S.key && S.driver === 'ear') { S.key = mk; S.on_looks = 0; S.ear_at = now; bump(); }
      // an estimated clock (words, a live recording) that a studio recording now confirms: the ear has it
      if (S.driver === 'words' || S.driver === 'live') { Object.assign(S, {driver: 'ear', on_track_at: now, ear_at: now, on_looks: 0}); bump(); }
      return false;
    }
    // something is up and was on track recently: a different song, or a different place in
    // this song (the other chorus), has to keep saying so, window after window
    // (a backing track followed on an estimated clock is protected the same way: 30 Sep, Loyalty was thrown
    // off to a wrong song two minutes in)
    if (S.song_id != null && (S.driver === 'ear' || S.driver === 'live') && now - S.on_track_at < C.CHALLENGE_WITHIN) {
      const fresh = now - CHALLENGE.at < C.CHALLENGE_GAP;
      if (fresh && CHALLENGE.song_id === m.song_id && CHALLENGE.key === mk && Math.abs(CHALLENGE.started - started) < C.AGREE_SEC)
        Object.assign(CHALLENGE, {n: CHALLENGE.n + 1, at: now, started: (CHALLENGE.started + started) / 2});
      else Object.assign(CHALLENGE, {song_id: m.song_id, key: mk, started, n: 1, at: now});
      const other = m.song_id !== S.song_id;
      if (CHALLENGE.n >= (other ? C.CHALLENGE_SONG_N : C.CHALLENGE_N) && now - S.on_track_at >= (other ? C.OFF_TRACK_SONG_SEC : C.OFF_TRACK_SEC) && S.auto) {
        take(m.song_id, CHALLENGE.started, now, mk);
        CHALLENGE.song_id = null; CHALLENGE.n = 0;
        return true;
      }
      return false;
    }
    // the music just started but this isn't the top of the song: possible (they started at a
    // later section) but unusual, so it has to keep saying so, look after look
    if (m.top === false) {
      // a look whose window reaches back before the music started heard too little of the song to
      // tell its top from the same phrase repeated later (Build Your House on a Rock): it can't vote
      if (S.music_since != null && heardAt - win < S.music_since) return false;
      if (now - PENDING.at < C.CANDIDATE_TTL && PENDING.song_id === m.song_id && PENDING.key === mk &&
          Math.abs(PENDING.started - started) < C.AGREE_SEC) {
        PENDING.n++; PENDING.at = now;
        if (PENDING.n >= C.MID_AGREE_N && S.auto) {
          const st = (started + PENDING.started) / 2;
          PENDING.n = 0;
          take(m.song_id, st, now, mk);
          return true;
        }
        return false;
      }
      Object.assign(PENDING, {song_id: m.song_id, key: mk, started, at: now, n: 1});
      return false;
    }
    // a very strong match needs no second opinion
    if (m.votes >= C.LOCK_VOTES && m.margin >= C.LOCK_MARGIN && S.auto) { take(m.song_id, started, now, mk); return true; }
    // the music has just started and this look puts us at the TOP of a song: songs start at the
    // top, so that already is the second opinion. One clear look is enough (saves 0.75-1.5 s,
    // which is the first line)
    if (m.top === true && m.votes >= C.TOP_LOCK_VOTES && m.margin >= C.TOP_LOCK_MARGIN && S.auto) { take(m.song_id, started, now, mk); return true; }
    // does this confirm what we saw last time?
    if (now - PENDING.at < C.CANDIDATE_TTL && PENDING.song_id === m.song_id && PENDING.key === mk &&
        Math.abs(PENDING.started - started) < C.AGREE_SEC) {
      PENDING.song_id = null;
      if (!S.auto) return false;
      take(m.song_id, (started + PENDING.started) / 2, now, mk);
      return true;
    }
    Object.assign(PENDING, {song_id: m.song_id, key: mk, started, at: now, n: 1});
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
      Object.assign(S, {song_id: sid, started_at: null, driver: 'live', mode: 'words', anchor, last_confirm: now, ear_at: null, on_looks: 0, cue: null});
    } else {
      // heard in the intro (the music began moments ago, after quiet): it's the top. A looping backing track
      // matches equally well everywhere, so its best-matching place means nothing; where the music began does (Joel)
      const fromTop = S.music_since != null && S.music_real && heardAt - S.music_since <= C.TOP_SEC;
      Object.assign(S, {song_id: sid, started_at: fromTop ? S.music_since : heardAt - (m.offset_sec + win) * k, paused_at: null, driver: 'live',
                        mode: 'timed', anchor: null, last_confirm: now, on_track_at: now, taken_at: now, ear_at: null, on_looks: 0, key: m.key || 0, cue: null});
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
    // a song held because it was mentioned: is this a line of it?
    if (S.song_id == null && S.cue) {
      const h = heldWords(recent || text, at, now, ix);
      if (h != null) return h;
      // the talking has gone on without any more of this song: it was only mentioned
      if (C.CANCEL_SEC && at - S.cue.last > C.CANCEL_SEC) { S.cue = null; bump(); }
    }
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
        if (best) S.last_words = {cue: best.cue, at, moved: false};     // the line last heard (a quote is held there)
        if (!best || best.d <= C.WORDS_OUT) return false;
        S.started_at = at - (s.cues[best.cue].t + half(s, best.cue)); S.ear_at = null; S.on_looks = 0;
        S.last_words = {cue: best.cue, at, moved: true};
        bump();
        return true;
      }
      if (S.driver === 'live') return false;      // the recording named this song; words alone don't overrule it
    }
    const r = ix.search(text, C.WORDS_SCORE, C.WORDS_GRAMS);
    if (!r || !song(r.song_id) || r.song_id === S.song_id || !S.auto) return false;
    const s = song(r.song_id);
    // cross-check with the fingerprints: a pile of evidence for this song, from 2+ looks, that puts
    // the song at this line: its clock is measured, not estimated, so take it at once
    const P = piles(r.song_id);
    const agrees = !!(P && P.looks >= 2 && P.votes >= 2 * C.ACC_FLOOR &&
      copies(s, r.cue).some(j => outside(s, j, at - P.start, C.WORDS_POOL) <= C.WORDS_OUT));
    if (!agrees && r.grams < C.WORDS_GRAMS_ALONE) return false;   // two common 3-grams ('I wish you were') prove nothing
    // words alone: they must name this song twice, a moment apart
    if (!agrees) {
      // how much of the evidence is not everyday preaching (scripture the preacher quotes all the time)
      const fresh = r.fresh == null ? r.score : r.fresh, plain = fresh >= C.WORDS_FRESH;
      if (!(C.WORDS_ONCE && plain)) {
        const gap = plain ? C.WORDS_CONFIRM : C.PREACHED_GAP, within = plain ? C.WORDS_CONFIRM_SEC : C.PREACHED_WITHIN;
        const again = WORDS1.song_id === r.song_id && at - WORDS1.at <= within;
        if (!again) WORDS1 = {song_id: r.song_id, at};
        if (!again || at - WORDS1.at < gap) return false;
      }
    }
    WORDS1 = {song_id: null, at: -1e9};
    PENDING.song_id = null;
    S.last_match = {song_id: r.song_id, offset: null, votes: 0, margin: r.margin, at, via: null,
                    how: 'from the sung words', line: r.line, score: r.score};
    if (!hasTimes(s) || s.cues[r.cue].t == null) {   // no timings: the one case left for a block of words
      Object.assign(S, {song_id: r.song_id, started_at: null, paused_at: null, driver: 'words', mode: 'words',
                        anchor: r.cue, last_confirm: now, searching: false, ear_at: null, on_looks: 0, cue: null});
      bump(); return true;
    }
    // which line is being sung right now: the newest words, if they name a line of this song
    let cue = r.cue;
    const L = recent ? ix.song_lines(recent, r.song_id) : [];
    if (L.length && L[0].score >= C.WORDS_ANCHOR && s.cues[L[0].cue].t != null) cue = L[0].cue;
    // no recorded music: a quote, or singing the fingerprints can't hear. HOLD the line (the clock
    // stopped); a later line of it (singing on) or the music starts it; nothing for HOLD_SEC, it goes
    if (!agrees && !recorded(now)) {
      if (S.song_id != null) clear();
      S.cue = {song_id: r.song_id, kind: 'line', cue, pos: s.cues[cue].t, at: now, last: now, name: s.title, how: 'a line of it was heard'};
      S.key = 0; PRIOR.at = -1e9; bump();
      return true;
    }
    let started = at - (s.cues[cue].t + half(s, cue)), driver = 'words';
    if (agrees) { started = P.start; driver = 'ear'; S.key = P.key || 0; S.last_match.how = `sung words + ${P.looks} looks agree`; }
    else S.key = 0;
    Object.assign(S, {song_id: r.song_id, started_at: started, paused_at: null, driver, mode: 'timed', anchor: null,
                      last_confirm: now, on_track_at: now, searching: false, ear_at: driver === 'ear' ? now : null, on_looks: 0, cue: null});
    S.last_words = {cue, at, moved: false};
    if (driver === 'ear') EVIDENCE = [];
    bump();
    return true;
  }

  /** The engine's answer for a window that ended at heardAt (the /hear handler). */
  function result(r, heardAt, win, now) {
    if (r) {                               // recorded music in the room (a quote is held; singing to it scrolls)
      let mv = r.votes || 0;
      for (const c of r.cands || []) mv = Math.max(mv, c.votes || 0);
      if (mv >= C.MUSIC_VOTES) S.music_at = now;
    }
    let m = r && r.song_id && r.votes >= C.MIN_VOTES ? r : null;
    // other keys asked in this look (nothing up, an estimated clock, or doubt): the best believable
    // answer among them all speaks for the look; ties go to the key asked first
    // (only when the look's own key found nothing believable, and more strictly: six more keys are
    // six more chances for a chance match)
    if (r && r.alts && r.alts.length && !(m && believable(m))) {
      const strong = a => a.song_id && (a.votes >= C.KEY_STRICT * C.STRONG_VOTES ||
        (a.votes >= C.KEY_STRICT * C.MIN_VOTES && a.margin >= C.KEY_MARGIN)) && a.votes >= C.KEY_STRICT * ((r.song_id !== a.song_id && r.votes) || 0);
      let best = null;
      for (const a of r.alts) if (strong(a) && song(a.song_id) && (!best || a.votes > best.votes)) best = a;
      if (best) m = Object.assign({}, best, {track_votes: r.track_votes, track_recent: r.track_recent, track_offset: r.track_offset});
    }
    if (m && !isLive(m)) m = placeFromTop(m, heardAt, win, now);
    const liveHit = !!(m && isLive(m) && believable(m));
    let conf = 0;
    if (m) conf = Math.min(1, m.votes / 30) * (believable(m) ? 0.85 : 0.55);
    if (PENDING.song_id) conf = Math.max(conf, 0.7);
    S.conf = S.song_id == null ? Math.max(conf, now - S.conf_at < 3 ? S.conf * 0.8 : conf) : 0;
    S.conf_at = now;
    // on track = enough hashes at the expected place over the whole window AND at least one from
    // its last 2 s (after a song change the window's tail no longer vouches for the old song)
    const onTrack = r != null && r.track_votes != null && r.track_votes >= C.TRACK_MIN &&
                    (r.track_recent == null || r.track_recent >= C.TRACK_RECENT_MIN);
    let changed = false;
    if (liveHit && !onTrack) changed = considerLive(m, heardAt, win, now);
    if (m) S.last_match = {song_id: m.song_id, offset: m.offset_sec, votes: m.votes, margin: m.margin, at: heardAt,
                           via: m.ref_id && m.ref_id.includes('::') ? m.ref_id : null,
                           top: m.top, moved_from: m.moved_from, key: m.key || 0};
    if (onTrack) {
      // still exactly where we think we are: that is all we need to know
      S.last_confirm = S.on_track_at = now;
      CHALLENGE.song_id = null; CHALLENGE.n = 0; PENDING.song_id = null;
    } else if (!liveHit) changed = consider(m, heardAt, win, now);
    // a song held because it was mentioned is the likely one: its own looks need less
    if (!changed && S.song_id == null && S.cue) changed = considerPrior(r, heardAt, win, now);
    // an estimated clock (words): a fingerprint candidate of this song at this place keeps it up
    if (S.driver === 'words' && S.started_at != null && r && r.cands)
      for (const c of r.cands) if (c.song_id === S.song_id && !c.live && c.votes >= C.ACC_FLOOR &&
                                   Math.abs(heardAt - win - c.offset_sec - S.started_at) <= C.WORDS_AGREE) { S.last_confirm = now; break; }
    // always verifying: count looks off track while music plays; three in a row is doubt
    if (S.song_id != null && S.driver === 'ear' && r && r.track_votes != null) {
      const loud = now - S.last_loud < 1.5;
      S.on_looks = onTrack ? (S.on_looks || 0) + 1 : 0;
      if (onTrack) { S.off_looks = 0; S.doubt = false; }
      else if (loud) { S.off_looks = (S.off_looks || 0) + 1; if (S.off_looks >= C.DOUBT_LOOKS) S.doubt = true; }
    } else if (S.song_id == null) { S.off_looks = 0; S.doubt = false; }
    // weak evidence keeps adding up while nothing is up, while the clock is only an estimate,
    // and while in doubt (so a changed song is found as fast as a new one)
    const estimated = S.driver === 'words' || S.driver === 'live';
    if (!changed && (S.song_id == null || estimated || S.doubt)) {
      const was = S.song_id;
      changed = accumulate(r, heardAt, win, now);
      if (changed && was != null && S.song_id !== was) { S.doubt = false; S.off_looks = 0; }
      if (changed && S.song_id === was) { S.doubt = false; S.off_looks = 0; }
    }
    else if (S.song_id != null && !estimated) EVIDENCE = [];
    bump();
    return changed;
  }

  /** server.py maybe_release(): a song the room no longer has must come off. True if released. */
  function tick(now) {
    // a mentioned song waits: a title CUE_SEC for its music, a quoted line HOLD_SEC (from the last sign of it)
    if (S.song_id == null && S.cue) {
      if (now - S.cue.last > (S.cue.kind === 'title' ? C.CUE_SEC : C.HOLD_SEC)) { S.cue = null; bump(); return true; }
      return false;
    }
    if (!['ear', 'live', 'words'].includes(S.driver) || S.song_id == null) return false;
    const dur = (song(S.song_id) || {}).duration || 0;
    if (S.started_at != null && dur && now - S.started_at > dur + C.END_GRACE) { clear(); return true; }
    // however it has been kept up (a looping track re-confirming it), a song is never held past twice its
    // own length: 30 Sep, a 6-minute song sat on screen for 65 minutes and nothing after it could come up
    if (S.taken_at != null && dur && now - S.taken_at > 2 * dur + 60) { clear(); return true; }
    // a words-only song with no further line and no recorded music for LINE_ALONE: it was a quote.
    // Hold the line last heard rather than scroll on through a song nobody is singing
    if (S.driver === 'words' && S.started_at != null && S.last_words && now - S.last_confirm > C.LINE_ALONE && !recorded(now)) {
      const sid = S.song_id, s = song(sid), k = S.last_words.cue;
      clear();
      S.cue = {song_id: sid, kind: 'line', cue: k, pos: s.cues[k].t, at: now, last: now, name: s.title,
               how: 'no more lines and no music: holding the line heard'};
      bump(); return true;
    }
    if (!S.active) return false;
    // a pause, a quiet bridge or an a cappella moment is silence, not a different song. (Sound means
    // music-level OR clearly above the room's floor: a soft song is not silence.)
    const lastHeard = Math.max(S.last_loud, S.last_sound), musicNow = now - lastHeard < 3.0;
    const unconf = now - Math.max(S.last_confirm, S.music_since);
    if (musicNow && unconf < C.LOUD_MISS_SEC) {
      // the song up has gone unconfirmed while another song keeps building up evidence: the song changed. Let go
      // now, so the new one comes up (it takes the screen as soon as its own evidence is enough)
      if (unconf >= C.SWITCH_MISS_SEC) { const P = piles(); if (P && P.song_id !== S.song_id && P.looks >= 3 && P.votes >= 4 * C.ACC_FLOOR) { clear(); return true; } }
      return false;
    }
    if (!musicNow && now - lastHeard < C.SILENCE_SEC) return false;
    clear();
    return true;
  }

  /** Put a song up by hand (demo / operator). driver 'hand' is never released automatically. */
  function hold(fields, now) {
    Object.assign(S, {driver: 'hand', mode: 'timed', anchor: null, started_at: null, key: 0, cue: null}, fields,
                  {last_confirm: now, on_track_at: now, ear_at: null, on_looks: 0});   // put up by hand: never learnt from
    PENDING.song_id = null; CHALLENGE.song_id = null; CHALLENGE.n = 0; bump();
  }

  /** Should the device be listening for sung words? While searching (music, nothing up), and
   *  while the song up has only an estimated clock (words, a live recording) that words correct.
   *  Never while a fingerprint clock or a hand-held song is up. */
  /** Room memory: should the engine learn the look that just ended at heardAt (result r)? Only
   *  when the fingerprints took this song (driver 'ear', not words, a live estimate or a hand)
   *  at least LEARN_AFTER ago, LEARN_LOOKS looks in a row found it exactly on track, this look
   *  strongly (LEARN_VOTES) and at the clock's own place, and nothing is in doubt. Returns the
   *  worker's learn message ({at, song_id, lyric_offset, ref_id}) or null. */
  function learn(r, heardAt, win, now) {
    if (S.ear_at !== S.ear_seen) { S.ear_seen = S.ear_at; S.ear_ms = S.music_since; }   // when the music had started, at the lock
    if (!r || S.song_id == null || S.driver !== 'ear' || S.mode !== 'timed' || S.started_at == null || S.ear_at == null) return null;
    if (S.doubt || (S.on_looks || 0) < C.LEARN_LOOKS || now - S.ear_at < C.LEARN_AFTER) return null;
    const need = C.LEARN_VOTES != null ? C.LEARN_VOTES : 2 * C.TRACK_MIN;
    if (r.track_votes == null || r.track_votes < need || r.track_offset == null) return null;
    if (r.track_recent != null && r.track_recent < C.TRACK_RECENT_MIN) return null;
    if (Math.abs(r.track_offset - (heardAt - win - S.started_at)) > C.TRACK_TOL) return null;   // asked about another place
    // ...and only a song placed at its TOP, when the music started. Songs start at the top in church;
    // a song placed mid-song could be at the wrong copy of a repeated section (a concert recording
    // that plays it twice), and a memory learnt there would make that mistake stick. This also means
    // every look since the music started was this song: they are filled in too.
    const from_top = S.ear_ms != null && Math.abs(S.started_at - S.ear_ms) <= C.TOP_TOL;
    if (!from_top) return null;
    return {at: heardAt, song_id: S.song_id, lyric_offset: r.track_offset, ref_id: r.track_ref || null, from_top, key: S.key || 0};
  }

  /** The key to ask this look at: the song's, or 0 with nothing up. */
  const key = () => (S.song_id != null ? S.key || 0 : 0);
  /** Other keys to try in this look (null = none). afford = how many this device can manage per
   *  look (app.js measures it): all of them at once, or a few per look in rotation. */
  function keys(at, afford) {
    const k = key();
    let list = null;
    const musicOn = S.music_since != null && at - S.music_since >= C.KEY_AFTER && at - Math.max(S.last_loud, S.last_sound) < 3;
    if (S.song_id == null || S.driver === 'words' || S.driver === 'live') { if (musicOn) list = C.KEYS.filter(x => x !== k); }
    else if (S.doubt && S.driver === 'ear') list = [0, k + 1, k - 1].filter((x, i, a) => x !== k && a.indexOf(x) === i && Math.abs(x) <= 6);
    if (!list || !list.length) return null;
    const n = Math.max(1, Math.min(list.length, afford == null ? list.length : afford));
    if (n >= list.length) return list;
    const out = [];
    for (let i = 0; i < n; i++) out.push(list[(S.key_turn + i) % list.length]);
    S.key_turn = (S.key_turn + n) % list.length;
    return out;
  }

  /* ---------------- MENTIONED: a title said, a line quoted ---------------- */
  const recorded = now => now - S.music_at <= C.MUSIC_RECENT;

  /** A title heard (text = the last ~9 s of words, at = when; tix = a mention.js title index, lix =
   *  a lyricsearch.js index). Only while nothing is up. Returns {song_id, name, how} when a song goes
   *  up held at its top (S.cue kind 'title'), else null. A DISTINCTIVE title needs nothing more; a
   *  COMMON one (mention.js) needs a cue before it ('let's sing'), fingerprint evidence for the song,
   *  a line of the song besides the title's own words, or (3+ words) to be said twice. */
  function titles(text, at, now, tix, lix) {
    if (!tix || !text) return null;
    const hits = tix.find(text), seen = new Set();
    // when each title was said: a sighting is a NEW mention if the title now occurs more often in the
    // words than last time, or it's been MENTION_GAP since it was last seen (the words pool keeps a
    // mention in view for ~9 s)
    for (const h of hits) {
      seen.add(h.key);
      let M = MENT.get(h.key);
      if (!M) MENT.set(h.key, M = {occ: 0, last: -1e9, times: []});
      const add = h.occ > M.occ ? h.occ - M.occ : (at - M.last > C.MENTION_GAP ? 1 : 0);
      M.times = M.times.filter(t => at - t <= C.MENTION_AGAIN);
      for (let i = 0; i < add; i++) M.times.push(at);
      M.occ = h.occ; M.last = at;
    }
    for (const [k, M] of MENT) { if (!seen.has(k)) M.occ = 0; if (at - M.last > C.MENTION_AGAIN) MENT.delete(k); }
    if (S.song_id != null || !S.auto) return null;        // a song is up: titles never move it
    for (const h of hits) {
      const s = song(h.song_id);
      if (!s) continue;
      let how = null;
      if (!h.common) how = 'its title';
      else if (h.cued) how = 'its title, called by name';
      else if (h.n >= C.TITLE_ANY_MIN) how = 'its title';
      else {
        const P = piles(h.song_id), M = MENT.get(h.key);
        if (P && P.votes >= C.TITLE_EVIDENCE) how = 'its title, and the music agrees';
        else if (lix && tix.without) {
          const L = lix.song_lines(tix.without(text, h), h.song_id);
          if (L.length && L[0].score >= C.WORDS_ANCHOR) how = 'its title, and a line of it';
        }
        if (!how && h.n >= 3 && M && M.times.length >= 2 && M.times[M.times.length - 1] - M.times[0] >= C.WORDS_CONFIRM) how = 'its title, said twice';
      }
      if (!how) continue;
      if (S.cue && S.cue.song_id === h.song_id) { S.cue.last = now; return null; }   // already held: keep it longer
      S.cue = {song_id: h.song_id, kind: 'title', cue: null, pos: 0, at: now, last: now, name: h.name, how};
      PRIOR.at = -1e9; WORDS1 = {song_id: null, at: -1e9}; bump();
      return {song_id: h.song_id, name: h.name, how, common: h.common};
    }
    return null;
  }

  /** A line of the HELD song heard. null = not a line of it; true/false = whether the screen changed.
   *  A line after the held one (singing on), or any line of it with recorded music playing, starts
   *  the clock from that line; otherwise the hold moves to the line heard. */
  function heldWords(text, at, now, ix) {
    const c = S.cue, s = song(c.song_id);
    if (!s || !hasTimes(s)) return null;
    const L = ix.song_lines(text, c.song_id);
    if (!L.length || L[0].score < C.WORDS_ANCHOR) return null;
    const near = L.filter(x => x.score >= 0.9 * L[0].score && s.cues[x.cue].t != null);
    if (!near.length) return null;
    const t0 = c.kind === 'line' ? s.cues[c.cue].t : null;
    let on = null;                         // singing on: the first copy after the held line, not far after it
    if (t0 != null) for (const x of near) {
      const t = s.cues[x.cue].t;
      if (t > t0 + 0.01 && t - t0 <= C.CONTINUE_SEC && (on == null || t < s.cues[on].t)) on = x.cue;
    }
    if (on == null && recorded(now)) on = near[0].cue;
    if (on != null) {
      Object.assign(S, {song_id: c.song_id, started_at: at - (s.cues[on].t + half(s, on)), paused_at: null, driver: 'words',
                        mode: 'timed', anchor: null, last_confirm: now, on_track_at: now, searching: false, ear_at: null,
                        on_looks: 0, key: 0, cue: null});
      S.last_words = {cue: on, at, moved: false};
      S.last_match = {song_id: c.song_id, offset: null, votes: 0, margin: null, at, via: null, line: s.cues[on].text,
                      how: c.kind === 'title' ? 'called by name, then its words' : 'the singing went on from the line held'};
      bump(); return true;
    }
    const k = near.some(x => x.cue === c.cue) ? c.cue : near[0].cue;
    c.last = now;
    if (c.kind === 'line' && c.cue === k) return false;
    S.cue = Object.assign({}, c, {kind: 'line', cue: k, pos: s.cues[k].t, last: now, how: 'a line of it was heard'});
    bump(); return true;
  }

  /** The held song's fingerprints, with a head start: one look of PRIOR_VOTES at its top starts it
   *  (the music started, it was just called); elsewhere 2 agreeing looks (MID_AGREE_N if the music
   *  just started and this isn't the top). Every other song keeps the usual rules, so a different
   *  song clearly recognised still wins. */
  function considerPrior(r, heardAt, win, now) {
    const X = S.cue.song_id;
    if (!r || !S.auto || !song(X) || isLive({song_id: X})) return false;
    let best = null, other = 0;
    for (const c of [r, ...(r.cands || [])]) {
      if (!c || !c.song_id || c.live || c.offset_sec == null || (c.key || 0) !== 0) continue;
      if (c.song_id === X) { if (!best || c.votes > best.votes) best = c; }
      else other = Math.max(other, c.votes || 0);
    }
    if (!best || best.votes < C.PRIOR_VOTES || best.votes < C.PRIOR_MARGIN * other) return false;
    let m = {song_id: X, ref_id: best.ref_id, offset_sec: best.offset_sec, votes: best.votes, live: false,
             margin: best.votes / Math.max(other, 1), cands: r.cands};
    if (r.song_id === X) Object.assign(m, {top_votes: r.top_votes, top_offset: r.top_offset});
    m = placeFromTop(m, heardAt, win, now);
    const started = heardAt - (m.offset_sec + win);
    const go = (st, how) => {
      take(X, st, now);
      S.last_match = {song_id: X, offset: heardAt - win - st, votes: m.votes, margin: m.margin, at: heardAt,
                      via: m.ref_id && m.ref_id.includes('::') ? m.ref_id : null, top: m.top, how};
      PRIOR.at = -1e9; EVIDENCE = [];
      return true;
    };
    if (m.top === true) return go(started, 'called by name, then heard from the top');
    if (m.top === false && S.music_since != null && heardAt - win < S.music_since) return false;   // heard too little to tell
    const need = m.top === false ? C.MID_AGREE_N : 2;
    if (now - PRIOR.at < C.CANDIDATE_TTL && Math.abs(PRIOR.started - started) < C.AGREE_SEC) {
      PRIOR.n++; PRIOR.at = now; PRIOR.started = (PRIOR.started + started) / 2;
      if (PRIOR.n >= need) return go(PRIOR.started, `called by name, then ${PRIOR.n} looks agree`);
      return false;
    }
    Object.assign(PRIOR, {started, at: now, n: 1});
    return false;
  }

  /** Should the device be listening for words? Always while nothing is up (a title or a line said at
   *  any moment can pull a song up), and while the song up has only an estimated clock (words, a live
   *  recording) that words correct. Never while a fingerprint clock or a hand-held song is up. */
  const wantWords = () => S.song_id == null ? true : (S.driver === 'words' || S.driver === 'live');

  return {state: S, config: C, heard, track, top, result, tick, hold, words, titles, wantWords, learn, key, keys, stop: clear, believable,
          listening: on => { S.active = !!on; }};
}
