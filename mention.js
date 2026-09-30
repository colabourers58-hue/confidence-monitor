/* A song pulled up because it was MENTIONED: its title said (or sung) in the room. A faithful port
 * of app/mention.py (read that for the rules); mention.test.mjs checks the two agree on real and
 * sermon-like text. Pure logic, no DOM.
 *
 * Joel: "All it really should take for a song to be pulled up is for the song to be mentioned.
 * The song title or lines from the song." Lines are lyricsearch.js's job; this is titles.
 *
 * A DISTINCTIVE title heard once is enough. A COMMON one (1-2 words, a phrase the preacher uses,
 * or a phrase inside another song's lyrics) needs a cue before it ("let's sing ...", "the next
 * song is ...") or a second sign, which decide.js titles() looks for (the music, a line of the song,
 * or, 3+ words, the title said twice).
 */
const CONTRACT = {
  "i'm": 'i am', "you're": 'you are', "we're": 'we are', "they're": 'they are',
  "i've": 'i have', "we've": 'we have', "you've": 'you have', "they've": 'they have',
  "i'll": 'i will', "you'll": 'you will', "we'll": 'we will', "he'll": 'he will',
  "don't": 'do not', "can't": 'can not', "won't": 'will not', "isn't": 'is not',
  "didn't": 'did not', "doesn't": 'does not', "aren't": 'are not', "wasn't": 'was not',
  "it's": 'it is', "there's": 'there is', "let's": 'let us', "that's": 'that is',
  "what's": 'what is', "who's": 'who is', "he's": 'he is', "she's": 'she is',
  "'tis": 'it is', 'tis': 'it is',
};
const SPELL = {wanna: 'want to', gonna: 'going to', gotta: 'got to', cannot: 'can not',
               o: 'oh', savior: 'saviour', favorite: 'favourite', fulfil: 'fulfill',
               dreamin: 'dreaming', everyday: 'every day', honor: 'honour', okay: 'ok'};
const DROP = new Set(['the', 'a', 'an', 'uh', 'um', 'er', 'erm', 'ah', 'hmm', 'mm']);
const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
              'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const CUE = new Set(['sing', 'singing', 'sang', 'sung', 'song', 'songs', 'hymn', 'hymns', 'play', 'playing', 'next', 'chorus']);
const LINK = new Set(['is', 'it', 'called', 'titled', 'entitled', 'named', 'us', 'let', 'we', 'are', 'will', 'going',
  'to', 'now', 'again', 'next', 'one', 'this', 'that', 'our', 'your', 'my', 'all', 'together',
  'please', 'then', 'and', 'shall', 'can', 'do', 'be', 'for', 'of', 'you', 'me', 'up', 'with',
  'them', 'him', 'her', 'everybody', 'everyone', 'church']);   // 'sing that song for them. Forgiven' (Lenk 2025)
const CUE_GAP = 3;
const SMALL = new Set(['i', 'to', 'of', 'in', 'on', 'at', 'my', 'me', 'is', 'it', 'so', 'and', 'or', 'for', 'you',
  'your', 'we', 'us', 'be', 'oh', 'he', 'his', 'our', 'by', 'as', 'am', 'are', 'with', 'not', 'do']);
const LOOSE_MIN = 4;

export function rawToks(s) {
  s = String(s).toLowerCase().replace(/[‘’ʼ]/g, "'");
  s = s.replace(/[^a-z0-9' ]/g, ' ');
  return s.split(' ').filter(w => w);
}
function numberWords(d) {
  if (d.length > 2) return [...d].map(c => ONES[+c]);
  const n = +d;
  if (n < 20) return [ONES[n]];
  return [TENS[Math.floor(n / 10)], ...(n % 10 ? [ONES[n % 10]] : [])];
}
function expand(w) {
  let out;
  if (Object.prototype.hasOwnProperty.call(CONTRACT, w)) out = CONTRACT[w].split(' ');
  else {
    w = w.replace(/'/g, '');
    if (!w) return [];
    out = /^[0-9]+$/.test(w) ? numberWords(w) : (Object.prototype.hasOwnProperty.call(SPELL, w) ? SPELL[w] : w).split(' ');
  }
  return out.filter(x => !DROP.has(x));
}
/** {ws, src}: the normalised words, and for each the index of the raw token it came from. */
export function norm(text) {
  const ws = [], src = [];
  rawToks(text).forEach((w, i) => { for (const x of expand(w)) { ws.push(x); src.push(i); } });
  return {ws, src};
}
/** The name as someone would say it: no 'Intro:', no '(Jazz)', no ' - The BDs'. */
export function cleanTitle(t) {
  t = String(t).replace(/^\s*in(t)?ro\s*:\s*/i, '');
  t = t.replace(/\([^)]*\)/g, ' ');
  t = t.split(/\s+[-–]\s+/)[0];
  return t.replace(/\s+/g, ' ').trim();
}
/** A cue word just before position i, with at most CUE_GAP linking words between. */
export function cued(ws, i) {
  let j = i - 1, gap = 0;
  while (j >= 0) {
    if (CUE.has(ws[j])) return true;
    if (!LINK.has(ws[j]) || gap >= CUE_GAP) return false;
    gap++; j--;
  }
  return false;
}
/** The text with the title's own words taken out: what is left to be a LINE of the song. */
export function without(text, hit) {
  const rt = rawToks(text);
  return [...rt.slice(0, hit.raw_start), ...rt.slice(hit.raw_end)].join(' ');
}

/** songs: [{id, title, cues}]; extra: titles.json ({aliases: {song_id: [names]}, preached: [keys]}). */
export function createTitleIndex(songs, extra) {
  extra = extra || {};
  const ids = new Set(songs.map(s => s.id));
  const names = [];                                     // [song_id, name, preferred]
  for (const s of songs) {
    const t = s.title || s.id;
    names.push([s.id, cleanTitle(t), cleanTitle(t) === String(t).trim()]);
  }
  const al = extra.aliases || {};
  for (const sid of Object.keys(al).sort())
    if (ids.has(sid)) for (const a of al[sid]) names.push([sid, cleanTitle(a), false]);
  const preached = new Set(extra.preached || []);
  // every normalised 3-gram of every lyric line -> the songs it is in
  const grams = new Map();
  for (const s of songs) for (const c of s.cues || []) {
    if (c.s || c.section) continue;
    const ws = norm(c.text || '').ws;
    for (let i = 0; i + 2 < ws.length; i++) {
      const g = ws.slice(i, i + 3).join(' ');
      let set = grams.get(g); if (!set) grams.set(g, set = new Set());
      set.add(s.id);
    }
  }
  const entries = [], byk = new Map();
  for (const [sid, name, pref] of names) {
    const ws = norm(name).ws;
    if (!ws.length) continue;
    const key = ws.join(' ');
    const e0 = byk.get(key);
    if (e0) {
      if (pref && !e0.pref && e0.song_id !== sid) Object.assign(e0, {song_id: sid, name, pref: true});
      continue;
    }
    const e = {key, toks: ws, song_id: sid, name, n: ws.length, pref};
    byk.set(key, e); entries.push(e);
  }
  for (const e of entries) {
    let why = null;
    if (e.n <= 2) why = 'short';
    else if (preached.has(e.key)) why = 'preached';
    else {
      let inter = null;
      for (let i = 0; i + 2 < e.n; i++) {
        const set = grams.get(e.toks.slice(i, i + 3).join(' ')) || new Set();
        inter = inter == null ? new Set(set) : new Set([...inter].filter(x => set.has(x)));
      }
      if (inter) { inter.delete(e.song_id); if (inter.size) why = 'sung'; }
    }
    e.common = why != null; e.why = why;
  }
  const first = new Map();
  entries.forEach((e, k) => {
    const forms = [[e.toks, false]];
    if (e.n >= LOOSE_MIN) {
      const seen = new Set();
      e.toks.forEach((w, j) => {
        if (!SMALL.has(w) || j === 0 || j === e.n - 1) return;     // never an end word: the ends anchor the title
        const f = [...e.toks.slice(0, j), ...e.toks.slice(j + 1)], fk = f.join(' ');
        if (!seen.has(fk)) { seen.add(fk); forms.push([f, true]); }
      });
    }
    for (const [f, loose] of forms) {
      let l = first.get(f[0]); if (!l) first.set(f[0], l = []);
      l.push([k, f, loose]);
    }
  });

  /** Titles in the text, as mention.py TitleIndex.find(). */
  function find(text) {
    const {ws, src} = norm(text);
    const hits = [];
    ws.forEach((w, i) => {
      for (const [k, f, loose] of first.get(w) || [])
        if (i + f.length <= ws.length && f.every((x, j) => ws[i + j] === x)) hits.push([k, i, i + f.length, loose]);
    });
    // a longer title beats one inside it; exact beats loose; then the order heard
    hits.sort((a, b) => ((b[2] - b[1]) - (a[2] - a[1])) || ((a[3] ? 1 : 0) - (b[3] ? 1 : 0)) || (a[1] - b[1]));
    const kept = [];
    for (const h of hits) {
      if (kept.some(o => (h[1] >= o[1] && h[2] <= o[2] && !(h[1] === o[1] && h[2] === o[2])) ||
                         (h[1] === o[1] && h[2] === o[2] && h[0] !== o[0]))) continue;
      if (kept.some(o => h[0] === o[0] && h[1] < o[2] && o[1] < h[2])) continue;
      kept.push(h);
    }
    const out = new Map();
    for (const [k, i, j, loose] of kept) {
      const e = entries[k];
      const r = out.get(e.key);
      if (r) { r.occ++; continue; }
      out.set(e.key, {song_id: e.song_id, name: e.name, key: e.key, n: e.n, common: e.common, why: e.why,
                      cued: cued(ws, i), loose, occ: 1, start: i, end: j, raw_start: src[i], raw_end: src[j - 1] + 1});
    }
    for (const [k, i] of kept) { const r = out.get(entries[k].key); if (!r.cued && cued(ws, i)) r.cued = true; }
    const res = [...out.values()];
    res.sort((a, b) => ((a.cued ? 0 : 1) - (b.cued ? 0 : 1)) || ((a.common ? 1 : 0) - (b.common ? 1 : 0)) ||
                       (b.n - a.n) || (a.start - b.start));
    return res;
  }

  return {find, without, entries, n_titles: entries.length, n_common: entries.filter(e => e.common).length};
}
