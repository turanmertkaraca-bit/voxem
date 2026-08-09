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

## The bug that killed live decode (fixed here)

The old app gave `decodeFrame` a fixed **45 ms budget**. A first-time full
detection takes ~50–350 ms even on desktop, so every frame aborted before
sampling and a lock was never acquired — the live receiver decoded **0
symbols** while the headless selftest (which passed no deadline) passed 10/10.
Fixed: acquisition frames get **no deadline**; once the cached-homography
fast path is locked (~1–2 ms/frame) fallback re-detection gets a 150 ms
budget. `sim/deadline-test.mjs` reproduces the starvation; T14 in the selftest
locks it in as a regression test.

## Use it

1. Open the page on both devices (the receiving one needs HTTPS or localhost
   for camera access).
2. **Send** — pick a file, choose grid/palette/frame rate, start streaming.
3. **Receive** — start the camera, point it at the sender's screen. When the
   fountain completes, download the file.

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
