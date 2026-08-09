/* compare-frames.mjs — render ONE seed, write it as a 1-frame-loop y4m,
   read back what Chromium renders, compare per-channel stats vs the sim's
   own capture of the same frame. Pinpoints YUV/color conversion corruption.
*/
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const sandbox = {
  console, performance,
  TextEncoder, TextDecoder,
  Uint8Array, Uint8ClampedArray, Uint32Array, Float64Array, Float32Array,
  Int32Array, DataView, Math, Set, Map, Array, Object, JSON, Error,
  crypto: undefined,
};
const sb = Object.assign({}, sandbox);
vm.createContext(sb);
vm.runInContext(fs.readFileSync(path.join(DIR, 'core.js'), 'utf8'), sb);
vm.runInContext(fs.readFileSync(path.join(DIR, 'sim-core.js'), 'utf8'), sb);
const S = sb.LumenSim;

const W = 1280, H = 720, grid = 168, colors = 4;
const name = 'cmp.bin';
const chunkLen = sb.chunkLenFor(grid, colors, sb.nameBytes(name).length);
const payload = new Uint8Array(chunkLen * 9);
for (let i = 0; i < payload.length; i++) payload[i] = (i * 2654435761) >>> 24;
const meta = { grid, colors, name, chunkLen, k: 9, len: payload.length, clen: payload.length, flags: 0, fileCrc: sb.crc32(payload), session: 0xBEEF, blocks: [] };
for (let i = 0; i < meta.k; i++) { const part = payload.subarray(i * chunkLen); const blk = new Uint8Array(chunkLen); blk.set(part.subarray(0, chunkLen)); meta.blocks.push(blk); }

const SEED = sb.systematicSeedFor(meta.k, 1);
const BORDER = 4;
const Sg = grid + 2 * BORDER;
const modulePx = Math.max(2, Math.floor((W * 0.85) / Sg));
const opts = Object.assign({}, S.DEFAULTS, { modulePx, blur: 0.3, noise: 3, gain: 1, tintR: 1, tintB: 1 });

/* sim frame */
const fr = S.genFrame(meta, meta.blocks, SEED);
const screen = S.makeScreen(fr.buf, fr.S, modulePx);
const sim = S.capture(screen, opts, W, H);

/* one-frame y4m */
function rgb2yuv420(img) {
  const { data, w, h } = img;
  const Y = Buffer.alloc(w * h), U = Buffer.alloc((w >> 1) * (h >> 1)), V = Buffer.alloc((w >> 1) * (h >> 1));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const o = (y * w + x) * 4;
    Y[y * w + x] = (0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2]) | 0;
    if ((x & 1) === 0 && (y & 1) === 0) {
      const o2 = ((y >> 1) * (w >> 1) + (x >> 1)) * 4;
      U[(y >> 1) * (w >> 1) + (x >> 1)] = (-0.169 * data[o2] - 0.331 * data[o2 + 1] + 0.5 * data[o2 + 2] + 128) | 0;
      V[(y >> 1) * (w >> 1) + (x >> 1)] = (0.5 * data[o2] - 0.419 * data[o2 + 1] - 0.081 * data[o2 + 2] + 128) | 0;
    }
  }
  return Buffer.concat([Y, U, V]);
}
const chunks = [Buffer.from(`YUV4MPEG2 W${W} H${H} F30:1 Ip A1:1 C420mpeg2\n`)];
for (let f = 0; f < 90; f++) chunks.push(Buffer.from('FRAME\n'), rgb2yuv420(sim));
fs.writeFileSync(path.join(DIR, 'one-frame.y4m'), Buffer.concat(chunks));

/* browser readback */
const server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<video id="v" autoplay playsinline muted></video>'); });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const browser = await chromium.launch({
  headless: true,
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
    '--use-file-for-fake-video-capture=' + path.join(DIR, 'one-frame.y4m'),
    '--autoplay-policy=no-user-gesture-required', '--no-sandbox'],
});
const page = await browser.newPage();
await page.goto('http://127.0.0.1:' + server.address().port + '/');
await page.evaluate(async () => {
  const v = document.getElementById('v');
  v.srcObject = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
});
await page.waitForTimeout(2500);
const bframe = await page.evaluate(() => {
  const v = document.getElementById('v');
  const c = document.createElement('canvas');
  c.width = v.videoWidth; c.height = v.videoHeight;
  const x = c.getContext('2d');
  x.drawImage(v, 0, 0);
  return Array.from(x.getImageData(0, 0, c.width, c.height).data);
});

function stats(d) {
  const byR = [[], [], [], []], byG = [[], [], [], []], byB = [[], [], [], []];
  // classify each pixel by dominant channel to compare color rendering
  let counts = { black: 0, red: 0, green: 0, blue: 0, white: 0, other: 0 };
  const mean = [0, 0, 0];
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i], g = d[i + 1], b = d[i + 2];
    mean[0] += r; mean[1] += g; mean[2] += b;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    const sat = mx > 0 ? 1 - mn / mx : 0;
    if (mx < 30) counts.black++;
    else if (sat < 0.25) counts[mx > 200 ? 'white' : 'other']++;
    else if (r > g * 1.4 && r > b * 1.4) counts.red++;
    else if (g > r * 1.4 && g > b * 1.4) counts.green++;
    else if (b > r * 1.4 && b > g * 1.4) counts.blue++;
    else counts.other++;
  }
  return { mean: mean.map((v) => Math.round(v / (d.length / 4))), counts };
}

console.log('SIM frame  : ' + JSON.stringify(stats(sim.data)));
console.log('BROWSER    : ' + JSON.stringify(stats(bframe)));
await browser.close();
server.close();
process.exit(0);
