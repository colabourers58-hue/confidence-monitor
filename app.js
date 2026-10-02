/* Everything runs on this device. No server, no network after the first load. */
import {Orb} from './orb.js?v=202610021325';
// Stamped by publish_site.sh on every publish ('dev' when served straight from this Mac).
const APP_VERSION = '202610021325';

const $ = s => document.querySelector(s);
// the orb is decoration: if this device can't draw it (old GPU, WebGL off, a shader error), the
// lyrics must still work, so anything the app asks of the orb quietly does nothing
let orb;
try{ orb = new Orb($('#orb')); orb.attach(document); }     // poke it: it dents, springs back and jiggles
catch(e){ console.warn('orb:', e); orb = new Proxy({}, {get: () => () => {}}); }
const LEAD = 1.2;                 // seconds the screen runs ahead of the audio
const RELEASE_SEC = 10;           // drop a song we have not heard for this long

let SONGS = {};
const st = {song:null, started:null, lastConfirm:0, pending:null};
// with no Mac, this device decides for itself, by the same rules as server.py (see decide.js);
// loaded only then, since the Mac does not serve it
let dec = null;

/* ---------------- data ---------------- */
async function loadSongs(){
  const list = await (await fetch('data/songs.json?v=' + APP_VERSION)).json();
  for(const s of list) SONGS[s.id] = s;
  await loadPrivate();
}
/* Other artists' songs come in a scrambled pack. The private link carries its key (?k=…): open it
   once and this device keeps the key, so those songs are there from then on. No password, ever. */
function privateKey(){
  const q = new URLSearchParams(location.search).get('k');
  try{ if(q) localStorage.setItem('cm.k', q); return q || localStorage.getItem('cm.k'); }catch(e){ return q; }
}
async function loadPrivate(){
  const k = privateKey();
  if(!k || !(window.crypto && crypto.subtle)) return;
  try{
    const b64 = k.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - k.length % 4) % 4);
    const raw = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const blob = new Uint8Array(await (await fetch('data/private.pack?v=' + APP_VERSION)).arrayBuffer());
    const key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt']);
    const plain = await crypto.subtle.decrypt({name: 'AES-GCM', iv: blob.slice(0, 12),
                    additionalData: new TextEncoder().encode('prompter-private-v1')}, key, blob.slice(12));
    const extra = JSON.parse(new TextDecoder().decode(plain));
    for(const s of extra) SONGS[s.id] = s;
    privateCount = extra.length;
  }catch(e){ console.warn('private songs:', e); }
}
let privateCount = 0;

/* ---------------- engine (runs in a worker, on device) ---------------- */
let worker = null, engineReady = false, loadMsgT = 0, engineRetry = 0;
function startEngine(){
  try{ worker = new Worker('engine/fp-worker.js?v=202610021325', {type:'module'}); }
  catch(e){ try{ worker = new Worker('engine/fp-worker.js?v=202610021325'); }catch(e2){ worker = null; } }
  if(!worker){ $('#load').classList.add('done'); return; }
  worker.onmessage = ev => {
    const m = ev.data || {};
    if(m.type === 'progress'){ loadPct = m.loaded/Math.max(1,m.total); $('#load i').style.width = (100*m.loaded/Math.max(1,m.total)).toFixed(1)+'%';
      // a first download takes a while on phone data: say what's happening, once it's clearly not instant
      if(!loadMsgT) loadMsgT = setTimeout(() => { if(!engineReady) $('#loadMsg').hidden = false; }, 2500); }
    if(m.type === 'ready'){ engineReady = true; $('#load').classList.add('done'); $('#loadMsg').hidden = true; if(m.decide && dec) Object.assign(dec.config, m.decide); }
    if(m.type === 'result'){ lastLookAt = performance.now()/1000; onResult(m); }
    if(m.type === 'room'){ roomInfo = m; if(!$('#cp').hidden) renderRoom();
      if(m.error && !m.ready) console.warn('room memory:', m.error); }
    if(m.type === 'error'){ $('#load').classList.add('done'); $('#loadMsg').hidden = true; console.warn('engine:', m.message);
      // a download that broke (slow or dropped connection) must not leave it deaf until someone reloads: try again,
      // and what already arrived is kept by the offline store, so each try gets further
      if(!engineReady){ const w = worker; worker = null; try{ w && w.terminate(); }catch(e){}
        engineRetry = Math.min(60, (engineRetry || 3) * 2); setTimeout(() => { if(!engineReady && !worker) startEngine(); }, engineRetry * 1000); } }
  };
  worker.onerror = () => { worker = null; $('#load').classList.add('done');
    if(!engineReady){ engineRetry = Math.min(60, (engineRetry || 3) * 2); setTimeout(() => { if(!engineReady && !worker) startEngine(); }, engineRetry * 1000); } };
  worker.postMessage({type:'load', base: new URL('engine/', location.href).href});
}

/* ---------------- room memory: faster at a song every time it hears it in this room ----------------
   Once a song is locked and proven on track, each look's sounds are stored for that song at that
   place (engine.js learn), on this device only. decide.js learn() says when; the worker keeps them. */
let roomInfo = null;
function renderRoom(){
  const el = $('#cpRoom'); if(!el) return;
  const r = roomInfo;
  el.textContent = !r ? 'Starting…' : !r.ready ? 'Loading…'
    : `${r.songs} song${r.songs === 1 ? '' : 's'} learned ${r.mac ? 'on the Mac' : 'on this device'}` + (r.persist ? '' : ' (this browser won’t keep it after it closes)');
  $('#cpForget').hidden = !(r && r.songs);
}
// per-look cost, to decide how many other keys (a transposed track) a look can afford
let costBase = null, costKey = null;
function keysAfford(){
  if(costBase == null) return 2;
  const perKey = costKey != null ? costKey : costBase / 5;
  return Math.max(1, Math.min(6, Math.floor((0.45 * EVERY - costBase) / Math.max(1, perKey))));
}
let closest = null, lastDoubt = false;   // lastDoubt: the Mac server's doubt flag (server mode)                  // the best guess of the last 30 s, for the log when nothing locks
function onResult(m){
  if(!dec) return;
  const now = performance.now()/1000;
  if(m.song_id && (!closest || now - closest.at > 30 || m.votes > closest.votes))
    closest = {id: m.song_id, votes: m.votes, margin: m.margin, at: now};
  // m.at = when the window ENDED (sendWindow's clock); offset is where it STARTS in the recording
  const heardAt = m.at != null ? m.at : now - (m.ms||0)/1000;
  if(m.ms != null){
    const nk = (m.alts || []).length;
    if(!nk) costBase = costBase == null ? m.ms : 0.8 * costBase + 0.2 * m.ms;
    else if(costBase != null){ const pk = Math.max(0, (m.ms - costBase) / nk); costKey = costKey == null ? pk : 0.8 * costKey + 0.2 * pk; }
  }
  dec.result(m, heardAt, m.win || 5, now);
  // room memory: a look heard confidently on track teaches the engine how this song sounds here
  const L = dec.learn(m, heardAt, m.win || 5, now);
  if(L && worker) worker.postMessage(Object.assign({type:'learn'}, L));
  if(dec.state.last_match) lastMatchInfo = dec.state.last_match;
  applyLocal(now);
}
// the decider's state onto the screen, the way pollServer puts the Mac's there
function applyLocal(now){
  const s = dec.state, song = s.song_id && SONGS[s.song_id];
  if(song && s.mode === 'words' && s.anchor != null) showWords(song, s.anchor);     // only a song with no timings
  else if(song && s.started_at != null){
    if(!st.song || st.song.id !== song.id || st.words || st.paused != null || Math.abs(st.started - s.started_at) > 0.25)
      catchSong(song, s.started_at, s.driver === 'words' ? (s.last_match && s.last_match.how) || 'from the sung words'
                                  : s.driver === 'live' ? 'a live recording: clock estimated, the singing corrects it'
                                  : (s.last_match && s.last_match.how) || 'following the track');
    else st.started = s.started_at;      // same clock, no jitter: follow it exactly
  }
  else if(!song && s.cue && SONGS[s.cue.song_id]) holdSong(SONGS[s.cue.song_id], s.cue);   // mentioned: held, clock stopped
  else if(st.song) release();
  if(st.song) st.lastConfirm = now;       // the decider says when to let go
}

/* ---------------- microphone ---------------- */
const SR = 16000, WIN = 5*SR, EVERY = 500;     // a fresh look every 0.5 s (measured: faster locks; a look costs ~60 ms on a Mac)
let actx, ring = [], ringLen = 0, level = 0, busy = false;
// automatic gain: a quiet feed (a mixer line set low, a mic far from the speakers) is brought up to a working level
// in software, so nobody has to touch the desk. rawLevel = what actually arrives (for 'no sound' checks).
let rawLevel = 0, agcPeak = 0.02, agcGain = 1, clipFrac = 0;
// automatic gain is OFF (1 Oct: it boosted a laptop mic's room noise up to 40x, so the app thought music was always
// playing and dropped right songs; and it clipped loud singing after a quiet moment). A plain, steady input level
// set by hand in Settings replaces it: 0 dB = exactly what arrives.
let inputDb = 0; try{ inputDb = parseFloat(localStorage.getItem('cm.inputdb') || '0') || 0; }catch(e){}
const AGC_TARGET = 0.12, AGC_MAX = 40;
let mstream = null, analyser = null, fbuf = null, inputId = null;
let srcNode = null, procNode = null, lastFrameAt = 0;   // lastFrameAt: when sound last arrived (word search watches it)
try{ inputId = localStorage.getItem('cm.input'); }catch(e){}
// one microphone start at a time: two at once (the page's own start and a tap) closed each other's
// audio mid-start on Safari -> "null is not an object (evaluating 'actx.state')"
let micChain = Promise.resolve();
function startMic(deviceId, opts){
  const p = micChain.then(() => startMic0(deviceId, opts));
  micChain = p.catch(() => {});
  return p;
}
async function startMic0(deviceId, opts){
  // keep: a fresh microphone stream into the SAME running audio graph. Used to bring the mic back
  // without a tap (a new audio graph on iPhone/iPad needs one)
  const keep = !!(opts && opts.keepContext && actx && actx.state === 'running' && procNode);
  if(mstream){ mstream.getTracks().forEach(t => t.stop()); mstream = null; }
  // reuse: the audio graph was just made INSIDE the user's tap (begin -> unlockAudio). iPhone only
  // lets sound start inside a tap, and waiting for the microphone prompt first uses the tap up
  const reuse = !!(opts && opts.reuse && actx && actx.state !== 'closed');
  if(actx && !keep && !reuse){ try{ await actx.close(); }catch(e){} actx = null; }
  if(reuse){ try{ srcNode && srcNode.disconnect(); procNode && procNode.disconnect(); }catch(e){} }
  const audio = {echoCancellation:false, noiseSuppression:false, autoGainControl:false};
  if(deviceId) audio.deviceId = {exact: deviceId};
  let stream;
  try{ stream = await navigator.mediaDevices.getUserMedia({audio}); }
  catch(e){
    if(e && e.name === 'NotAllowedError') throw e;                       // the person said no: don't ask again
    // anything else (a remembered input that's gone, a setting the device can't do): the plainest request
    try{ stream = await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:false,noiseSuppression:false,autoGainControl:false}}); }
    catch(e2){ if(e2 && e2.name === 'NotAllowedError') throw e2; stream = await navigator.mediaDevices.getUserMedia({audio:true}); }
  }
  // nobody chose an input and the browser handed us a phone over Continuity (or another
  // borrowed mic): prefer this device's own built-in microphone
  if(!deviceId){
    try{
      const label = (stream.getAudioTracks()[0] || {}).label || '';
      if(!/macbook|built-?in|internal|ipad|default/i.test(label) || /iphone|telephone|continuity/i.test(label)){
        const devs = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'audioinput');
        const own = devs.find(d => /macbook|built-?in|internal|ipad microphone/i.test(d.label));
        if(own && own.deviceId !== stream.getAudioTracks()[0].getSettings().deviceId){
          stream.getTracks().forEach(t => t.stop());
          return startMic0(own.deviceId, opts);
        }
      }
    }catch(e){}
  }
  mstream = stream; ring = []; ringLen = 0;
  if(keep && actx && actx.state !== 'closed' && procNode){
    try{ srcNode && srcNode.disconnect(); }catch(e){}
    srcNode = actx.createMediaStreamSource(stream);
    srcNode.connect(procNode); if(analyser) srcNode.connect(analyser);
    return;
  }
  // the device's own rate. Asking for 16 kHz here works in Chrome but gives SILENCE in Safari,
  // so the audio is converted to 16 kHz by us (to16k) or by the Mac server (X-Rate), never by the browser
  if(!reuse || !actx || actx.state === 'closed') actx = new (window.AudioContext || window.webkitAudioContext)();
  if(actx.state !== 'running'){
    try{ await Promise.race([actx.resume(), new Promise(r => setTimeout(r, 1500))]); }catch(e){}
  }
  if(actx.state !== 'running'){ const err = new Error('sound not started'); err.name = 'AudioNotStarted'; throw err; }
  const src = srcNode = actx.createMediaStreamSource(stream);
  const node = procNode = actx.createScriptProcessor(4096, 1, 1);
  node.onaudioprocess = e => {
    lastFrameAt = performance.now()/1000;
    const d = e.inputBuffer.getChannelData(0);
    let s = 0; for(let i=0;i<d.length;i++) s += d[i]*d[i];
    rawLevel = Math.sqrt(s/d.length);
    agcGain = Math.pow(10, inputDb / 20);                                   // the hand-set level, nothing automatic
    let clip = 0; for(let i=0;i<d.length;i++) if(Math.abs(d[i]) > 0.985) clip++;          // distorted before it reached us
    clipFrac = 0.96 * clipFrac + 0.04 * (clip / d.length);
    level = rawLevel * agcGain;
    const g = new Float32Array(d.length); for(let i=0;i<d.length;i++) g[i] = Math.max(-1, Math.min(1, d[i] * agcGain));
    ring.push(g); ringLen += g.length;
    const cap = Math.round(5 * actx.sampleRate);
    while(ringLen > cap){ ringLen -= ring[0].length; ring.shift(); }
  };
  src.connect(node); node.connect(actx.destination);
  // a small, fast analyser read every frame: 31 Hz bins, so the kick drum lives in bins 1-4
  analyser = actx.createAnalyser(); analyser.fftSize = 512; analyser.smoothingTimeConstant = 0;
  fbuf = new Float32Array(analyser.frequencyBinCount); src.connect(analyser);
  if(!startMic.timer) startMic.timer = setInterval(sendWindow, EVERY);
}
let kickPrev = 0, kickAvg = 0, lastKick = 0;
function detectKick(now){
  if(!analyser) return;
  analyser.getFloatFrequencyData(fbuf);
  let e = 0; for(let i=1;i<=4;i++) e += Math.pow(10, fbuf[i]/10);
  const flux = Math.max(0, e - kickPrev); kickPrev = e;
  kickAvg = kickAvg*0.97 + flux*0.03;                   // adapts to how loud the room is
  if(flux > kickAvg*3.2 && flux > 1e-7 && now - lastKick > 0.16){
    lastKick = now; orb.kick(Math.min(1, 0.35 + flux/(kickAvg*10 + 1e-12)));
  }
}

/* ---------------- the control panel: what it hears, what it did, how fast ----------------
   Kept on this device (it works offline), last 400 events remembered between sessions. */
let LOG = [];
try{ LOG = JSON.parse(localStorage.getItem('cm.log') || '[]'); }catch(e){ LOG = []; }
const SESSION_START = Date.now();
function logEvent(kind, text, extra){
  LOG.push(Object.assign({t: Date.now(), kind, text}, extra || {}));
  if(LOG.length > 3000){ const keep = LOG.slice(-2500), old = LOG.slice(0, -2500).filter(e => e.kind === 'miss').slice(-300); LOG = old.concat(keep); }
  try{ localStorage.setItem('cm.log', JSON.stringify(LOG)); }catch(e){}
  if(!$('#cp').hidden) renderPanel();
}
const hhmmss = t => new Date(t).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit', second:'2-digit'});
function renderPanel(){
  const ses = LOG.filter(e => e.t >= SESSION_START);
  const found = ses.filter(e => e.kind === 'identified').length;
  const ids = ses.filter(e => e.kind === 'identified' && e.secs != null).map(e => e.secs).sort((x,y) => x-y);
  const med = ids.length ? ids[Math.floor(ids.length/2)] : null;
  const miss = ses.filter(e => e.kind === 'miss').length;
  const late = ses.filter(e => e.kind === 'identified' && e.secs != null && e.secs > 8).length;
  $('#cpStats').innerHTML = [
    [found, 'songs identified'], [med == null ? '–' : med.toFixed(1)+' s', 'typical time to identify'],
    [ids.length ? ids[0].toFixed(1)+' s' : '–', 'fastest'], [ids.length ? ids[ids.length-1].toFixed(1)+' s' : '–', 'slowest'],
    [late, 'took over 8 s'], [miss, 'music never identified']]
    .map(([b,s]) => `<div><b>${b}</b><span>${s}</span></div>`).join('');
  const recent = LOG.slice(-150), probs = LOG.slice(0, -150).filter(e => e.kind === 'miss').slice(-30);   // problems are never scrolled away
  $('#log').innerHTML = probs.concat(recent).reverse().map(e =>
    `<div><time>${hhmmss(e.t)}</time><span class="${e.kind==='identified'?'id':e.kind==='miss'?'miss':e.kind==='heard'?'heard':''}">${esc(e.text)}</span></div>`).join('')
    || '<div><time></time><span>Nothing yet. Play or sing something.</span></div>';
}
function renderNow(){
  let t;
  if(st.song) t = `Showing <b>${esc(st.song.title)}</b><small>${st.words ? 'A block of words (this song has no timings yet)' : 'Following the track'}</small>`;
  else if(confNow > 0.05) t = `Thinking… ${Math.round(confNow*100)}% sure`;
  else if(level*3.2 > 0.10) t = 'Hearing music, listening for a song';
  else t = 'Resting, listening for music';
  if(st.song && st.paused != null && heldInfo)
    t = `Ready: <b>${esc(st.song.title)}</b><small>${heldInfo.kind === 'title'
          ? `Its title was heard${heldInfo.name && heldInfo.name !== st.song.title ? ` (“${esc(heldInfo.name)}”)` : ''}. Waiting for the music or the singing to start it`
          : 'A line of it was heard. Held on that line until the singing goes on or the music starts'}</small>`;
  else if(st.song && !serverMode && dec && (dec.state.driver === 'words' || dec.state.driver === 'live'))
    t = `Showing <b>${esc(st.song.title)}</b><small>Place estimated from ${dec.state.driver === 'words' ? 'the sung words' : 'a live recording'}; ` +
        `${asrReady ? 'listening to the singing to correct it' : 'the music keeps checking it'}</small>`;
  if(!serverMode && dec && dec.state.searching && !st.song){
    const a = dec.state.acc;
    t = `Searching hard<small>${a ? `Adding up the evidence. Best so far: ${esc((SONGS[a.song_id] || {}).title || a.song_id)}, ${a.looks} look${a.looks === 1 ? '' : 's'} agree` : 'Adding up the evidence'}` +
        `${asrReady ? '. Listening to the words too' : ''}</small>`;
  }
  const ws = $('#cpWords');
  if(ws) ws.textContent = serverMode ? 'Done by the Mac (Whisper).'
    : asrReady ? `On this device, no internet needed. ${asrMs.length ? (asrMedian() / 1000).toFixed(1) + ' s per 5 s of sound' + (asrMedian() > ASR_SLOW ? ' (a slow device: every other 5 s)' : '') : 'Waiting for sound'}.`
    : asrInfo === 'starting' ? 'On this device: getting ready.' : 'On this device: ' + asrInfo + '. Songs are still found from the music.';
  if(!serverMode && !engineReady)
    t += `<small>Songs still downloading (${($('#load i').style.width || '0%')}). It can’t recognise anything until this finishes.</small>`;
  else if(!serverMode && !st.song && closest && performance.now()/1000 - closest.at < 20)
    t += `<small>Closest guess: ${esc((SONGS[closest.id] || {}).title || closest.id)} (${closest.votes} matches)</small>`;
  $('#cpNow').innerHTML = t;
}
async function renderDevices(){
  const list = $('#devlist'); list.innerHTML = '';
  let devs = [];
  try{ devs = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'audioinput'); }catch(e){}
  const tr = mstream && mstream.getAudioTracks()[0], current = tr && tr.getSettings().deviceId;
  if(!devs.length || !devs.some(d => d.label)){ list.innerHTML = '<div class="mrow">Allow the microphone first (tap the screen), then open this again to see every input.</div>'; if(!devs.length) return; }
  devs.forEach(d => {
    const b = document.createElement('button');
    b.className = 'dev' + (d.deviceId === current ? ' on' : '');
    b.textContent = (d.label || 'Input ' + (d.deviceId || '').slice(0, 6)) + (d.deviceId === current ? '  ·  in use' : '');
    b.onclick = async () => { unlockAudio(); try{ await startMic(d.deviceId, {reuse:true}); inputId = d.deviceId; localStorage.setItem('cm.input', d.deviceId);
                                   logEvent('input', 'Listening from ' + (d.label || 'another input')); }catch(e){} renderDevices(); };
    list.appendChild(b);
  });
}
/* ---------------- say what's wrong, in words ----------------
   Joel: "it should really tell us what the problem is." When music has played for a few seconds and
   nothing is up (or the song up has stopped matching), one plain line says why. */
let whyAt = 0, quietSinceAt = null, loadPct = 0, lastLookAt = 0;
let updateWaiting = null;
// Joel: "why do we have to guess... if it's gone offline or the mic is off it should clearly say it."
// A status light that is always on screen, and one plain instruction when something needs doing.
const CLICK = (() => { try{ return matchMedia('(pointer:fine)').matches ? 'Click' : 'Tap'; }catch(e){ return 'Tap'; } })();
const click = CLICK.toLowerCase();
function showWhy(now, loud, up){
  if(now - whyAt < 0.5) return; whyAt = now;
  const el = $('#why'), pill = $('#stat'); if(!el || !pill) return;
  const gate = $('#gate'), gateUp = gate && !gate.classList.contains('gone');
  if(gateUp && CLICK === 'Click'){                                     // a computer: say click, not tap
    for(const x of gate.querySelectorAll('b,small')) if(/\btap\b|\bTap\b/.test(x.textContent))
      x.textContent = x.textContent.replace(/\bTap\b/g, 'Click').replace(/\btap\b/g, 'click').replace(/\bOne click\b/, 'One click');
  }
  const online = navigator.onLine !== false;
  const tr = mstream && mstream.getAudioTracks()[0], mic = tr ? (tr.label || 'the input').replace(/\s*\(.*?\)\s*$/, '') : '';
  if(mstream && rawLevel < 0.0004){ if(quietSinceAt == null) quietSinceAt = now; } else quietSinceAt = null;
  const silent = quietSinceAt == null ? 0 : now - quietSinceAt;
  const music = attemptStart != null && now - attemptStart > 4;
  let t = '', p = '', cls = 'ok';
  if(serverMode){ p = 'Connected to the Mac'; }
  else if(!mstream){ p = 'Not listening'; cls = 'bad'; t = gateUp ? '' : `${CLICK} anywhere to start listening`; }
  else if(tr && (tr.readyState === 'ended' || tr.muted) || (actx && actx.state !== 'running')){
    p = 'Microphone off'; cls = 'bad'; t = gateUp ? '' : `The microphone is off. ${CLICK} anywhere to turn it back on`; }
  else if(!engineReady){
    if(!online){ p = 'Offline, songs not saved'; cls = 'bad'; t = 'No internet, and this computer hasn’t finished saving the songs. Connect to Wi-Fi'; }
    else { const pc = Math.round(100 * loadPct); p = `Getting the songs ready${pc ? ' ' + pc + '%' : ''}`; cls = 'warn';
      if(music) t = `Getting the songs ready${pc ? '… ' + pc + '%' : '…'} It can’t recognise anything until this finishes`; } }
  else if(silent > 8){ p = `No sound from ${mic}`; cls = silent > 30 ? 'bad' : 'warn';
    if(silent > 30) t = `No sound is reaching Prompter from “${mic}”. Check the cable or the feed, or pick the input in Settings`; }
  else {
    const ago = lastLookAt ? Math.max(0, Math.round(now - lastLookAt)) : null;
    p = `Listening \u00b7 ${mic}` + (ago == null ? '' : ` \u00b7 checked ${ago} s ago`) + (online ? '' : ' \u00b7 offline, using saved songs');
    if(updateWaiting) p += ' \u00b7 update ready (applies next time Prompter is opened)';
    if(ago != null && ago > 10){ cls = 'bad'; t = 'Prompter has stopped checking the music. Reload the page'; }
    if(clipFrac > 0.02){ t = 'Input very hot: turn it down at the desk'; cls = 'warn'; }
    else if(up && dec && dec.state.doubt) { t = 'Checking: the music doesn’t match this song right now'; cls = 'warn'; }
    else if(!up && !st.song && music){
      if(level * 3.2 < 0.02){ t = 'Very quiet input: turn it up (Settings \u203a Input level)'; cls = 'warn'; }
      else if(now - attemptStart > 15){ t = (closest && now - closest.at < 8)
          ? `Hearing music but haven’t recognised it yet (closest: ${(SONGS[closest.id] || {}).title || closest.id}). Type the song in Settings`
          : 'Hearing music but haven’t recognised it yet. Type the song in Settings'; cls = 'warn'; }
    }
  }
  // NEVER cover the lyrics (Joel, 30 Sep): while a song is up, any message goes into the small top line instead
  if(t){ p = t; t = ''; }                                         // never a banner over the screen (Joel, 1 Oct)
  if(el.textContent !== t) el.textContent = t;
  el.classList.toggle('show', !!t); el.classList.toggle('bad', false);
  if(pill.textContent !== p) pill.textContent = p;
  pill.className = cls; pill.hidden = !p;
  placeStat(pill);
}
// a plain input meter under the status light: what actually ARRIVES (before the automatic boost), in dBFS
let mPeak = -90, mPeakAt = 0, mPeakRaw = 0;
function drawMeter(now){
  const box = $('#meter'), pill = $('#stat'); if(!box || !pill) return;
  box.hidden = !mstream || pill.hidden;
  if(box.hidden) return;
  const db = rawLevel > 0 ? Math.max(-60, 20 * Math.log10(rawLevel * agcGain * Math.SQRT2)) : -60;   // what Prompter hears, after the Input level
  if(db >= mPeak || now - mPeakAt > 1.5){ mPeak = db; mPeakAt = now; }
  const pc = v => ((v + 60) / 60 * 100).toFixed(1) + '%';
  box.querySelector('i').style.width = pc(db);
  box.querySelector('b').style.left = pc(mPeak);
  box.querySelector('i').style.background = clipFrac > 0.004 || db > -3 ? '#ff453a' : db > -12 ? '#ffd60a' : '#30d158';
  box.querySelector('span').textContent = rawLevel > 0 ? `${Math.round(db)} dB` : 'no signal';
  const r = pill.getBoundingClientRect();
  if(box.classList.contains('compact')){ box.style.left = (r.right + 10) + 'px'; box.style.top = (r.top + r.height/2 - box.offsetHeight/2) + 'px'; box.style.width = '300px'; }
  else { box.style.left = r.left + 'px'; box.style.top = (r.bottom + 6) + 'px'; box.style.width = Math.max(220, r.width) + 'px'; }
}
function placeStat(pill){
  // a song is up: one small line right after its title. Nothing up: above the orb.
  const t = $('#title'), compact = true;                            // always in the top line, song or no song (Joel)
  pill.classList.toggle('compact', compact); $('#meter') && $('#meter').classList.toggle('compact', compact);
  if(compact){ const r = t.getBoundingClientRect(), tw = Math.min(r.width, t.scrollWidth), se = $('#sect');
    const after = st.song && se && se.classList.contains('show') && se.textContent ? se.getBoundingClientRect().right : st.song && t.textContent ? r.left + tw : r.left - 18;
    pill.style.left = (after + 18) + 'px'; pill.style.top = (r.top + r.height/2 - pill.offsetHeight/2) + 'px'; pill.style.bottom = 'auto'; pill.style.transform = 'none'; }
  else { const m = Math.min(innerWidth, innerHeight);
    pill.style.left = '50%'; pill.style.top = Math.max(8, innerHeight/2 - m*0.27 - pill.offsetHeight - 14) + 'px'; pill.style.bottom = 'auto'; pill.style.transform = 'translateX(-50%)'; }
}
addEventListener('online', () => { whyAt = 0; }); addEventListener('offline', () => { whyAt = 0; });

/* ---------------- tell it the song (Control Panel) ----------------
   Type the song that's on, spelled any old way; pick it; the listener then only has to confirm WHERE in
   the song we are (the held song's fingerprints need far less), and puts it up there. */
const fnorm = t => (t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
function grams(t){ const g = new Map(), x = ' ' + t + ' '; for(let i = 0; i < x.length - 1; i++){ const k = x.slice(i, i + 2); g.set(k, (g.get(k) || 0) + 1); } return g; }
function dice(a, b){ const A = grams(a), B = grams(b); let n = 0, ta = 0, tb = 0; for(const v of A.values()) ta += v; for(const v of B.values()) tb += v;
  for(const [k, v] of A) n += Math.min(v, B.get(k) || 0); return ta + tb ? 2 * n / (ta + tb) : 0; }
function fuzzySongs(q){
  const n = fnorm(q); if(n.length < 2) return [];
  const aliases = (TITLES && TITLES.aliases) || {}, out = [];
  for(const s of Object.values(SONGS)){
    let best = 0;
    for(const name of [s.title, ...(aliases[s.id] || [])]){
      const t = fnorm(name); if(!t) continue;
      let sc = dice(n, t);
      if(t.startsWith(n)) sc = Math.max(sc, 0.9); else if(t.includes(n)) sc = Math.max(sc, 0.8);
      else { const qw = n.split(' ').filter(w => w.length > 1), tw = t.split(' ');   // word by word, misspellings allowed
        if(qw.length){ const per = qw.map(w => Math.max(...tw.map(x => dice(w, x)))); sc = Math.max(sc, per.reduce((a, b) => a + b, 0) / qw.length * 0.95); } }
      best = Math.max(best, sc);
    }
    if(best < 0.55 && n.length >= 8){                       // a line of the song, roughly
      for(const c of s.cues || []){ if(c.s) continue; const sc = dice(n, fnorm(c.text)); if(sc > best) best = sc * 0.92; }
    }
    if(best >= 0.45) out.push({s, sc: best});
  }
  return out.sort((a, b) => b.sc - a.sc).slice(0, 8);
}
function renderTell(){
  const q = $('#tellQ').value, list = $('#tellList'); list.innerHTML = '';
  for(const r of fuzzySongs(q)){
    const b = document.createElement('button'); b.className = 'dev'; b.textContent = r.s.title;
    b.onclick = () => tellSong(r.s); list.appendChild(b);
  }
}
function tellSong(song){
  $('#tellQ').value = ''; $('#tellList').innerHTML = '';
  logEvent('input', `Told: ${song.title} is on`);
  if(serverMode){ fetch('cue', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({action:'arm', song_id: song.id})}).catch(()=>{}); return; }
  const now = performance.now()/1000;
  if(dec && dec.state.song_id && dec.state.song_id !== song.id) dec.stop();     // a wrong song was up: drop it
  const c = {song_id: song.id, kind: 'title', cue: null, pos: 0, at: now, last: now + 300, name: song.title, how: 'you told it'};
  if(dec) dec.state.cue = c;
  holdSong(song, c);
  $('#cp').hidden = true;
}
$('#tellQ') && ($('#tellQ').oninput = renderTell);
$('#tellQ') && ($('#tellQ').onkeydown = e => { if(e.key === 'Enter'){ const r = fuzzySongs($('#tellQ').value)[0]; if(r) tellSong(r.s); } e.stopPropagation(); });
function setInputDb(v){ inputDb = Math.max(-24, Math.min(24, v)); try{ localStorage.setItem('cm.inputdb', String(inputDb)); }catch(e){}
  const r = $('#inDb'), o = $('#inDbV'); if(r) r.value = inputDb; if(o) o.textContent = (inputDb > 0 ? '+' : '') + inputDb + ' dB'; }
$('#inDb') && ($('#inDb').oninput = e => setInputDb(parseFloat(e.target.value)));
setInputDb(inputDb);
function openPanel(){ $('#cp').hidden = false; renderPanel(); renderNow(); renderDevices(); renderRoom(); }
// a microphone or audio interface plugged in or out: the list follows while the panel is open
try{ navigator.mediaDevices.addEventListener('devicechange', () => { if(!$('#cp').hidden) renderDevices(); }); }catch(e){}
$('#cpForget') && ($('#cpForget').onclick = () => {
  const mac = serverMode;
  if((!worker && !mac) || !confirm(`Forget what ${mac ? 'the Mac has' : 'this device has'} learned about how songs sound in this room?`)) return;
  if(mac) fetch('cue', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({action:'forget_room'})}).catch(()=>{});
  else worker.postMessage({type:'forget'});
  logEvent('input', `Room memory forgotten ${mac ? 'on the Mac' : 'on this device'}`);
});
// room memory is saved every few seconds; save now when the app goes to the background or closes
const flushRoom = () => { if(worker) worker.postMessage({type:'flush'}); };
document.addEventListener('visibilitychange', () => { if(document.visibilityState === 'hidden') flushRoom(); });
addEventListener('pagehide', flushRoom);
let holdT = null, holdXY = null;
addEventListener('pointerdown', e => { if(!$('#cp').hidden) return; holdXY = [e.clientX, e.clientY];
  clearTimeout(holdT); holdT = setTimeout(openPanel, 750); });
addEventListener('pointermove', e => { if(holdXY && Math.hypot(e.clientX-holdXY[0], e.clientY-holdXY[1]) > 12) clearTimeout(holdT); });
addEventListener('pointerup', () => clearTimeout(holdT));
addEventListener('pointercancel', () => clearTimeout(holdT));
addEventListener('keydown', e => { if(e.key === 'i') openPanel(); });
let stillT = 0;
const woke = () => { document.body.classList.remove('still'); clearTimeout(stillT);
                     stillT = setTimeout(() => document.body.classList.add('still'), 3000); };
addEventListener('pointermove', woke); addEventListener('pointerdown', woke); woke();

let serverMode = false, skew = 0;
async function sendToServer(){
  if(busy || !actx || ringLen < actx.sampleRate*1.5) return;      // first look after 1.5 s of sound
  const f = new Float32Array(ringLen); let o = 0;
  for(const c of ring){ f.set(c, o); o += c.length; }
  const i16 = new Int16Array(f.length);
  for(let i=0;i<f.length;i++){ const v = Math.max(-1, Math.min(1, f[i])); i16[i] = v*32767; }
  busy = true;
  try{ await fetch('hear', {method:'POST', headers:{'Content-Type':'application/octet-stream','X-Level':String(level),
                              'X-Rate':String(actx ? actx.sampleRate : SR)}, body:i16.buffer}); }
  catch(e){}
  busy = false;
}
async function pollServer(){
  try{
    const t0 = performance.now();
    const s = await (await fetch('state', {cache:'no-store'})).json();
    skew = s.server_now + (performance.now()-t0)/2000 - Date.now()/1000;
    const l = s.listen || {};
    lastDoubt = !!s.doubt;                  // the Mac says the song on screen stopped matching
    if(s.room) roomInfo = {songs: s.room.songs, postings: s.room.postings, ready: true, persist: true, mac: true};
    confNow = (l.conf_at && s.server_now - l.conf_at < 4) ? (l.conf || 0) : 0;
    if(l.last_match) lastMatchInfo = l.last_match;
    if(l.heard && l.heard_at && l.heard_at !== pollServer.heardAt && l.heard.trim().length > 3){
      pollServer.heardAt = l.heard_at; logEvent('heard', 'Heard: “' + l.heard.trim().slice(0, 120) + '”');
    }
    const song = s.song_id && SONGS[s.song_id];
    if(song && s.mode === 'words' && s.anchor != null) showWords(song, s.anchor);
    else if(song && s.started_at != null){
      const startedPerf = performance.now()/1000 - ((Date.now()/1000 + skew) - s.started_at);
      if(!st.song || st.song.id !== song.id || st.words || st.paused != null || Math.abs(st.started - startedPerf) > 0.25)
        catchSong(song, startedPerf, s.driver === 'words' ? (l.last_match && l.last_match.how) || 'from the sung words'
                                   : s.driver === 'live' ? 'a live recording: clock estimated, the singing corrects it'
                                   : (l.last_match && l.last_match.how) || 'following the track');
      st.lastConfirm = performance.now()/1000;
    }
    else if(!song && s.cued && SONGS[s.cued.song_id]){        // mentioned: the Mac holds it, clock stopped
      const c = s.cued, k = c.song_id + '#' + c.kind + '#' + c.cue;
      if(k !== pollServer.cued){
        pollServer.cued = k;
        const cs = SONGS[c.song_id];
        logEvent('heard', c.kind === 'title' ? `Heard the title “${c.name || cs.title}”: song ready`
                          : `Heard a line of ${cs.title}: “${((cs.cues[c.cue] || {}).text || '').slice(0, 60)}”. Holding it there`);
      }
      holdSong(SONGS[c.song_id], c);
    }
    else if(st.song) release();
    if(!s.cued) pollServer.cued = null;
    if(st.song) st.lastConfirm = performance.now()/1000;   // the Mac decides when to let go
  }catch(e){}
}
/* any rate -> 16 kHz: a triangle-weighted average around each output point (low-passes as it
   thins, so what's above 8 kHz doesn't fold back into the band the matcher listens to) */
function to16k(f, rate){
  if(Math.abs(rate - SR) < 1) return f;
  const r = rate / SR, n = Math.floor(f.length / r), out = new Float32Array(n), h = Math.max(1, r);
  for(let i = 0; i < n; i++){
    const c = i * r, a = Math.max(0, Math.ceil(c - h)), b = Math.min(f.length - 1, Math.floor(c + h));
    let s = 0, w = 0;
    for(let j = a; j <= b; j++){ const k = 1 - Math.abs(j - c) / h; s += f[j] * k; w += k; }
    out[i] = w ? s / w : 0;
  }
  return out;
}
function sendWindow(){
  if(serverMode) return sendToServer();
  if(!worker || !dec || !engineReady || busy || !actx || ringLen < actx.sampleRate*1.5) return;   // first look after 1.5 s
  const raw = new Float32Array(ringLen); let o = 0;
  for(const c of ring){ raw.set(c, o); o += c.length; }
  const f = to16k(raw, actx.sampleRate);
  const at = performance.now()/1000, win = f.length/SR;
  dec.heard(level, at);
  busy = true;
  const done = ev => { if(ev.data && ev.data.type === 'result'){ busy = false; worker.removeEventListener('message', done); } };
  worker.addEventListener('message', done);
  setTimeout(() => { busy = false; }, 4000);
  worker.postMessage({type:'match', pcm:f, win, at, track: dec.track(at, win), top: dec.top(at, win),
                     key: dec.key ? dec.key() : 0, keys: dec.keys ? dec.keys(at, keysAfford()) : null}, [f.buffer]);
}

/* ---------------- choreography ---------------- */
function dotUV(){
  const r = $('#dot').getBoundingClientRect(), m = Math.min(innerWidth, innerHeight);
  return [((r.left + r.width/2) - innerWidth/2)/m, (innerHeight/2 - (r.top + r.height/2))/m];
}
let attemptStart = null, lastMatchInfo = null;
function logIdentified(song, how){
  const secs = attemptStart == null ? null : performance.now()/1000 - attemptStart;
  const via = lastMatchInfo && lastMatchInfo.via ? ' from ' + String(lastMatchInfo.via).split('::')[1]?.replace(/-/g, ' ') : '';
  logEvent('identified', `Identified ${song.title}${secs == null ? '' : ' in ' + secs.toFixed(1) + ' s'}${via}${how ? ' (' + how + ')' : ''}`,
           {secs, song: song.id});
  attemptStart = null;
}
function catchSong(song, started, how){
  orbHome = '';
  const fresh = !st.song || st.song.id !== song.id || st.words, wasHeld = st.paused != null;
  // a correction while a song is up (another song, or the clock moved): the corner orb swells once
  // so the stage can see it just re-checked and moved
  if(st.song && (st.song.id !== song.id || (!wasHeld && Math.abs(st.started - started) > 1.0))){
    orb.pulse(); logEvent('heard', st.song.id !== song.id ? `Switched to ${song.title}` : `Corrected the place in ${song.title} by ${(started - st.started > 0 ? '-' : '+') + Math.abs(started - st.started).toFixed(1)} s`);
  }
  if(fresh || wasHeld) logIdentified(song, how || 'following the track');     // a held song starting counts as found
  st.words = null; st.paused = null; heldInfo = null; document.body.classList.remove('words');
  st.song = song; st.started = started; st.lastConfirm = performance.now()/1000;
  if(fresh){
    buildSong(song);
    orb.setAmbient(1);
    orb.explode();
    document.body.classList.add('song');
    document.body.classList.remove('caught'); void document.body.offsetWidth;
    document.body.classList.add('caught');
    setTimeout(() => document.body.classList.remove('caught'), 1600);
    setTimeout(() => { if(st.song === song){ const [x,y] = dotUV(); orb.toStatus(x, y); orbCorner = [x, y]; } }, 380);
  }
}
/* A MENTIONED song, held with its clock stopped (decide.js S.cue): its title was said (shown at its
   top, the first line waiting) or a line of it quoted (shown at that line). The music or the singing
   starts it (catchSong), another song replaces it, or it is let go. */
let heldInfo = null;
function holdSong(song, c){
  heldInfo = c;
  const pos = c.pos || 0;
  if(st.song && st.song.id === song.id && st.paused === pos && !st.words) return;
  const fresh = !st.song || st.song.id !== song.id || st.words;
  if(st.song && !fresh && st.paused == null) logEvent('heard', `Holding ${song.title} on the line last heard (no more singing, no music)`);
  st.words = null; document.body.classList.remove('words');
  st.song = song; st.started = null; st.paused = pos; st.lastConfirm = performance.now()/1000;
  activeCue = -2;
  if(fresh){
    orbHome = '';
    buildSong(song);
    orb.setAmbient(1);
    orb.explode();
    document.body.classList.add('song');
    document.body.classList.remove('caught'); void document.body.offsetWidth;
    document.body.classList.add('caught');
    setTimeout(() => document.body.classList.remove('caught'), 1600);
    setTimeout(() => { if(st.song === song){ const [x,y] = dotUV(); orb.toStatus(x, y); orbCorner = [x, y]; } }, 380);
  }
}
/* Where the orb lives when no song is up. Before the first song: the middle. After that it never
   takes over the screen again: it waits in its corner, listening. Only when it is NOT listening
   (microphone off, waiting for a tap) does it come back to the middle. */
let orbCorner = null, orbHome = '';
function placeOrb(){
  if(st.song) return;
  const listening = $('#gate').classList.contains('gone');
  const home = (!listening || !orbCorner) ? 'middle' : 'corner';
  if(home === orbHome) return;
  orbHome = home;
  if(home === 'corner') (() => { const z = cornerSize(), c = fitCorner(orbCorner[0], orbCorner[1], z); orb.toCorner(c[0], c[1], z); })(); else orb.toListening();
}
// in its corner the orb shows it's working: bigger while it hears music and hunts for the song,
// biggest as it closes in, calm and small when the room is quiet
function fitCorner(x, y, size){                 // keep the whole orb (and its glow) on screen, at any size
  const m = Math.min(innerWidth, innerHeight), hw = innerWidth / 2 / m, hh = innerHeight / 2 / m, r = size * 1.25 + 0.02;
  return [Math.max(-hw + r, Math.min(hw - r, x)), Math.max(-hh + r, Math.min(hh - r, y))];
}
function cornerSize(){
  const hunting = !serverMode && dec && dec.state.searching ? 1 : 0;
  const loud = Math.min(1, level * 3.2 / 0.12);
  const act = Math.max(confNow || 0, hunting * 0.7, loud * 0.45);
  return 0.1 + 0.2 * act;             // 0.10 resting .. 0.30 working hard
}
let cornerAt = 0;
function breatheCorner(now){          // refresh the corner size a few times a second, smoothly
  if(st.song || orbHome !== 'corner' || now - cornerAt < 0.25) return;
  cornerAt = now; (() => { const z = cornerSize(), c = fitCorner(orbCorner[0], orbCorner[1], z); orb.toCorner(c[0], c[1], z); })();
}
function release(){
  if(st.song) logEvent('release', `Let go of ${st.song.title}`);
  st.song = null; st.started = null; st.pending = null; st.words = null; st.paused = null; heldInfo = null;
  document.body.classList.remove('song', 'words');
  orb.setAmbient(0);
  orbHome = ''; placeOrb();
}
function showWords(song, anchor){
  const key = song.id + '#' + anchor;
  if(st.words === key) return;
  const fresh = !st.song || st.song.id !== song.id;
  if(fresh) logIdentified(song, 'following the singing');
  st.words = key; st.song = song; st.started = null; st.paused = null; heldInfo = null; st.lastConfirm = performance.now()/1000;
  if(fresh) buildSong(song);
  renderBlock(song, anchor);
  document.body.classList.add('song', 'words');
  orb.setAmbient(1);
  if(fresh){ orb.explode(); document.body.classList.remove('caught'); void document.body.offsetWidth;
             document.body.classList.add('caught'); setTimeout(() => document.body.classList.remove('caught'), 1600);
             setTimeout(() => { if(st.song === song){ const [x,y] = dotUV(); orb.toStatus(x, y); orbCorner = [x, y]; } }, 380); }
}
// the section that holds the sung line, whole; what was sung softens, the next section waits below
function renderBlock(song, anchor){
  const c = song.cues;
  let a0 = anchor, a1 = anchor;
  while(a0 > 0 && !c[a0-1].s) a0--;
  while(a1+1 < c.length && !c[a1+1].s) a1++;
  const hasSections = c.some(x => x.s);
  if(!hasSections){ a0 = Math.max(0, anchor-2); a1 = Math.min(c.length-1, anchor+5); }
  let sec = ''; for(let k=anchor;k>=0;k--) if(c[k].s){ sec = c[k].text; break; }
  $('#blkSec').textContent = sec ? sectionName(sec) : '';
  const lines = $('#blkLines'); lines.innerHTML = '';
  for(let k=a0;k<=a1;k++){
    if(c[k].s) continue;
    const p = document.createElement('p'); p.textContent = c[k].text;
    p.className = k === anchor ? 'hit' : k < anchor ? 'sung' : '';
    lines.appendChild(p);
  }
  // a glimpse of what comes next, so they can flow on
  let nk = a1 + 1, nsec = ''; if(nk < c.length && c[nk].s){ nsec = c[nk].text; nk++; }
  const nxt = []; while(nk < c.length && !c[nk].s && nxt.length < 2){ nxt.push(c[nk].text); nk++; }
  $('#blkNext').innerHTML = nxt.length
    ? `<span>Next${nsec ? ' · ' + esc(sectionName(nsec)) : ''}</span>` + nxt.map(esc).join('<br>') : '';
  const se = $('#sect'); se.textContent = sec ? sectionName(sec) : ''; se.classList.toggle('show', !!sec);
  requestAnimationFrame(fitBlock);
}
function fitBlock(){
  const blk = $('#blk'), box = $('#blockView'); if(!box.clientHeight) return;
  let lo = innerHeight*0.022, hi = innerHeight*0.115*zoom, best = lo;
  for(let n=0;n<9;n++){
    const mid = (lo+hi)/2; blk.style.fontSize = mid+'px';
    if(blk.scrollHeight <= box.clientHeight*0.94 && blk.scrollWidth <= box.clientWidth+1){ best = mid; lo = mid; } else hi = mid;
  }
  blk.style.fontSize = best+'px';
}

let cues = [], sections = [], lastNow = '', lastNext = '', lastSec = -1;
const esc = t => t.replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
function sectionName(t){
  let s = t.replace(/[:\-–]+\s*$/, '').trim().toLowerCase();
  const map = [[/\bpre[\s-]?chorus\b/,'Pre-Chorus'],[/\bchorus\b/,'Chorus'],[/\bverse\b/,'Verse'],[/\bbridge\b/,'Bridge'],
    [/\bintro(duction)?\b/,'Intro'],[/\boutro\b/,'Outro'],[/\binterlude\b/,'Interlude'],[/\brefrain\b/,'Refrain'],
    [/\bvamp\b/,'Vamp'],[/\bhook\b/,'Hook'],[/\bending\b/,'Ending'],[/\binstrumental\b/,'Instrumental'],
    [/\bbreak\b/,'Break'],[/\btag\b/,'Tag'],[/\bsolo\b/,'Solo'],[/\bad\s?lib\b/,'Ad Lib']];
  for(const [re,o] of map) s = s.replace(re, o);
  return s.replace(/\b[a-z]/g, c => c.toUpperCase());
}
let lineEls = [], activeCue = -2, gaps = [];
// a long wait before the next line (an intro, an instrumental) shows three dots that fill as the time
// passes, like Apple Music, so the singer sees the next line coming (Joel)
const GAP_SILENCE = 7.5;          // seconds of NO singing (after the line has been sung) before dots show: about two bars, not a long held line (Joel, 1 Oct)
const lineDur = text => Math.max(1.8, Math.min(7, 0.42 * text.split(/\s+/).length + 0.8));   // about how long a line takes to sing
function buildSong(song){
  cues = song.cues; lastSec = -1; activeCue = -2;
  $('#title').textContent = song.title;
  sections = [];
  cues.forEach((c,k) => { if(c.s) sections.push({i:k, t:c.t, label:sectionName(c.text)}); });
  const dur = song.duration || (cues.length ? cues[cues.length-1].t : 0);
  sections.forEach((x,n) => x.end = n+1 < sections.length ? sections[n+1].t : dur);
  $('#map').innerHTML = sections.length > 1
    ? sections.map(x => `<div class="sec"><u>${esc(x.label)}</u><i></i></div>`).join('') : '';
  { const strip = $('#map'), room = strip.parentElement.clientWidth;      // start centred when it all fits
    strip.style.transform = `translateX(${Math.max(0, (room - strip.scrollWidth) / 2)}px)`; }
  // one paragraph per sung line; a new section gets a little more air above it
  const col = $('#col'); col.innerHTML = ''; lineEls = []; gaps = [];
  let brk = false, prev = null;
  const addGap = (from, to, after) => {
    const g = document.createElement('div'); g.className = 'gap'; g.innerHTML = '<i></i><i></i><i></i>';
    col.appendChild(g); gaps.push({el: g, from, to, after});
  };
  cues.forEach((c,k) => {
    if(c.s){ brk = true; return; }
    if(c.t != null){
      if(prev == null){ if(c.t >= 6) addGap(0, c.t, -1); }                      // the intro
      else { const sung = lineDur(prev.text);                                     // the dots come once the line is over
        if(c.t - prev.t - sung >= GAP_SILENCE) addGap(prev.t + sung + 1, c.t, prev.k); }
      prev = {t: c.t, k, text: c.text};
    }
    const p = document.createElement('p'); p.className = 'ln' + (brk ? ' brk' : ''); brk = false;
    p.textContent = c.text; p.dataset.i = k; col.appendChild(p); lineEls[k] = p;
  });
  col.style.transition = 'none'; col.style.transform = 'translateY(50vh)';
  requestAnimationFrame(() => { col.style.transition = ''; });
}
// mark the sung line, dim what is past, soften what is further away, and glide it into place
function setActive(k, pending){
  const key = k + (pending ? 'p' : '');
  if(key === activeCue) return; activeCue = key;
  gaps.forEach(g => g.el.classList.remove('on'));
  let order = []; lineEls.forEach((el,i) => { if(el) order.push(i); });
  const pos = order.indexOf(k);
  order.forEach((i,n) => {
    const el = lineEls[i], d = n - pos;
    el.className = 'ln' + (el.classList.contains('brk') ? ' brk' : '')
      + (d === 0 ? (pending ? ' pending' : ' on') : d < 0 ? ' past' : d === 1 ? ' near' : '');
  });
  scrollTo(k);
}
// in a wait: the dots are the line being 'sung'; everything up to it is past, the next line is next
function setGap(n){
  const g = gaps[n], key = 'g' + n;
  if(key === activeCue) return; activeCue = key;
  gaps.forEach((x,m) => x.el.classList.toggle('on', m === n));
  let next = -1; for(let k = g.after + 1; k < cues.length; k++) if(lineEls[k]){ next = k; break; }
  lineEls.forEach((el,i) => { if(el) el.className = 'ln' + (el.classList.contains('brk') ? ' brk' : '')
    + (i <= g.after ? ' past' : i === next ? ' near' : ''); });
  scrollToEl(g.el);
}
function gapProgress(n, look){
  const g = gaps[n], f = Math.max(0, Math.min(1, (look - g.from) / Math.max(.001, g.to - g.from)));
  const dots = g.el.children;
  for(let j = 0; j < 3; j++){ const v = Math.max(0, Math.min(1, f*3 - j)); dots[j].style.setProperty('--f', v.toFixed(3)); }
}
function scrollToEl(el){
  const view = $('#view'); if(!el || !view) return;
  const y = view.clientHeight*0.5 - (el.offsetTop + el.offsetHeight/2);
  $('#col').style.transform = `translateY(${Math.round(y)}px)`;
}
function scrollTo(k){
  const el = lineEls[k], view = $('#view'); if(!el || !view) return;
  // the sung line sits in the middle of the lyric area, between the title bar and the section strip
  // (Joel: "it should really be in the center")
  const y = view.clientHeight*0.5 - (el.offsetTop + el.offsetHeight/2);
  $('#col').style.transform = `translateY(${Math.round(y)}px)`;
}
let zoom = parseFloat(localStorage.getItem('cm.zoom') || '1') || 1;
function refit(){
  // default lyric size (Joel: 30% bigger than the first version, for reading from the stage);
  // the pinch / +/- zoom multiplies on top of it
  $('#col').style.fontSize = (Math.min(innerHeight*0.12, Math.max(28, innerWidth*0.125)) * zoom).toFixed(1) + 'px';
  if(typeof activeCue === 'string' || typeof activeCue === 'number'){
    const k = parseInt(activeCue, 10); if(!isNaN(k)) requestAnimationFrame(() => scrollTo(k));
    else if(/^g\d+$/.test(activeCue)){ const g = gaps[+activeCue.slice(1)]; if(g) requestAnimationFrame(() => scrollToEl(g.el)); }
  }
}
function setZoom(z){
  zoom = Math.max(0.6, Math.min(3.0, z));
  try{ localStorage.setItem('cm.zoom', zoom.toFixed(3)); }catch(e){}
  document.body.classList.toggle('big', zoom >= 1.35);
  document.body.classList.toggle('huge', zoom >= 1.85);
  refit(); if(st.words) fitBlock();
  const t = $('#zoomTag'); t.textContent = Math.round(zoom*100)+'%'; t.classList.add('show');
  clearTimeout(setZoom._t); setZoom._t = setTimeout(() => t.classList.remove('show'), 900);
}

let soundSince = null, quietSince = null, lastLoud = 0, confNow = 0;
let deadSince = null;
function frame(){
  const now = performance.now()/1000;
  placeOrb();                         // cheap: only acts when where it should be has changed
  breatheCorner(now);
  orb.setLevel(Math.min(1, level*3.2));
  // A real microphone is never EXACTLY silent: even a quiet room has some hiss. Pure zeros for
  // a few seconds means the browser has cut the microphone off (Safari does this when its window
  // isn't in front, or after an interruption). Say so, and let one tap bring it back.
  // (not while word search is starting, running or handing the mic back: it watches the mic itself)
  if(words && words.guarding(now)) deadSince = null;
  else if(mstream && $('#gate').classList.contains('gone') && document.visibilityState === 'visible'){
    // ...but a MIXER LINE through a sound card is exactly silent whenever nothing is playing (a fader down,
    // a gate shut): zeros alone are not proof. Only zeros with the audio engine stopped or the track muted.
    const tr0 = mstream.getAudioTracks()[0], cut = (actx && actx.state !== 'running') || (tr0 && (tr0.muted || tr0.readyState === 'ended'));
    if(level === 0 && cut){ if(deadSince == null) deadSince = now;
      else if(now - deadSince > 4){ deadSince = null; logEvent('miss', 'The microphone went silent (cut off by the browser)');
        $('#gate b').textContent = 'The microphone stopped. Tap to turn it back on'; $('#gate').classList.remove('gone'); frame.silentGate = true; } }
    else deadSince = null;
  }
  // sound is coming in again: a 'microphone stopped' notice was wrong (or the browser recovered): clear it
  if(frame.silentGate && level > 0 && mstream && !(actx && actx.state !== 'running')){
    frame.silentGate = false; $('#gate').classList.add('gone'); logEvent('start', 'Sound is coming in again');
  }
  const loud = level*3.2 > 0.10, up = st.song && st.paused == null;   // a held (mentioned) song isn't found yet
  if(loud && !up && attemptStart == null){ attemptStart = now; logEvent('sound', 'Music started'); }
  showWhy(now, loud, up);
  drawMeter(now);
  if(attemptStart != null && !up && now - attemptStart > 30 && !frame.missLogged){
    frame.missLogged = true;
    const why = serverMode ? '' : !engineReady ? ' (the songs were still downloading, so it had nothing to compare with)'
      : closest ? ` (closest guess: ${(SONGS[closest.id] || {}).title || closest.id}, ${closest.votes} matches, not sure enough)`
      : ' (nothing in the music matched any song)';
    logEvent('miss', 'Heard 30 s of music but could not identify it' + why);
  }
  if(up || attemptStart == null) frame.missLogged = false;
  if(!loud && !up && attemptStart != null && now - lastLoud > 12) attemptStart = null;
  if(!$('#cp').hidden && (frame.pt = (frame.pt || 0) + 1) % 6 === 0){
    const db = 20*Math.log10(level || 1e-6);
    $('#cpMeter').style.width = Math.min(100, Math.max(0, (db + 70) / 60 * 100)) + '%';
    $('#cpLevel').textContent = db.toFixed(0) + ' dB';
    $('#cpHearing').innerHTML = rawLevel < 0.0004 ? '<span class="warn">Nothing coming in. Check the input below</span>' : level*3.2 > 0.10 ? 'Hearing music' : 'Quiet room';
    renderNow();
  }
  if(loud){ quietSince = null; if(soundSince == null) soundSince = now; }
  else { if(quietSince == null) quietSince = now; if(now - quietSince > 2) soundSince = null; }
  // the room glow follows how SURE it is, not how loud the room is: a sermon with no song
  // in sight stays calm; a song being found lights the room as it gets closer
  orb.setAtmos(st.song ? 0 : Math.min(1, confNow * 1.1));
  orb.setConfidence(st.song ? 0 : confNow);
  orb.setDoubt(!!(st.song && (serverMode ? lastDoubt : (dec && dec.state.doubt))));
  // silence is not evidence against the song: only sustained unmatched MUSIC, or a long
  // quiet (the music has stopped), lets it go
  if(loud) lastLoud = now;
  if(!serverMode && dec){
    dec.tick(now);
    // the end-of-song rule below, for songs the listener didn't put up (a hand/demo song would
    // otherwise be released and caught again every frame)
    const ds = dec.state, dsong = ds.song_id && SONGS[ds.song_id];
    if(dsong && ds.started_at != null && now - ds.started_at > (dsong.duration || 1e9) + 2.5) dec.stop();
    applyLocal(now);
    const s = dec.state; confNow = (s.song_id == null && now - s.conf_at < 4) ? s.conf : 0;
    if(words) words.set(WORDS_CLOUD && !!mstream && dec.wantWords());
  }
  // the song has run out: let it go now rather than holding the last line
  if(st.song && st.started != null && (now - st.started) > (st.song.duration || 1e9) + 2.5) release();
  if(st.song && (st.started != null || st.paused != null)){
    // held (mentioned, clock stopped): exactly the line held, no lead
    const p = st.paused != null ? st.paused : now - st.started, look = st.paused != null ? p + 0.01 : p + LEAD;
    let i = -1; for(let k=0;k<cues.length;k++){ if(cues[k].t <= look) i = k; else break; }
    let ci = i; while(ci >= 0 && cues[ci].s) ci--;
    // the line being sung; before the first line, put that first line up early (dimmed)
    const gn = st.paused != null ? -1 : gaps.findIndex(g => look >= g.from && look < g.to);
    if(gn >= 0){ setGap(gn); gapProgress(gn, look); }
    else if(ci >= 0) setActive(ci, false);
    else { let f = i+1; while(f < cues.length && cues[f].s) f++; if(f < cues.length) setActive(f, true); }
    let sect = ''; for(let k=i;k>=0;k--) if(cues[k].s){ sect = cues[k].text; break; }
    const se = $('#sect'), nm = sect ? sectionName(sect) : '';
    if(se.textContent !== nm) se.textContent = nm;
    se.classList.toggle('show', !!nm);
    const dur = st.song.duration || cues[cues.length-1].t || 1, left = Math.max(0, dur - p);
    $('#clock').textContent = `-${Math.floor(left/60)}:${String(Math.floor(left%60)).padStart(2,'0')}`;
    if(sections.length > 1){
      let cur = -1; for(let k=0;k<sections.length;k++){ if(sections[k].t <= look) cur = k; else break; }
      const kids = $('#map').children;
      for(let k=0;k<kids.length;k++){
        const sec = sections[k], on = k === cur, done = k < cur;
        kids[k].classList.toggle('on', on); kids[k].classList.toggle('done', done);
        const f = done ? 1 : on ? Math.max(0, Math.min(1, (look - sec.t)/Math.max(.001, sec.end - sec.t))) : 0;
        kids[k].lastElementChild.style.setProperty('--f', f.toFixed(3));
      }
      if(cur >= 0 && cur !== lastSec){
        lastSec = cur; const el = kids[cur], strip = $('#map'), room = strip.parentElement.clientWidth;
        // all the sections fit: sit them centred across the bottom. They don't: slide so the one
        // being sung stays in the middle, never past either end
        if(el){ const fits = strip.scrollWidth <= room;
                const shift = fits ? (room - strip.scrollWidth) / 2
                  : Math.max(room - strip.scrollWidth, Math.min(0, room/2 - (el.offsetLeft + el.offsetWidth/2)));
                strip.style.transform = `translateX(${shift}px)`; }
      }
    }
  }
  requestAnimationFrame(frame);
}

/* ---------------- gestures ---------------- */
let pb = 0, pz = 1;
const dist = t => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
addEventListener('touchstart', e => { if(e.touches.length === 2){ pb = dist(e.touches); pz = zoom; } }, {passive:true});
addEventListener('touchmove', e => { if(e.touches.length === 2 && pb > 0){ e.preventDefault(); setZoom(pz*dist(e.touches)/pb); } }, {passive:false});
addEventListener('touchend', () => { pb = 0; }, {passive:true});
addEventListener('gesturestart', e => { e.preventDefault(); pz = zoom; }, {passive:false});
addEventListener('gesturechange', e => { e.preventDefault(); setZoom(pz*e.scale); }, {passive:false});
addEventListener('wheel', e => { if(e.ctrlKey || e.metaKey){ e.preventDefault(); setZoom(zoom*(1 - e.deltaY*0.004)); } }, {passive:false});
addEventListener('keydown', e => {
  if(e.key === '+' || e.key === '=') setZoom(zoom*1.1);
  if(e.key === '-') setZoom(zoom/1.1);
  if(e.key === '0') setZoom(1);
});
addEventListener('resize', () => { refit(); if(st.words) fitBlock(); if(st.song){ const [x,y] = dotUV(); orb.toStatus(x,y); orbCorner = [x, y]; }
  else if(orbCorner){ const [x,y] = dotUV(); if(isFinite(x) && isFinite(y)) orbCorner = [x, y]; orbHome = ''; } });

/* ---------------- stay awake, stay listening ----------------
   On a music stand the screen must never dim or sleep, and after a phone call, a lock or a
   switch to another app the microphone has to come back by itself. */
let wake = null, awakeVid = null;
async function keepAwake(){
  if(document.visibilityState !== 'visible') return;
  try{
    if('wakeLock' in navigator){
      if(!wake){ wake = await navigator.wakeLock.request('screen'); wake.addEventListener('release', () => { wake = null; }); }
      return;
    }
  }catch(e){ wake = null; }
  // older iPads: a tiny silent video playing inline keeps the screen on
  if(!awakeVid){
    awakeVid = document.createElement('video');
    Object.assign(awakeVid, {src:'awake.mp4', muted:true, loop:true, playsInline:true});
    awakeVid.setAttribute('playsinline', ''); awakeVid.setAttribute('muted', '');
    awakeVid.style.cssText = 'position:fixed;width:1px;height:1px;opacity:0;pointer-events:none';
    document.body.appendChild(awakeVid);
  }
  awakeVid.play().catch(() => {});
}
async function reviveMic(){
  if(document.visibilityState !== 'visible' || !$('#gate').classList.contains('gone')) return;
  const tr = mstream && mstream.getAudioTracks()[0];
  // only a track that has ENDED is gone. Safari mutes a track for a moment while the page is
  // hidden and unmutes it by itself; restarting then would fight it.
  const dead = !tr || tr.readyState === 'ended';
  try{
    if(dead){ await startMic(inputId); logEvent('start', 'Microphone back on'); return; }
    if(actx && actx.state !== 'running') await actx.resume();
  }catch(e){}
  // still not running: Safari only restarts sound after a tap, so ask for one
  if(dead || (actx && actx.state !== 'running')){
    $('#gate b').textContent = 'Tap to keep listening'; $('#gate').classList.remove('gone');
  }
}
document.addEventListener('visibilitychange', () => { keepAwake(); reviveMic(); });
addEventListener('pageshow', () => { keepAwake(); reviveMic(); });
setInterval(reviveMic, 5000);              // a track can end quietly (headphones pulled, input unplugged)

/* ---------------- the sung words (no Mac) ---------------- */
// Words heard (from the on-device recogniser, or the browser's own): titles and lines through the
// same rules. pool = the last ~9 s of words, recent = the newest of them, at = when they were heard.
function heardWords(pool, recent, at){
  if(!dec) return;
  if(!LSIX) LSIX = LS.createIndex(Object.values(SONGS), PREACHED);
  if(MN && !TIX) TIX = MN.createTitleIndex(Object.values(SONGS), TITLES || {});   // private songs too, once unlocked
  const now = performance.now()/1000;
  // a title said: its song goes up held at its top, waiting for the music
  const tt = TIX ? dec.titles(pool, at, now, TIX, LSIX) : null;
  if(tt) logEvent('heard', `Heard the title “${tt.name}”: song ready` +
                           (SONGS[tt.song_id].title !== tt.name ? ` (${SONGS[tt.song_id].title})` : '') +
                           (tt.how !== 'its title' ? ` (${tt.how.replace(/^its title, (and )?/, '')})` : ''));
  const before = {id: dec.state.song_id, started: dec.state.started_at,
                  held: dec.state.cue && dec.state.cue.song_id + '#' + dec.state.cue.cue};
  if(!dec.words(pool, recent, at, now, LSIX)){ if(tt) applyLocal(now); return; }
  const s = dec.state, song = SONGS[s.song_id], held = !s.song_id && s.cue && SONGS[s.cue.song_id];
  if(held && s.cue.kind === 'line' && before.held !== s.cue.song_id + '#' + s.cue.cue)
    logEvent('heard', `Heard a line of ${held.title}: “${(held.cues[s.cue.cue].text || '').slice(0, 60)}”. Holding it there until the singing or the music goes on`);
  else if(song && before.id === s.song_id && before.started != null && s.started_at != null)
    logEvent('info', `Moved ${song.title} to the line being sung (${(before.started - s.started_at >= 0 ? '+' : '')}${(before.started - s.started_at).toFixed(1)} s)`);
  else if(song && s.last_match && s.last_match.line)
    logEvent('info', `The words “${s.last_match.line.slice(0, 60)}” are in ${song.title}`);
  applyLocal(now);
}

/* ---------------- listening to the words ON THIS DEVICE ----------------
   Joel: "there shouldn't be anything like 'may need internet'". Whisper tiny.en runs in its own
   worker (asr/asr-worker.js) on the room's own audio: every 5 s while no song is up, the last 5 s
   at 16 kHz. Nothing leaves the device; after the first visit it works with no internet at all.
   A device that takes over ASR_SLOW for a window hears every other window; while the fingerprint
   looks are struggling it waits (the fingerprints always come first). */
const ASR_EVERY = 5000, ASR_SLOW = 2500;
let asrW = null, asrReady = false, asrBusy = false, asrMs = [], asrOdd = false, asrPool = [], asrInfo = 'starting', asrLoadMs = null;
let cleanASR = t => String(t || '').trim();       // asrtext.js replaces it once loaded
const asrMedian = () => { const a = asrMs.slice().sort((x, y) => x - y); return a.length ? a[a.length >> 1] : 0; };
function startASR(){
  if(asrW || serverMode) return;
  import('./asrtext.js?v=' + APP_VERSION).then(m => { cleanASR = m.cleanASR; }).catch(e => console.warn('asrtext:', e));
  try{ asrW = new Worker('asr/asr-worker.js', {type: 'module'}); }
  catch(e){ asrW = null; asrInfo = 'not available in this browser'; return; }
  asrW.onmessage = ev => {
    const m = ev.data || {};
    if(m.type === 'ready'){ asrReady = true; asrInfo = 'on'; asrLoadMs = m.ms;
      logEvent('info', `Listening to the words on this device (ready in ${(m.ms / 1000).toFixed(1)} s)`); }
    else if(m.type === 'heard'){ asrBusy = false; asrMs.push(m.ms); if(asrMs.length > 24) asrMs.shift(); onASR(m.text, m.at); }
    else if(m.type === 'error'){ asrBusy = false; if(!asrReady) asrInfo = 'could not start (' + m.message + ')'; console.warn('asr:', m.message); }
  };
  asrW.onerror = e => { asrInfo = 'could not start'; asrW = null; console.warn('asr worker:', e && e.message); };
  asrW.postMessage({type: 'load'});
  setInterval(asrTick, ASR_EVERY);
}
function asrTick(){
  if(!asrW || !asrReady || !dec || !actx || !mstream || document.visibilityState !== 'visible') return;
  if(!dec.wantWords()){ asrPool = []; return; }          // a song is up and the fingerprints follow it
  if(asrBusy) return;                                     // still on the last window: this one is skipped
  if(asrMedian() > ASR_SLOW){ asrOdd = !asrOdd; if(asrOdd) return; }       // a slow device: every other window
  if(costBase != null && costBase > 0.8 * EVERY) return;  // the fingerprint looks are struggling: they come first
  if(ringLen < actx.sampleRate * 4) return;
  const raw = new Float32Array(ringLen); let o = 0;
  for(const c of ring){ raw.set(c, o); o += c.length; }
  const f = to16k(raw, actx.sampleRate);
  let e = 0; for(let i = 0; i < f.length; i++) e += f[i] * f[i];
  if(Math.sqrt(e / f.length) < 0.002) return;             // silence: Whisper would only imagine words
  asrBusy = true;
  asrW.postMessage({type: 'hear', pcm: f, at: performance.now() / 1000}, [f.buffer]);
  setTimeout(() => { asrBusy = false; }, 15000);          // never stuck
}
// for testing with no microphone: ?asrfile=<audio url> plays nothing aloud; it decodes the file and
// feeds it to the on-device recogniser 5 s at a time, exactly as the microphone would be
async function asrFeedFile(url){
  while(!asrReady) await new Promise(r => setTimeout(r, 500));
  const buf = await (await fetch(url)).arrayBuffer();
  const tmp = new OfflineAudioContext(1, 16000, 16000), dec0 = await tmp.decodeAudioData(buf);
  const oc = new OfflineAudioContext(1, Math.ceil(dec0.duration * 16000), 16000);
  const src = oc.createBufferSource(); src.buffer = dec0; src.connect(oc.destination); src.start();
  const pcm = (await oc.startRendering()).getChannelData(0);
  logEvent('info', `Test: feeding ${Math.round(dec0.duration)} s of ${url} to the on-device recogniser`);
  for(let o = 0; o + 80000 <= pcm.length; o += 80000){
    const at = performance.now() / 1000;
    if(dec) dec.heard(0.05, at);
    const r = await new Promise(res => { const h = ev => { if(ev.data && (ev.data.type === 'heard' || ev.data.type === 'error')){ asrW.removeEventListener('message', h); res(ev.data); } };
      asrW.addEventListener('message', h); asrBusy = true; asrW.postMessage({type: 'hear', pcm: pcm.slice(o, o + 80000), at}); });
    await new Promise(r => setTimeout(r, Math.max(0, 5000 - (performance.now() / 1000 - at) * 1000)));
  }
}
function onASR(text, at){
  asrPool = asrPool.filter(x => at - x.at <= 9.5);        // the last ~9 s (two windows), as the Mac pools
  const t = cleanASR(text);
  if(!t) return;
  if(!(asrPool.length && asrPool[asrPool.length - 1].t.toLowerCase() === t.toLowerCase())) asrPool.push({at, t});
  logEvent('heard', 'Heard: “' + t.slice(0, 120) + '”');
  heardWords(asrPool.map(x => x.t).join(' '), t, at);
}

/* ---------------- the browser's own speech recognition (an extra, only if WORDS_CLOUD) ----------------
   Chrome sends the audio to Google, Safari to Apple: with no internet it stops. The on-device
   recogniser above is what the app relies on; this is off unless it earns its place. */
const WORDS_CLOUD = false;
let words = null, LSIX = null, LS = null, MN = null, TIX = null, TITLES = null, PREACHED = [];
const WORD_SEARCH = true;            // the browser's own speech recognition (words.js): titles and lines
async function startWords(){
  if(!WORD_SEARCH) return;
  try{
    LS = await import('./lyricsearch.js?v=' + APP_VERSION);
    // song titles (and other names songs go by): a title said pulls its song up (mention.js)
    try{ MN = await import('./mention.js?v=' + APP_VERSION);
         TITLES = await (await fetch('data/titles.json?v=' + APP_VERSION)).json(); }catch(e){ console.warn('titles:', e); TITLES = TITLES || {}; }
    // the lyric phrases the preacher uses every week: a line made only of these must be heard twice
    try{ PREACHED = (await (await fetch('data/preached.json?v=' + APP_VERSION)).json()).grams || []; }catch(e){ PREACHED = []; }
    words = (await import('./words.js?v=' + APP_VERSION)).createWordListener({
      now: () => performance.now()/1000,
      health: () => ({frameAt: lastFrameAt, level, track: mstream && mstream.getAudioTracks()[0], actx}),
      log: (kind, text) => logEvent(kind, text),
      onMicTrouble: restoreMic,
      onWords: (pool, recent, at) => { if(WORDS_CLOUD && navigator.onLine !== false) heardWords(pool, recent, at); },
    });
    if(!words.supported) logEvent('info', 'Word search isn’t available in this browser; songs are found from the music alone');
    probeWords();                      // the microphone may already be on
  }catch(e){ words = null; console.warn('words:', e); }
}
// try word search once, 3 s after the microphone starts, so any permission question comes up at
// setup rather than mid-song, and a device where it upsets the microphone is found out now
function probeWords(){
  if(probeWords.done || !WORDS_CLOUD || !words || !words.supported || serverMode || !mstream) return;
  probeWords.done = true;
  setTimeout(async () => { await words.probe(); logEvent('info', 'Word search: ' + words.describe()); }, 3000);
}
// Word search interrupted the microphone: bring it back, without a tap if at all possible
async function restoreMic(){
  const t0 = performance.now()/1000, ok = () => {
    const tr = mstream && mstream.getAudioTracks()[0];
    return tr && tr.readyState === 'live' && !tr.muted && actx && actx.state === 'running' &&
           performance.now()/1000 - lastFrameAt < 0.5 && level > 0;
  };
  const wait = ms => new Promise(r => setTimeout(r, ms));
  for(let i = 0; i < 8 && !ok(); i++){ await wait(200); if(actx && actx.state !== 'running') try{ await actx.resume(); }catch(e){} }
  if(ok()){ logEvent('start', 'Microphone fine again'); return; }
  try{ await startMic(inputId, {keepContext: true}); }catch(e){}
  for(let i = 0; i < 8 && !ok(); i++) await wait(200);
  if(ok()) logEvent('start', `Microphone back on (${(performance.now()/1000 - t0).toFixed(1)} s)`);
  else reviveMic();          // the usual path: a restart, or one tap if the browser insists
}

/* ---------------- boot ---------------- */
/* iPhone/iPad only let sound start during a tap: make and start the audio graph right here,
   before anything is awaited (the microphone prompt would use the tap up) */
function unlockAudio(){
  try{
    if(!actx || actx.state === 'closed') actx = new (window.AudioContext || window.webkitAudioContext)();
    if(actx.state !== 'running') actx.resume().catch(() => {});
  }catch(e){}
}
async function begin(){
  unlockAudio();
  keepAwake();
  $('#gate').classList.add('gone');
  try{ await startMic(inputId, {reuse:true}); orbHome = ''; placeOrb();
       const tr = mstream && mstream.getAudioTracks()[0]; logEvent('start', 'Started, listening from ' + ((tr && tr.label) || 'the default input'));
       try{ localStorage.setItem('cm.micok', '1'); }catch(e){}             // next time: start without a tap
       probeWords();
  }catch(e){
    // say WHY, in words a singer can act on, and keep the real error in the log
    const n = (e && e.name) || 'Error';
    const why = n === 'NotAllowedError' ? ['Microphone is switched off for Prompter', 'Open Settings, then Apps, then Safari, then Microphone, and choose Allow. Then tap here.']
      : n === 'AudioNotStarted' ? ['Tap once more to start listening', 'The phone wants one more tap before it plays sound.']
      : n === 'NotFoundError' ? ['No microphone found', 'Plug in or choose a microphone, then tap here.']
      : n === 'NotReadableError' ? ['Another app is using the microphone', 'Close it (a call, a recording, another listening app), then tap here.']
      : ['Microphone not available', `Tap to try again. (${n}${e && e.message ? ': ' + e.message : ''})`];
    $('#gate b').textContent = why[0]; $('#gate small').textContent = why[1];
    logEvent('miss', `Microphone did not start: ${n}${e && e.message ? ' (' + e.message + ')' : ''}`);
    $('#gate').classList.remove('gone');
  }
  document.documentElement.requestFullscreen?.().catch(()=>{});
}
$('#gate').addEventListener('click', begin);

/* the welcome sheet: once per person (and again whenever WELCOME changes, to say what's new) */
const WELCOME = '1';
/* one-click "save to this device": the browser's own install prompt where it exists (Chrome, Edge,
   Android). iPhone/iPad and Mac Safari don't allow a site to add itself, so there the button
   shows exactly where to tap. */
let deferredInstall = null;
function installInfo(){
  const ua = navigator.userAgent;
  return {standalone: matchMedia('(display-mode: standalone), (display-mode: fullscreen)').matches || !!navigator.standalone,
          ios: /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1),
          ipad: /iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1),
          macSafari: /Macintosh/.test(ua) && navigator.maxTouchPoints <= 1 && /Safari/.test(ua) && !/Chrome|Chromium|Edg/.test(ua)};
}
function refreshInstall(){
  const i = installInfo();
  // the button exists only where it truly works in one tap (the browser's own install prompt)
  const label = (!i.standalone && deferredInstall) ? 'Add to this device' : '';
  for(const b of [$('#wInstall'), $('#cpInstall')]){ b.hidden = !label; b.textContent = label; }
  if(label && !i.standalone) $('#wKeep').textContent = '';          // the button says it; no second instruction
}
async function doInstall(e){
  e && e.stopPropagation();
  const i = installInfo();
  if(deferredInstall){ deferredInstall.prompt(); try{ await deferredInstall.userChoice; }catch(err){} deferredInstall = null; refreshInstall(); return; }
  const h = $('#saveHelp');
  const B = t => `<b style="display:inline;font-size:inherit">${t}</b>`;
  if(i.macSafari){ h.querySelector('.card').innerHTML = `<b>Add Prompter to your Dock</b>In the menu bar, choose ${B('File')}, then ${B('Add to Dock')}.`; h.querySelector('.arrow').hidden = true; }
  else if(!i.ios){          // Chrome/Edge/Android before their own prompt is ready
    h.querySelector('.card').innerHTML = /Android/.test(navigator.userAgent)
      ? `<b>Add Prompter to this phone</b>Tap the ${B('⋮')} menu at the top right of Chrome, then ${B('Install app')} (or ${B('Add to Home screen')}).`
      : `<b>Add Prompter to this computer</b>Click the install icon at the right end of the address bar, or open the browser menu and choose ${B('Install Prompter')}.`;
    h.querySelector('.arrow').hidden = true; h.classList.add('ipad');
  }
  h.classList.toggle('ipad', i.ipad); $('#shareWhere') && ($('#shareWhere').textContent = i.ipad ? 'at the top of the screen' : 'at the bottom of the screen');
  h.hidden = false;
}
addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferredInstall = e; refreshInstall(); });
addEventListener('appinstalled', () => { deferredInstall = null; refreshInstall(); logEvent('start', 'Saved to this device'); });
$('#wInstall').addEventListener('click', doInstall);
$('#cpInstall').addEventListener('click', e => { $('#cp').hidden = true; doInstall(e); });
$('#saveHelp').addEventListener('click', e => { e.stopPropagation(); $('#saveHelp').hidden = true; });
$('#saveHelp').addEventListener('pointerdown', e => e.stopPropagation());

function showWelcome(){
  const ua = navigator.userAgent, standalone = matchMedia('(display-mode: standalone), (display-mode: fullscreen)').matches || navigator.standalone;
  const ios = /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  $('#wKeep').textContent = standalone ? '' :
    ios ? 'To keep it on this iPad or iPhone: tap Share, then Add to Home Screen.' :
    /Android/.test(ua) ? 'To keep it on this phone: open the Chrome menu, then Install app.' :
    /Macintosh/.test(ua) && /Safari/.test(ua) && !/Chrome/.test(ua) ? 'To keep it on this Mac: in the menu bar choose File, then Add to Dock.' :
    'To keep it on this computer: click the install icon at the right of the address bar.';
  $('#welcome').hidden = false; $('#welcome').classList.remove('leaving');
  refreshInstall();
}
$('#wGo').addEventListener('click', e => {
  e.stopPropagation();
  try{ localStorage.setItem('cm.welcome', WELCOME); }catch(err){}
  $('#welcome').classList.add('leaving');
  setTimeout(() => { $('#welcome').hidden = true; }, 450);
  if(!$('#gate').classList.contains('gone')) begin();        // this tap is the one that starts the microphone
});
$('#welcome').addEventListener('pointerdown', e => e.stopPropagation());
$('#cpAbout').addEventListener('click', () => { $('#cp').hidden = true; showWelcome(); });
let seen = null; try{ seen = localStorage.getItem('cm.welcome'); }catch(e){}
if(seen !== WELCOME && !new URLSearchParams(location.search).get('demo')) showWelcome();
$('#cpDone').addEventListener('click', () => { $('#cp').hidden = true; });
$('#cpBtn').addEventListener('click', e => { e.stopPropagation(); openPanel(); });
$('#cpBtn').addEventListener('pointerdown', e => e.stopPropagation());
$('#cpCopy').addEventListener('click', async () => {
  const text = LOG.map(e => `${new Date(e.t).toISOString()}  ${e.kind}  ${e.text}`).join('\n');
  try{ await navigator.clipboard.writeText(text); $('#cpCopy').textContent = 'Copied'; }
  catch(err){ $('#cpCopy').textContent = 'Copy not allowed here'; }
  setTimeout(() => $('#cpCopy').textContent = 'Copy log', 1500);
});
document.body.classList.toggle('big', zoom >= 1.35);
document.body.classList.toggle('huge', zoom >= 1.85);

/* ---------------- everything kept on the device ----------------
   The big files (the song index, the learned fingerprint, the speech model and their runtimes,
   ~180 MB) are fetched here, through sw.js once it has taken control, which stores each one. Not in
   sw.js's install: a browser allows an install only about 5 minutes, and on a slow connection
   (0.6 MB/s measured on 30 Sep) that failed, and then nothing worked offline. One file at a time;
   what is already stored comes straight back. */
async function keepOffline(){
  if(APP_VERSION === 'dev' || !navigator.onLine) return;
  await navigator.serviceWorker.ready;
  if(!navigator.serviceWorker.controller)
    await new Promise(r => { navigator.serviceWorker.addEventListener('controllerchange', r, {once: true}); setTimeout(r, 20000); });
  if(!navigator.serviceWorker.controller) return;
  const list = [];
  try{ const m = await (await fetch('engine/manifest.json')).json(); for(const x of m.shards || []) list.push('engine/' + (x.file || x)); }catch(e){}
  try{ const m2 = await (await fetch('engine/fp2/manifest.json')).json();
       list.push('engine/fp2/' + m2.model.file, ...(m2.shards || []).map(x => 'engine/fp2/' + x.file));
       const ORT = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/';
       for(const f of ['ort.wasm.min.js', 'ort.wasm.min.mjs', 'ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm']) list.push(ORT + f); }catch(e){}
  try{ const a = await (await fetch('asr/manifest.json')).json();
       for(const f of a.files) list.push('asr/' + f.file);
       for(const f of a.runtime.files) list.push(a.runtime.base + f); }catch(e){}
  let n = 0;
  for(const u of list){ try{ const r = await fetch(u); if(r.ok){ await r.arrayBuffer(); n++; } }catch(e){} }
  logEvent('info', `Kept on this device for use with no internet: ${n} of ${list.length} files`);
}

/* ---------------- always the newest version when online ----------------
   GitHub keeps serving an old copy for up to 10 minutes after a publish, and the offline store
   keeps the version it has. So on every open (and whenever it comes back to the front) the app
   asks what the newest version is, bypassing every cache, and if it's behind it reloads itself
   onto that exact version. Never while a song is on screen. */
async function checkUpdate(){
  if(APP_VERSION === 'dev' || serverMode || st.song || st.words) return;
  try{
    const v = (await (await fetch('version.json?t=' + Date.now(), {cache:'no-store'})).json()).version;
    if(!v || v === APP_VERSION) return;
    // NEVER reload while listening: a reload stops the microphone, and a browser may not restart it without a
    // click (30 Sep: a machine sat deaf for 13 minutes in a service). The update waits for the next opening.
    if(mstream){ updateWaiting = v; return; }
    const k = 'cm.upd.' + v;
    if(sessionStorage.getItem(k)) return;          // already tried this one: don't loop
    sessionStorage.setItem(k, '1');
    const kq = new URLSearchParams(location.search).get('k');
    location.replace(location.pathname + '?' + (kq ? 'k=' + encodeURIComponent(kq) + '&' : '') + 'v=' + encodeURIComponent(v));
  }catch(e){}                                      // offline: the stored copy is the right one
}
function showVersion(){
  const pretty = APP_VERSION === 'dev' ? 'running from this Mac'
    : APP_VERSION.replace(/^(\d{4})(\d\d)(\d\d)(\d\d)(\d\d)$/, (m, y, mo, d, h, mi) =>
        new Date(+y, +mo - 1, +d, +h, +mi).toLocaleString([], {day:'numeric', month:'short', hour:'numeric', minute:'2-digit'}));
  $('#cpVer').textContent = 'Version ' + pretty + (privateCount ? ` · ${privateCount} private songs unlocked` : '');
  const q = new URLSearchParams(location.search);
  if(q.get('v')){                                  // we just updated: say so, then tidy the address
    const t = $('#toast'); t.textContent = 'Prompter updated'; t.hidden = false;
    setTimeout(() => { t.hidden = true; }, 3500);
    q.delete('v'); history.replaceState(null, '', location.pathname + (q.toString() ? '?' + q : ''));
  }
}
document.addEventListener('visibilitychange', () => { if(document.visibilityState === 'visible') checkUpdate(); });
setInterval(checkUpdate, 3 * 60 * 1000);          // left open all day: still picks up a new version between songs

// for testing without audio:  ?demo=<song id>@<seconds into the song>
const demo = new URLSearchParams(location.search).get('demo');
const asrfile = new URLSearchParams(location.search).get('asrfile');
// start-up, as one async function: top-level await needs Chrome 89+, and smart TVs run older engines
// (a Nasco Android 11 TV's browser is Chrome 83: with top-level await the whole app failed to load)
(async () => {
await loadSongs();
refit();
showVersion();
refreshInstall();
try{ const r = await fetch('fpstatus', {cache:'no-store'}); if(r.ok) serverMode = !!(await r.json()).ready; }catch(e){}
if(serverMode){
  $('#load').classList.add('done');
  setInterval(pollServer, 150);            // the Mac says what it heard: check often, it is on this network
}else{
  let LOOPS = []; try{ LOOPS = await (await fetch('data/loops.json?v=' + APP_VERSION)).json(); }catch(e){}
  try{ dec = (await import('./decide.js?v=' + APP_VERSION)).createDecider(id => SONGS[id], {KEYS: [], LOOPS}); }catch(e){ console.warn('decide.js:', e); }   // KEYS: [] = key-change search OFF (30 Sep): six extra keys named wrong songs on an unknown song (Destiny)
  startEngine();
  await startWords();
  startASR();                              // the words, heard on this device
  if('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').then(() => keepOffline()).catch(()=>{});
  checkUpdate();
}

if(asrfile && !serverMode){ $('#gate').classList.add('gone'); asrFeedFile(asrfile).catch(e => console.warn('asrfile:', e)); }
if(demo){
  const [id, at] = demo.split('@');
  $('#gate').classList.add('gone'); orb.toListening();
  if(at && at.startsWith('held')){      // ?demo=<id>@held (called by its title) or @held<seconds> (a line quoted)
    setTimeout(() => { if(SONGS[id]){ const pos = parseFloat(at.slice(4)) || 0;
      const c = {song_id: id, kind: pos ? 'line' : 'title', cue: null, pos, at: 0, last: 1e12, name: SONGS[id].title, how: 'demo'};
      if(!serverMode && dec) dec.state.cue = c;
      holdSong(SONGS[id], c); st.lastConfirm = 1e12; } }, 1200);
  }else if(at && at.startsWith('w')){
    setTimeout(() => { if(SONGS[id]){ showWords(SONGS[id], parseInt(at.slice(1), 10)); st.lastConfirm = 1e12;
      if(!serverMode && dec) dec.hold({song_id:id, mode:'words', anchor:parseInt(at.slice(1), 10)}, performance.now()/1000); } }, 1200);
  }else{
    const hold = parseFloat(new URLSearchParams(location.search).get('hold') || '0');
    setTimeout(() => { if(SONGS[id]){ catchSong(SONGS[id], performance.now()/1000 - parseFloat(at || '0'));
      st.lastConfirm = hold ? performance.now()/1000 + hold - RELEASE_SEC : 1e12;
      // offline: 'hold' = let it go after that many seconds of quiet, as the listener would
      if(!serverMode && dec){ const t = performance.now()/1000;
        dec.hold(hold ? {song_id:id, started_at:st.started, driver:'ear', active:true, last_loud:t + hold - dec.config.SILENCE_SEC}
                      : {song_id:id, started_at:st.started}, t); } } }, 1500);
  }
}
frame();

/* stress-free start: once the microphone has been allowed and the welcome has been seen, opening
   Prompter starts listening straight away, no tap (a TV or a phone on a stand shouldn't need
   touching). If the browser still wants one tap before it will process sound, begin() shows
   "Tap once more" and nothing else. */
(async () => {
  if(demo) return;
  let granted = false, seen = false;
  try{ granted = (await navigator.permissions.query({name:'microphone'})).state === 'granted'; }catch(e){}
  try{ seen = localStorage.getItem('cm.welcome') === WELCOME; granted = granted || localStorage.getItem('cm.micok') === '1'; }catch(e){}
  if(granted && seen && !$('#gate').classList.contains('gone')) begin();
})();
})();
