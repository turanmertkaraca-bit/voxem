/* debug-t4.mjs — reproduce T4 and print each decoded symbol's degree */
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

const meta = S.makeMeta(168, 4, 32768);
const opts = Object.assign({}, S.DEFAULTS, { meta, modulePx: 6, blur: 0.2, noise: 2, decoder: 'fast' });
const st = S.makeStream();
st.begin(opts);
for (let i = 0; i < 10; i++) {
  const r = st.step(opts, 1280, 720);
  if (r.res && r.res.type === 'symbol') {
    const nb = sb.neighborsFor(r.res.sym.seed, meta.k, sb.solitonCdf(meta.k));
    console.log('frame ' + i + ': seed=' + r.res.sym.seed + ' deg=' + nb.length + ' neighbors=' + JSON.stringify(nb) + ' solved=' + st.solved);
  } else {
    console.log('frame ' + i + ': NO SYMBOL' + (r.res ? JSON.stringify(r.res) : '') + ' lastFail=' + r.state.lastFail);
  }
}
console.log('final solved: ' + st.solved + '/' + meta.k + ' unique: ' + st.unique);
