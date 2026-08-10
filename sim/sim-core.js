/* sim-core.js — DOM-free synthetic-camera pipeline for Lumen.
   Pure logic, shared by the test page (index.html) and the node selftest:
     - genFrame / makeMeta : exact mirror of index.html's sender frame path
     - makeScreen          : the sender's screen (grid rendered at modulePx)
     - capture             : synthetic camera (perspective, focus blur, noise,
                             exposure, white-balance tint)
     - runTrial/runTrials  : decode a single (or many) frames with the REAL
                             decoder extracted into core.js
     - makeStream          : continuous stream + LT pool, like the real app
     - sweep               : decode rate vs one parameter
   All decode calls go through hooks.decodeFrame (default: the core decoder),
   so experimental decoders can be A/B tested without touching core.js.
*/
var LumenSim = (function () {
  "use strict";

  /* -------- deterministic RNG (noise, seeds, payloads) -------- */
  let rngState = 0x12345678;
  function simRand() {
    rngState |= 0; rngState = (rngState + 0x6D2B79F5) | 0;
    let t = Math.imul(rngState ^ (rngState >>> 15), 1 | rngState);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  function setSimSeed(s) { rngState = s >>> 0; }

  /* -------- sender side (mirrors index.html makeDataFrame) -------- */
  function genFrame(meta, blocks, seed) {
    const data = ltEncode(seed, meta.k, blocks, meta.chunkLen);
    // wire v3: makeSymbol(seed, sessionId, k, len, clen, flags, name, fileCrc, data)
    const payload = makeSymbol.length >= 9
      ? makeSymbol(seed, meta.session || 0, meta.k, meta.len, meta.clen, meta.flags, meta.name, meta.fileCrc || 0, data)
      : makeSymbol(seed, meta.k, meta.len, meta.clen, meta.flags, meta.name, data);
    const full = new Uint8Array(payload.length + CRC_BYTES);
    full.set(payload);
    const c = crc32(payload);
    full[payload.length] = (c >>> 24) & 0xFF;
    full[payload.length + 1] = (c >>> 16) & 0xFF;
    full[payload.length + 2] = (c >>> 8) & 0xFF;
    full[payload.length + 3] = c & 0xFF;
    const idx = payloadToColors(full, meta.grid, meta.colors);
    const buf = renderGrid(meta.grid, meta.colors, idx);
    return { buf, S: meta.grid + 2 * BORDER, seed };
  }

  function randomBytes(n) {
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) out[i] = (simRand() * 256) | 0;
    return out;
  }

  /* One simulated "file": random payload split into k LT blocks.
     opts.paddedTail (#81): real files' last block is usually short and
     often mostly zeros — the padded-tail case that exposed the missing
     whitening (§1.1). The sim's default random payload can never produce
     it, which is why the bug survived. */
  function makeMeta(grid, colors, size, opts) {
    const name = 'sim-test.bin';
    const chunkLen = chunkLenFor(grid, colors, nameBytes(name).length);
    const k = Math.max(1, Math.ceil(size / chunkLen));
    const payload = opts && opts.paddedTail
      ? (() => {
          const p = randomBytes((k - 1) * chunkLen + 40);
          for (let i = (k - 1) * chunkLen + 40; i < k * chunkLen; i++) p[i] = 0;
          return p;
        })()
      : randomBytes(size);
    const blocks = [];
    for (let i = 0; i < k; i++) {
      const start = i * chunkLen;
      const part = payload.subarray(start, Math.min(start + chunkLen, payload.length));
      const blk = new Uint8Array(chunkLen);
      blk.set(part);
      blocks.push(blk);
    }
    return { grid, colors, name, chunkLen, k, len: size, clen: size, flags: 0, fileCrc: crc32(payload), session: 0x9E2C, blocks };
  }

  /* -------- the sender's screen: grid buffer -> RGBA at modulePx -------- */
  function makeScreen(buf, S, modulePx) {
    const m = Math.max(1, modulePx);
    const SS = Math.round(S * m);
    const out = new Uint8ClampedArray(SS * SS * 4);
    for (let y = 0; y < SS; y++) {
      const sy = Math.min(S - 1, (y / m) | 0);
      const row = sy * S;
      for (let x = 0; x < SS; x++) {
        const v = buf[row + Math.min(S - 1, (x / m) | 0)];
        const o = (y * SS + x) * 4;
        out[o] = v & 255; out[o + 1] = (v >>> 8) & 255; out[o + 2] = (v >>> 16) & 255; out[o + 3] = 255;
      }
    }
    return { data: out, w: SS, h: SS };
  }

  /* -------- synthetic camera -------- */
  const CAM_SIZES = [[640, 360], [960, 540], [1280, 720]];

  /* Project the square code onto the camera plane.
     Plane (physical half-size 0.5) sits at z=1, camera looks down +z from the
     origin with focal f=L, so a fronto-parallel code spans exactly L px.
     yaw tilts around the vertical, pitch around the horizontal, then roll
     rotates the projected image in 2D. Returns [TL,TR,BL,BR] in camera px. */
  function quadFor(L, yawDeg, pitchDeg, rollDeg, cx, cy) {
    const yaw = yawDeg * Math.PI / 180, pitch = pitchDeg * Math.PI / 180, roll = rollDeg * Math.PI / 180;
    const f = L;
    const cyaw = Math.cos(yaw), syaw = Math.sin(yaw);
    const cp = Math.cos(pitch), sp = Math.sin(pitch);
    const corners = [];
    for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      const x = sx * 0.5, y = sy * 0.5, z = 1;
      const X1 = x * cyaw + z * syaw;
      const Z1 = -x * syaw + z * cyaw;
      const X = X1;
      const Y = y * cp - Z1 * sp;
      const Z = y * sp + Z1 * cp;
      corners.push([f * X / Z + cx, f * Y / Z + cy]);
    }
    if (Math.abs(roll) > 1e-9) {
      const cr = Math.cos(roll), sr = Math.sin(roll);
      for (const c of corners) {
        const dx = c[0] - cx, dy = c[1] - cy;
        c[0] = cx + dx * cr - dy * sr;
        c[1] = cy + dx * sr + dy * cr;
      }
    }
    return corners;
  }

  function invertH(H) {
    const a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7], i = H[8];
    const A = e * i - f * h, B = c * h - b * i, C = b * f - c * e;
    const det = a * A + d * B + g * C;
    if (Math.abs(det) < 1e-12) return null;
    return [
      A / det, B / det, C / det,
      (f * g - d * i) / det, (a * i - c * g) / det, (c * d - a * f) / det,
      (d * h - e * g) / det, (b * g - a * h) / det, (a * e - b * d) / det
    ];
  }

  /* True gaussian blur with fractional sigma (the box-blur version rounded
     the radius up, so ANY nonzero blur was ~sigma 1.4 — a binary knob).
     Separable FIR: horizontal pass then vertical pass. */
  function gaussKernel(sigma) {
    const r = Math.max(1, Math.ceil(3 * sigma));
    const w = new Float64Array(2 * r + 1);
    let sum = 0;
    for (let d = -r; d <= r; d++) {
      const v = Math.exp(-(d * d) / (2 * sigma * sigma));
      w[d + r] = v; sum += v;
    }
    for (let i = 0; i < w.length; i++) w[i] /= sum;
    return { w, r };
  }

  function blurPass(src, dst, W, H, r, weights, vert) {
    const len = vert ? H : W;
    const rows = vert ? W : H;
    const step = vert ? W : 1;
    for (let a = 0; a < rows; a++) {
      const base = vert ? a : a * W;
      for (let b = 0; b < len; b++) {
        let s0 = 0, s1 = 0, s2 = 0;
        const off = base + b * step;
        for (let d = -r; d <= r; d++) {
          const k = b + d;
          if (k < 0 || k >= len) continue;
          const o = (off + d * step) * 4;
          const wgt = weights[d + r];
          s0 += src[o] * wgt; s1 += src[o + 1] * wgt; s2 += src[o + 2] * wgt;
        }
        const o = off * 4;
        dst[o] = s0; dst[o + 1] = s1; dst[o + 2] = s2;
      }
    }
  }

  function gaussBlur(img, sigma) {
    if (sigma < 0.08) return;
    const { w, r } = gaussKernel(sigma);
    const { data, w: W, h: H } = img;
    const tmp = new Float32Array(W * H * 4);
    const tmp2 = new Float32Array(W * H * 4);
    blurPass(data, tmp, W, H, r, w, false);
    blurPass(tmp, tmp2, W, H, r, w, true);
    for (let i = 0, j = 0; i < tmp2.length; i += 4, j += 4) {
      data[j] = tmp2[i]; data[j + 1] = tmp2[i + 1]; data[j + 2] = tmp2[i + 2];
    }
  }

  /* Per-capture noise LUT (statistically fine, ~free). */
  function noiseLut(n) {
    const lut = new Float32Array(4096);
    for (let i = 0; i < 4096; i++) lut[i] = (simRand() * 2 - 1) * n;
    return lut;
  }

  /* Capture: inverse-warp the screen into the camera frame (bilinear),
     then focus blur, sensor noise, exposure gain, white-balance tint.
     fit=true (default): the code is scaled so it fully fits the frame
     (models moving closer — capped when the code fills the view).
     fit=false: modulePx is applied literally; past the frame edge the code
     is cropped exactly like a real camera zoomed in past the screen. */
  function capture(screen, opts, camW, camH, screen2) {
    const S = screen.w;
    let L = opts.modulePx * S;
    if (opts.fit !== false) L = Math.min(L, Math.min(camW, camH) * 0.92);
    const tearLine = screen2 && opts.tear ? Math.round(camH * opts.tear) : -1;
    const cx = camW / 2, cy = camH / 2;
    const quad = quadFor(L, opts.yaw || 0, opts.pitch || 0, opts.roll || 0, cx, cy);
    const H = solveHomography([[0, 0], [S, 0], [0, S], [S, S]], quad);
    const Hi = invertH(H);
    const img = { data: new Uint8ClampedArray(camW * camH * 4), w: camW, h: camH };
    const src = screen.data;
    for (let y = 0; y < camH; y++) {
      for (let x = 0; x < camW; x++) {
        const w = Hi[6] * x + Hi[7] * y + Hi[8];
        const gx = (Hi[0] * x + Hi[1] * y + Hi[2]) / w;
        const gy = (Hi[3] * x + Hi[4] * y + Hi[5]) / w;
        const o = (y * camW + x) * 4;
        if (gx < 0 || gy < 0 || gx >= S - 1 || gy >= S - 1) continue;
        if (y >= tearLine && screen2) {
          // #83 rolling shutter: below the tear line the sensor readout
          // caught the NEXT symbol (shifted by the transition)
          const t2 = screen2.data;
          const o2 = (Math.round(gy) * S + Math.round(gx)) * 4;
          img.data[o] = t2[o2]; img.data[o + 1] = t2[o2 + 1]; img.data[o + 2] = t2[o2 + 2];
          img.data[o + 3] = 255;
          continue;
        }
        const x0 = gx | 0, y0 = gy | 0;
        const fx = gx - x0, fy = gy - y0;
        const i00 = (y0 * S + x0) * 4;
        const i10 = i00 + 4, i01 = i00 + S * 4, i11 = i01 + 4;
        for (let c = 0; c < 3; c++) {
          const v = (src[i00 + c] * (1 - fx) + src[i10 + c] * fx) * (1 - fy) +
                    (src[i01 + c] * (1 - fx) + src[i11 + c] * fx) * fy;
          img.data[o + c] = v;
        }
        img.data[o + 3] = 255;
      }
    }
    const blur = opts.blur || 0;
    if (blur > 0.05) gaussBlur(img, blur);
    // 4:2:0 chroma subsampling — REAL cameras and video pipelines store
    // chroma at quarter resolution. At module scale (~2-4px/module) the
    // chroma interpolation blends adjacent module colors, which corrupts
    // hue-based classification. The headless sim never modeled this, which
    // is why it decoded 100% while real hardware decoded ~0%. The decoder
    // must classify by luma (full-res) to survive it.
    chroma420(img);
    const noise = opts.noise || 0;
    const gain = opts.gain || 1;
    const tR = opts.tintR || 1, tG = opts.tintG || 1, tB = opts.tintB || 1;
    const blackOffset = opts.blackOffset || 0; // AGC/lens-glare black lift
    const lut = noise ? noiseLut(noise) : null;
    const d = img.data;
    let ni = 0;
    for (let i = 0; i < d.length; i += 4) {
      d[i]     = Math.min(255, Math.max(0, (d[i] + (lut ? lut[ni++] & 4095 : 0)) * gain * tR + blackOffset));
      d[i + 1] = Math.min(255, Math.max(0, (d[i + 1] + (lut ? lut[ni++] & 4095 : 0)) * gain * tG + blackOffset));
      d[i + 2] = Math.min(255, Math.max(0, (d[i + 2] + (lut ? lut[ni++] & 4095 : 0)) * gain * tB + blackOffset));
    }
    return img;
  }

  /* 4:2:0 chroma subsampling: per-pixel luma is kept, chroma (U/V) is
     averaged per 2x2 block and bilinearly upsampled back — exactly what a
     YUV420 video path does. */
  function chroma420(img) {
    const { data, w, h } = img;
    const w2 = w >> 1, h2 = h >> 1;
    const cu = new Float64Array(w2 * h2), cv = new Float64Array(w2 * h2);
    for (let by = 0; by < h2; by++) {
      for (let bx = 0; bx < w2; bx++) {
        let r = 0, g = 0, b = 0;
        for (let dy = 0; dy < 2; dy++) {
          for (let dx = 0; dx < 2; dx++) {
            const o = ((by * 2 + dy) * w + bx * 2 + dx) * 4;
            r += data[o]; g += data[o + 1]; b += data[o + 2];
          }
        }
        r /= 4; g /= 4; b /= 4;
        cu[by * w2 + bx] = -0.169 * r - 0.331 * g + 0.5 * b + 128;
        cv[by * w2 + bx] = 0.5 * r - 0.419 * g - 0.081 * b + 128;
      }
    }
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const bx = Math.min(w2 - 1, x >> 1), by = Math.min(h2 - 1, y >> 1);
        const u = cu[by * w2 + bx], v = cv[by * w2 + bx];
        const o = (y * w + x) * 4;
        const Y = 0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2];
        const r = Y + 1.402 * (v - 128);
        const g = Y - 0.344 * (u - 128) - 0.714 * (v - 128);
        const b = Y + 1.772 * (u - 128);
        data[o] = Math.min(255, Math.max(0, r));
        data[o + 1] = Math.min(255, Math.max(0, g));
        data[o + 2] = Math.min(255, Math.max(0, b));
      }
    }
  }

  /* -------- receiver side: the REAL decoder, wired exactly like index.html -------- */
  function freshState() {
    return { lastFail: 'none', grid: null, colors: null, H: null, palHex: null, cal: null, _lutKey: null, _luts: null };
  }

  function diagInfo(img, state) {
    const small = downscaleRGBA(img.data, img.w, img.h, 640);
    const mk = findMarkers(small);
    let est = null, colors = null;
    if (mk) { est = estimateGrid(mk.markers); colors = mk.colors; }
    return { markers: mk ? 4 : 0, est, colors, lastFail: state.lastFail };
  }

  /* -------- EXPERIMENT: decode with the refined-marker homography only.
     The real decodeFrame also tries canvas-walk corners, marker centroids and
     4 affine corner-subsets (~36 sampling passes when the first grid estimate
     is wrong). decodeFast tries ONLY the refined corners — 4 sampling passes.
     Falls back to the real decoder whenever markers can't be refined, so the
     rates are directly comparable. ---- */
  function decodeFast(img, state) {
    const small = downscaleRGBA(img.data, img.w, img.h, 640);
    const markers = findMarkers(small);
    if (!markers) return decodeFrame(img, state);
    const kx = img.w / small.w, ky = img.h / small.h;
    const roles = ['tl', 'tr', 'bl', 'br'];
    const refined = [];
    for (let i = 0; i < 4; i++) {
      const r = refineMarker(img, markers.markers[i].cx * kx, markers.markers[i].cy * ky, roles[i]);
      if (!r) return decodeFrame(img, state);
      refined.push([r.x, r.y]);
    }
    const g1 = state.grid || estGridFixed(markers, kx) || 168;
    const g2 = g1 === 168 ? 224 : 168;
    const c1 = state.colors || markers.colors;
    const c2 = c1 === 4 ? 8 : 4;
    const lutKey = (state.palHex ? state.palHex.join(',') : '') + '|' +
      (state.cal ? state.cal.white.toFixed(1) + '/' + state.cal.black.toFixed(1) : '-');
    if (state._lutKey !== lutKey) {
      state._lutKey = lutKey;
      state._luts = {};
      for (const c of [4, 8]) state._luts[c] = classifyLUT(makePrototypes(c, state.palHex), state.cal);
    }
    for (const g of [g1, g2]) {
      const H0 = solveHomography([[0, 0], [g, 0], [0, g], [g, g]], refined);
      if (!H0) continue;
      for (const c of [c1, c2]) {
        const idx = sampleGrid(img, H0, g, state._luts[c]);
        const dataLen = dataBytes(g, c);
        const payload = colorsToPayload(idx, g, c, dataLen);
        if (!payload) continue;
        const crc = crc32(payload.subarray(0, dataLen - CRC_BYTES));
        const got = ((payload[dataLen - 4] << 24) | (payload[dataLen - 3] << 16) | (payload[dataLen - 2] << 8) | payload[dataLen - 1]) >>> 0;
        if (crc !== got) continue;
        const sym = parseSymbol(payload.subarray(0, dataLen - CRC_BYTES));
        if (!sym) continue;
        if (sym.data.length !== chunkLenFor(g, c, nameBytes(sym.name).length)) continue;
        state.H = H0; state.grid = g; state.colors = c;
        return { type: 'symbol', sym, grid: g, colors: c };
      }
    }
    state.lastFail = 'sampling';
    return null;
  }

  /* -------- EXPERIMENT: grid estimate with the blob side measured at FULL
     resolution. decodeFrame's estimateGrid uses the 640px-downscaled blob
     side, which is stride-2 quantized down (~25% too small at 7px markers)
     and systematically over-estimates the grid to 224. The correct combo
     then only wins via the CRC arbitration, doubling the decode cost. ---- */
  function estGridFixed(markers, kx) {
    const m = markers.markers;
    const dx = m[1].cx - m[0].cx, dy = m[1].cy - m[0].cy;
    const dist = Math.hypot(dx, dy) * kx;
    const side = ((m[0].side + m[1].side + m[2].side + m[3].side) / 4) * kx;
    if (side < 2) return null;
    const est = dist / side * MARKER + MARKER;
    let best = null, bd = Infinity;
    for (const g of GRID_OPTIONS) {
      const d = Math.abs(g - est);
      if (d < bd) { bd = d; best = g; }
    }
    return bd / est < 0.25 ? best : null;
  }

  /* -------- EXPERIMENT: per-frame color calibration from the markers.
     The 4 corner markers are KNOWN colors (black/red/green/blue-or-cyan), so
     their measured in-frame RGB gives the camera's white balance and exposure
     for THIS frame, for free. Red/green/cyan markers yield per-channel gains;
     blue/yellow/magenta protos are derived from the ideal palette × gains;
     the white border gives the exposure ref. This is the fix for 8-color
     classification under WB/exposure drift. Falls back to the real decoder
     when markers can't be refined. ---- */
  function measureCalib8(img, markers, kx, ky, refined) {
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
    // rgbs order: black, red, green, blue/cyan
    // per-channel gains from the chromatic markers (skip black):
    // red marker -> R gain, green marker -> G gain, blue/cyan marker -> B gain
    // (cyan's R channel is ~0, so it can only calibrate G and B)
    const gR = 255 / rgbs[1][0];
    const gG = (255 / rgbs[2][1] + 255 / rgbs[3][1]) / 2;
    const gB = (255 / rgbs[3][2] + 255 / rgbs[2][2]) / 2;
    const san = (v) => (isFinite(v) && v > 0.3 && v < 3 ? v : 1);
    const gains = [san(gR), san(gG), san(gB)];
    // white: sample the border just outside the grid corner (1.5 modules out,
    // diagonally between the two outward edges)
    const mp = side / MARKER;
    let white = null;
    for (const [ci, rp] of [[0, refined[0]], [2, refined[2]]]) {
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
    return { gains: [gR, gG, gB], white, black };
  }

  /* Custom LUT for the calibration experiment: classifies in MEASURED space
     (no luma stretch — that would double-correct against the gains-corrected
     protos). White/black thresholds derive from the measured border + black
     marker, so exposure drift is absorbed. Same 5-bit RGB lookup scheme and
     distance weights as the core classifier. */
  function calibLUT(colors, gains, white, black) {
    const hexes = PALETTE_HEX[colors];
    const protos = [];
    for (let i = 0; i < hexes.length; i++) {
      const r = Math.min(255, parseInt(hexes[i].slice(1, 3), 16) * gains[0]);
      const g = Math.min(255, parseInt(hexes[i].slice(3, 5), 16) * gains[1]);
      const b = Math.min(255, parseInt(hexes[i].slice(5, 7), 16) * gains[2]);
      const [h, s, v] = rgb2hsv(r, g, b);
      protos.push({ index: i, h, s, v, chromatic: s >= 0.2 });
    }
    const wThresh = 0.72 * (white / 255) + 0.12;
    const bThresh = 0.5 * (black / 255) + 0.12;
    const lut = new Uint8Array(32768).fill(255);
    for (let i = 0; i < 32768; i++) {
      const r = ((i >>> 10) & 31) * 8 + 4;
      const g = ((i >>> 5) & 31) * 8 + 4;
      const b = (i & 31) * 8 + 4;
      const [h, s, v] = rgb2hsv(r, g, b);
      if (s < 0.22) {
        if (v < bThresh) { lut[i] = 0; continue; }
        if (colors === 8 && v > wThresh) { lut[i] = 7; continue; }
        lut[i] = 255; continue;
      }
      let best = -1, bestD = Infinity;
      for (const p of protos) {
        if (!p.chromatic) continue;
        let dh = Math.abs(h - p.h);
        if (dh > 180) dh = 360 - dh;
        const d = dh + Math.abs(v - p.v) * 90 + Math.abs(s - p.s) * 50;
        if (d < bestD) { bestD = d; best = p.index; }
      }
      lut[i] = bestD > 95 ? 255 : best;
    }
    return lut;
  }

  function decodeCalibExp(img, state) {
    const small = downscaleRGBA(img.data, img.w, img.h, 640);
    const markers = findMarkers(small);
    if (!markers || markers.colors !== 8) return decodeFrame(img, state);
    const kx = img.w / small.w, ky = img.h / small.h;
    const roles = ['tl', 'tr', 'bl', 'br'];
    const refined = [];
    for (let i = 0; i < 4; i++) {
      const r = refineMarker(img, markers.markers[i].cx * kx, markers.markers[i].cy * ky, roles[i]);
      if (!r) return decodeFrame(img, state);
      refined.push([r.x, r.y]);
    }
    const cal = measureCalib8(img, markers, kx, ky, refined);
    if (!cal) return decodeFrame(img, state);
    const lut = calibLUT(8, cal.gains, cal.white, cal.black);
    const g1 = state.grid || estGridFixed(markers, kx) || 168;
    const g2 = g1 === 168 ? 224 : 168;
    for (const g of [g1, g2]) {
      const H0 = solveHomography([[0, 0], [g, 0], [0, g], [g, g]], refined);
      if (!H0) continue;
      const idx = sampleGrid(img, H0, g, lut);
      const dataLen = dataBytes(g, 8);
      const payload = colorsToPayload(idx, g, 8, dataLen);
      if (!payload) continue;
      const crc = crc32(payload.subarray(0, dataLen - CRC_BYTES));
      const got = ((payload[dataLen - 4] << 24) | (payload[dataLen - 3] << 16) | (payload[dataLen - 2] << 8) | payload[dataLen - 1]) >>> 0;
      if (crc !== got) continue;
      const sym = parseSymbol(payload.subarray(0, dataLen - CRC_BYTES));
      if (!sym) continue;
      if (sym.data.length !== chunkLenFor(g, 8, nameBytes(sym.name).length)) continue;
      state.H = H0; state.grid = g; state.colors = 8;
      return { type: 'symbol', sym, grid: g, colors: 8 };
    }
    state.lastFail = 'sampling';
    return null;
  }

  const DECODERS = { real: decodeFrame, fast: decodeFast, calib8: decodeCalibExp };

  const DEFAULTS = {
    hooks: { decodeFrame: decodeFrame },
    decoder: 'real',
    meta: null,
    modulePx: 2.8,
    fit: true,
    yaw: 0, pitch: 0, roll: 0,
    blur: 0, noise: 0, gain: 1, tintR: 1, tintG: 1, tintB: 1,
  };

  function pickDecoder(opts) {
    if (opts.decoder && DECODERS[opts.decoder]) return DECODERS[opts.decoder];
    if (opts.hooks && opts.hooks.decodeFrame) return opts.hooks.decodeFrame;
    return decodeFrame;
  }

  function runTrial(opts, camW, camH) {
    const meta = opts.meta;
    const seed = (simRand() * 4294967296) >>> 0;
    const fr = genFrame(meta, meta.blocks, seed);
    const screen = makeScreen(fr.buf, fr.S, opts.modulePx);
    const t0 = performance.now();
    let screen2 = null;
    if (opts.tear) {
      // #83: the sensor caught the transition to the NEXT symbol
      const fr2 = genFrame(meta, meta.blocks, (seed + 1) >>> 0);
      screen2 = makeScreen(fr2.buf, fr2.S, opts.modulePx);
    }
    const cam = capture(screen, opts, camW, camH, screen2);
    const t1 = performance.now();
    const state = freshState();
    let res = null;
    try { res = pickDecoder(opts)({ data: cam.data, w: cam.w, h: cam.h }, state); }
    catch (e) { state.lastFail = 'throw: ' + e.message; }
    const t2 = performance.now();
    return {
      ok: !!res, res, lastFail: state.lastFail,
      ms: t2 - t0, captureMs: t1 - t0, decodeMs: t2 - t1,
      diag: diagInfo(cam, state),
    };
  }

  function runTrials(opts, camW, camH, n) {
    const agg = { ok: 0, fail: 0, failDetect: 0, failSampling: 0, ms: 0, markers: 0, unique: 0, sawCalib: 0 };
    for (let i = 0; i < n; i++) {
      const t = runTrial(opts, camW, camH);
      agg.ms += t.ms; agg.markers += t.diag.markers;
      if (t.ok) { agg.ok++; if (t.res.type === 'calib') agg.sawCalib++; else agg.unique++; }
      else {
        agg.fail++;
        if (t.lastFail === 'detect') agg.failDetect++;
        else if (t.lastFail === 'sampling') agg.failSampling++;
      }
    }
    agg.ms /= n; agg.markers /= n;
    return agg;
  }

  /* Continuous stream with a shared decode state + LT pool (real flow). */
  function makeStream() {
    const state = freshState();
    let decoder = createLtDecoder();
    let unique = new Set();
    let meta = null;
    return {
      get solved() { return decoder.solved; },
      get unique() { return unique.size; },
      begin(opts) {
        meta = opts.meta;
        state.grid = null; state.colors = null; state.H = null; state.palHex = null;
        state.cal = null; state._lutKey = null; state._luts = null;
        decoder = createLtDecoder();
        unique = new Set();
      },
      step(opts, camW, camH, seed) {
        if (seed === undefined) seed = (simRand() * 4294967296) >>> 0;
        const fr = genFrame(meta, meta.blocks, seed);
        const screen = makeScreen(fr.buf, fr.S, opts.modulePx);
        const cam = capture(screen, opts, camW, camH);
        const t0 = performance.now();
        let res = null;
        try { res = pickDecoder(opts)({ data: cam.data, w: cam.w, h: cam.h }, state); }
        catch (e) { state.lastFail = 'throw: ' + e.message; }
        const ms = performance.now() - t0;
        if (res && res.type === 'symbol' && !unique.has(res.sym.seed)) {
          unique.add(res.sym.seed);
          decoder.add([{ seed: res.sym.seed, data: res.sym.data }], meta.k);
        }
        return { fr, cam, screen, res, ms, state, solved: decoder.solved, unique: unique.size, k: meta.k };
      }
    };
  }

  /* -------- throughput model --------
     The receiver decodes every camera frame it can (decodeFps = 1000/ms),
     keeps only unique symbols, and the sender offers `fps` symbols/sec.
     The receiver can absorb min(senderFps, decodeFps) × successRate
     symbols/sec, each worth chunkLen bytes of file data. */
  const SENDER_FPS = [10, 15, 20, 24, 30, 40, 60];

  function senderMaxBytes() {
    const rows = [];
    for (const grid of [168, 224]) {
      for (const colors of [4, 8]) {
        const chunk = chunkLenFor(grid, colors, nameBytes('sim-test.bin').length);
        rows.push({ grid, colors, chunk, perFps: SENDER_FPS.map((f) => chunk * f) });
      }
    }
    return rows;
  }

  function estimateThroughput(opts, camW, camH, n) {
    let ok = 0, ms = 0, capMs = 0, decMs = 0;
    for (let i = 0; i < n; i++) {
      const t = runTrial(opts, camW, camH);
      if (t.ok) ok++;
      ms += t.ms; capMs += t.captureMs; decMs += t.decodeMs;
    }
    ms /= n; capMs /= n; decMs /= n;
    const decodeFps = 1000 / ms;
    const success = ok / n;
    const chunk = opts.meta.chunkLen;
    const camFps = opts.camFps || 30;
    const rows = SENDER_FPS.map((fps) => {
      // the min-law: the receiver absorbs min(sender fps, camera fps,
      // decode fps) x success — a 60fps sender gains nothing on a 30fps
      // camera, and a camera at 60fps doubles the ceiling
      const eff = Math.min(fps, camFps, decodeFps) * success;
      return { fps, eff, kBs: eff * chunk / 1024 };
    });
    return { decodeFps, success, chunk, ms, capMs, decMs, camFps, rows };
  }

  /* Decode rate (%) vs one parameter across a range. */
  function sweep(param, min, max, steps, baseOpts, camW, camH, nPerValue) {
    const out = [];
    for (let i = 0; i <= steps; i++) {
      const v = min + (max - min) * i / steps;
      const o = Object.assign({}, baseOpts, { [param]: v });
      const agg = runTrials(o, camW, camH, nPerValue);
      out.push({
        v: +v.toFixed(3), n: nPerValue,
        rate: agg.ok / nPerValue,
        ok: agg.ok, failDetect: agg.failDetect, failSampling: agg.failSampling,
        ms: +agg.ms.toFixed(1), markers: +agg.markers.toFixed(1),
      });
    }
    return out;
  }

  return {
    CAM_SIZES,
    DECODERS,
    SENDER_FPS, senderMaxBytes, estimateThroughput,
    setSimSeed, simRand,
    makeMeta, genFrame, makeScreen, capture, quadFor,
    freshState, runTrial, runTrials, makeStream, sweep,
    DEFAULTS,
  };
})();

if (typeof module === 'object' && module.exports) module.exports = LumenSim;
