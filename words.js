/* Listening to the WORDS, on the device: the browser's own speech recognition, used only as a
 * last resort (decide.js wantWords(): music for 10 s with no song found, or a song up whose
 * clock is only an estimate). The Mac does this with Whisper; a phone can't run Whisper, but
 * most browsers can recognise speech.
 *
 * The fingerprints come first, always. Speech recognition wants the microphone too, and some
 * devices (iPhone and iPad Safari in particular) can mute or interrupt the page's own microphone
 * stream when it starts. So:
 *   - it is only started while the microphone is healthy (sound arriving, not exactly silent);
 *   - while it runs, and for a few seconds after, the microphone is watched. If sound stops
 *     arriving, turns to pure zeros, or the track is muted or ended, recognition is stopped,
 *     the microphone is restored, and word search stays off for the rest of this session;
 *   - errors never reach the singer's screen, only the Control Panel.
 * Chrome and Edge send the audio to Google to recognise it (so it needs internet); Safari uses
 * Apple's. Firefox has none: word search is simply not available there.
 */
const POOL_SEC = 9;          // words heard in the last this-many seconds are searched together
const POOL_WORDS = 32;       // ...at most this many (about 9 s of singing)
const RECENT_SEC = 4;        // "what is being sung right now"
const RECENT_WORDS = 12;
const DEAD_SEC = 1.0;        // microphone silent / stalled this long while recognising: it broke the mic
const GUARD_AFTER = 6;       // keep watching (and keep app.js's own dead-mic alarm quiet) this long after

export function createWordListener(o) {
  // o: {health() -> {frameAt, level, track, actx}, onWords(pool, recent, at), onMicTrouble(), log(kind, text), now()}
  const Rec = typeof window !== 'undefined' && (window.SpeechRecognition || window.webkitSpeechRecognition);
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  const android = /Android/i.test(ua);
  // Chrome and Edge (not on iPhone/iPad, where every browser is Safari underneath) recognise on Google's servers
  const google = /Chrome|Chromium|Edg\//.test(ua) && !/CriOS|EdgiOS|FxiOS/.test(ua);
  const W = {
    supported: !!Rec,
    status: Rec ? 'ready' : 'unsupported',   // ready | listening | off-blocked | off-mic | offline | off-quiet | unsupported
    running: false, want: false, disabled: null, guardUntil: 0, heard: 0,
  };
  let rec = null, entries = [], restartT = 0, retryAt = 0, starts = [], emptySessions = 0, gotResult = false;
  let watchT = 0, zeroSince = null, lastSent = '', sendT = 0;
  const now = () => o.now();

  function healthy(h, t) {
    if (!h || !h.track || h.track.readyState === 'ended' || h.track.muted) return false;
    if (h.actx && h.actx.state !== 'running') return false;
    return t - h.frameAt < 0.6 && h.level > 0;
  }

  function trouble(why) {
    // recognition took the microphone away from the fingerprints: give it back, never try again this session
    stopRec(true);
    W.disabled = 'mic'; W.status = 'off-mic';
    o.log('miss', 'Word search turned off on this device: it interrupted the microphone (' + why + '). Songs are still found from the music.');
    W.guardUntil = now() + GUARD_AFTER;
    try { o.onMicTrouble(); } catch (e) {}
  }

  function watch() {
    const t = now();
    if (!W.running && t > W.guardUntil) { clearInterval(watchT); watchT = 0; zeroSince = null; return; }
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') { zeroSince = null; return; }
    if (W.disabled === 'mic') return;
    const h = o.health();
    if (!h || !h.track) return;
    let why = null;
    if (h.track.readyState === 'ended') why = 'the microphone track ended';
    else if (h.actx && h.actx.state !== 'running' && h.actx.state !== 'closed') why = 'audio was ' + h.actx.state;
    else if (t - h.frameAt > DEAD_SEC + 0.2) why = 'sound stopped arriving';
    else if (h.track.muted || h.level === 0) {
      if (zeroSince == null) zeroSince = t;
      else if (t - zeroSince > DEAD_SEC) why = h.track.muted ? 'the microphone was muted' : 'the microphone went silent';
    } else zeroSince = null;
    if (why) trouble(why);
  }
  function startWatch() { if (!watchT) watchT = setInterval(watch, 200); }

  function pool(t) {
    entries = entries.filter(e => t - e.at <= POOL_SEC);
    const words = [];
    let recent = [];
    for (const e of entries) {
      const ws = e.text.split(/\s+/).filter(Boolean);
      words.push(...ws);
      if (t - e.at <= RECENT_SEC) recent.push(...ws);
    }
    return {pool: words.slice(-POOL_WORDS).join(' '), recent: recent.slice(-RECENT_WORDS).join(' ')};
  }

  function onresult(ev) {
    const t = now();
    gotResult = true;
    for (let i = ev.resultIndex; i < ev.results.length; i++) {
      const res = ev.results[i], text = ((res[0] && res[0].transcript) || '').trim();
      // one entry per result slot: an interim result is replaced as it grows, a final one stays
      let e = entries.find(x => x.rec === rec && x.i === i);
      if (!e) { e = {rec, i, text: '', at: t, final: false}; entries.push(e); }
      if (e.final) continue;
      // the same words again (some browsers repeat a final result): keep the first, don't pile them up
      if (res.isFinal && entries.some(x => x !== e && x.final && x.text.toLowerCase() === text.toLowerCase() && t - x.at < POOL_SEC)) {
        entries = entries.filter(x => x !== e); continue;
      }
      e.text = text; e.at = t; e.final = !!res.isFinal;
      if (e.final && text.length > 3) { W.heard++; o.log('heard', 'Heard: “' + text.slice(0, 120) + '”'); }
    }
    send();
  }
  function send() {
    const t = now(), p = pool(t);
    if (!p.pool || p.pool === lastSent) return;
    if (t - sendT < 0.25) { clearTimeout(send.t); send.t = setTimeout(send, 260); return; }
    sendT = t; lastSent = p.pool;
    try { o.onWords(p.pool, p.recent, t); } catch (e) { console.warn('words:', e); }
  }

  function onerror(ev) {
    const e = ev && ev.error;
    if (e === 'not-allowed' || e === 'service-not-allowed' || e === 'language-not-supported') {
      W.disabled = 'blocked'; W.status = 'off-blocked';
      o.log('info', 'Word search not allowed on this device (' + e + '). Songs are still found from the music.');
    } else if (e === 'network') {
      W.status = 'offline'; retryAt = now() + 60;
      o.log('info', 'Word search needs the internet on this browser; trying again in a minute.');
    } else if (e === 'audio-capture') {
      // the microphone can't be shared with the recogniser on this device
      W.disabled = 'mic'; W.status = 'off-mic';
      o.log('info', 'Word search turned off: this device won’t share the microphone with it.');
    }
    // 'no-speech', 'aborted': nothing to do; onend restarts it while it's wanted
  }

  function onend() {
    if (this !== rec) return;                // one we stopped ourselves
    rec = null; W.running = false; W.guardUntil = now() + GUARD_AFTER; startWatch();
    if (W.status === 'listening') W.status = 'ready';
    if (!W.probing) { if (!gotResult) emptySessions++; else emptySessions = 0; }
    // a browser that ends every session with nothing (Android restarts also make a sound): give up
    if (emptySessions >= (android ? 3 : 8)) {
      W.disabled = 'quiet'; W.status = 'off-quiet';
      o.log('info', 'Word search stopped: the browser kept hearing nothing.');
      return;
    }
    if (W.want && !W.disabled) { clearTimeout(restartT); restartT = setTimeout(update, android ? 2500 : 400); }
  }

  function startRec() {
    const t = now();
    if (t < retryAt) return;
    starts = starts.filter(s => t - s < 60);
    if (starts.length >= (android ? 6 : 20)) return;          // never thrash
    const h = o.health();
    if (!healthy(h, t)) return;              // the mic is already in trouble: don't make it worse, and don't get blamed
    try {
      rec = new Rec();
      rec.continuous = true; rec.interimResults = true; rec.lang = 'en-US'; rec.maxAlternatives = 1;
      rec.onresult = onresult; rec.onerror = onerror; rec.onend = onend;
      gotResult = false;
      rec.start();
      starts.push(t); W.running = true; W.status = 'listening'; zeroSince = null;
      startWatch();
    } catch (e) {
      rec = null; W.running = false;
      W.disabled = 'blocked'; W.status = 'off-blocked';
      o.log('info', 'Word search could not start on this device (' + (e && e.name || e) + ').');
    }
  }

  function stopRec(hard) {
    clearTimeout(restartT);
    if (!rec) { W.running = false; return; }
    const r = rec; rec = null;
    try { hard ? r.abort() : r.stop(); } catch (e) {}
    W.running = false; W.guardUntil = now() + GUARD_AFTER; startWatch();
    if (W.status === 'listening') W.status = 'ready';
  }

  function update() {
    const visible = typeof document === 'undefined' || document.visibilityState === 'visible';
    const go = W.want && visible && !W.disabled && W.supported;
    if (go && !rec) startRec();
    else if (!go && rec) { stopRec(false); entries = []; lastSent = ''; }
    if (!go && W.status === 'listening') W.status = 'ready';
    if (W.status === 'offline' && now() >= retryAt && !W.disabled) W.status = 'ready';
  }

  /** Should it be listening now? Called often (every frame is fine); only acts on a change. */
  W.set = want => { if (!!want !== W.want) { W.want = !!want; if (!W.want) { entries = []; lastSent = ''; } update(); }
                    else if (W.want && !rec && !W.disabled) update(); };
  W.stop = () => { W.want = false; stopRec(false); entries = []; lastSent = ''; };
  /** Try it once at the start (the tap that starts the microphone): any permission question
   *  comes up now, while someone is setting up, not mid-song; and a device where it interrupts the
   *  microphone is found out now, when nothing is at stake. Resolves with the status. */
  W.probe = (secs = 2.5) => new Promise(res => {
    if (!W.supported || W.disabled || rec) return res(W.status);
    W.probing = true; startRec();
    if (!rec) { W.probing = false; return res(W.status); }
    setTimeout(() => { W.probing = false; if (!W.want) stopRec(false); res(W.status); }, secs * 1000);
  });
  /** app.js's own "the microphone went silent" alarm must not fire because of recognition. */
  W.guarding = t => W.running || t < W.guardUntil;
  W.describe = () => ({
    unsupported: 'Not available in this browser. Songs are found from the music alone.',
    ready: 'Ready. Used only when the music alone can’t find the song' +
           (google ? ' (this browser sends the singing to Google to recognise it, so it needs the internet).' : '.'),
    listening: 'Listening to the singing now' + (W.heard ? '' : ' (nothing recognised yet)') + '.',
    offline: 'Needs the internet on this browser. It will try again.',
    'off-blocked': 'Turned off: this device didn’t allow speech recognition.',
    'off-mic': 'Turned off for this session: it interrupted the microphone on this device.',
    'off-quiet': 'Turned off for this session: the browser kept hearing nothing.',
  })[W.status] || W.status;
  if (typeof document !== 'undefined')
    document.addEventListener('visibilitychange', () => { if (document.visibilityState !== 'visible') { stopRec(true); entries = []; lastSent = ''; } else update(); });
  if (typeof window !== 'undefined') window.addEventListener('online', () => { retryAt = 0; if (W.status === 'offline') W.status = 'ready'; update(); });
  return W;
}
