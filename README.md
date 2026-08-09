# Lumen2

Screen-to-camera file transfer in a single HTML file. No network, no pairing,
no servers, no CDN — one device streams a file as a flickering color grid on
its screen, another device's camera captures it and rebuilds the file.

The hybrid of two ideas:

- **decimen-style wire** — self-describing 25-byte frame header with a random
  `sessionId` (a re-sent file can never mix old symbols into a new stream),
  per-symbol CRC32, whole-file CRC32, native gzip container with size ceiling.
- **lumen-style physical layer** — a 168×168 or 224×224 module grid in 4 or 8
  colors (2/3 bits per module = **6.9–18.7 KB per frame**, 2.3–6× a V40 QR),
  8×8 corner markers, whitened data, exposure-adaptive classification.

Everything rides inside every symbol — no calibration, nothing to match. The
receiver needs ~1.15–1.5× the source blocks in any order; dropped or blurry
frames cost time, never correctness.

## The bugs that killed live decode (all fixed here)

1. **Fixed 45 ms decode deadline** — the old app gave `decodeFrame` a fixed
   45 ms budget. A first-time full detection takes ~50–350 ms even on
   desktop, so every frame aborted before sampling and a lock was never
   acquired — the live receiver decoded **0 symbols** while the headless
   selftest (which passed no deadline) passed. Fixed: acquisition frames
   get **no deadline**; once the cached-homography fast path is locked
   (~1–2 ms/frame) fallback re-detection gets a 300 ms budget. T14 locks
   this in.

2. **4:2:0 chroma subsampling** — the headless sim modeled a perfect camera.
   Real cameras (and video pipelines) store chroma at quarter resolution:
   at 3–5 px/module the chroma blends between modules and **hue becomes
   unreliable**. This is why the sim decoded 100% while real hardware
   decoded ~0% — and why QR (black/white, luma-only) works on any phone.
   Fixes:
   - the sim's camera now does real 4:2:0 chroma subsampling, so it fails
     when the decoder would fail;
   - classification is **luma-primary** (luma survives subsampling at full
     resolution; every palette color has a distinct luma);
   - the 4-color DATA palette is black/red/green/**white** (luma gaps
     76/74/105) instead of black/red/green/blue (gap 29) — the old blue
     was indistinguishable from black at small module sizes. The corner
     MARKERS stay black/red/green/blue (solid 8×8 blocks, chroma-safe);
   - **marker-gain correction**: the red/green/blue markers are known
     colors, so per-channel gains measured from them normalize exposure
     AND white-balance tint before classifying (a warm tint used to
     scramble luma bins);
   - **9-point majority sampling** with center tie-break — a single
     unresolved module used to kill the whole frame in `colorsToPayload`.

3. **Hidden camera preview** — the receive video element's CSS default was
   `display:none`; on Safari a hidden video stops producing frames, so the
   receiver saw black. Now `display:block` (lumen's original behavior).

4. **Uneven module pixels** — the sender canvas was stretched by CSS onto
   the wrap box, so modules landed on non-integer device pixels. The canvas
   element is now sized to exactly `backing/dpr` CSS px (1:1 device-pixel
   mapping); every module is the same whole number of device pixels.

## Use it

1. Open the page on both devices (the receiving one needs HTTPS or localhost
   for camera access).
2. **Send** — pick a file, choose grid/palette/frame rate, start streaming.
3. **Receive** — start the camera, point it at the sender's screen. When the
   fountain completes, download the file.

Physical tips: modules must be ~4+ camera pixels wide to decode — hold the
phone close enough that the grid fills most of the frame (Tiny 96 grid
helps). Disable Night Shift / True Tone / adaptive brightness on both
devices.

## Test without a camera

The Receive panel has a **Self-test** button: it renders real frames in
memory and decodes them with the exact receiver pipeline. If it passes, the
codec works in your browser and any remaining failure is physical (framing,
focus, exposure).

## Run locally

```bash
python3 -m http.server 8080
# or: npx serve .
# then open http://localhost:8080
```

## Files

- `index.html` — the whole app (sender + receiver + codec in one file).
- `app.template.html` + `build.mjs` — the source template; `node build.mjs`
  assembles `index.html` from the proven core extracted from the lumen repo
  (`../lumen/lumen-sim/core.js`).
- `sim/` — headless verification: `sim-core.js` (synthetic camera),
  `selftest2.mjs` (16 tests), `deadline-test.mjs` (starvation reproduction),
  `extract-core.js` (pulls the core back out of `index.html` for testing).
  Run `QUICK=1 node selftest2.mjs` for a fast pass.

## Browser support

Modern mobile and desktop browsers. Camera requires HTTPS or localhost. gzip
uses native `CompressionStream`/`DecompressionStream` (Safari 16.4+, Chrome
80+, Firefox 113+). Zero external dependencies — the page works fully offline
after first load, and from `file://` for the sender.
