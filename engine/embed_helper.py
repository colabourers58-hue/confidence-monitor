#!/usr/bin/env python3
"""For Node tests of the web chain: runs engine/fp2/model.onnx (the same file the browser runs)
on patches sent over stdin: [int32 n][n*64*32 float32] -> [n*64 float32]. Nothing touches disk."""
import sys, os, numpy as np, onnxruntime as ort
so = ort.SessionOptions(); so.intra_op_num_threads = 2
s = ort.InferenceSession(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'fp2', 'model.onnx'), so,
                         providers=['CPUExecutionProvider'])
inp, out = sys.stdin.buffer, sys.stdout.buffer
while True:
    h = inp.read(4)
    if len(h) < 4: break
    n = int(np.frombuffer(h, np.int32)[0])
    P = np.frombuffer(inp.read(n * 64 * 32 * 4), np.float32).reshape(n, 64, 32)
    out.write(s.run(None, {'mel': P})[0].astype(np.float32).tobytes()); out.flush()
