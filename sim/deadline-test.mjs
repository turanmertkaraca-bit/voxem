/* deadline-test.mjs — reproduce the live-app decode path: persistent state,
   decodeFrame called with the ingestFrame deadline policy on every frame.
   Old policy (d0+45) starved acquisition; new policy: no deadline while
   acquiring (lockCount === 0), d0+150 once locked. */
import vm from 'node:vm';
import fs from 'node:fs';

const sandbox = {
  console, performance,
  TextEncoder, TextDecoder,
  Uint8Array, Uint8ClampedArray, Uint32Array, Float64Array, Float32Array,
  Int32Array, DataView, Math, Set, Map, Array, Object, JSON, Error,
  crypto: undefined,
};
const sb = Object.assign({}, sandbox);
vm.createContext(sb);
vm.runInContext(fs.readFileSync('core.js', 'utf8'), sb);
vm.runInContext(fs.readFileSync('sim-core.js', 'utf8'), sb);

const S = sb.LumenSim;
const decodeFrame = sb.decodeFrame;
const freshState = S.freshState;

const meta = S.makeMeta(168, 4, 64 * 1024);
const opts = Object.assign({}, S.DEFAULTS, { meta, modulePx: 6, blur: 0.2, noise: 2 });

/* full stream: persistent state, fresh camera frames */
function stream(nFrames, policy) {
  const state = freshState();
  let ok = 0, locked = 0, failDetect = 0, failSampling = 0, tTotal = 0, tDec = 0;
  for (let i = 0; i < nFrames; i++) {
    const seed = (Math.random() * 4294967296) >>> 0;
    const fr = S.genFrame(meta, meta.blocks, seed);
    const screen = S.makeScreen(fr.buf, fr.S, opts.modulePx);
    const cam = S.capture(screen, opts, 1280, 720);
    const t0 = performance.now();
    const d = policy === 'old' ? t0 + 45
            : policy === 'new' ? (state.lockCount > 0 ? t0 + 150 : undefined)
            : undefined;
    let res = null;
    try { res = decodeFrame({ data: cam.data, w: cam.w, h: cam.h }, state, d); }
    catch (e) { console.log('THROW', e.message); }
    const ms = performance.now() - t0;
    tTotal += ms; tDec += ms;
    if (res) {
      ok++;
      if (state.lockCount > 0 && state.H) locked++;
    } else {
      if (state.lastFail === 'detect') failDetect++;
      else failSampling++;
    }
  }
  return { ok, locked, failDetect, failSampling, avgMs: tTotal / nFrames };
}

for (const n of [3, 10]) {
  const oldDl = stream(n, 'old');
  const newDl = stream(n, 'new');
  const noDl = stream(n, 'none');
  console.log('--- ' + n + ' frames, persistent state ---');
  console.log('OLD policy (d0+45):      decoded ' + oldDl.ok + '/' + n +
    '  detect=' + oldDl.failDetect + ' sampling=' + oldDl.failSampling +
    '  avg ' + oldDl.avgMs.toFixed(0) + 'ms/frame');
  console.log('NEW policy (adaptive):   decoded ' + newDl.ok + '/' + n +
    '  detect=' + newDl.failDetect + ' sampling=' + newDl.failSampling +
    '  avg ' + newDl.avgMs.toFixed(0) + 'ms/frame');
  console.log('NO deadline (selftest):  decoded ' + noDl.ok + '/' + n +
    '  detect=' + noDl.failDetect + ' sampling=' + noDl.failSampling +
    '  avg ' + noDl.avgMs.toFixed(0) + 'ms/frame');
}
