/* ============================================================
   LT-CORE-BEGIN — pure algorithm, deterministic on any engine.
   ============================================================ */
/* ============================================================
   LT-CORE-BEGIN — pure algorithm, deterministic on any engine.
   ============================================================ */
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const LN2 = 0.6931471805599453;
function dlog(x) {
  let e = 0, m = x;
  while (m >= 1.5) { m /= 2; e++; }
  while (m < 0.75) { m *= 2; e--; }
  const z = (m - 1) / (m + 1), z2 = z * z;
  let term = z, sum = 0;
  for (let n = 1; n <= 21; n += 2) { sum += term / n; term *= z2; }
  return e * LN2 + 2 * sum;
}

function solitonCdf(k, c = 0.1, delta = 0.5) {
  const cdf = new Float64Array(k);
  if (k === 1) { cdf[0] = 1; return cdf; }
  const R = Math.max(1, c * dlog(k / delta) * Math.sqrt(k));
  const spike = Math.min(k, Math.ceil(k / R));
  let total = 0;
  for (let d = 1; d <= k; d++) {
    const rho = d === 1 ? 1 / k : 1 / (d * (d - 1));
    let tau = 0;
    if (d < spike) tau = R / (d * k);
    else if (d === spike) tau = (R * Math.max(0, dlog(R / delta))) / k;
    total += rho + tau;
    cdf[d - 1] = total;
  }
  for (let d = 0; d < k; d++) cdf[d] /= total;
  return cdf;
}

function sampleDegree(rng, cdf) {
  const u = rng();
  let lo = 0, hi = cdf.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (u <= cdf[mid]) hi = mid; else lo = mid + 1;
  }
  return lo + 1;
}

function neighborsFor(seed, k, cdf) {
  const rng = mulberry32(seed);
  const d = sampleDegree(rng, cdf);
  const idx = new Set();
  let guard = 0;
  while (idx.size < d && guard < k * 4) { idx.add(1 + Math.floor(rng() * k)); guard++; }
  return Array.from(idx);
}

function xorInto(out, src) { for (let i = 0; i < src.length; i++) out[i] ^= src[i]; }

function ltEncode(seed, k, blocks, chunkLen) {
  const cdf = solitonCdf(k);
  const nb = neighborsFor(seed, k, cdf);
  const out = new Uint8Array(chunkLen);
  for (const b of nb) xorInto(out, blocks[b - 1]);
  return out;
}

function createLtDecoder() {
  const blocks = new Map();
  const symOf = new Map();
  const ofBlock = new Map();
  const queue = [];
  let cdf = null;
  return {
    get solved() { return blocks.size; },
    get blocks() { return blocks; },
    add(symbols, k) {
      if (!cdf) cdf = solitonCdf(k);
      for (const sym of symbols) {
        if (symOf.has(sym.seed)) continue;
        const nb = neighborsFor(sym.seed, k, cdf);
        const s = { neighbors: new Set(nb), data: sym.data.slice() };
        for (const b of nb) {
          const val = blocks.get(b);
          if (val !== undefined) {
            s.neighbors.delete(b);
            xorInto(s.data, val);
          } else {
            let set = ofBlock.get(b);
            if (!set) { set = new Set(); ofBlock.set(b, set); }
            set.add(sym.seed);
          }
        }
        symOf.set(sym.seed, s);
        if (s.neighbors.size === 1) queue.push(sym.seed);
      }
      while (queue.length) {
        const seed = queue.pop();
        const sym = symOf.get(seed);
        if (!sym) continue;
        // Trap 5b: the symbol may have been mutated since it was enqueued.
        if (sym.neighbors.size !== 1) continue;
        const [s] = sym.neighbors;
        if (blocks.has(s)) {
          sym.neighbors.delete(s);
          xorInto(sym.data, blocks.get(s));
          if (sym.neighbors.size === 1) queue.push(seed);
        } else {
          blocks.set(s, sym.data.slice());
          symOf.delete(seed);
          const set = ofBlock.get(s);
          if (set) for (const otherSeed of set) {
            // Trap 5a: never reduce a symbol against itself.
            if (otherSeed === seed) continue;
            const other = symOf.get(otherSeed);
            if (!other) continue;
            other.neighbors.delete(s);
            xorInto(other.data, sym.data);
            if (other.neighbors.size === 1) queue.push(otherSeed);
          }
        }
      }
      return blocks.size;
    }
  };
}
/* ============================================================
   LT-CORE-END
   ============================================================ */
/* ---------------- wire format v3 + CRC32 ----------------
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
/* ============================================================
   PHYSICAL-CORE-BEGIN — color grid codec (DOM-free).
   Render + camera-decode primitives operating on RGBA buffers.
   ============================================================ */

/* ============================================================
   PHYSICAL-CORE-BEGIN — color grid codec (DOM-free).
   Render + camera-decode primitives operating on RGBA buffers.
   ============================================================ */
/* ============================================================
   PHYSICAL-CORE-BEGIN — color grid codec (DOM-free).
   Render + camera-decode primitives operating on RGBA buffers.
   ============================================================ */
/* ============================================================
   PHYSICAL-CORE-BEGIN — color grid codec (DOM-free).
   Render + camera-decode primitives operating on RGBA buffers.
   ============================================================ */

const BORDER = 4;
const MARKER = 8;               // 8x8-module corner markers (was 4): reliable
                                // detection at the 640px working scale; the
                                // 224 grid only decodes with the bigger markers
const GRID_OPTIONS = [96, 128, 168, 224];

const PALETTES = {
  // NOTE: index 0 stays PURE BLACK. A dark-grey index 0 (#6 idea) was
  // tried and reverted: under underexposure the grey marker's distance to
  // the "black" prototype lands exactly on the detector gate (0.41 vs
  // 0.42), losing the TL marker and the whole frame. Whitening (§1.1)
  // already delivers #6's real benefit (uniform palette statistics).
  4: { black: 0xff000000, red: 0xff0000ff, green: 0xff00ff00, blue: 0xffff0000, white: 0xffffffff, list: ['black', 'red', 'green', 'white'] },
  8: { black: 0xff000000, red: 0xff0000ff, green: 0xff00ff00, blue: 0xffff0000, yellow: 0xff00ffff, cyan: 0xffffff00, magenta: 0xffff00ff, white: 0xffffffff, list: ['black', 'red', 'green', 'blue', 'yellow', 'cyan', 'magenta', 'white'] },
};

const PALETTE_HEX = {
  4: ['#000000', '#ff0000', '#00ff00', '#ffffff'],
  8: ['#000000', '#ff0000', '#00ff00', '#0000ff', '#ffff00', '#00ffff', '#ff00ff', '#ffffff'],
};

// marker identity colors, in canonical corner order TL, TR, BL, BR
const MARKER_NAMES = ['black', 'red', 'green', 'blue']; // 4-color mode: BR is blue
const MARKER_BR_8 = 'cyan';                             // 8-color mode: BR is cyan

function paletteFor(colors) {
  return PALETTES[colors].list.map((n) => PALETTES[colors][n]);
}

function dataModules(GRID) {
  return GRID * GRID - 4 * MARKER * MARKER;
}

function dataBytes(GRID, colors) {
  const bits = dataModules(GRID) * (colors === 8 ? 3 : 2);
  return Math.floor(bits / 8);
}

function chunkLenFor(GRID, colors, nameLen) {
  return dataBytes(GRID, colors) - HEADER_BASE - CRC_BYTES - nameLen;
}

function isMarkerCell(GRID, mx, my) {
  const e = GRID - MARKER;
  return (mx < MARKER && my < MARKER) || (mx >= e && my < MARKER) ||
         (mx < MARKER && my >= e) || (mx >= e && my >= e);
}

/* ---- encode: payload bytes -> module color indices (row-major, markers
   skipped). WHITENING (§1.1): each module's bits are XORed with a fixed
   deterministic mask drawn from mulberry32(0x9E3779B9). Without it, a
   degree-1 symbol over a zero-padded final block renders a mostly-BLACK
   screen (index 0 = black) — the camera can't read it, and the padded block
   is the one that only degree-1 symbols can solve outright. The mask cannot
   be keyed to the symbol seed — the receiver hasn't read the seed when it
   samples. Same fixed constant on both sides keeps the streams in lockstep
   (one rng() per data module, same walk order, including the padded tail
   where v stays 0 but a mask value is still consumed). ---- */
const WHITEN_KEY = 0x9E3779B9;

function payloadToColors(payload, GRID, colors, seedRand) {
  const bitsPer = colors === 8 ? 3 : 2;
  const out = new Uint8Array(GRID * GRID).fill(255);
  const rng = seedRand || mulberry32(WHITEN_KEY);
  let bit = 0;
  for (let my = 0; my < GRID; my++) {
    for (let mx = 0; mx < GRID; mx++) {
      if (isMarkerCell(GRID, mx, my)) continue;
      let v = 0;
      for (let b = 0; b < bitsPer; b++) {
        if (bit >= payload.length * 8) break;
        const byte = payload[bit >> 3];
        v |= ((byte >> (7 - (bit & 7))) & 1) << b;
        bit++;
      }
      // XOR with the mask: colors is a power of two, so the result stays in
      // the alphabet
      out[my * GRID + mx] = v ^ ((rng() * colors) | 0);
    }
  }
  return out;
}

/* ---- render: module color indices -> RGBA u32 buffer (whole canvas incl. border) ---- */
function renderGrid(GRID, colors, colorIdx) {
  const S = GRID + 2 * BORDER;
  const buf = new Uint32Array(S * S).fill(0xffffffff);
  const pal = paletteFor(colors);
  const set = (x, y, c) => { buf[y * S + x] = c; };
  const brName = colors === 8 ? MARKER_BR_8 : 'blue';
  const markerColors = [PALETTES[colors].black, PALETTES[colors].red, PALETTES[colors].green, PALETTES[colors][brName]];
  const corners = [[0, 0], [GRID - MARKER, 0], [0, GRID - MARKER], [GRID - MARKER, GRID - MARKER]];
  for (let m = 0; m < 4; m++) {
    const [ox, oy] = corners[m];
    for (let y = 0; y < MARKER; y++)
      for (let x = 0; x < MARKER; x++)
        set(BORDER + ox + x, BORDER + oy + y, markerColors[m]);
  }
  for (let my = 0; my < GRID; my++) {
    for (let mx = 0; mx < GRID; mx++) {
      const idx = colorIdx[my * GRID + mx];
      if (idx !== 255) set(BORDER + mx, BORDER + my, pal[idx]);
    }
  }
  return buf; // length S*S u32, little-endian RGBA
}

/* ---- color math ---- */
function rgb2hsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d > 0) {
    if (mx === r) h = ((g - b) / d) % 6;
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  const s = mx === 0 ? 0 : d / mx;
  return [h, s, mx];
}

function hexToHsv(hex) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return rgb2hsv(r, g, b);
}

function makePrototypes(colors, palHex) {
  const names = PALETTES[colors].list;
  const hexes = palHex || PALETTE_HEX[colors];
  const protos = [];
  for (let i = 0; i < names.length; i++) {
    const [h, s, v] = hexToHsv(hexes[i]);
    const R = parseInt(hexes[i].slice(1, 3), 16), G = parseInt(hexes[i].slice(3, 5), 16), B = parseInt(hexes[i].slice(5, 7), 16);
    protos.push({ index: i, h, s, v, chromatic: s >= 0.2, luma: 0.299 * R + 0.587 * G + 0.114 * B });
  }
  return protos;
}

/* ---- classify pixel; returns color index or -1. `cal` = {white, black} luma refs. ---- */
function classifyPixel(r, g, b, protos, cal) {
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
}

/* ---- 5-bit RGB classification LUT: one lookup per sampled pixel. Rebuild
   only when the palette or the exposure calibration changes. ---- */
function markerLumas(img, m, kx, ky) {
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
}

/* ---- homography (canonical grid space -> image space).
   Raw 4-point DLT is ill-conditioned for near-affine input (screen-camera
   poses are near-affine), so normalize both point sets to a unit-centered
   frame first, solve there, then denormalize — Hartley conditioning. ---- */
function solveHomography(src, dst) {
  const norm = (pts) => {
    let cx = 0, cy = 0;
    for (const [x, y] of pts) { cx += x; cy += y; }
    cx /= pts.length; cy /= pts.length;
    let d = 0;
    for (const [x, y] of pts) d += Math.hypot(x - cx, y - cy);
    d = d / pts.length || 1;
    const s = Math.SQRT2 / d;
    return { s, cx, cy, pts: pts.map(([x, y]) => [s * (x - cx), s * (y - cy)]) };
  };
  const ns = norm(src), nd = norm(dst);

  const M = [];
  const b = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = ns.pts[i], [u, v] = nd.pts[i];
    M.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
    M.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
  }
  const A = M.map((row, i) => row.concat(b[i]));
  for (let col = 0; col < 8; col++) {
    let piv = col;
    for (let r = col + 1; r < 8; r++) if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
    if (piv !== col) { const t = A[col]; A[col] = A[piv]; A[piv] = t; }
    const pv = A[col][col];
    if (Math.abs(pv) < 1e-12) return null;
    for (let r = 0; r < 8; r++) {
      if (r === col) continue;
      const f = A[r][col] / pv;
      for (let c = col; c < 9; c++) A[r][c] -= f * A[col][c];
    }
  }
  const hn = A.map((row, i) => row[8] / A[i][i]);
  hn.push(1);

  // denormalize: H = T2^-1 * Hn * T1
  const t1 = [ns.s, 0, -ns.s * ns.cx, 0, ns.s, -ns.s * ns.cy, 0, 0, 1];
  const t2i = [1 / nd.s, 0, nd.cx, 0, 1 / nd.s, nd.cy, 0, 0, 1];
  const matMul = (A, B) => {
    const r = new Array(9).fill(0);
    for (let i = 0; i < 3; i++)
      for (let k = 0; k < 3; k++)
        for (let j = 0; j < 3; j++) r[i * 3 + j] += A[i * 3 + k] * B[k * 3 + j];
    return r;
  };
  const H = matMul(t2i, matMul(hn, t1));
  const w = H[8] || 1;
  return H.map((v) => v / w);
}

function applyH(H, x, y) {
  const w = H[6] * x + H[7] * y + 1;
  return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w];
}

/* ---- downscale an RGBA buffer to maxDim ---- */
function downscaleRGBA(data, w, h, maxDim) {
  const scale = Math.min(1, maxDim / Math.max(w, h));
  if (scale >= 1) return { data, w, h };
  const nw = Math.max(1, Math.round(w * scale)), nh = Math.max(1, Math.round(h * scale));
  const out = new Uint8ClampedArray(nw * nh * 4);
  for (let y = 0; y < nh; y++) {
    const sy = Math.min(h - 1, Math.floor(y / scale));
    for (let x = 0; x < nw; x++) {
      const sx = Math.min(w - 1, Math.floor(x / scale));
      const si = (sy * w + sx) * 4, di = (y * nw + x) * 4;
      out[di] = data[si]; out[di + 1] = data[si + 1]; out[di + 2] = data[si + 2]; out[di + 3] = 255;
    }
  }
  return { data: out, w: nw, h: nh };
}

/* ---- marker detection: 4 solid 8x8-module squares at the code corners.
   Markers are the only place with a large run of uniform color (data modules
   are 1 module each), so detect by LOCAL UNIFORMITY, not by color alone —
   this works whether the full canvas is in view or the camera is zoomed in
   and the white border is off-frame. ---- */
const MARKER_UNIFORM_SPREAD = 24;

function findMarkers(img, stretch) {
  const { data, w, h } = img;
  const u = new Uint8Array(w * h);
  const stride = 2;
  const WW = 2;
  for (let y = 0; y < h; y += stride) {
    const y0 = Math.max(0, y - WW), y1 = Math.min(h - 1, y + WW);
    for (let x = 0; x < w; x += stride) {
      const x0 = Math.max(0, x - WW), x1 = Math.min(w - 1, x + WW);
      let sr = 0, sg = 0, sb = 0, n = 0;
      for (let yy = y0; yy <= y1; yy++) {
        const row = yy * w;
        for (let xx = x0; xx <= x1; xx++) {
          const pi = (row + xx) * 4;
          sr += data[pi]; sg += data[pi + 1]; sb += data[pi + 2]; n++;
        }
      }
      sr /= n; sg /= n; sb /= n;
      let sp = 0;
      for (let yy = y0; yy <= y1; yy++) {
        const row = yy * w;
        for (let xx = x0; xx <= x1; xx++) {
          const pi = (row + xx) * 4;
          sp += Math.abs(data[pi] - sr) + Math.abs(data[pi + 1] - sg) + Math.abs(data[pi + 2] - sb);
        }
      }
      sp /= n;
      if (sp < MARKER_UNIFORM_SPREAD) {
        const [h, s, v] = rgb2hsv(sr, sg, sb);
        // Gate = distance to the 5 KNOWN marker colors (black/red/green/
        // blue/cyan). This is exposure-relative by construction: a marker
        // at 55% brightness is still close to its prototype, while a warm-
        // tinted WHITE border (s=0.44, v=0.69 — otherwise "saturated") is
        // far from every prototype and never marked. Crude s/v gates
        // flooded the uniformity map: under a tint, the border became
        // saturated and bridged the marker blobs to the dark background,
        // merging everything into one over-size component -> no markers.
        // False positives from near-color DATA modules survive here and are
        // filtered by the parallelogram geometry check below.
        const M_PROTOS = {
          black: [0, 0, 0], red: [0, 1, 1], green: [120, 1, 1],
          blue: [240, 1, 1], cyan: [180, 1, 1],
        };
        let bestD = Infinity;
        for (const name in M_PROTOS) {
          const [mh, ms, mv] = M_PROTOS[name];
          let dh = Math.abs(h - mh);
          if (dh > 180) dh = 360 - dh;
          const d = name === 'black'
            ? Math.abs(v - mv) * 3 + Math.min(s, 1 - s) * 0.6
            : dh / 360 + Math.abs(s - ms) * 0.9 + Math.abs(v - mv) * 0.6;
          if (d < bestD) bestD = d;
        }
        // threshold 0.42: an underexposed + blue-crushed marker (v=0.38)
        // sits at 0.37; the worst "almost-marker" non-markers (warm-tinted
        // white border) sit at ~0.67+ — clean separation.
        if (bestD < 0.42) {
          for (let yy = y0; yy <= y1; yy++) for (let xx = x0; xx <= x1; xx++) u[yy * w + xx] = 1;
        }
      }
    }
  }

  function nearestMarker(r, g, b) {
    const [h, s, v] = rgb2hsv(r, g, b);
    const protos = {
      black: [0, 0, 0], red: [0, 1, 1], green: [120, 1, 1],
      blue: [240, 1, 1], cyan: [180, 1, 1],
    };
    let best = null, bd = Infinity;
    for (const name in protos) {
      const [mh, ms, mv] = protos[name];
      let dh = Math.abs(h - mh);
      if (dh > 180) dh = 360 - dh;
      const d = name === 'black'
        ? Math.abs(v - mv) * 3 + Math.min(s, 1 - s) * 0.6
        : dh / 360 + Math.abs(s - ms) * 0.9 + Math.abs(v - mv) * 0.6;
      if (d < bd) { bd = d; best = name; }
    }
    return { name: best, d: bd };
  }

  const visited = new Uint8Array(w * h);
  const comps = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!u[i] || visited[i]) continue;
      const stack = [[x, y]];
      let minX = x, maxX = x, minY = y, maxY = y, count = 0;
      let sr = 0, sg = 0, sb = 0, sx = 0, sy = 0;
      while (stack.length) {
        const [cx, cy] = stack.pop();
        const ci = cy * w + cx;
        if (ci < 0 || ci >= w * h || !u[ci] || visited[ci]) continue;
        visited[ci] = 1;
        count++;
        const cpi = ci * 4;
        sr += data[cpi]; sg += data[cpi + 1]; sb += data[cpi + 2];
        sx += cx; sy += cy;
        if (cx < minX) minX = cx; if (cx > maxX) maxX = cx;
        if (cy < minY) minY = cy; if (cy > maxY) maxY = cy;
        if (cx > 0) stack.push([cx - 1, cy]);
        if (cx < w - 1) stack.push([cx + 1, cy]);
        if (cy > 0) stack.push([cx, cy - 1]);
        if (cy < h - 1) stack.push([cx, cy + 1]);
      }
      if (count < 24) continue;
      const sideX = maxX - minX + 1, sideY = maxY - minY + 1;
      const aspect = Math.max(sideX, sideY) / Math.max(1, Math.min(sideX, sideY));
      if (aspect > 1.7) continue;
      if (sideX > w * 0.35 || sideY > h * 0.35) continue;
      const avg = nearestMarker(sr / count, sg / count, sb / count);
      // aligned with the gate threshold (0.42): an underexposed+crushed
      // blue marker sits at ~0.37, above the old absolute 0.24
      if (avg.d > 0.42) continue;
      comps.push({
        name: avg.name,
        // centroid: sub-pixel marker center (bbox midpoint quantizes at stride 2)
        cx: sx / count, cy: sy / count,
        side: (sideX + sideY) / 2,
        x0: minX, y0: minY, x1: maxX + 1, y1: maxY + 1,
      });
    }
  }
  // keep several candidates per color, largest first: a same-color data
  // cluster can outrank the true marker by size, so the geometric check
  // below decides, not the blob size
  const byColor = {};
  for (const c of comps) (byColor[c.name] ||= []).push(c);
  for (const n in byColor) {
    byColor[n].sort((a, b) => b.side - a.side);
    if (byColor[n].length > 6) byColor[n].length = 6;
  }
  if (!byColor.black || !byColor.red || !byColor.green) return null;
  const brCands = [...(byColor.blue || []), ...(byColor.cyan || [])];
  if (!brCands.length) return null;
  const cands = [byColor.black, byColor.red, byColor.green, brCands];
  const markers = [cands[0][0], cands[1][0], cands[2][0], cands[3][0]];
  // parallelogram consistency: the markers are the corners of a square, so
  // each corner must sit near the position implied by the other three
  // (tl+br = tr+bl). Returns [worst normalized deviation, corner index].
  const OPP = [3, 2, 1, 0];
  const quadErr = (m) => {
    const side = (Math.hypot(m[1].cx - m[0].cx, m[1].cy - m[0].cy) +
                  Math.hypot(m[2].cx - m[0].cx, m[2].cy - m[0].cy)) / 2 || 1;
    let worst = 0, wi = 0;
    for (let i = 0; i < 4; i++) {
      const a = [0, 1, 2, 3].filter((j) => j !== i && j !== OPP[i]);
      const ex = m[a[0]].cx + m[a[1]].cx - m[OPP[i]].cx;
      const ey = m[a[0]].cy + m[a[1]].cy - m[OPP[i]].cy;
      const d = Math.hypot(m[i].cx - ex, m[i].cy - ey) / side;
      if (d > worst) { worst = d; wi = i; }
    }
    return [worst, wi];
  };
  // repair: one bad corner pollutes ALL four parallelogram deviations, so
  // the suspect can't be identified from the deviations alone — try every
  // corner x alternate swap greedily and keep the one that most reduces the
  // total error (a correct swap collapses it to ~0)
  let [err] = quadErr(markers);
  for (let iter = 0; iter < 6 && err > 0.18; iter++) {
    let bestC = null, bestI = -1, bestE = err - 1e-9;
    for (let i = 0; i < 4; i++) {
      for (const cand of cands[i]) {
        if (cand === markers[i]) continue;
        const trial = markers.slice();
        trial[i] = cand;
        const [e] = quadErr(trial);
        if (e < bestE) { bestE = e; bestC = cand; bestI = i; }
      }
    }
    if (!bestC) break;
    markers[bestI] = bestC;
    [err] = quadErr(markers);
  }
  if (err > 0.18) return null;
  // geometric sanity: quad must be roughly rectangular (cross products agree)
  const v1x = markers[1].cx - markers[0].cx, v1y = markers[1].cy - markers[0].cy;
  const v2x = markers[2].cx - markers[0].cx, v2y = markers[2].cy - markers[0].cy;
  const cross = v1x * v2y - v1y * v2x;
  if (Math.abs(cross) < 100) return null;
  const colors = markers[3].name === 'blue' ? 4 : 8;
  return { colors, markers };
}

/* ---- estimate GRID from marker geometry ---- */
/* `scale` = img.w / small.w: the blob `side` comes from the downscaled
   detection image, where stride-2 quantization shrinks it (~25% at small
   markers) and biases the estimate up to the wrong grid — which then costs a
   full wrong-grid arbitration pass. Rescaling to full-res coords fixes it. */
function estimateGrid(markers, scale) {
  const [tl, tr, bl, br] = markers;
  const dx = tr.cx - tl.cx, dy = tr.cy - tl.cy;
  const dist = Math.hypot(dx, dy) * (scale || 1);
  const side = (tl.side + tr.side + bl.side + br.side) / 4 * (scale || 1);
  if (side < 2) return null;
  const est = dist / side * MARKER + MARKER;
  let best = null, bd = Infinity;
  for (const g of GRID_OPTIONS) {
    const d = Math.abs(g - est);
    if (d < bd) { bd = d; best = g; }
  }
  return bd / est < 0.25 ? best : null;
}

/* ---- sample all modules and classify.
   5 samples per module: the center plus four at canonical +-0.15 offsets,
   majority of 5 (abstains on ties); abstained modules fall back to the
   center pixel only. Tolerant to ~0.5px of homography error while staying
   clear of the bilinear boundary blends that eat module edges at small
   scales. Bad frames are caught by CRC, never by half-sampled modules. ---- */
function sampleGrid(img, H, GRID, lut) {
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
}

/* ---- cheap sampling: 1 sample per module (center only). ~1/5 the cost of
   the 5-point majority pass. Used as the FIRST CRC gate: if the cheap
   payload is bit-perfect it IS the frame (the CRC is the match check), so
   no majority pass is needed. Noisy frames fail here and fall through to
   the full pass — nothing is ever dropped by this gate. ---- */
function sampleGridFast(img, H, GRID, lut) {
  const { data, w, h } = img;
  const idx = new Uint8Array(GRID * GRID).fill(255);
  for (let my = 0; my < GRID; my++) {
    for (let mx = 0; mx < GRID; mx++) {
      const [ix, iy] = applyH(H, mx + 0.5, my + 0.5);
      const xi = Math.round(ix), yi = Math.round(iy);
      if (xi < 0 || yi < 0 || xi >= w || yi >= h) continue;
      const pi = (yi * w + xi) * 4;
      const c = lut[((data[pi] >> 3) << 10) | ((data[pi + 1] >> 3) << 5) | (data[pi + 2] >> 3)];
      if (c !== 255) idx[my * GRID + mx] = c;
    }
  }
  return idx;
}

/* ---- sample one (grid, palette) combo with a LUT and verify the full
   payload: CRC + header + chunk-length. Returns the parsed symbol or null.
   `fast` selects the cheap single-sample pass. ---- */
function sampleAndCheck(img, H0, g, c, lut, fast) {
  const dataLen = dataBytes(g, c);
  const idx = fast ? sampleGridFast(img, H0, g, lut) : sampleGrid(img, H0, g, lut);
  const payload = colorsToPayload(idx, g, c, dataLen);
  if (!payload) return null;
  const crc = crc32(payload.subarray(0, dataLen - CRC_BYTES));
  const got = ((payload[dataLen - 4] << 24) | (payload[dataLen - 3] << 16) | (payload[dataLen - 2] << 8) | payload[dataLen - 1]) >>> 0;
  if (crc !== got) return null;
  const sym = parseSymbol(payload.subarray(0, dataLen - CRC_BYTES));
  if (!sym) return null;
  if (sym.data.length !== chunkLenFor(g, c, nameBytes(sym.name).length)) return null;
  return sym;
}
/* ---- bits -> payload bytes (row-major, markers skipped), returns null on garbage fill ---- */
function colorsToPayload(idx, GRID, colors, expectLen) {
  const bitsPer = colors === 8 ? 3 : 2;
  const rng = mulberry32(WHITEN_KEY);
  const out = new Uint8Array(expectLen);
  let bit = 0;
  for (let my = 0; my < GRID; my++) {
    for (let mx = 0; mx < GRID; mx++) {
      if (isMarkerCell(GRID, mx, my)) continue;
      let v = idx[my * GRID + mx];
      if (v === 255) return null;
      v ^= (rng() * colors) | 0; // un-whiten (§1.1) — same walk order as the encoder
      for (let b = 0; b < bitsPer; b++) {
        if (bit >= expectLen * 8) break;
        if ((v >> b) & 1) out[bit >> 3] |= 1 << (7 - (bit & 7));
        bit++;
      }
    }
  }
  return bit >= expectLen * 8 ? out : null;
}

/* ---- sub-pixel marker corner refinement at full resolution.
   The centroid estimate can be dragged by same-color data modules touching
   the marker, so first re-seat the walk start at the neighborhood pixel
   closest to ANY marker color (markers are solid; adjacent same-color data
   is fine — walking outward, the last dark run before white is the marker's
   outer edge). Only the two OUTER edges face the white border, so walk those
   and intersect them for the corner. `role`: 'tl'|'tr'|'bl'|'br'. ---- */
const MARKER_COLORS_RGB = [
  [0, 0, 0], [255, 0, 0], [0, 255, 0], [0, 0, 255], [0, 255, 255],
];

function refineMarker(img, cx, cy, role, whiteRef) {
  const { data, w, h } = img;
  const ix = Math.round(cx), iy = Math.round(cy);
  const R = 16;
  // exposure stretch: a dim marker (gain 0.55, blue crushed to ~98) scores
  // below the absolute color-distance gates — normalize against the frame's
  // own white level so a dim-but-correct marker still qualifies
  const f = whiteRef ? 255 / Math.max(1, whiteRef) : 1;
  // best start = pixel closest to a marker color that ALSO sits in a large
  // same-color block (the marker interior; isolated data modules lose on
  // solidity even when they share the marker's color)
  let sx = -1, sy = -1, bestScore = -Infinity;
  for (let dy = -R; dy <= R; dy += 2) {
    const y = iy + dy;
    if (y < 3 || y >= h - 3) continue;
    for (let dx = -R; dx <= R; dx += 2) {
      const x = ix + dx;
      if (x < 3 || x >= w - 3) continue;
      const pi = (y * w + x) * 4;
      let bd = Infinity;
      for (let mi = 0; mi < MARKER_COLORS_RGB.length; mi++) {
        const mc = MARKER_COLORS_RGB[mi];
        let d;
        if (mi === 0) {
          // black: raw luma, capped — the exposure stretch would otherwise
          // brighten the dark-grey marker (index 0, #6) and push its
          // distance to black past the score gate. Anything "dark enough"
          // scores as black; the solidity check filters false starts.
          d = Math.min(data[pi] + data[pi + 1] + data[pi + 2], 80);
        } else {
          d = Math.abs(Math.min(255, data[pi] * f) - mc[0]) +
              Math.abs(Math.min(255, data[pi + 1] * f) - mc[1]) +
              Math.abs(Math.min(255, data[pi + 2] * f) - mc[2]);
        }
        if (d < bd) bd = d;
      }
      if (bd > 200) continue;
      let solid = 0;
      for (let yy = -2; yy <= 2; yy++) {
        const row = (y + yy) * w;
        for (let xx = -2; xx <= 2; xx++) {
          const qi = (row + x + xx) * 4;
          const d2 = Math.abs(data[qi] - data[pi]) + Math.abs(data[qi + 1] - data[pi + 1]) + Math.abs(data[qi + 2] - data[pi + 2]);
          if (d2 < 90) solid++;
        }
      }
      const score = solid - bd / 8;
      if (score > bestScore) { bestScore = score; sx = x; sy = y; }
    }
  }
  if (sx < 0 || bestScore < 15) return null;
  const lum = (x, y) => {
    const pi = (y * w + x) * 4;
    return (data[pi] + data[pi + 1] + data[pi + 2]) / 3;
  };
  const mid = (lum(sx, sy) + (whiteRef || 255)) / 2;
  const scan = (startX, startY, dx, dy) => {
    let prev = lum(startX, startY);
    if (prev > mid) {
      // start landed on a boundary blend: retreat inward to the solid block
      let found = false;
      for (let r = 1; r <= 10; r++) {
        const px = startX - dx * r, py = startY - dy * r;
        if (px < 0 || py < 0 || px >= w || py >= h) break;
        prev = lum(px, py);
        if (prev <= mid) { startX = px; startY = py; found = true; break; }
      }
      if (!found) return null;
    }
    for (let d = 1; d <= 80; d++) {
      const x = startX + dx * d, y = startY + dy * d;
      if (x < 1 || y < 1 || x >= w - 1 || y >= h - 1) return null;
      const v = lum(x, y);
      if (prev <= mid && v > mid) {
        const t = (mid - prev) / (v - prev);
        return { x: startX + dx * (d - 1) + dx * t, y: startY + dy * (d - 1) + dy * t };
      }
      prev = v;
    }
    return null;
  };
  // walk each OUTER edge at 5 positions along it (inner sides face data
  // and have no white crossing); fit the edge line from the successes
  const dxOut = (role === 'tl' || role === 'bl') ? -1 : 1;
  const dyOut = (role === 'tl' || role === 'tr') ? -1 : 1;
  const edgePts = [];
  for (const off of [-4, -2, 0, 2, 4]) {
    const pv = scan(sx + off, sy, 0, dyOut);
    if (pv) edgePts.push({ x: pv.x, y: pv.y, vert: false });
  }
  for (const off of [-4, -2, 0, 2, 4]) {
    const ph = scan(sx, sy + off, dxOut, 0);
    if (ph) edgePts.push({ x: ph.x, y: ph.y, vert: true });
  }
  const vertPts = edgePts.filter((p) => p.vert);
  const horizPts = edgePts.filter((p) => !p.vert);
  if (vertPts.length < 2 || horizPts.length < 2) return null;
  // robust line fit: a scan that starts even 1px outside the marker locks
  // onto a data-module edge (8-color's white/yellow/cyan data all cross the
  // luma threshold), and one such outlier drags an OLS fit off the corner by
  // pixels. Exhaustive-pair search for the max-inlier line, then OLS refit
  // on the inliers only. Vertical edge: x = a*y + b; horizontal: y = a*x + b.
  const fitLine = (pts, vert) => {
    const dep = vert ? (p) => p.x : (p) => p.y;
    const ind = vert ? (p) => p.y : (p) => p.x;
    if (pts.length === 2) {
      const di = ind(pts[1]) - ind(pts[0]);
      const a = Math.abs(di) < 1e-9 ? 0 : (dep(pts[1]) - dep(pts[0])) / di;
      return { a, b: dep(pts[0]) - a * ind(pts[0]) };
    }
    let best = null;
    for (let i = 0; i < pts.length; i++) {
      for (let j = i + 1; j < pts.length; j++) {
        const di = ind(pts[j]) - ind(pts[i]);
        const a = Math.abs(di) < 1e-9 ? 0 : (dep(pts[j]) - dep(pts[i])) / di;
        const b = dep(pts[i]) - a * ind(pts[i]);
        let inl = 0, resid = 0;
        for (const p of pts) {
          const r = Math.abs(dep(p) - (a * ind(p) + b));
          if (r <= 1.5) { inl++; resid += r; }
        }
        if (!best || inl > best.inl || (inl === best.inl && resid < best.resid)) {
          best = { a, b, inl, resid };
        }
      }
    }
    if (!best || best.inl < 3) return null;
    let mx = 0, my = 0, n = 0;
    for (const p of pts) {
      if (Math.abs(dep(p) - (best.a * ind(p) + best.b)) <= 1.5) { mx += ind(p); my += dep(p); n++; }
    }
    mx /= n; my /= n;
    let num = 0, den = 0;
    for (const p of pts) {
      if (Math.abs(dep(p) - (best.a * ind(p) + best.b)) > 1.5) continue;
      num += (ind(p) - mx) * (dep(p) - my); den += (ind(p) - mx) * (ind(p) - mx);
    }
    const a = den > 1e-9 ? num / den : 0;
    return { a, b: my - a * mx };
  };
  const vl = fitLine(vertPts, true), hl = fitLine(horizPts, false);
  if (!vl || !hl) return null;
  const denom = 1 - vl.a * hl.a;
  if (Math.abs(denom) < 1e-9) return null;
  const x = (vl.a * hl.b + vl.b) / denom;
  const y = hl.a * x + hl.b;
  if (!isFinite(x) || !isFinite(y)) return null;
  return { x, y };
}

/* ---- canvas-based corner detection: the white border region's bbox gives
   deterministic canvas corners; a diagonal walk inward from each corner
   crosses border -> marker, and the crossing is the marker's outer corner
   (= grid corner). Robust against marker/data color merges. ---- */
function findCanvasCorners(small, wThresh) {
  const { data, w, h } = small;
  const thresh = wThresh || 190;
  const lum = (x, y) => {
    const pi = (y * w + x) * 4;
    return (data[pi] + data[pi + 1] + data[pi + 2]) / 3;
  };
  const visited = new Uint8Array(w * h);
  let best = null;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (visited[i] || lum(x, y) < thresh) continue;
      const stack = [[x, y]];
      let minX = x, maxX = x, minY = y, maxY = y, count = 0;
      while (stack.length) {
        const [cx, cy] = stack.pop();
        const ci = cy * w + cx;
        if (ci < 0 || ci >= w * h || lum(cx, cy) < thresh || visited[ci]) continue;
        visited[ci] = 1;
        count++;
        if (cx < minX) minX = cx; if (cx > maxX) maxX = cx;
        if (cy < minY) minY = cy; if (cy > maxY) maxY = cy;
        if (cx > 0) stack.push([cx - 1, cy]);
        if (cx < w - 1) stack.push([cx + 1, cy]);
        if (cy > 0) stack.push([cx, cy - 1]);
        if (cy < h - 1) stack.push([cx, cy + 1]);
      }
      if (count < 40) continue;
      if (count > best) best = { minX, maxX, minY, maxY, count };
    }
  }
  if (!best) return null;
  const sideX = best.maxX - best.minX + 1, sideY = best.maxY - best.minY + 1;
  const aspect = Math.max(sideX, sideY) / Math.max(1, Math.min(sideX, sideY));
  if (aspect > 1.3) return null;
  if (sideX < w * 0.25 || sideY < h * 0.25) return null;
  return {
    tl: [best.minX, best.minY], tr: [best.maxX, best.minY],
    bl: [best.minX, best.maxY], br: [best.maxX, best.maxY],
  };
}

function walkMarkerCorner(img, centerX, centerY, dirx, diry, wThresh) {
  const { data, w, h } = img;
  const lum = (x, y) => {
    const pi = (y * w + x) * 4;
    return (data[pi] + data[pi + 1] + data[pi + 2]) / 3;
  };
  const startX = Math.round(centerX), startY = Math.round(centerY);
  if (startX < 1 || startY < 1 || startX >= w - 1 || startY >= h - 1) return null;
  // walk the bbox diagonal from the canvas center: data -> marker -> border,
  // so the FIRST dark->white crossing is the marker's outer corner
  let prev = lum(startX, startY);
  for (let t = 1; t <= 560; t++) {
    const x = startX + dirx * t, y = startY + diry * t;
    if (x < 1 || y < 1 || x >= w - 1 || y >= h - 1) return null;
    const v = lum(x, y);
    const thresh = wThresh || 190;
    if (prev <= thresh && v > thresh) {
      const f = (thresh - prev) / (v - prev);
      return { x: startX + dirx * (t - 1) + dirx * f, y: startY + diry * (t - 1) + diry * f };
    }
    prev = v;
  }
  return null;
}

function computeCalRefs(small) {
  const vals = [];
  const { data, w, h } = small;
  for (let y = 0; y < h; y += 4) {
    const row = y * w;
    for (let x = 0; x < w; x += 4) {
      const pi = (row + x) * 4;
      vals.push((data[pi] + data[pi + 1] + data[pi + 2]) / 3);
    }
  }
  vals.sort((a, b) => a - b);
  const n = vals.length;
  let white = 0, black = 0;
  for (let i = Math.floor(n * 0.92); i < n; i++) white += vals[i];
  for (let i = 0; i < Math.floor(n * 0.08); i++) black += vals[i];
  white /= Math.max(1, n - Math.floor(n * 0.92));
  black /= Math.max(1, Math.floor(n * 0.08));
  if (white - black < 24) return null;
  return { white, black };
}

/* ---- accurate white level: average the border ring between the code edge
   and ~1 module inside (the 4-module white border is the only guaranteed
   white in the frame). The percentile refs get diluted by bright data
   modules; the ring doesn't. Corners in `canvas` (small coords). ---- */
function borderWhite(small, canvas, insetA, insetB) {
  const { data, w, h } = small;
  const [x0, y0] = canvas.tl, [x1, y1] = canvas.br;
  let sum = 0, n = 0;
  const add = (x, y) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const pi = (y * w + x) * 4;
    sum += (data[pi] + data[pi + 1] + data[pi + 2]) / 3;
    n++;
  };
  for (let d = insetA; d <= insetB; d++) {
    for (let x = x0 + d; x <= x1 - d; x++) { add(x, y0 + d); add(x, y1 - d); }
    for (let y = y0 + d; y <= y1 - d; y++) { add(x0 + d, y); add(x1 - d, y); }
  }
  return n ? sum / n : null;
}

function solve3x3(A, b) {
  const M = A.map((row, i) => row.concat(b[i]));
  for (let col = 0; col < 3; col++) {
    let piv = col;
    for (let r = col + 1; r < 3; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    if (piv !== col) { const t = M[col]; M[col] = M[piv]; M[piv] = t; }
    const pv = M[col][col];
    if (Math.abs(pv) < 1e-12) return null;
    for (let r = 0; r < 3; r++) {
      if (r === col) continue;
      const f = M[r][col] / pv;
      for (let cc = col; cc < 4; cc++) M[r][cc] -= f * M[col][cc];
    }
  }
  return [M[0][3] / M[0][0], M[1][3] / M[1][1], M[2][3] / M[2][2]];
}

/* ---- color-fault fallback: rebuild the classifier from the markers.
   The 4 corner markers are KNOWN colors, so when the default classifier
   fails CRC on every combo we measure what the camera ACTUALLY rendered at
   the markers (per-channel gains) + the white border + the black marker,
   rebuild the 5-bit LUT in measured space, and retry once. Handles cameras
   whose colors drift or are wrong in places (bad WB, tinted lens). Only
   runs on failing frames, so it costs nothing on good ones. ---- */
function buildCalibLut(img, markers, kx, ky, refined) {
  const { data, w, h } = img;
  const m = markers.markers;
  const side = ((m[0].side + m[1].side + m[2].side + m[3].side) / 4) * kx;
  const R = Math.max(1, Math.floor(side * 0.25));
  const rgbs = [];
  for (let i = 0; i < 4; i++) {
    const cx0 = m[i].cx * kx, cy0 = m[i].cy * ky;
    let r = 0, g = 0, b = 0, n = 0;
    for (let dy = -R; dy <= R; dy++) {
      for (let dx = -R; dx <= R; dx++) {
        const x = Math.round(cx0 + dx), y = Math.round(cy0 + dy);
        if (x < 1 || y < 1 || x >= w - 1 || y >= h - 1) continue;
        const o = (y * w + x) * 4;
        r += data[o]; g += data[o + 1]; b += data[o + 2]; n++;
      }
    }
    if (n < 3) return null;
    rgbs.push([r / n, g / n, b / n]);
  }
  const san = (v) => (isFinite(v) && v > 0.3 && v < 3 ? v : 1);
  // red marker -> R gain; green marker -> G; blue/cyan marker -> B
  const gains = [
    san(255 / rgbs[1][0]),
    san((255 / rgbs[2][1] + 255 / rgbs[3][1]) / 2),
    san((255 / rgbs[3][2] + 255 / rgbs[2][2]) / 2),
  ];
  // white from the border just outside a grid corner (1.5 modules out,
  // along the outward diagonal); black from the black marker
  let white = null;
  const mp = side / MARKER;
  for (const rp of [refined[0], refined[2]]) {
    const v1 = [refined[1][0] - rp[0], refined[1][1] - rp[1]];
    const v2 = [refined[3][0] - rp[0], refined[3][1] - rp[1]];
    const ln = Math.hypot(v1[0] + v2[0], v1[1] + v2[1]);
    if (ln < 1e-6) continue;
    const dx = -(v1[0] + v2[0]) / ln, dy = -(v1[1] + v2[1]) / ln;
    const bx = Math.round(rp[0] + dx * 1.5 * mp), by = Math.round(rp[1] + dy * 1.5 * mp);
    if (bx < 2 || by < 2 || bx >= w - 2 || by >= h - 2) continue;
    const o = (by * w + bx) * 4;
    white = (data[o] + data[o + 1] + data[o + 2]) / 3;
    break;
  }
  if (white === null) white = 255;
  const black = (rgbs[0][0] + rgbs[0][1] + rgbs[0][2]) / 3;
  const wThresh = 0.72 * (white / 255) + 0.12;
  const bThresh = 0.5 * (black / 255) + 0.12;
  const luts = {};
  for (const colors of [4, 8]) {
    const hexes = PALETTE_HEX[colors];
    const protos = [];
    for (let i = 0; i < hexes.length; i++) {
      const r = Math.min(255, parseInt(hexes[i].slice(1, 3), 16) * gains[0]);
      const g = Math.min(255, parseInt(hexes[i].slice(3, 5), 16) * gains[1]);
      const b = Math.min(255, parseInt(hexes[i].slice(5, 7), 16) * gains[2]);
      const [hh, ss, vv] = rgb2hsv(r, g, b);
      protos.push({ index: i, h: hh, s: ss, v: vv, chromatic: ss >= 0.2 });
    }
    const lut = new Uint8Array(32768).fill(255);
    for (let i = 0; i < 32768; i++) {
      const r = ((i >>> 10) & 31) * 8 + 4;
      const g = ((i >>> 5) & 31) * 8 + 4;
      const b = (i & 31) * 8 + 4;
      const [hh, ss, vv] = rgb2hsv(r, g, b);
      if (ss < 0.22) {
        if (vv < bThresh) { lut[i] = 0; continue; }
        if (colors === 8 && vv > wThresh) { lut[i] = 7; continue; }
        lut[i] = 255; continue;
      }
      let best = -1, bestD = Infinity;
      for (const p of protos) {
        if (!p.chromatic) continue;
        let dh = Math.abs(hh - p.h);
        if (dh > 180) dh = 360 - dh;
        const d = dh + Math.abs(vv - p.v) * 90 + Math.abs(ss - p.s) * 50;
        if (d < bestD) { bestD = d; best = p.index; }
      }
      lut[i] = bestD > 95 ? 255 : best;
    }
    luts[colors] = lut;
  }
  return luts;
}

/* #52 support: 5-point sampling that also reports the "weak" modules —
   those whose majority was exactly 3-of-5 (or fewer votes). Those are the
   modules a single misclassification could flip, and the CRC is a free
   oracle for trying alternatives. */
function sampleGridTrack(img, H, GRID, lut) {
  const idx = new Uint8Array(GRID * GRID).fill(255);
  const weak = [];
  const { data, w, h } = img;
  const OFF = [[0, 0], [0.15, 0], [-0.15, 0], [0, 0.15], [0, -0.15]];
  for (let my = 0; my < GRID; my++) {
    for (let mx = 0; mx < GRID; mx++) {
      if (isMarkerCell(GRID, mx, my)) continue;
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
      let best = -1, bc = 0, alt = -1, ac = 0;
      for (let c = 0; c < votes.length; c++) {
        if (votes[c] > bc) { alt = best; ac = bc; bc = votes[c]; best = c; }
        else if (votes[c] > ac) { ac = votes[c]; alt = c; }
      }
      if (bc < 3) continue;
      const i = my * GRID + mx;
      idx[i] = best;
      if (bc === 3 && alt >= 0) weak.push({ i, alt });
    }
  }
  return { idx, weak };
}

/* #52: confidence-based bit flipping. When every candidate fails CRC, take
   the primary (grid, palette) combo, flip the 1-3 weakest modules to their
   runner-up colour and retry — CRC decides. Bounded: 3 single flips + 1
   double flip. Local camera faults (smudge, falloff) cost a few modules,
   and this turns those frames from 100% loss into recovered. */
function flipFix(img, H0, g, c, lut) {
  const dataLen = dataBytes(g, c);
  const t = sampleGridTrack(img, H0, g, lut);
  if (!t.weak.length) return null;
  const tryIdx = () => {
    const payload = colorsToPayload(t.idx, g, c, dataLen);
    if (!payload) return null;
    const crc = crc32(payload.subarray(0, dataLen - CRC_BYTES));
    const got = ((payload[dataLen - 4] << 24) | (payload[dataLen - 3] << 16) | (payload[dataLen - 2] << 8) | payload[dataLen - 1]) >>> 0;
    if (crc !== got) return null;
    const sym = parseSymbol(payload.subarray(0, dataLen - CRC_BYTES));
    if (!sym) return null;
    if (sym.data.length !== chunkLenFor(g, c, nameBytes(sym.name).length)) return null;
    return sym;
  };
  const N = Math.min(3, t.weak.length);
  for (let a = 0; a < N; a++) {
    const saved = t.idx[t.weak[a].i];
    t.idx[t.weak[a].i] = t.weak[a].alt;
    const sym = tryIdx();
    if (sym) return sym;
    t.idx[t.weak[a].i] = saved;
  }
  if (N >= 2) {
    const a = t.weak[0], b = t.weak[1];
    const sa = t.idx[a.i], sb = t.idx[b.i];
    t.idx[a.i] = a.alt; t.idx[b.i] = b.alt;
    const sym = tryIdx();
    if (sym) return sym;
    t.idx[a.i] = sa; t.idx[b.i] = sb;
  }
  return null;
}

function decodeFrame(img, state, deadline) {
  state.lastFail = 'none';
  const expired = () => !!deadline && performance.now() > deadline;

  // #44: cached-H fast path. Once a stream is locked (H + grid + colors +
  // LUTs known and the last frame succeeded), sampling with the cached
  // homography costs ~1-2 ms vs ~400 ms of detection — and findMarkers was
  // measured at ~97% of clean-frame decode cost. CRC still decides; on
  // failure we fall through to the full detection pipeline (motion,
  // exposure change, whatever broke the geometry).
  if (state.H && state.grid && state.colors && state.lockCount > 0 && state._luts) {
    const sym = sampleAndCheck(img, state.H, state.grid, state.colors, state._luts[state.colors], true) ||
                sampleAndCheck(img, state.H, state.grid, state.colors, state._luts[state.colors], false);
    if (sym) {
      state.lockCount = 8;
      return { type: 'symbol', sym, grid: state.grid, colors: state.colors };
    }
  }

  // detect at 400px first (cheap); retry at 640px when the code is small in
  // the frame, so markers stay >= ~8px for the uniformity windows
  let small = downscaleRGBA(img.data, img.w, img.h, 400);
  // per-frame exposure refs FIRST (cheap percentile scan): every threshold
  // downstream — marker color gate, canvas walk, refineMarker, classifier —
  // is scaled to the frame's own white level instead of hardcoded 255/190.
  let refs = computeCalRefs(small);
  let wThresh = refs ? 0.75 * refs.white : 190;
  let markers = findMarkers(small);
  if (!markers && Math.max(img.w, img.h) > 520) {
    small = downscaleRGBA(img.data, img.w, img.h, 640);
    markers = findMarkers(small);
  }
  // refine the white level from the border RING once the canvas bbox is
  // known (the percentile refs get diluted by bright data modules)
  const canvas = findCanvasCorners(small, wThresh);
  if (refs && canvas) {
    const ring = borderWhite(small, canvas, 2, 4);
    if (ring) {
      refs = { white: ring, black: refs.black };
      wThresh = 0.75 * ring;
    }
    if (!state.cal ||
        Math.abs(refs.white - state.cal.white) > 0.03 * 255 ||
        Math.abs(refs.black - state.cal.black) > 0.03 * 255) {
      state.cal = refs; // only adopt when it moved — LUT rebuild is costly
    }
  }
  if (!markers && !canvas) {
    if (state.lockCount > 0) state.lockCount--;
    state.lastFail = 'detect';
    return null;
  }

  const kx = img.w / small.w, ky = img.h / small.h;
  const est = markers ? estimateGrid(markers.markers, kx) : null;
  // §1.2a format lock: once a stream is confirmed (lockCount > 0), only the
  // locked grid/palette are tried — a failing frame no longer exhausts all
  // 4 combos x 7 homographies. Eight consecutive failures re-open the full
  // search, so a mid-stream format change still recovers.
  const locked = !!(state.lockCount > 0 && state.grid && state.colors);
  let grids;
  if (locked) grids = [state.grid];
  else {
    grids = GRID_OPTIONS.slice();
    if (est) grids.sort((a, b) => Math.abs(a - est) - Math.abs(b - est));
  }
  const g1 = grids[0];
  const c1 = markers ? markers.colors : (state.colors || 4);
  const c2 = c1 === 4 ? 8 : 4;
  const cols = locked ? [state.colors] : [c1, c2];
  // LUTs cost ~32k classifications each — build once, rebuild only when the
  // palette or the exposure calibration changes. §1.7: quantise the cal key
  // to 4-unit bins so tiny frame-to-frame refs drift doesn't rebuild LUTs
  // (a rebuild costs ~7x a sampling pass).
  let curve = null;
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
  }
  const luts = state._luts;
  const m = markers ? markers.markers : null;

  // §1.2b: refineMarker is hoisted — it refines corners in IMAGE space and
  // does not depend on the grid, so it runs ONCE (the old code ran it per
  // grid and again in the colour-fault fallback: 12 calls where 4 suffice).
  let refined = null;
  if (m) {
    refined = [];
    let ok = true;
    for (let i = 0; i < 4; i++) {
      const r = refineMarker(img, m[i].cx * kx, m[i].cy * ky, ['tl', 'tr', 'bl', 'br'][i], refs ? refs.white : 255);
      if (!r) { ok = false; break; }
      refined.push([r.x, r.y]);
    }
    if (!ok && Math.max(img.w, img.h) > 520) {
      const sm2 = downscaleRGBA(img.data, img.w, img.h, 640);
      const mk2 = findMarkers(sm2);
      if (mk2) {
        const k2x = img.w / sm2.w, k2y = img.h / sm2.h;
        ok = true;
        refined.length = 0;
        for (let i = 0; i < 4; i++) {
          const r = refineMarker(img, mk2.markers[i].cx * k2x, mk2.markers[i].cy * k2y, ['tl', 'tr', 'bl', 'br'][i], refs ? refs.white : 255);
          if (!r) { ok = false; break; }
          refined.push([r.x, r.y]);
        }
      }
    }
    if (!ok) refined = null;
  }

  // build the homography candidate list per grid ONCE
  const tried = {}; // grid -> [H0, ...]
  for (const g of grids) {
    const srcSets = [];
    if (m) {
      if (refined) srcSets.push(refined);
      srcSets.push(m.map((p) => [p.cx * kx, p.cy * ky]));
    }
    if (canvas) {
      const cx = ((canvas.tl[0] + canvas.tr[0]) / 2 + 0.5) * kx;
      const cy = ((canvas.tl[1] + canvas.bl[1]) / 2 + 0.5) * ky;
      const corners = [canvas.tl, canvas.tr, canvas.bl, canvas.br];
      const midX = (canvas.tl[0] + canvas.tr[0]) / 2;
      const midY = (canvas.tl[1] + canvas.bl[1]) / 2;
      const pts = [];
      let ok = true;
      for (let i = 0; i < 4; i++) {
        const dx = Math.sign(corners[i][0] - midX) || 1;
        const dy = Math.sign(corners[i][1] - midY) || 1;
        const r = walkMarkerCorner(img, cx, cy, dx, dy, wThresh);
        if (!r) { ok = false; break; }
        pts.push([r.x, r.y]);
      }
      if (ok) srcSets.push(pts);
    }
    const list = [];
    for (const srcPts of srcSets) {
      const H0 = solveHomography([[0, 0], [g, 0], [0, g], [g, g]], srcPts);
      if (H0) list.push(H0);
    }
    if (srcSets[0]) {
      // one bad corner ruins the 4-point fit; the affine 3-corner subsets
      // survive it (perspective is mild, so affine is a fine approximation)
      for (let drop = 0; drop < 4; drop++) {
        const dst3 = [[0, 0], [g, 0], [0, g], [g, g]].filter((_, i) => i !== drop);
        const src3 = srcSets[0].filter((_, i) => i !== drop);
        const A = [[dst3[0][0], dst3[0][1], 1], [dst3[1][0], dst3[1][1], 1], [dst3[2][0], dst3[2][1], 1]];
        const bx = src3.map((p) => p[0]), by = src3.map((p) => p[1]);
        const xv = solve3x3(A, bx), yv = solve3x3(A, by);
        if (xv && yv) list.push([xv[0], xv[1], xv[2], yv[0], yv[1], yv[2], 0, 0, 1]);
      }
    }
    if (list.length) tried[g] = list;
  }

  const accept = (H0, g, c, sym) => {
    state.H = H0;
    state.grid = g;
    state.colors = c;
    state.lockCount = 8; // §1.2a: confirmed stream
    return { type: 'symbol', sym, grid: g, colors: c };
  };

  // §1.2c: ALL cheap passes run before ANY full pass — a wrong candidate
  // no longer pays a 5-point pass before the next one gets its cheap try.
  for (const g of grids) {
    const list = tried[g];
    if (!list) continue;
    for (const H0 of list) {
      for (const c of cols) {
        if (expired()) { state.lastFail = 'sampling'; return null; } // §1.2d
        const sym = sampleAndCheck(img, H0, g, c, luts[c], true);
        if (sym) return accept(H0, g, c, sym);
      }
    }
  }
  for (const g of grids) {
    const list = tried[g];
    if (!list) continue;
    for (const H0 of list) {
      for (const c of cols) {
        if (expired()) { state.lastFail = 'sampling'; return null; } // §1.2d
        const sym = sampleAndCheck(img, H0, g, c, luts[c], false);
        if (sym) return accept(H0, g, c, sym);
      }
    }
  }

  // #52: confidence-based bit flipping on the primary candidate — the CRC
  // decides. Localised camera faults (smudge, edge falloff) cost a few
  // modules; this recovers those frames instead of dropping them.
  if (!locked && tried[g1]) {
    const H0 = tried[g1][0];
    const sym = flipFix(img, H0, g1, c1, luts[c1]);
    if (sym) return accept(H0, g1, c1, sym);
  }

  state.lastFail = 'sampling';
  state.failInfo = {
    locked: !!state.lockCount, lockCount: state.lockCount,
    est: est, tried: Object.keys(tried).join(','),
    markers: !!markers, canvas: !!canvas, refined: !!refined,
    g1: g1, c1: c1,
    curve: curve ? curve.map((p) => p[0].toFixed(0)).join('/') : '-',
    cal: state.cal ? Math.round(state.cal.white) + '/' + Math.round(state.cal.black) : '-',
  };
  // color-fault fallback: every combo failed CRC with the default
  // classifier. The 4 corner markers are ground-truth colors IN this
  // frame — measure what the camera actually rendered there, rebuild the
  // classifier in measured space, and retry once (cheap first again).
  if (m && refined) {
    const calLuts = buildCalibLut(img, markers, kx, ky, refined);
    if (calLuts) {
      for (const g of grids) {
        const list = tried[g];
        if (!list) continue;
        for (const H0 of list) {
          for (const c of cols) {
            if (expired()) break;
            const sym = sampleAndCheck(img, H0, g, c, calLuts[c], true) ||
                        sampleAndCheck(img, H0, g, c, calLuts[c], false);
            if (sym) return accept(H0, g, c, sym);
          }
        }
      }
    }
  }
  if (state.lockCount > 0) state.lockCount--; // §1.2a countdown
  return null;
}

/* ============================================================
   PHYSICAL-CORE-END
   ============================================================ */