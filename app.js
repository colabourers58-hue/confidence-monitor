/* Everything runs on this device. No server, no network after the first load. */
import {Orb} from './orb.js?v=202609301151';
// Stamped by publish_site.sh on every publish ('dev' when served straight from this Mac).
const APP_VERSION = '202609301151';

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
}

/* ---------------- engine (runs in a worker, on device) ---------------- */
let worker = null, engineReady = false, loadMsgT = 0;
function startEngine(){
  try{ worker = new Worker('engine/fp-worker.js?v=202609301151', {type:'module'}); }
  catch(e){ try{ worker = new Worker('engine/fp-worker.js?v=202609301151'); }catch(e2){ worker = null; } }
  if(!worker){ $('#load').classList.add('done'); return; }
  worker.onmessage = ev => {
    const m = ev.data || {};
    if(m.type === 'progress'){ $('#load i').style.width = (100*m.loaded/Math.max(1,m.total)).toFixed(1)+'%';
      // a first download takes a while on phone data: say what's happening, once it's clearly not instant
      if(!loadMsgT) loadMsgT = setTimeout(() => { if(!engineReady) $('#loadMsg').hidden = false; }, 2500); }
    if(m.type === 'ready'){ engineReady = true; $('#load').classList.add('done'); $('#loadMsg').hidden = true; if(m.decide && dec) Object.assign(dec.config, m.decide); }
    if(m.type === 'result') onResult(m);
    if(m.type === 'error'){ $('#load').classList.add('done'); $('#loadMsg').hidden = true; console.warn('engine:', m.message); }
  };
  worker.onerror = () => { worker = null; $('#load').classList.add('done'); };
  worker.postMessage({type:'load', base: new URL('engine/', location.href).href});
}

let closest = null, lastDoubt = false;   // lastDoubt: the Mac server's doubt flag (server mode)                  // the best guess of the last 30 s, for the log when nothing locks
function onResult(m){
  if(!dec) return;
  const now = performance.now()/1000;
  if(m.song_id && (!closest || now - closest.at > 30 || m.votes > closest.votes))
    closest = {id: m.song_id, votes: m.votes, margin: m.margin, at: now};
  // m.at = when the window ENDED (sendWindow's clock); offset is where it STARTS in the recording
  dec.result(m, m.at != null ? m.at : now - (m.ms||0)/1000, m.win || 5, now);
  if(dec.state.last_match) lastMatchInfo = dec.state.last_match;
  applyLocal(now);
}
// the decider's state onto the screen, the way pollServer puts the Mac's there
function applyLocal(now){
  const s = dec.state, song = s.song_id && SONGS[s.song_id];
  if(song && s.mode === 'words' && s.anchor != null) showWords(song, s.anchor);     // only a song with no timings
  else if(song && s.started_at != null){
    if(!st.song || st.song.id !== song.id || st.words || Math.abs(st.started - s.started_at) > 0.25)
      catchSong(song, s.started_at, s.driver === 'words' ? (s.last_match && s.last_match.how) || 'from the sung words'
                                  : s.driver === 'live' ? 'a live recording: clock estimated, the singing corrects it'
                                  : (s.last_match && s.last_match.how) || 'following the track');
    else st.started = s.started_at;      // same clock, no jitter: follow it exactly
  }
  else if(st.song) release();
  if(st.song) st.lastConfirm = now;       // the decider says when to let go
}

/* ---------------- microphone ---------------- */
const SR = 16000, WIN = 5*SR, EVERY = 750;     // a fresh look every 0.75 s
let actx, ring = [], ringLen = 0, level = 0, busy = false;
let mstream = null, analyser = null, fbuf = null, inputId = null;
let srcNode = null, procNode = null, lastFrameAt = 0;   // lastFrameAt: when sound last arrived (word search watches it)
try{ inputId = localStorage.getItem('cm.input'); }catch(e){}
async function startMic(deviceId, opts){
  // keep: a fresh microphone stream into the SAME running audio graph. Used to bring the mic back
  // without a tap (a new audio graph on iPhone/iPad needs one)
  const keep = !!(opts && opts.keepContext && actx && actx.state === 'running' && procNode);
  if(mstream){ mstream.getTracks().forEach(t => t.stop()); mstream = null; }
  if(actx && !keep){ try{ await actx.close(); }catch(e){} actx = null; }
  const audio = {echoCancellation:false, noiseSuppression:false, autoGainControl:false};
  if(deviceId) audio.deviceId = {exact: deviceId};
  let stream;
  try{ stream = await navigator.mediaDevices.getUserMedia({audio}); }
  catch(e){ if(!deviceId) throw e; stream = await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:false,noiseSuppression:false,autoGainControl:false}}); }
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
          return startMic(own.deviceId, opts);
        }
      }
    }catch(e){}
  }
  mstream = stream; ring = []; ringLen = 0;
  if(keep){
    try{ srcNode && srcNode.disconnect(); }catch(e){}
    srcNode = actx.createMediaStreamSource(stream);
    srcNode.connect(procNode); if(analyser) srcNode.connect(analyser);
    return;
  }
  // the device's own rate. Asking for 16 kHz here works in Chrome but gives SILENCE in Safari,
  // so the audio is converted to 16 kHz by us (to16k) or by the Mac server (X-Rate), never by the browser
  actx = new (window.AudioContext || window.webkitAudioContext)();
  if(actx.state === 'suspended') await actx.resume();
  const src = srcNode = actx.createMediaStreamSource(stream);
  const node = procNode = actx.createScriptProcessor(4096, 1, 1);
  node.onaudioprocess = e => {
    lastFrameAt = performance.now()/1000;
    const d = e.inputBuffer.getChannelData(0);
    let s = 0; for(let i=0;i<d.length;i++) s += d[i]*d[i];
    level = Math.sqrt(s/d.length);
    ring.push(new Float32Array(d)); ringLen += d.length;
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
  if(LOG.length > 400) LOG = LOG.slice(-400);
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
  $('#log').innerHTML = LOG.slice(-150).reverse().map(e =>
    `<div><time>${hhmmss(e.t)}</time><span class="${e.kind==='identified'?'id':e.kind==='miss'?'miss':e.kind==='heard'?'heard':''}">${esc(e.text)}</span></div>`).join('')
    || '<div><time></time><span>Nothing yet. Play or sing something.</span></div>';
}
function renderNow(){
  let t;
  if(st.song) t = `Showing <b>${esc(st.song.title)}</b><small>${st.words ? 'A block of words (this song has no timings yet)' : 'Following the track'}</small>`;
  else if(confNow > 0.05) t = `Thinking… ${Math.round(confNow*100)}% sure`;
  else if(level*3.2 > 0.10) t = 'Hearing music, listening for a song';
  else t = 'Resting, listening for music';
  if(st.song && !serverMode && dec && (dec.state.driver === 'words' || dec.state.driver === 'live'))
    t = `Showing <b>${esc(st.song.title)}</b><small>Place estimated from ${dec.state.driver === 'words' ? 'the sung words' : 'a live recording'}; ` +
        `${words && words.running ? 'listening to the singing to correct it' : 'the music keeps checking it'}</small>`;
  if(!serverMode && dec && dec.state.searching && !st.song){
    const a = dec.state.acc;
    t = `Searching hard<small>${a ? `Adding up the evidence. Best so far: ${esc((SONGS[a.song_id] || {}).title || a.song_id)}, ${a.looks} look${a.looks === 1 ? '' : 's'} agree` : 'Adding up the evidence'}` +
        `${words && words.running ? '. Listening to the words too' : ''}</small>`;
  }
  const ws = $('#cpWords');
  if(ws) ws.textContent = serverMode ? 'Done by the Mac (Whisper).' : words ? words.describe()
    : !WORD_SEARCH ? 'Not switched on in this version yet.' : 'Not available in this browser. Songs are found from the music alone.';
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
  if(!devs.length){ list.innerHTML = '<div class="mrow">Tap to begin first, then open this again.</div>'; return; }
  devs.forEach(d => {
    const b = document.createElement('button');
    b.className = 'dev' + (d.deviceId === current ? ' on' : '');
    b.textContent = (d.label || 'Input ' + (d.deviceId || '').slice(0, 6)) + (d.deviceId === current ? '  ·  in use' : '');
    b.onclick = async () => { try{ await startMic(d.deviceId); inputId = d.deviceId; localStorage.setItem('cm.input', d.deviceId);
                                   logEvent('input', 'Listening from ' + (d.label || 'another input')); }catch(e){} renderDevices(); };
    list.appendChild(b);
  });
}
function openPanel(){ $('#cp').hidden = false; renderPanel(); renderNow(); renderDevices(); }
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
    confNow = (l.conf_at && s.server_now - l.conf_at < 4) ? (l.conf || 0) : 0;
    if(l.last_match) lastMatchInfo = l.last_match;
    if(l.heard && l.heard_at && l.heard_at !== pollServer.heardAt && l.heard.trim().length > 3){
      pollServer.heardAt = l.heard_at; logEvent('heard', 'Heard: “' + l.heard.trim().slice(0, 120) + '”');
    }
    const song = s.song_id && SONGS[s.song_id];
    if(song && s.mode === 'words' && s.anchor != null) showWords(song, s.anchor);
    else if(song && s.started_at != null){
      const startedPerf = performance.now()/1000 - ((Date.now()/1000 + skew) - s.started_at);
      if(!st.song || st.song.id !== song.id || st.words || Math.abs(st.started - startedPerf) > 0.25)
        catchSong(song, startedPerf, s.driver === 'words' ? (l.last_match && l.last_match.how) || 'from the sung words'
                                   : s.driver === 'live' ? 'a live recording: clock estimated, the singing corrects it'
                                   : (l.last_match && l.last_match.how) || 'following the track');
      st.lastConfirm = performance.now()/1000;
    }
    else if(st.song) release();
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
  if(!worker || !dec || !engineReady || busy || !actx || ringLen < actx.sampleRate*2) return;
  const raw = new Float32Array(ringLen); let o = 0;
  for(const c of ring){ raw.set(c, o); o += c.length; }
  const f = to16k(raw, actx.sampleRate);
  const at = performance.now()/1000, win = f.length/SR;
  dec.heard(level, at);
  busy = true;
  const done = ev => { if(ev.data && ev.data.type === 'result'){ busy = false; worker.removeEventListener('message', done); } };
  worker.addEventListener('message', done);
  setTimeout(() => { busy = false; }, 4000);
  worker.postMessage({type:'match', pcm:f, win, at, track: dec.track(at, win), top: dec.top(at, win)}, [f.buffer]);
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
  const fresh = !st.song || st.song.id !== song.id || st.words;
  if(fresh) logIdentified(song, how || 'following the track');
  st.words = null; document.body.classList.remove('words');
  st.song = song; st.started = started; st.lastConfirm = performance.now()/1000;
  if(fresh){
    buildSong(song);
    orb.setAmbient(1);
    orb.explode();
    document.body.classList.add('song');
    document.body.classList.remove('caught'); void document.body.offsetWidth;
    document.body.classList.add('caught');
    setTimeout(() => document.body.classList.remove('caught'), 1600);
    setTimeout(() => { if(st.song === song){ const [x,y] = dotUV(); orb.toStatus(x, y); } }, 380);
  }
}
function release(){
  if(st.song) logEvent('release', `Let go of ${st.song.title}`);
  st.song = null; st.started = null; st.pending = null; st.words = null;
  document.body.classList.remove('song', 'words');
  orb.setAmbient(0);
  orb.toListening();
}
function showWords(song, anchor){
  const key = song.id + '#' + anchor;
  if(st.words === key) return;
  const fresh = !st.song || st.song.id !== song.id;
  if(fresh) logIdentified(song, 'following the singing');
  st.words = key; st.song = song; st.started = null; st.lastConfirm = performance.now()/1000;
  if(fresh) buildSong(song);
  renderBlock(song, anchor);
  document.body.classList.add('song', 'words');
  orb.setAmbient(1);
  if(fresh){ orb.explode(); document.body.classList.remove('caught'); void document.body.offsetWidth;
             document.body.classList.add('caught'); setTimeout(() => document.body.classList.remove('caught'), 1600);
             setTimeout(() => { if(st.song === song){ const [x,y] = dotUV(); orb.toStatus(x, y); } }, 380); }
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
let lineEls = [], activeCue = -2;
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
  const col = $('#col'); col.innerHTML = ''; lineEls = [];
  let brk = false;
  cues.forEach((c,k) => {
    if(c.s){ brk = true; return; }
    const p = document.createElement('p'); p.className = 'ln' + (brk ? ' brk' : ''); brk = false;
    p.textContent = c.text; p.dataset.i = k; col.appendChild(p); lineEls[k] = p;
  });
  col.style.transition = 'none'; col.style.transform = 'translateY(40vh)';
  requestAnimationFrame(() => { col.style.transition = ''; });
}
// mark the sung line, dim what is past, soften what is further away, and glide it into place
function setActive(k, pending){
  const key = k + (pending ? 'p' : '');
  if(key === activeCue) return; activeCue = key;
  let order = []; lineEls.forEach((el,i) => { if(el) order.push(i); });
  const pos = order.indexOf(k);
  order.forEach((i,n) => {
    const el = lineEls[i], d = n - pos;
    el.className = 'ln' + (el.classList.contains('brk') ? ' brk' : '')
      + (d === 0 ? (pending ? ' pending' : ' on') : d < 0 ? ' past' : d === 1 ? ' near' : '');
  });
  scrollTo(k);
}
function scrollTo(k){
  const el = lineEls[k], view = $('#view'); if(!el || !view) return;
  const y = view.clientHeight*0.40 - (el.offsetTop + el.offsetHeight/2);
  $('#col').style.transform = `translateY(${Math.round(y)}px)`;
}
let zoom = parseFloat(localStorage.getItem('cm.zoom') || '1') || 1;
function refit(){
  // default lyric size (Joel: 30% bigger than the first version, for reading from the stage);
  // the pinch / +/- zoom multiplies on top of it
  $('#col').style.fontSize = (Math.min(innerHeight*0.0975, Math.max(23, innerWidth*0.11)) * zoom).toFixed(1) + 'px';
  if(typeof activeCue === 'string' || typeof activeCue === 'number'){
    const k = parseInt(activeCue, 10); if(!isNaN(k)) requestAnimationFrame(() => scrollTo(k));
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
  orb.setLevel(Math.min(1, level*3.2));
  // A real microphone is never EXACTLY silent: even a quiet room has some hiss. Pure zeros for
  // a few seconds means the browser has cut the microphone off (Safari does this when its window
  // isn't in front, or after an interruption). Say so, and let one tap bring it back.
  // (not while word search is starting, running or handing the mic back: it watches the mic itself)
  if(words && words.guarding(now)) deadSince = null;
  else if(mstream && $('#gate').classList.contains('gone') && document.visibilityState === 'visible'){
    if(level === 0){ if(deadSince == null) deadSince = now;
      else if(now - deadSince > 4){ deadSince = null; logEvent('miss', 'The microphone went silent (cut off by the browser)');
        $('#gate b').textContent = 'The microphone stopped. Tap to turn it back on'; $('#gate').classList.remove('gone'); } }
    else deadSince = null;
  }
  const loud = level*3.2 > 0.10;
  if(loud && !st.song && attemptStart == null){ attemptStart = now; logEvent('sound', 'Music started'); }
  if(attemptStart != null && !st.song && now - attemptStart > 30 && !frame.missLogged){
    frame.missLogged = true;
    const why = serverMode ? '' : !engineReady ? ' (the songs were still downloading, so it had nothing to compare with)'
      : closest ? ` (closest guess: ${(SONGS[closest.id] || {}).title || closest.id}, ${closest.votes} matches, not sure enough)`
      : ' (nothing in the music matched any song)';
    logEvent('miss', 'Heard 30 s of music but could not identify it' + why);
  }
  if(st.song || attemptStart == null) frame.missLogged = false;
  if(!loud && !st.song && attemptStart != null && now - lastLoud > 12) attemptStart = null;
  if(!$('#cp').hidden && (frame.pt = (frame.pt || 0) + 1) % 6 === 0){
    const db = 20*Math.log10(level || 1e-6);
    $('#cpMeter').style.width = Math.min(100, Math.max(0, (db + 70) / 60 * 100)) + '%';
    $('#cpLevel').textContent = db.toFixed(0) + ' dB';
    $('#cpHearing').innerHTML = level < 0.0015 ? '<span class="warn">Nothing coming in. Check the input below</span>' : level*3.2 > 0.10 ? 'Hearing music' : 'Quiet room';
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
    if(words) words.set(!!mstream && engineReady && dec.wantWords());
  }
  // the song has run out: let it go now rather than holding the last line
  if(st.song && st.started != null && (now - st.started) > (st.song.duration || 1e9) + 2.5) release();
  if(st.song && st.started != null){
    const p = now - st.started, look = p + LEAD;
    let i = -1; for(let k=0;k<cues.length;k++){ if(cues[k].t <= look) i = k; else break; }
    let ci = i; while(ci >= 0 && cues[ci].s) ci--;
    // the line being sung; before the first line, put that first line up early (dimmed)
    if(ci >= 0) setActive(ci, false);
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
addEventListener('resize', () => { refit(); if(st.words) fitBlock(); if(st.song){ const [x,y] = dotUV(); orb.toStatus(x,y); } });

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

/* ---------------- the sung words (no Mac) ----------------
   The last resort when the music alone can't find the song: the browser's own speech
   recognition (words.js), searched against every song's lyrics (lyricsearch.js, the Mac's
   search ported). decide.js wantWords() says when; decide.js words() decides what it means. */
let words = null, LSIX = null, LS = null;
const WORD_SEARCH = true;            // the browser's own speech recognition, as a last resort (words.js)
async function startWords(){
  if(!WORD_SEARCH) return;
  try{
    LS = await import('./lyricsearch.js?v=' + APP_VERSION);
    words = (await import('./words.js?v=' + APP_VERSION)).createWordListener({
      now: () => performance.now()/1000,
      health: () => ({frameAt: lastFrameAt, level, track: mstream && mstream.getAudioTracks()[0], actx}),
      log: (kind, text) => logEvent(kind, text),
      onMicTrouble: restoreMic,
      onWords: (pool, recent, at) => {
        if(!dec) return;
        if(!LSIX) LSIX = LS.createIndex(Object.values(SONGS));
        const before = {id: dec.state.song_id, started: dec.state.started_at};
        if(!dec.words(pool, recent, at, performance.now()/1000, LSIX)) return;
        const s = dec.state, song = SONGS[s.song_id];
        if(song && before.id === s.song_id && before.started != null && s.started_at != null)
          logEvent('info', `Moved ${song.title} to the line being sung (${(before.started - s.started_at >= 0 ? '+' : '')}${(before.started - s.started_at).toFixed(1)} s)`);
        else if(song && s.last_match && s.last_match.line)
          logEvent('info', `The words “${s.last_match.line.slice(0, 60)}” are in ${song.title}`);
        applyLocal(performance.now()/1000);
      },
    });
    if(!words.supported) logEvent('info', 'Word search isn’t available in this browser; songs are found from the music alone');
    probeWords();                      // the microphone may already be on
  }catch(e){ words = null; console.warn('words:', e); }
}
// try word search once, 3 s after the microphone starts, so any permission question comes up at
// setup rather than mid-song, and a device where it upsets the microphone is found out now
function probeWords(){
  if(probeWords.done || !words || !words.supported || serverMode || !mstream) return;
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
async function begin(){
  keepAwake();
  $('#gate').classList.add('gone');
  try{ await startMic(inputId); orb.toListening();
       const tr = mstream && mstream.getAudioTracks()[0]; logEvent('start', 'Started, listening from ' + ((tr && tr.label) || 'the default input'));
       probeWords();
  }catch(e){ $('#gate b').textContent = 'Microphone not available'; $('#gate').classList.remove('gone'); }
  document.documentElement.requestFullscreen?.().catch(()=>{});
}
$('#gate').addEventListener('click', begin);

/* the welcome sheet: once per person (and again whenever WELCOME changes, to say what's new) */
const WELCOME = '1';
function showWelcome(){
  const ua = navigator.userAgent, standalone = matchMedia('(display-mode: standalone), (display-mode: fullscreen)').matches || navigator.standalone;
  const ios = /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  $('#wKeep').textContent = standalone ? '' :
    ios ? 'To keep it on this iPad or iPhone: tap Share, then Add to Home Screen.' :
    /Android/.test(ua) ? 'To keep it on this phone: open the Chrome menu, then Install app.' :
    /Macintosh/.test(ua) && /Safari/.test(ua) && !/Chrome/.test(ua) ? 'To keep it on this Mac: in the menu bar choose File, then Add to Dock.' :
    'To keep it on this computer: click the install icon at the right of the address bar.';
  $('#welcome').hidden = false; $('#welcome').classList.remove('leaving');
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
    const k = 'cm.upd.' + v;
    if(sessionStorage.getItem(k)) return;          // already tried this one: don't loop
    sessionStorage.setItem(k, '1');
    location.replace(location.pathname + '?v=' + encodeURIComponent(v));
  }catch(e){}                                      // offline: the stored copy is the right one
}
function showVersion(){
  const pretty = APP_VERSION === 'dev' ? 'running from this Mac'
    : APP_VERSION.replace(/^(\d{4})(\d\d)(\d\d)(\d\d)(\d\d)$/, (m, y, mo, d, h, mi) =>
        new Date(+y, +mo - 1, +d, +h, +mi).toLocaleString([], {day:'numeric', month:'short', hour:'numeric', minute:'2-digit'}));
  $('#cpVer').textContent = 'Version ' + pretty;
  const q = new URLSearchParams(location.search);
  if(q.get('v')){                                  // we just updated: say so, then tidy the address
    const t = $('#toast'); t.textContent = 'Prompter updated'; t.hidden = false;
    setTimeout(() => { t.hidden = true; }, 3500);
    q.delete('v'); history.replaceState(null, '', location.pathname + (q.toString() ? '?' + q : ''));
  }
}
document.addEventListener('visibilitychange', () => { if(document.visibilityState === 'visible') checkUpdate(); });
setInterval(checkUpdate, 3 * 60 * 1000);          // left open all day: still picks up a new version between songs

await loadSongs();
refit();
showVersion();
try{ const r = await fetch('fpstatus', {cache:'no-store'}); if(r.ok) serverMode = !!(await r.json()).ready; }catch(e){}
if(serverMode){
  $('#load').classList.add('done');
  setInterval(pollServer, 500);
}else{
  try{ dec = (await import('./decide.js?v=' + APP_VERSION)).createDecider(id => SONGS[id]); }catch(e){ console.warn('decide.js:', e); }
  startEngine();
  await startWords();
  if('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(()=>{});
  checkUpdate();
}

// for testing without audio:  ?demo=<song id>@<seconds into the song>
const demo = new URLSearchParams(location.search).get('demo');
if(demo){
  const [id, at] = demo.split('@');
  $('#gate').classList.add('gone'); orb.toListening();
  if(at && at.startsWith('w')){
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
