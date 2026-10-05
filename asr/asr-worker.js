/* Speech recognition ON THE DEVICE: Whisper tiny.en (quantized) through transformers.js, in its own
 * worker. No audio ever leaves the device and nothing here needs the internet once sw.js has kept
 * the files (Joel: "there shouldn't be anything like 'may need internet'").
 *
 * app.js sends it 5 s windows of the room at 16 kHz while no song is up; each comes back as text
 * and goes through the same title and lyric rules as any other words (mention.js, lyricsearch.js,
 * decide.js). The model files are in ./models/ (app/build_asr.py, listed in ./manifest.json);
 * transformers.js and its ONNX Runtime are in ../vendor/ (app/build_vendor.py), kept offline by sw.js.
 *
 * Messages in:  {type:'load'}  {type:'hear', pcm: Float32Array (16 kHz), at}
 * Messages out: {type:'ready', ms} {type:'heard', text, at, ms} {type:'error', message}
 */
// transformers.js and its ONNX Runtime, served from this site (web/vendor/, pinned in web/vendor.json):
// never a CDN, so nothing here needs a third-party origin, online or offline
const TF_DIR = new URL('../vendor/transformers-3.8.1/', self.location.href).href;
const TF = TF_DIR + 'transformers.min.js';
let asr = null, loading = null;

async function load() {
  const t0 = performance.now();
  const {pipeline, env} = await import(TF);
  env.allowRemoteModels = false;                       // only the files shipped with the app
  env.allowLocalModels = true;
  env.localModelPath = new URL('./models/', self.location.href).href;
  env.useBrowserCache = false;                         // sw.js keeps them (one copy, not two)
  env.backends.onnx.wasm.wasmPaths = TF_DIR;           // its runtime from here too (its default is jsDelivr)
  env.backends.onnx.wasm.numThreads = 1;               // a GitHub Pages site can't use threads; and the
                                                       // fingerprints must always have a core to themselves
  const man = await (await fetch(new URL('./manifest.json', self.location.href))).json();
  asr = await pipeline('automatic-speech-recognition', man.model, {dtype: man.dtype || 'q8', device: 'wasm'});
  // one silent window through it now, so the first real one isn't slowed by warming up
  await asr(new Float32Array(16000));
  return performance.now() - t0;
}

self.onmessage = async ev => {
  const m = ev.data || {};
  try {
    if (m.type === 'load') {
      if (!loading) loading = load();
      const ms = await loading;
      self.postMessage({type: 'ready', ms: Math.round(ms)});
    } else if (m.type === 'hear') {
      if (!asr) { if (!loading) loading = load(); await loading; }
      const t0 = performance.now();
      const r = await asr(m.pcm);
      self.postMessage({type: 'heard', text: (r && r.text || '').trim(), at: m.at, ms: Math.round(performance.now() - t0)});
    }
  } catch (e) {
    self.postMessage({type: 'error', message: String(e && e.message || e), at: m.at});
  }
};
