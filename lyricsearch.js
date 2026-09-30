/* Find a song from sung or spoken words: a faithful port of app/lyricsearch.py, so the phone
 * finds a song from its words exactly as the Mac does. Pure logic, no DOM: runs in a page, a
 * worker or Node. lyricsearch.test.mjs checks it against the Python on real and misheard lines.
 *
 * It matches word 3-grams against every lyric line in the library, weighted by how rare each
 * 3-gram is, so "praise the lord" counts for little and "you found me in a mess" counts for a lot.
 *
 * Songs are songs.json entries: cues [{t, text, s}] (web) or [{t, text, section}] (Mac library);
 * a section heading is skipped either way. Cue indexes count every cue, headings included.
 */
const N = 3;

export function toks(s) {
  s = String(s).toLowerCase().replace(/[‘’ʼ]/g, "'");
  s = s.replace(/[^a-z0-9' ]/g, ' ');
  return s.split(' ').filter(w => w);
}

export function grams(ws, n = N) {
  const out = [];
  for (let i = 0; i + n <= ws.length; i++) out.push(ws.slice(i, i + n).join(' '));
  return out;
}

// Python's round(x, 2): correctly rounded, and an exact tie goes to the even hundredth. An exact
// tie is only possible when x is a multiple of 1/8 (x * 100 then ends in exactly .5).
function round2(x) {
  const e = x * 8;
  if (Number.isInteger(e) && e % 2 !== 0) {
    const n = Math.floor(x * 100);                 // x * 100 = n + 0.5 exactly
    return (n % 2 === 0 ? n : n + 1) / 100;
  }
  return Number(x.toFixed(2));
}

const isSection = c => !!(c.section || c.s);
const pyLen = t => [...t].length;                  // Python counts code points

export function createIndex(songs) {
  const lines = [];                                // [song_id, title, cue_index, text]
  const post = new Map();                          // 3-gram -> line numbers, ascending
  for (const s of songs) {
    (s.cues || []).forEach((c, ci) => {
      if (isSection(c)) return;
      const t = String(c.text || '').trim();
      if (pyLen(t) < 6) return;
      const li = lines.length;
      lines.push([s.id, s.title, ci, t]);
      for (const g of new Set(grams(toks(t)))) {
        let l = post.get(g); if (!l) post.set(g, l = []);
        l.push(li);
      }
    });
  }
  const n = Math.max(1, lines.length), idf = new Map();
  for (const [g, v] of post) idf.set(g, Math.log(1.0 + n / v.length));

  /** The best line in the whole library, or null. Same result as Index.search(). */
  function search(text, min_score = 34.0, min_grams = 3) {
    const q = grams(toks(text));
    if (!q.length) return null;
    const score = new Map(), hitg = new Map();
    for (const g of q) {
      const ls = post.get(g);
      if (!ls || ls.length > 400) continue;        // a phrase in 400 lines identifies nothing
      const w = idf.get(g);
      for (const li of ls) {
        score.set(li, (score.get(li) || 0) + w);
        let h = hitg.get(li); if (!h) hitg.set(li, h = new Set());
        h.add(g);
      }
    }
    if (!score.size) return null;
    // a song is stronger if several of its lines matched: fold in a song bonus
    const bysong = new Map();
    for (const [li, sc] of score) { const sid = lines[li][0]; bysong.set(sid, (bysong.get(sid) || 0) + sc); }
    let best_li = null, best = 0.0;
    for (const [li, sc] of score) {
      const total = sc + 0.25 * bysong.get(lines[li][0]);
      if (total > best) { best = total; best_li = li; }
    }
    if (best_li == null || best < min_score || hitg.get(best_li).size < min_grams) return null;
    const [sid, title, ci, txt] = lines[best_li];
    // how clearly does the winning SONG beat the next best song
    const ranked = [...bysong.values()].sort((a, b) => b - a);
    const runner = ranked.length > 1 ? ranked[1] : 0.0;
    return {song_id: sid, title, cue: ci, line: txt, score: round2(best), grams: hitg.get(best_li).size,
            margin: round2(bysong.get(sid) / Math.max(runner, 0.01))};
  }

  /** How close are we? 0..1 relative to the firing threshold, for the 'thinking' glow. */
  function peek(text) {
    const r = search(text, 0.0, 1);
    return !r ? 0.0 : Math.min(1.0, r.score / 26.0);
  }

  /** Where in ONE known song are they singing? Same result as Index.search_song(). */
  function search_song(text, song_id, min_score = 6.0) {
    const all = song_lines(text, song_id);
    if (!all.length) return null;
    const top = all[0];
    if (top.score < min_score) return null;
    return {song_id, cue: top.cue, line: top.line, score: round2(top.score)};
  }

  /** Every line of ONE song that the words hit, best first (ties keep the order found), with
   *  unrounded scores. A repeated chorus is several lines with the same score: the caller picks
   *  the copy nearest where it thinks the song is. Same result as Index.song_lines(). */
  function song_lines(text, song_id) {
    const q = grams(toks(text));
    const score = new Map();
    for (const g of q) for (const li of (post.get(g) || []))
      if (lines[li][0] === song_id) score.set(li, (score.get(li) || 0) + idf.get(g));
    const out = [...score].map(([li, sc]) => ({cue: lines[li][2], line: lines[li][3], score: sc}));
    return out.sort((a, b) => b.score - a.score);     // stable: ties stay in the order found
  }

  return {search, peek, search_song, song_lines, n_lines: lines.length, n_grams: post.size};
}
