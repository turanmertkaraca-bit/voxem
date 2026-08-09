/* gen-grid-video.mjs — render the real sender stream as a .y4m video that
   Chromium's fake camera (--use-file-for-fake-video-capture) will feed to
   the unmodified app. Frames come from the REAL codec (core.js + sim-core.js
   capture model: perspective fit, gaussian blur, sensor noise, exposure).
   Usage: node gen-grid-video.mjs <grid> <colors> <out.y4m> [fps] [blur] [noise]
*/
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const [grid = 168, colors = 4, out = 'grid-168-4.y4m', fps = 30, blur = 0.3, noise = 3, frames = 300] = process.argv.slice(2).map((v, i) => (i < 2 || i === 3 || i === 4 || i === 5 ? Number(v) : v));
const FPS = Number(fps), BLUR = Number(blur), NOISE = Number(noise);

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

const W = 1280, H = 720;
const name = 'fakecam-test.bin';
const chunkLen = sb.chunkLenFor(grid, colors, sb.nameBytes(name).length);
const payload = new Uint8Array(chunkLen * 9);
for (let i = 0; i < payload.length; i++) payload[i] = (i * 2654435761 + (i >> 8)) >>> 24; // incompressible-ish
const meta = {
  grid, colors, name, chunkLen,
  k: Math.max(8, Math.ceil(payload.length / chunkLen)),
  len: payload.length, clen: payload.length, flags: 0,
  fileCrc: sb.crc32(payload), session: 0xFACE, blocks: [],
};
for (let i = 0; i < meta.k; i++) {
  const start = i * chunkLen;
  const part = payload.subarray(start, Math.min(start + chunkLen, payload.length));
  const blk = new Uint8Array(chunkLen);
  blk.set(part);
  meta.blocks.push(blk);
}
const sysSeeds = [];
for (let i = 1; i <= meta.k; i++) sysSeeds.push(sb.systematicSeedFor(meta.k, i));
sb.seedCounter = 50000;

/* sender canvas: grid fills ~85% of the frame width, centered.
   BORDER/MARKER are consts in the vm script — not sandbox properties —
   so hard-code them (extract-core.js goldens: BORDER=4, MARKER=8). */
const BORDER = 4;
const Sg = grid + 2 * BORDER;
const modulePx = Math.max(2, Math.floor((W * 0.85) / Sg));
const opts = Object.assign({}, S.DEFAULTS, { modulePx, blur: BLUR, noise: NOISE, gain: 1, tintR: 1, tintB: 1 });

function rgb2yuv420(img) {
  const { data, w, h } = img;
  const Y = Buffer.alloc(w * h), U = Buffer.alloc((w >> 1) * (h >> 1)), V = Buffer.alloc((w >> 1) * (h >> 1));
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      const r = data[o], g = data[o + 1], b = data[o + 2];
      Y[y * w + x] = (0.299 * r + 0.587 * g + 0.114 * b) | 0;
      if ((x & 1) === 0 && (y & 1) === 0) {
        // chroma from the 2x2 block's top-left luma pixel; the chroma plane
        // index is (y>>1)*(w>>1)+(x>>1) — NOT a luma-space RGBA offset
        const o2 = ((y & ~1) * w + (x & ~1)) * 4;
        const ci = (y >> 1) * (w >> 1) + (x >> 1);
        const r2 = data[o2], g2 = data[o2 + 1], b2 = data[o2 + 2];
        U[ci] = (-0.169 * r2 - 0.331 * g2 + 0.5 * b2 + 128) | 0;
        V[ci] = (0.5 * r2 - 0.419 * g2 - 0.081 * b2 + 128) | 0;
      }
    }
  }
  return Buffer.concat([Y, U, V]);
}

const FRAMES = frames || 300; // fake camera loops the file
const chunks = [Buffer.from(`YUV4MPEG2 W${W} H${H} F${FPS}:1 Ip A1:1 C420mpeg2\n`)];
for (let i = 0; i < FRAMES; i++) {
  let seed;
  if (i < meta.k) seed = sysSeeds[i];
  else seed = sb.nextSeed();
  const fr = S.genFrame(meta, meta.blocks, seed);
  const screen = S.makeScreen(fr.buf, fr.S, modulePx);
  const cam = S.capture(screen, opts, W, H);
  chunks.push(Buffer.from(`FRAME\n`), rgb2yuv420(cam));
  if (i % 50 === 0) console.log('frame ' + i + '/' + FRAMES + ' (seed ' + seed + ')');
}
fs.writeFileSync(out, Buffer.concat(chunks));
console.log('wrote ' + out + ' (' + path.basename(out) + ', ' + (FRAMES / FPS).toFixed(1) + 's, ' + meta.k + ' blocks, modulePx ' + modulePx + ')');
