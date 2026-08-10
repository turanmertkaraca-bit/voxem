/* selftest2.mjs — headless verification of the lumen2 sim pipeline.
   Loads the REAL core extracted from ../index.html (wire v3: sessionId)
   plus sim-core.js (wire-v3 patched). Tests:
     T1   168/4 @1280x720 fit — must decode
     T1b  168/4 @1920x1080 fit with mild noise/blur
     T2   224/8 @1920x1080 — the >1 MB/s path (M=8 markers)
     T3   focus-blur sweep
     T4   stream + LT pool completes end-to-end
     T5   timing report
     T6   throughput model
     T7   exposure-fault battery (must recover, not just not-throw)
     T8   whitening: no near-black frames on padded tails
     T9   fuzz decodeFrame — never throws
     T10  property roundtrip incl. sessionId (wire v3)
     T11  golden vector (wire v3 pinned)
     T12  torn frames never throw
     T13  systematic degree-1 seeds for all blocks
     T14  DEADLINE REGRESSION: the d0+45 starvation (fixed app policy) must
          decode while the old policy must not — this is the bug that made
          the live receiver never decode (#the-fix)
   Run: node selftest2.mjs   |   QUICK=1 node selftest2.mjs
*/
import vm from 'node:vm';
import fs from 'node:fs';

const QUICK = process.env.QUICK === '1';
const T1N = QUICK ? 2 : 3, T1bN = QUICK ? 2 : 4,
      T2N = QUICK ? 2 : 4, T3N = QUICK ? 1 : 2, T3PTS = QUICK ? 2 : 4,
      T4N = QUICK ? 10 : 30, T4SIZE = QUICK ? 32768 : 65536, T6N = QUICK ? 2 : 3;

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
const SB = sb;
const decodeFrame = SB.decodeFrame, freshState = S.freshState,
      ltEncode = SB.ltEncode, makeSymbol = SB.makeSymbol, crc32 = SB.crc32,
      nameBytes = SB.nameBytes, chunkLenFor = SB.chunkLenFor,
      parseSymbol = SB.parseSymbol, colorsToPayload = SB.colorsToPayload,
      payloadToColors = SB.payloadToColors, solitonCdf = SB.solitonCdf,
      neighborsFor = SB.neighborsFor;
const SESSION = 0x9E2C;

let GOLDEN_VECTOR = '255619bc:6988:9,200';

let passed = 0, failed = 0;
function check(name, ok, extra) {
  if (ok) passed++; else failed++;
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (extra ? '  [' + extra + ']' : ''));
}

/* T1: the one solid regime */
{
  const meta = S.makeMeta(168, 4, 64 * 1024);
  for (const dec of ['real', 'fast']) {
    const opts = Object.assign({}, S.DEFAULTS, { meta, modulePx: 6, blur: 0.2, noise: 2, decoder: dec });
    let ok = 0, last = null;
    for (let i = 0; i < T1N; i++) {
      last = S.runTrial(opts, 1280, 720);
      if (last.ok) ok++;
    }
    check('T1 168/4 @1280x720 fit ' + dec, ok * 2 >= T1N,
      ok + '/' + T1N + (last.ok ? ' ' + last.res.grid + '/' + last.res.colors : ' lastFail=' + last.lastFail + ' markers=' + last.diag.markers));
  }
}

/* T1b: 1080p */
{
  const meta = S.makeMeta(168, 4, 64 * 1024);
  const opts = Object.assign({}, S.DEFAULTS, { meta, modulePx: 8, blur: 0.2, noise: 2, decoder: 'fast' });
  const agg = S.runTrials(opts, 1920, 1080, T1bN);
  console.log('\nT1b 168/4 @1920x1080 fit: ' + agg.ok + '/' + T1bN + ' decoded, ' +
    'detect=' + agg.failDetect + ' sampling=' + agg.failSampling + ' markers~' + agg.markers.toFixed(1));
  check('T1b 1080p decodes at least half', agg.ok * 2 >= T1bN, agg.ok + '/' + T1bN);
}

/* T2: 224/8 — the >1 MB/s path — must decode at 1080p */
{
  const meta = S.makeMeta(224, 8, 64 * 1024);
  const opts = Object.assign({}, S.DEFAULTS, { meta, modulePx: 8, blur: 0.3, noise: 4, decoder: 'real' });
  const agg = S.runTrials(opts, 1920, 1080, T2N);
  console.log('\nT2 224/8 @1920x1080 fit (blur 0.3, noise 4, real decoder): ' + agg.ok + '/' + T2N);
  check('T2 M=8 makes 224/8 decodable', agg.ok * 2 >= T2N, agg.ok + '/' + T2N);
}

/* T2b: the easy-read grids (96/128, 4 colors) must decode at phone-like
   geometry — these are the "it has to work" modes for first-time users. */
{
  for (const [grid, colors] of [[96, 4], [128, 4]]) {
    const meta = S.makeMeta(grid, colors, 64 * 1024);
    const opts = Object.assign({}, S.DEFAULTS, { meta, modulePx: 6, blur: 0.3, noise: 3, decoder: 'real' });
    const agg = S.runTrials(opts, 1280, 720, T2N);
    console.log('\nT2b ' + grid + '/' + colors + ' @1280x720 (blur 0.3, noise 3): ' + agg.ok + '/' + T2N +
      '  detect=' + agg.failDetect + ' sampling=' + agg.failSampling);
    check('T2b ' + grid + '/' + colors + ' easy-read grid decodes', agg.ok * 2 >= T2N, agg.ok + '/' + T2N);
  }
}

/* T2c: the user-reported real-world case — 96/4 at ~4.8px/module (phone
   screen ~10 device px/module, camera at arm's length filling ~40% of the
   frame). This is the module-size edge where chroma bleed + blur used to
   kill every frame; must decode now. */
{
  for (const [grid, colors, modulePx] of [[96, 4, 5], [168, 4, 5]]) {
    const meta = S.makeMeta(grid, colors, 64 * 1024);
    const opts = Object.assign({}, S.DEFAULTS, { meta, modulePx, blur: 0.3, noise: 3, decoder: 'real' });
    const agg = S.runTrials(opts, 1280, 720, T2N);
    console.log('\nT2c ' + grid + '/' + colors + ' @' + modulePx + 'px/module (user case): ' + agg.ok + '/' + T2N +
      '  detect=' + agg.failDetect + ' sampling=' + agg.failSampling);
    check('T2c ' + grid + '/' + colors + ' @' + modulePx + 'px/module decodes', agg.ok * 2 >= T2N, agg.ok + '/' + T2N);
  }
}

/* T2d: 8-COLOR grids (all the colors!) must decode at realistic sizes —
   128/8 and 168/8 at ~5-6 px/module (720p fit) and at 1080p. */
{
  for (const [grid, colors, camW, camH, modulePx] of [[128, 8, 1280, 720, 6], [168, 8, 1920, 1080, 8], [128, 8, 1920, 1080, 8]]) {
    const meta = S.makeMeta(grid, colors, 64 * 1024);
    const opts = Object.assign({}, S.DEFAULTS, { meta, modulePx, blur: 0.2, noise: 3, decoder: 'real' });
    const agg = S.runTrials(opts, camW, camH, T2N);
    console.log('\nT2d ' + grid + '/' + colors + ' @' + camW + 'x' + camH + ': ' + agg.ok + '/' + T2N +
      '  detect=' + agg.failDetect + ' sampling=' + agg.failSampling);
    check('T2d ' + grid + '/' + colors + ' 8-color grid decodes', agg.ok * 2 >= T2N, agg.ok + '/' + T2N);
  }
}

/* T3: focus-blur cliff */
console.log('\nT3 blur sweep (1280x720 fit, 168/4, modulePx 6 -> eff. 3.76 px/module, ' + T3N + ' trials/point):');
for (const row of S.sweep('blur', 0, 1.0, T3PTS, Object.assign({}, S.DEFAULTS, { meta: S.makeMeta(168, 4, 64 * 1024), modulePx: 6, noise: 2 }), 1280, 720, T3N)) {
  const bar = '#'.repeat(Math.round(row.rate * 30));
  console.log('  blur ' + row.v.toFixed(2).padStart(5) + '  ' + (row.rate * 100).toFixed(0).padStart(3) + '%  ' +
    bar.padEnd(30) + '  detect=' + row.failDetect + ' sampling=' + row.failSampling + ' ' + row.ms.toFixed(0) + 'ms');
}

/* T4: stream + LT pool completes. Uses SYSTEMATIC seeds for the first k
   frames (exactly what the app's sender does) plus random repairs — the
   systematic pass guarantees every block arrives as a degree-1 symbol, so
   the pool always solves. RNG is pinned for determinism. */
{
  const meta = S.makeMeta(168, 4, T4SIZE);
  const opts = Object.assign({}, S.DEFAULTS, { meta, modulePx: 6, blur: 0.2, noise: 2, decoder: 'fast' });
  const st = S.makeStream();
  st.begin(opts);
  const total = T4N;
  const k = meta.k;
  const sysSeeds = [];
  for (let i = 1; i <= k; i++) sysSeeds.push(sb.systematicSeedFor(k, i));
  for (let i = 0; i < total; i++) {
    S.setSimSeed(0x5EED + i * 0x9E3779B9);
    if (i < k) st.step(opts, 1280, 720, sysSeeds[i]);
    else st.step(opts, 1280, 720);
  }
  check('T4 stream LT pool solved ' + st.solved + '/' + k + ' from ' + st.unique + ' unique of ' + total + ' frames',
    st.solved === k, st.solved + '/' + k + ' (' + st.unique + ' unique)');
}

/* T5: timing */
{
  const meta = S.makeMeta(168, 4, 64 * 1024);
  const opts = Object.assign({}, S.DEFAULTS, { meta, modulePx: 6, blur: 0.3, noise: 4 });
  const t0 = performance.now();
  S.runTrial(opts, 1280, 720);
  console.log('\nT5 1280x720 blur0.3 noise4: ' + (performance.now() - t0).toFixed(0) + ' ms/frame (full capture+decode)');
  check('T5 under 60s/frame on this box', performance.now() - t0 < 60000);
}

/* T6: throughput model */
{
  console.log('\nT6 throughput (fast decoder):');
  console.log('  sender theoretical max per combo:');
  for (const row of S.senderMaxBytes()) {
    console.log('   ' + row.grid + '/' + row.colors + '  ' + row.chunk + ' B/sym -> 30fps ' +
      (row.perFps[4] / 1024).toFixed(0) + ' KB/s, 60fps ' + (row.perFps[6] / 1024).toFixed(0) + ' KB/s' +
      (row.perFps[6] >= 1048576 ? '  <-- breaks 1 MB/s' : ''));
  }
  let tp224 = null, best224 = null;
  for (const [grid, colors] of [[224, 4], [224, 8]]) {
    const meta = S.makeMeta(grid, colors, 64 * 1024);
    const opts = Object.assign({}, S.DEFAULTS, { meta, modulePx: 8, blur: 0.2, noise: 2, decoder: 'fast', camFps: 60 });
    const tp = S.estimateThroughput(opts, 1280, 720, T6N);
    const best = tp.rows.slice().sort((a, b) => b.kBs - a.kBs)[0];
    if (grid === 224 && colors === 4) { tp224 = tp; best224 = best; }
    console.log('  ' + grid + '/' + colors + ' @1280x720 fit: ' + tp.ms.toFixed(0) + 'ms/frame (' +
      tp.decodeFps.toFixed(2) + ' fps), success ' + (tp.success * 100).toFixed(0) + '%, best ' +
      best.kBs.toFixed(0) + ' KB/s at ' + best.fps + 'fps sender');
  }
  check('T6 model sane (success > 0, best <= sender ceiling)',
    tp224.success > 0 && best224.kBs <= 12445 * 60 / 1024,
    'success ' + (tp224.success * 100).toFixed(0) + '%, best ' + best224.kBs.toFixed(0) + ' KB/s, sender ceiling ' + (12445 * 60 / 1024).toFixed(0) + ' KB/s');
}

/* T7: exposure-fault battery — must RECOVER these frames, not just survive */
{
  const run = (grid, colors, extra, n) => {
    const m = S.makeMeta(grid, colors, 64 * 1024);
    const opts = Object.assign({}, S.DEFAULTS, { meta: m, modulePx: 6, blur: 0.2, noise: 3 }, extra);
    let ok = 0;
    for (let i = 0; i < n; i++) { const r = S.runTrial(opts, 1280, 720); if (r.ok) ok++; }
    return ok;
  };
  const N = QUICK ? 2 : 4;
  const cases = [
    ['underexposed warm', 168, 4, { gain: 0.55, tintR: 1.25, tintB: 0.7 }],
    ['dark noisy        ', 168, 4, { gain: 0.6, noise: 10 }],
    ['AGC lift (168 mild)', 168, 4, { gain: 1.05, blackOffset: 8, noise: 4 }],
    ['AGC lift (96 heavy)', 96, 4, { gain: 1.6, blackOffset: 35, noise: 4 }],
  ];
  let allOk = true;
  for (const [label, grid, colors, extra] of cases) {
    const o = run(grid, colors, extra, N);
    console.log('\nT7 ' + label + ': ' + o + '/' + N);
    if (o * 2 < N) allOk = false;
  }
  check('T7 exposure-fault recovery', allOk, '');
}

/* T8: whitening + padded tails */
{
  const meta = S.makeMeta(168, 4, 6997, { paddedTail: true }); // k=2, last block 40 real bytes
  let worst = 0;
  for (let i = 0; i < 40; i++) {
    const fr = S.genFrame(meta, meta.blocks, 1000 + i);
    let black = 0, total = 0;
    for (let j = 0; j < fr.buf.length; j++) {
      const v = fr.buf[j];
      if (v !== 0xffffffff) { total++; if ((v & 0xffffff) === 0) black++; }
    }
    worst = Math.max(worst, total ? black / total : 0);
  }
  console.log('\nT8 padded-tail worst single-colour fraction: ' + (worst * 100).toFixed(1) + '%');
  check('T8 whitening: no near-black frames on padded tails', worst < 0.45, (worst * 100).toFixed(1) + '% worst');
}

/* T9: fuzz decodeFrame — never throws */
{
  let threw = 0;
  for (let i = 0; i < 20; i++) {
    const w = 160 + (i * 37) % 480, h = 120 + (i * 53) % 360;
    const data = new Uint8ClampedArray(w * h * 4);
    for (let j = 0; j < data.length; j += 4) {
      data[j] = Math.random() * 255; data[j + 1] = Math.random() * 255; data[j + 2] = Math.random() * 255; data[j + 3] = 255;
    }
    if (i % 3 === 0) { for (let j = 0; j < w * 40; j++) { const o = j * 4; data[o] = 255; data[o + 1] = 255; data[o + 2] = 255; } }
    try { S.DECODERS.real({ data, w, h }, S.freshState()); }
    catch (e) { threw++; }
  }
  check('T9 fuzz: decodeFrame never throws', threw === 0, threw + ' throws');
}

/* T10: property roundtrip incl. sessionId across random k/grid/palette/name */
{
  let bad = 0, n = 0;
  for (let i = 0; i < 12; i++) {
    const grid = i % 2 ? 224 : 168, colors = i % 3 ? 8 : 4;
    const k = 1 + (i * 7) % 24;
    const name = i % 4 === 3 ? 'fïlé-名.txt' : 'sim-test.bin';
    const chunkLen = chunkLenFor(grid, colors, nameBytes(name).length);
    const size = Math.max(1, k * chunkLen - (i % 5) * 17);
    const meta = S.makeMeta(grid, colors, size);
    const seed = 4242 + i * 131;
    const data = ltEncode(seed, meta.k, meta.blocks, meta.chunkLen);
    const frame = makeSymbol(seed, SESSION, meta.k, meta.len, meta.clen, meta.flags, meta.name, meta.fileCrc || 0, data);
    const full = new Uint8Array(frame.length + 4);
    full.set(frame);
    const c = crc32(frame);
    full[frame.length] = (c >>> 24) & 255; full[frame.length + 1] = (c >>> 16) & 255;
    full[frame.length + 2] = (c >>> 8) & 255; full[frame.length + 3] = c & 255;
    const idx = payloadToColors(full, grid, colors);
    const back = colorsToPayload(idx, grid, colors, full.length);
    n++;
    if (!back) { bad++; continue; }
    const sym = parseSymbol(back.subarray(0, back.length - 4));
    if (!sym || sym.seed !== seed || sym.k !== meta.k || sym.sessionId !== SESSION) bad++;
  }
  check('T10 property roundtrip incl. sessionId', bad === 0, bad + '/' + n + ' mismatches');
}

/* T11: golden vector — wire v3 must stay byte-identical */
{
  S.setSimSeed(0x1234);
  const meta = S.makeMeta(168, 4, 64 * 1024);
  const data = ltEncode(777, meta.k, meta.blocks, meta.chunkLen);
  const frame = makeSymbol(777, SESSION, meta.k, meta.len, meta.clen, meta.flags, meta.name, meta.fileCrc || 0, data);
  const crc = crc32(frame);
  const hash = (crc >>> 0).toString(16) + ':' + frame.length + ':' + frame[0] + ',' + frame[24];
  console.log('\nT11 golden vector: ' + hash);
  check('T11 wire-format golden vector stable (wire v3)', hash === GOLDEN_VECTOR, hash);
}

/* T12: torn frames never throw */
{
  const meta = S.makeMeta(168, 4, 64 * 1024);
  let ok = 0, threw = 0;
  for (let i = 0; i < 8; i++) {
    const opts = Object.assign({}, S.DEFAULTS, { meta, modulePx: 6, blur: 0.1, noise: 2, tear: 0.4 + (i % 3) * 0.2 });
    const t = S.runTrial(opts, 1280, 720);
    if (t.lastFail && t.lastFail.indexOf('throw') === 0) threw++;
    if (t.ok) ok++;
  }
  check('T12 torn frames never throw', threw === 0, ok + '/8 decoded (CRC drops the rest)');
}

/* T13: systematic seeds exist for every block of k=10 */
{
  const cdf = solitonCdf(10);
  let missing = 0;
  for (let i = 1; i <= 10; i++) {
    let found = false;
    for (let s = 1; s < 40000; s++) {
      const nb = neighborsFor(s, 10, cdf);
      if (nb.length === 1 && nb[0] === i) { found = true; break; }
    }
    if (!found) missing++;
  }
  check('T13 systematic degree-1 seeds for all blocks', missing === 0, missing + ' missing');
}

/* T14: DEADLINE REGRESSION — the app's ingestFrame policies vs decode.
   Old policy (d0+45) starved acquisition: 0/N decoded even though the
   decoder itself is fine. New policy (no deadline while acquiring,
   d0+150 after lock) must decode ~all. This is THE live-receiver bug. */
{
  const meta = S.makeMeta(168, 4, 64 * 1024);
  const opts = Object.assign({}, S.DEFAULTS, { meta, modulePx: 6, blur: 0.2, noise: 2 });
  const N = QUICK ? 5 : 10;
  const stream = (policy) => {
    const state = freshState();
    let ok = 0;
    for (let i = 0; i < N; i++) {
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
      catch (e) {}
      if (res) ok++;
    }
    return ok;
  };
  const old = stream('old'), nw = stream('new');
  console.log('\nT14 deadline regression (' + N + ' frames each): old policy ' + old + '/' + N + ' decoded, new policy ' + nw + '/' + N);
  check('T14 adaptive deadline decodes (old 45ms starved)', nw * 2 >= N && old === 0, 'old=' + old + ' new=' + nw);
}

/* T15: FULL pipeline with the app's gzip container: random file -> gzip
   (native CompressionStream) -> sim stream -> own LT pool -> assemble ->
   gunzip -> CRC compare. Exercises the exact app wire (flags=1, clen<len). */
{
  const raw = new Uint8Array(48 * 1024);
  for (let i = 0; i < raw.length; i++) raw[i] = (i * 2654435761 + 17) >>> 24;
  const gz = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
  const name = 'app-test.bin';
  const chunkLen = chunkLenFor(168, 4, nameBytes(name).length);
  const k = Math.max(8, Math.ceil(gz.length / chunkLen));
  const blocks = [];
  for (let i = 0; i < k; i++) {
    const start = i * chunkLen;
    const part = gz.subarray(start, Math.min(start + chunkLen, gz.length));
    const blk = new Uint8Array(chunkLen);
    blk.set(part);
    if (start >= gz.length) { const r = SB.mulberry32(0xC0FFEE + i); for (let j = 0; j < chunkLen; j++) blk[j] = (r() * 256) | 0; }
    blocks.push(blk);
  }
  const meta = { grid: 168, colors: 4, name, chunkLen, k, len: raw.length, clen: gz.length, flags: 1, fileCrc: crc32(raw), session: SESSION, blocks };
  const opts = Object.assign({}, S.DEFAULTS, { meta, modulePx: 6, blur: 0.2, noise: 2, decoder: 'fast' });
  const state = freshState();
  const decoder = SB.createLtDecoder();
  const seen = new Set();
  const maxFrames = QUICK ? 40 : 90;
  for (let i = 0; i < maxFrames && decoder.solved < k; i++) {
    const seed = (Math.random() * 4294967296) >>> 0;
    const fr = S.genFrame(meta, meta.blocks, seed);
    const screen = S.makeScreen(fr.buf, fr.S, opts.modulePx);
    const cam = S.capture(screen, opts, 1280, 720);
    const res = S.DECODERS.fast({ data: cam.data, w: cam.w, h: cam.h }, state);
    if (res && res.type === 'symbol' && !seen.has(res.sym.seed)) {
      seen.add(res.sym.seed);
      decoder.add([{ seed: res.sym.seed, data: res.sym.data }], meta.k);
    }
  }
  let ok = false, err = '';
  if (decoder.solved === k) {
    try {
      const container = new Uint8Array(meta.clen);
      let o = 0;
      for (let i = 1; i <= k; i++) {
        const blk = decoder.blocks.get(i);
        const take = Math.min(blk.length, meta.clen - o);
        container.set(blk.subarray(0, take), o);
        o += take;
      }
      const inflated = new Uint8Array(await new Response(new Blob([container]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
      ok = inflated.length === raw.length && crc32(inflated) === crc32(raw);
      if (!ok) err = 'size ' + inflated.length + ' crc ' + crc32(inflated).toString(16);
    } catch (e) { err = e.message; }
  } else err = 'pool solved ' + decoder.solved + '/' + k + ' after ' + maxFrames + ' frames';
  check('T15 gzip pipeline: gzip -> stream -> assemble -> gunzip -> CRC match', ok, err || (k + ' blocks, ' + gz.length + ' B gzipped, ' + seen.size + ' unique)'));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);