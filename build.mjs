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

/* ---------- assemble ---------- */
const out = TPL
  .replace('/*__LT_CORE__*/', section('LT-CORE-BEGIN', 'LT-CORE-END'))
  .replace('/*__WIRE__*/', WIRE)
  .replace('/*__PHYSICAL_CORE__*/', PHYS);

fs.writeFileSync(path.join(DIR, 'index.html'), out);
console.log('wrote index.html (' + out.length + ' bytes)');
