/* What the on-device Whisper writes that isn't words: "(upbeat music)", "[BLANK_AUDIO]", "♪", a
 * lone "Thank you." on silence, one word looping. '' for a window that holds nothing sung or said.
 * Used by app.js on every window and by timings/song-calls/replay.test.mjs on the real footage. */
const HALLUCINATED = new Set(['thank', 'thanks', 'you', 'for', 'watching', 'bye', 'so', 'oh', 'okay', 'the', 'end',
  'please', 'subscribe', 'music', 'applause', 'amen', 'yeah', 'mm', 'hmm', 'uh', 'um', 'blank', 'audio']);
export function cleanASR(t) {
  t = String(t || '').replace(/\[[^\]]*\]|\([^)]*\)|\*[^*]*\*|♪|♫/g, ' ').replace(/\s+/g, ' ').trim();
  const ws = t.toLowerCase().replace(/[^a-z' ]/g, ' ').split(' ').filter(Boolean);
  if (!ws.length || ws.every(w => HALLUCINATED.has(w))) return '';
  if (ws.length >= 8) {                          // one word looping: Whisper stuck, not singing
    const c = {}; for (const w of ws) c[w] = (c[w] || 0) + 1;
    if (Math.max(...Object.values(c)) > 0.6 * ws.length) return '';
  }
  return t;
}
