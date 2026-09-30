#!/usr/bin/env python3
"""Export the learned fingerprint (app/library/fingerprints2.*) for the browser: engine/fp2/.

    python3 app/web/engine/export_fp2.py

  fp2/manifest.json      params, gates, refs (with the landmark manifest's song/shift/live), shards
  fp2/model.onnx         the embedding network (ONNX Runtime Web runs it in the worker)
  fp2/fp2-NN-<hash>.bin  one blob, sharded:  C float32 [nlist*64] | list_start int32 [nlist+1] |
                         E int8 [N*64] (in IVF-cell order) | R uint16 [N] | T uint16 [N] |
                         MELW float32 [513*64] | FIR float32 [41]
Only instrumentals and non-live releases go in (a live recording can't drive a clock anyway):
~0.99 M entries, ~68 MB.
"""
import os, sys, json, hashlib, shutil
import numpy as np
HERE = os.path.dirname(os.path.abspath(__file__))
APP = os.path.abspath(os.path.join(HERE, '..', '..'))
sys.path.insert(0, APP)
import fp2_nn as N
import fp2

OUT = os.path.join(HERE, 'fp2')
SHARD = 14_000_000

def main():
    z = np.load(os.path.join(APP, 'library', 'fingerprints2.npz'))
    meta = json.loads(str(z['meta'])); ids = [str(i) for i in z['ids']]
    lm = {r['ref_id']: r for r in json.load(open(os.path.join(HERE, 'manifest.json')))['refs']}
    keep_ref = np.array([(meta[i]['kind'] == 'backing' or not meta[i]['live']) and i in lm and not lm[i].get('excluded')
                         for i in ids])
    newid = -np.ones(len(ids), np.int64); kept = [i for i, k in zip(ids, keep_ref) if k]
    newid[keep_ref] = np.arange(len(kept))
    order = z['order'].astype(np.int64); ls = z['list_start'].astype(np.int64); C = z['C'].astype(np.float32)
    nlist = C.shape[0]
    cell = np.empty(order.size, np.int64)
    for c in range(nlist): cell[ls[c]:ls[c + 1]] = c
    R = z['R'].astype(np.int64); T = z['T'].astype(np.int64); E = z['E']
    rows = order[keep_ref[R[order]]]                   # kept rows, in cell order
    cells = cell[keep_ref[R[order]]]
    new_ls = np.searchsorted(cells, np.arange(nlist + 1)).astype(np.int32)
    Ek = np.ascontiguousarray(E[rows]); Rk = newid[R[rows]].astype(np.uint16); Tk = T[rows].astype(np.uint16)
    from scipy.signal import firwin
    fir = (firwin(41, 0.5, window=('kaiser', 5.0)) * 1.0).astype(np.float32)   # resample_poly(x, 1, 2)'s filter
    parts = [('C', C.tobytes()), ('list_start', new_ls.tobytes()), ('E', Ek.tobytes()), ('R', Rk.tobytes()),
             ('T', Tk.tobytes()), ('MELW', N.MELW.astype(np.float32).tobytes()), ('FIR', fir.tobytes())]
    blob = b''; sections = {}
    for name, b in parts:
        pad = (-len(blob)) % 8; blob += b'\0' * pad
        sections[name] = [len(blob), len(b)]; blob += b
    if os.path.isdir(OUT): shutil.rmtree(OUT)
    os.makedirs(OUT)
    shards = []
    for k in range(0, len(blob), SHARD):
        part = blob[k:k + SHARD]; h = hashlib.sha256(part).hexdigest()[:10]
        fn = f'fp2-{len(shards):02d}-{h}.bin'
        open(os.path.join(OUT, fn), 'wb').write(part); shards.append({'file': fn, 'bytes': len(part)})
    shutil.copy(os.path.join(APP, 'library', 'fingerprints2.onnx'), os.path.join(OUT, 'model.onnx'))
    refs = []
    for i in kept:
        f = lm[i]
        refs.append({'ref_id': i, 'song_id': f['song_id'], 'shift': f.get('shift') or 0.0, 'live': bool(f.get('live')),
                     'aligned': f.get('aligned'), 'duration': float(z['durs'][ids.index(i)])})
    man = {
        'format': 'fp2/1',
        'description': 'Learned fingerprint (app/fp2.py) for the browser. See app/RECOGNIZER.md and export_fp2.py.',
        'params': {'sr_in': 16000, 'sr': N.SR, 'nfft': N.NFFT, 'hop': N.HOP, 'nmel': N.NMEL, 'segf': N.SEGF,
                   'qhop': N.QHOPF, 'db_hop': int(z['hop']), 'dim': int(E.shape[1]), 'nlist': nlist, 'log_eps': 1e-6,
                   'fir_taps': 41, 'window': 'hann, symmetric (np.hanning)'},
        'search': dict(fp2.SEARCH, tol=int(z['hop']) // 2, scale=10.0),
        'gates': {'min_votes': 30.0, 'min_margin': 1.5, 'track_min': 15.0, 'lm_scale': 12.0 / 30.0, 'acc_floor': 22.0,
                  'lm_strong_votes': 40, 'lm_strong_margin': 2.0, 'lm_track_min': 5},
        'model': {'file': 'model.onnx', 'bytes': os.path.getsize(os.path.join(OUT, 'model.onnx')), 'input': 'mel', 'output': 'emb'},
        'sections': sections, 'n': int(len(rows)), 'total_bytes': len(blob), 'shards': shards, 'refs': refs,
    }
    json.dump(man, open(os.path.join(OUT, 'manifest.json'), 'w'))
    print(f'fp2 for the web: {len(kept)} recordings, {len(rows):,} entries, {len(blob)/1e6:.1f} MB in {len(shards)} shards '
          f'+ model {man["model"]["bytes"]/1e6:.1f} MB')

if __name__ == '__main__':
    main()
