/* build.mjs — assemble lumen2/index.html from the proven lumen core.
   - Wire v3: 25-byte header (adds u16 sessionId), same CRC32 + name bytes
   - Drops the calibration-QR path entirely (jsQR/qrcode CDNs, renderCalib,
     calibJson, calibFromJson, decodeFrame's jsQR branch)
   - gzip via native CompressionStream (zero CDN dependencies)
   Run: node build.mjs   (writes ../index.html)
*/
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));

const CORE = fs.readFileSync(path.join(DIR, '..', 'lumen', 'lumen-sim', 'core.js'), 'utf8').replace(/\r\n/g, '\n');
const TPL = fs.readFileSync(path.join(DIR, 'app.template.html'), 'utf8').replace(/\r\n/g, '\n');

function section(start, end) {
  let i0 = CORE.indexOf(start);
  i0 = CORE.lastIndexOf('/*', i0);
  let i1 = CORE.indexOf(end);
  i1 = CORE.indexOf('*/', i1) + 2;
  return CORE.slice(i0, i1);
}

/* ---------- wire v3 ---------- */
const WIRE = `/* ---------------- wire format v3 + CRC32 ----------------
   HEADER_BASE = 25: seed u32, sessionId u16, k u32, len u32, clen u32,
   nameLen u16, flags u8, fileCrc u32. sessionId is random per send — the
   receiver resets its pool the moment it changes, so a re-sent file (same
   k/clen/len) can never mix old symbols into a new stream. */
const HEADER_BASE = 25;
const NAME_MAX = 64;
const FLAG_DEFLATED = 1;
const CRC_BYTES = 4;

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

/* nameBytes: truncate on a UTF-8 code-point boundary so a split multi-byte
   sequence never turns into U+FFFD in the received filename */
function nameBytes(name) {
  const bytes = new TextEncoder().encode(name);
  if (bytes.length <= NAME_MAX) return bytes;
  let cut = NAME_MAX;
  while (cut > 0 && (bytes[cut] & 0xc0) === 0x80) cut--;
  return bytes.subarray(0, cut);
}

function makeSymbol(seed, sessionId, k, len, clen, flags, name, fileCrc, data) {
  const nb = nameBytes(name);
  const out = new Uint8Array(HEADER_BASE + nb.length + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, seed >>> 0, true);
  dv.setUint16(4, sessionId, true);
  dv.setUint32(6, k, true);
  dv.setUint32(10, len, true);
  dv.setUint32(14, clen, true);
  dv.setUint16(18, nb.length, true);
  dv.setUint8(20, flags, true);
  dv.setUint32(21, fileCrc >>> 0, true);
  out.set(nb, HEADER_BASE);
  out.set(data, HEADER_BASE + nb.length);
  return out;
}

function parseSymbol(buf) {
  if (!buf || buf.length < HEADER_BASE + 1) return null;
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const seed = dv.getUint32(0, true);
  const sessionId = dv.getUint16(4, true);
  const k = dv.getUint32(6, true);
  const len = dv.getUint32(10, true);
  const clen = dv.getUint32(14, true);
  const nl = dv.getUint16(18, true);
  const flags = dv.getUint8(20);
  const fileCrc = dv.getUint32(21, true);
  if (k < 1 || clen < 1 || nl > NAME_MAX) return null;
  if (buf.length < HEADER_BASE + nl + 1) return null;
  let name = '';
  try { name = new TextDecoder().decode(buf.subarray(HEADER_BASE, HEADER_BASE + nl)); } catch (e) { return null; }
  const data = buf.slice(HEADER_BASE + nl);
  if (data.length === 0) return null;
  return { seed, sessionId, k, len, clen, flags, name, fileCrc, data };
}

function randomSeed() {
  if (globalThis.crypto && crypto.getRandomValues) {
    return crypto.getRandomValues(new Uint32Array(1))[0] >>> 0;
  }
  return Math.floor(Math.random() * 4294967296) >>> 0;
}

/* counter-based symbol seeds: a monotonic counter can never collide with an
   earlier seed, so every transmitted symbol is a new one — random seeds
   colliding wastes frames. Reset per stream (startSending sets it to 50000,
   past the systematic-seed search range, so the two never overlap). */
let seedCounter = 0;
function nextSeed() {
  seedCounter = (seedCounter + 1) >>> 0;
  if (seedCounter === 0) seedCounter = 1;
  return seedCounter;
}

/* systematic fountain seeds: send block 1..k as plain degree-1 symbols
   first, so a clean transfer finishes in ~k frames instead of 1.15-1.5k.
   A degree-1 seed over block i is found by search (deterministic mulberry32
   — the receiver recomputes the same neighbors, so no wire change). */
const _deg1Cache = new Map();
function systematicSeedFor(k, block) {
  let arr = _deg1Cache.get(k);
  if (!arr) {
    const cdf = solitonCdf(k);
    arr = new Array(k + 1);
    for (let i = 1; i <= k; i++) {
      for (let s = 1; s < 40000; s++) {
        const nb = neighborsFor(s, k, cdf);
        if (nb.length === 1 && nb[0] === i) { arr[i] = s; break; }
      }
    }
    _deg1Cache.set(k, arr);
  }
  return arr[block];
}

function fmtBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1048576).toFixed(2) + ' MB';
}
function fmtRate(n) {
  if (n < 1024) return Math.round(n) + ' B/s';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB/s';
  return (n / 1048576).toFixed(2) + ' MB/s';
}

/* ============================================================
   PHYSICAL-CORE-BEGIN — color grid codec (DOM-free).
   Render + camera-decode primitives operating on RGBA buffers.
   ============================================================ */
`;

/* ---------- physical core, minus the calibration-QR machinery ---------- */
let PHYS = section('PHYSICAL-CORE-BEGIN', 'PHYSICAL-CORE-END');
// renderCalib/calibJson/calibFromJson block
const cb0 = PHYS.indexOf('/* ---- render the calibration QR frame ---- */');
const cb1 = PHYS.indexOf('/* ---- color math ---- */');
if (cb0 < 0 || cb1 < 0) throw new Error('calib block anchors not found');
PHYS = PHYS.slice(0, cb0) + PHYS.slice(cb1);
// decodeFrame's jsQR branch
const jq0 = PHYS.indexOf('if (!markers) {');
const jq1 = PHYS.indexOf('// refine the white level');
if (jq0 < 0 || jq1 < 0) throw new Error('jsQR branch anchors not found');
PHYS = PHYS.slice(0, jq0) + PHYS.slice(jq1);
// voxem: four grid sizes (96/128 easy-read modes added)
PHYS = PHYS.replace(
  'const GRID_OPTIONS = [168, 224];',
  'const GRID_OPTIONS = [96, 128, 168, 224];'
);
// voxem: multi-grid acquisition — try every grid size, est-nearest first
const GRID_BLOCK_OLD = `  const locked = !!(state.lockCount > 0 && state.grid && state.colors);
  const g1 = state.grid || est || 168;
  const g2 = g1 === 168 ? 224 : 168;
  const c1 = markers ? markers.colors : (state.colors || 4);
  const c2 = c1 === 4 ? 8 : 4;
  const grids = locked ? [state.grid] : [g1, g2];
  const cols = locked ? [state.colors] : [c1, c2];`;
const GRID_BLOCK_NEW = `  const locked = !!(state.lockCount > 0 && state.grid && state.colors);
  let grids;
  if (locked) grids = [state.grid];
  else {
    grids = GRID_OPTIONS.slice();
    if (est) grids.sort((a, b) => Math.abs(a - est) - Math.abs(b - est));
  }
  const g1 = grids[0];
  const c1 = markers ? markers.colors : (state.colors || 4);
  const c2 = c1 === 4 ? 8 : 4;
  const cols = locked ? [state.colors] : [c1, c2];`;
if (!PHYS.includes(GRID_BLOCK_OLD)) throw new Error('grids block not found');
PHYS = PHYS.replace(GRID_BLOCK_OLD, GRID_BLOCK_NEW);
// voxem: LUMA-PRIMARY classification. Real cameras subsample chroma (4:2:0
// video, Bayer demosaic) — at module scale (~2-4px) chroma blends between
// neighbors and hue becomes unreliable (the headless sim never modeled it,
// so it decoded 100% while real hardware decoded ~0%). Luma survives at
// full resolution, and every palette color has a distinct luma, so bin by
// normalized luma instead of hue.
const PROTOS_OLD = `function makePrototypes(colors, palHex) {
  const names = PALETTES[colors].list;
  const hexes = palHex || PALETTE_HEX[colors];
  const protos = [];
  for (let i = 0; i < names.length; i++) {
    const [h, s, v] = hexToHsv(hexes[i]);
    protos.push({ index: i, h, s, v, chromatic: s >= 0.2 });
  }
  return protos;
}`;
const PROTOS_NEW = `function makePrototypes(colors, palHex) {
  const names = PALETTES[colors].list;
  const hexes = palHex || PALETTE_HEX[colors];
  const protos = [];
  for (let i = 0; i < names.length; i++) {
    const [h, s, v] = hexToHsv(hexes[i]);
    const R = parseInt(hexes[i].slice(1, 3), 16), G = parseInt(hexes[i].slice(3, 5), 16), B = parseInt(hexes[i].slice(5, 7), 16);
    protos.push({ index: i, h, s, v, chromatic: s >= 0.2, luma: 0.299 * R + 0.587 * G + 0.114 * B });
  }
  return protos;
}`;
if (!PHYS.includes(PROTOS_OLD)) throw new Error('makePrototypes block not found');
PHYS = PHYS.replace(PROTOS_OLD, PROTOS_NEW);
const CLASSIFY_OLD = `function classifyPixel(r, g, b, protos, cal) {
  if (cal) {
    const span = Math.max(16, cal.white - cal.black);
    const f = 200 / span;
    r = Math.min(255, r * f); g = Math.min(255, g * f); b = Math.min(255, b * f);
  }
  const [h, s, v] = rgb2hsv(r, g, b);
  // dark pixels are BLACK regardless of saturation: the dark-grey data
  // colour (#161616) plus a couple of units of sensor noise lands at
  // s~0.3 — past the low-sat gate — where the chromatic branch rejects it
  // (distance > 95 -> unknown -> frame lost). The exposure stretch already
  // normalised brightness, so v < 0.30 is a safe black test in any palette
  // (8-color's white sits at v~1).
  if (v < 0.30) return 0;
  if (s < 0.22) {
    if (v < 0.45) return 0;
    if (protos.length === 8) return v >= 0.85 ? 7 : -1;
    return -1;
  }
  let best = -1, bestD = Infinity;
  for (const p of protos) {
    if (!p.chromatic) continue;
    let dh = Math.abs(h - p.h);
    if (dh > 180) dh = 360 - dh;
    const d = dh + Math.abs(v - p.v) * 90 + Math.abs(s - p.s) * 50;
    if (d < bestD) { bestD = d; best = p.index; }
  }
  if (bestD > 95) return -1;
  return best;
}`;
const CLASSIFY_NEW = `function classifyPixel(r, g, b, protos, cal) {
  // LUMA-PRIMARY classification. Real cameras subsample chroma (4:2:0
  // video, Bayer demosaic) — at module scale (~2-4px) chroma blends
  // between neighbors and hue becomes unreliable, but luma survives at
  // full resolution. Every palette color has a distinct luma, so bin by
  // luma normalized against the frame's own white/black refs (the 4 corner
  // markers + white border ring, which are solid and chroma-robust).
  let v = 0.299 * r + 0.587 * g + 0.114 * b;
  if (cal) {
    const span = Math.max(16, cal.white - cal.black);
    v = ((v - cal.black) * 255) / span;
  }
  v = Math.max(0, Math.min(255, v));
  let best = -1, bestD = Infinity;
  for (const p of protos) {
    const d = Math.abs(v - p.luma);
    if (d < bestD) { bestD = d; best = p.index; }
  }
  return bestD <= 45 ? best : -1;
}`;
if (!PHYS.includes(CLASSIFY_OLD)) throw new Error('classifyPixel body not found');
PHYS = PHYS.replace(CLASSIFY_OLD, CLASSIFY_NEW);
// voxem: 4-color DATA palette is black/red/green/WHITE (luma 0/76/150/255)
// instead of black/red/green/blue (0/76/150/29). Blue's luma is only 29
// units from black — at ~3px/module with blur+noise the bins overlap and
// whole frames die (colorsToPayload nulls on any unknown module). White
// gives 76-105-unit gaps, robust to 4:2:0 chroma bleed. The corner MARKERS
// stay black/red/green/blue (solid 8x8 blocks, chroma-safe) so marker
// detection is unchanged.
const PAL4_OLD = `  4: { black: 0xff000000, red: 0xff0000ff, green: 0xff00ff00, blue: 0xffff0000, list: ['black', 'red', 'green', 'blue'] },`;
const PAL4_NEW = `  4: { black: 0xff000000, red: 0xff0000ff, green: 0xff00ff00, blue: 0xffff0000, white: 0xffffffff, list: ['black', 'red', 'green', 'white'] },`;
if (!PHYS.includes(PAL4_OLD)) throw new Error('palette-4 block not found');
PHYS = PHYS.replace(PAL4_OLD, PAL4_NEW);
const PALHEX4_OLD = `  4: ['#000000', '#ff0000', '#00ff00', '#0000ff'],`;
const PALHEX4_NEW = `  4: ['#000000', '#ff0000', '#00ff00', '#ffffff'],`;
if (!PHYS.includes(PALHEX4_OLD)) throw new Error('palette-hex-4 block not found');
PHYS = PHYS.replace(PALHEX4_OLD, PALHEX4_NEW);
// voxem: 9-point majority sampling. At 3-5px/module the 5-point pass left
// boundary-blend modules unresolved (any single unknown killed the frame
// in colorsToPayload) and 3-of-5 majors were wrong on blends. 9 points
// (±0.28 module offsets) make the majority stable; ties resolve to the
// center sample; the last resort is the majority leader. Wrong guesses
// just fail CRC — a clean frame is never dropped for lack of a majority.
const SAMPLE9_OLD = `function sampleGrid(img, H, GRID, lut) {
  const { data, w, h } = img;
  const idx = new Uint8Array(GRID * GRID).fill(255);
  const OFF = [[0, 0], [0.15, 0], [-0.15, 0], [0, 0.15], [0, -0.15]];
  for (let my = 0; my < GRID; my++) {
    for (let mx = 0; mx < GRID; mx++) {
      const votes = [0, 0, 0, 0, 0, 0, 0, 0];
      let n = 0;
      for (let s = 0; s < 5; s++) {
        const [ix, iy] = applyH(H, mx + 0.5 + OFF[s][0], my + 0.5 + OFF[s][1]);
        const xi = Math.round(ix), yi = Math.round(iy);
        if (xi < 0 || yi < 0 || xi >= w || yi >= h) continue;
        const pi = (yi * w + xi) * 4;
        const c = lut[((data[pi] >> 3) << 10) | ((data[pi + 1] >> 3) << 5) | (data[pi + 2] >> 3)];
        if (c !== 255) { votes[c]++; n++; }
      }
      if (n < 3) continue;
      let best = -1, bc = 0;
      for (let c = 0; c < votes.length; c++) if (votes[c] > bc) { bc = votes[c]; best = c; }
      if (bc >= 3) idx[my * GRID + mx] = best;
    }
  }
  for (let my = 0; my < GRID; my++) {
    for (let mx = 0; mx < GRID; mx++) {
      const i = my * GRID + mx;
      if (idx[i] !== 255) continue;
      const [ix, iy] = applyH(H, mx + 0.5, my + 0.5);
      const xi = Math.round(ix), yi = Math.round(iy);
      if (xi < 0 || yi < 0 || xi >= w || yi >= h) continue;
      const pi = (yi * w + xi) * 4;
      const c = lut[((data[pi] >> 3) << 10) | ((data[pi + 1] >> 3) << 5) | (data[pi + 2] >> 3)];
      if (c !== 255) idx[i] = c;
    }
  }
  return idx;
}`;
const SAMPLE9_NEW = `function sampleGrid(img, H, GRID, lut) {
  const { data, w, h } = img;
  const idx = new Uint8Array(GRID * GRID).fill(255);
  const OFF = [[0, 0], [0.28, 0], [-0.28, 0], [0, 0.28], [0, -0.28], [0.2, 0.2], [-0.2, -0.2], [0.2, -0.2], [-0.2, 0.2]];
  for (let my = 0; my < GRID; my++) {
    for (let mx = 0; mx < GRID; mx++) {
      const votes = [0, 0, 0, 0, 0, 0, 0, 0];
      let n = 0, center = 255;
      for (let s = 0; s < 9; s++) {
        const [ix, iy] = applyH(H, mx + 0.5 + OFF[s][0], my + 0.5 + OFF[s][1]);
        const xi = Math.round(ix), yi = Math.round(iy);
        if (xi < 0 || yi < 0 || xi >= w || yi >= h) continue;
        const pi = (yi * w + xi) * 4;
        const c = lut[((data[pi] >> 3) << 10) | ((data[pi + 1] >> 3) << 5) | (data[pi + 2] >> 3)];
        if (c !== 255) { votes[c]++; n++; }
        if (s === 0) center = c;
      }
      let best = -1, bc = 0;
      for (let c = 0; c < votes.length; c++) if (votes[c] > bc) { bc = votes[c]; best = c; }
      idx[my * GRID + mx] = bc >= 5 ? best : (center !== 255 ? center : (best >= 0 ? best : 0));
    }
  }
  return idx;
}`;
if (!PHYS.includes(SAMPLE9_OLD)) throw new Error('sampleGrid block not found');
PHYS = PHYS.replace(SAMPLE9_OLD, SAMPLE9_NEW);
// voxem: LUMA CALIBRATION CURVE from the 4 corner MARKERS. The markers are
// known colors (black/red/green/blue = lumas 0/76/150/29), so the frame's
// own measured marker lumas give a piecewise-linear map measured->ideal
// luma. This handles black lift (AGC on a bright grid), gamma, tint, and
// channel clipping — the affine per-channel-gain model breaks whenever a
// channel clips, which is exactly when a bright grid is on screen.
const GAINS_OLD = `function classifyLUT(protos, cal) {
  const lut = new Uint8Array(32768).fill(255);
  for (let i = 0; i < 32768; i++) {
    const r = ((i >>> 10) & 31) * 8 + 4;
    const g = ((i >>> 5) & 31) * 8 + 4;
    const b = (i & 31) * 8 + 4;
    lut[i] = classifyPixel(r, g, b, protos, cal);
  }
  return lut;
}`;
const GAINS_NEW = `function markerLumas(img, m, kx, ky) {
  const { data, w, h } = img;
  const side = ((m[0].side + m[1].side + m[2].side + m[3].side) / 4) * kx;
  const R = Math.max(1, Math.floor(side * 0.25));
  const out = [];
  for (let i = 0; i < 4; i++) {
    const cx0 = m[i].cx * kx, cy0 = m[i].cy * ky;
    let r = 0, g = 0, b = 0, n = 0;
    for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
      const x = Math.round(cx0 + dx), y = Math.round(cy0 + dy);
      if (x < 1 || y < 1 || x >= w - 1 || y >= h - 1) continue;
      const o = (y * w + x) * 4;
      r += data[o]; g += data[o + 1]; b += data[o + 2]; n++;
    }
    if (n < 3) return null;
    out.push((0.299 * r + 0.587 * g + 0.114 * b) / n);
  }
  return out; // [black, red, green, blue] marker lumas
}

/* piecewise-linear map: (measured luma -> ideal luma) through the 4 marker
   lumas + white (measured from the border ring, or assumed 255). Sorted by
   measured; collapsed refs -> null. */
function lumaCurveFrom(lumas, whiteLuma) {
  const IDEAL = [0, 76, 150, 29]; // black, red, green, blue ideal lumas
  const pts = lumas.map((m, i) => [m, IDEAL[i]]);
  pts.push([whiteLuma == null ? 255 : whiteLuma, 255]);
  pts.sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < pts.length; i++) {
    if (pts[i][0] - pts[i - 1][0] < 4) return null;
  }
  return pts;
}

/* white reference from the border ring, estimated from the marker blob
   geometry: the grid corner sits (side/2)*sqrt(2) diagonally out from the
   marker centroid; sample ~1.5 modules beyond it along the same diagonal
   (the border ring is 4 modules wide, so this is tolerant of +-1-2px blob
   quantization). Runs before refined corners exist, so centroids only. */
function borderWhiteApprox(img, m, kx, ky) {
  const { data, w, h } = img;
  const side = ((m[0].side + m[1].side + m[2].side + m[3].side) / 4) * kx;
  const mp = side / MARKER;
  let ccx = 0, ccy = 0;
  for (let i = 0; i < 4; i++) { ccx += m[i].cx * kx; ccy += m[i].cy * ky; }
  ccx /= 4; ccy /= 4;
  for (let i = 0; i < 4; i += 3) { // TL and BL corners
    const cx0 = m[i].cx * kx, cy0 = m[i].cy * ky;
    let dx = cx0 - ccx, dy = cy0 - ccy;
    const ln = Math.hypot(dx, dy) || 1;
    dx /= ln; dy /= ln;
    const gx = cx0 - dx * side * 0.7071, gy = cy0 - dy * side * 0.7071;
    const bx = Math.round(gx - dx * 1.5 * mp), by = Math.round(gy - dy * 1.5 * mp);
    if (bx < 2 || by < 2 || bx >= w - 2 || by >= h - 2) continue;
    const o = (by * w + bx) * 4;
    return 0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2];
  }
  return null;
}

function interpLuma(curve, v) {
  if (v <= curve[0][0]) return curve[0][1];
  for (let i = 1; i < curve.length; i++) {
    if (v <= curve[i][0]) {
      const x0 = curve[i - 1][0], y0 = curve[i - 1][1];
      const x1 = curve[i][0], y1 = curve[i][1];
      return y0 + (y1 - y0) * (v - x0) / (x1 - x0);
    }
  }
  return curve[curve.length - 1][1];
}

function classifyLUT(protos, cal) {
  const lut = new Uint8Array(32768).fill(255);
  const curve = cal && Array.isArray(cal) ? cal : null;
  for (let i = 0; i < 32768; i++) {
    const r = ((i >>> 10) & 31) * 8 + 4;
    const g = ((i >>> 5) & 31) * 8 + 4;
    const b = (i & 31) * 8 + 4;
    let v = 0.299 * r + 0.587 * g + 0.114 * b;
    if (curve) v = interpLuma(curve, v);
    else if (cal && cal.white !== undefined) {
      const span = Math.max(16, cal.white - cal.black);
      v = Math.max(0, Math.min(255, (v - cal.black) * 255 / span));
    }
    let lc = -1, ld = Infinity;
    for (const p of protos) {
      const d = Math.abs(v - p.luma);
      if (d < ld) { ld = d; lc = p.index; }
    }
    if (ld > 45) { lut[i] = 255; continue; }
    // HUE GATE (chromatic classes only): 4:2:0 chroma bleed turns a pixel
    // at a red-green block boundary into ~(90,90,0) — mid-luma (lands in
    // the green bin) with a yellow-ish hue. Luma alone cannot see the lie.
    // Clean chromatic pixels agree on luma AND hue; blended ones (no
    // chromatic proto within 40 deg of the measured hue) abstain, and the
    // majority vote is decided by clean samples. White/black are luma-only
    // decisions (a warm tint legitimately gives white an orange hue).
    const pc = protos[lc];
    if (pc && pc.chromatic) {
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      const vv = mx / 255, ss = mx > 0 ? (mx - mn) / mx : 0;
      if (ss >= 0.25 && vv >= 0.3) {
        let hh;
        if (mx === r) hh = ((g - b) / (mx - mn)) % 6;
        else if (mx === g) hh = (b - r) / (mx - mn) + 2;
        else hh = (r - g) / (mx - mn) + 4;
        hh *= 60;
        if (hh < 0) hh += 360;
        let hc = -1, hd = Infinity;
        for (const p of protos) {
          if (!p.chromatic) continue;
          let dh = Math.abs(hh - p.h);
          if (dh > 180) dh = 360 - dh;
          if (dh < hd) { hd = dh; hc = p.index; }
        }
        if (hd > 40 || hc !== lc) { lut[i] = 255; continue; }
      }
    }
    lut[i] = lc;
  }
  return lut;
}`;
if (!PHYS.includes(GAINS_OLD)) throw new Error('classifyLUT block not found');
PHYS = PHYS.replace(GAINS_OLD, GAINS_NEW);
const LUTKEY_OLD = `  const lutKey = (state.palHex ? state.palHex.join(',') : '') + '|' +
    (state.cal ? Math.round(state.cal.white / 4) + '/' + Math.round(state.cal.black / 4) : '-');
  if (state._lutKey !== lutKey) {
    state._lutKey = lutKey;
    state._luts = {};
    for (const c of [4, 8]) state._luts[c] = classifyLUT(makePrototypes(c, state.palHex), state.cal);
  }`;
const LUTKEY_NEW = `  let curve = null;
  if (markers) {
    const lumas = markerLumas(img, markers.markers, kx, ky);
    if (lumas) {
      const wl = borderWhiteApprox(img, markers.markers, kx, ky);
      curve = lumaCurveFrom(lumas, wl);
    }
  }
  const lutKey = (state.palHex ? state.palHex.join(',') : '') + '|' +
    (curve ? curve.map((p) => p[0].toFixed(0)).join('/') : '-') + '|' +
    (state.cal ? Math.round(state.cal.white / 4) + '/' + Math.round(state.cal.black / 4) : '-');
  if (state._lutKey !== lutKey) {
    state._lutKey = lutKey;
    state._luts = {};
    for (const c of [4, 8]) state._luts[c] = classifyLUT(makePrototypes(c, state.palHex), curve || state.cal);
  }`;
if (!PHYS.includes(LUTKEY_OLD)) throw new Error('lutKey block not found');
PHYS = PHYS.replace(LUTKEY_OLD, LUTKEY_NEW);
// voxem: failure diagnostics
const FAILINFO_OLD = `  state.lastFail = 'sampling';`;
const FAILINFO_NEW = `  state.lastFail = 'sampling';
  state.failInfo = {
    locked: !!state.lockCount, lockCount: state.lockCount,
    est: est, tried: Object.keys(tried).join(','),
    markers: !!markers, canvas: !!canvas, refined: !!refined,
    g1: g1, c1: c1,
    curve: curve ? curve.map((p) => p[0].toFixed(0)).join('/') : '-',
    cal: state.cal ? Math.round(state.cal.white) + '/' + Math.round(state.cal.black) : '-',
  };`;
if (!PHYS.includes(FAILINFO_OLD)) throw new Error('failInfo anchor not found');
PHYS = PHYS.replace(FAILINFO_OLD, FAILINFO_NEW, 1);

/* ---------- assemble ---------- */
const out = TPL
  .replace('/*__LT_CORE__*/', section('LT-CORE-BEGIN', 'LT-CORE-END'))
  .replace('/*__WIRE__*/', WIRE)
  .replace('/*__PHYSICAL_CORE__*/', PHYS);

fs.writeFileSync(path.join(DIR, 'index.html'), out);
console.log('wrote index.html (' + out.length + ' bytes)');
