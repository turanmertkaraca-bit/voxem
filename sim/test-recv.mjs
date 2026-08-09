/* test-recv.mjs — run the UNMODIFIED voxem app in Chromium with a fake
   camera fed by a rendered grid video; verify the receiver decodes.
   Usage: node test-recv.mjs <grid.y4m> [seconds]
*/
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(DIR, '..');
const y4m = path.resolve(process.argv[2] || 'grid-168-4.y4m');
const SECONDS = Number(process.argv[3] || 25);

const mime = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css' };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  const f = path.join(root, p);
  if (!f.startsWith(root) || !fs.existsSync(f) || !fs.statSync(f).isFile()) { res.writeHead(404); res.end('404'); return; }
  res.writeHead(200, { 'content-type': mime[path.extname(f).toLowerCase()] || 'application/octet-stream' });
  res.end(fs.readFileSync(f));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
console.log('serving ' + root + ' on :' + port + '  camera=' + y4m);

const browser = await chromium.launch({
  headless: true,
  args: [
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
    '--use-file-for-fake-video-capture=' + y4m,
    '--autoplay-policy=no-user-gesture-required',
    '--no-sandbox',
  ],
});
const page = await browser.newPage();
page.on('console', (m) => console.log('[console]', m.type(), m.text().slice(0, 200)));
page.on('pageerror', (e) => console.log('[pageerror]', e.message.slice(0, 300)));

await page.goto('http://127.0.0.1:' + port + '/', { waitUntil: 'networkidle' });
await page.click('#tabRecv');
await page.click('#recvBtn');

/* diagnostic dump: manual decode of the live frame with failInfo */
await page.waitForTimeout(6000);
const camState = await page.evaluate(() => {
  const v = document.getElementById('video');
  const r = window.__voxem.recvState;
  return {
    vw: v ? v.videoWidth : -1, vh: v ? v.videoHeight : -1,
    status: (document.getElementById('recvStatus') || {}).textContent,
    stream: !!r.stream, running: r.running,
  };
});
console.log('camera state: ' + JSON.stringify(camState));
if (camState.vw > 0) {
const diag = await page.evaluate(() => {
  const vx = window.__voxem;
  const f = vx.grabFrame();
  const st = vx.recvState;
  const res = vx.decodeFrame({ data: new Uint8ClampedArray(f.data), w: f.w, h: f.h }, st);
  let hist = {};
  for (let y = 0; y < f.h; y += 9) for (let x = 0; x < f.w; x += 9) {
    const o = (y * f.w + x) * 4;
    const key = [f.data[o] >> 5, f.data[o + 1] >> 5, f.data[o + 2] >> 5].join(',');
    hist[key] = (hist[key] || 0) + 1;
  }
  const top = Object.entries(hist).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, n]) => k + 'x' + n).join(' | ');
  return { manual: res ? res.type + ' ' + (res.grid || '') + '/' + (res.colors || '') : 'null', lastFail: st.lastFail, failInfo: st.failInfo, hist: top };
});
console.log('MANUAL DECODE: ' + JSON.stringify(diag, null, 1));

/* dump the full frame for offline analysis */
const frame = await page.evaluate(() => {
  const f = window.__voxem.grabFrame();
  return { data: Array.from(f.data), w: f.w, h: f.h };
});
const outPath = path.join(DIR, 'browser-frame.raw');
const buf = Buffer.alloc(frame.w * frame.h * 4);
for (let i = 0; i < frame.data.length; i++) buf[i] = frame.data[i];
fs.writeFileSync(outPath, buf);
console.log('dumped frame to ' + outPath + ' (' + frame.w + 'x' + frame.h + ')');
} else {
  console.log('NO CAMERA FRAMES — videoWidth 0');
}

let done = false;
for (let i = 0; i < SECONDS; i++) {
  await page.waitForTimeout(1000);
  const diag = (await page.textContent('#diagLine').catch(() => '')) || '';
  const status = (await page.textContent('#recvStatus').catch(() => '')) || '';
  const solved = (await page.textContent('#rtSolved').catch(() => '')) || '';
  const dl = (await page.textContent('#dlBtn').catch(() => '')) || '';
  console.log('t+' + String(i + 1).padStart(2) + 's | diag: ' + diag + ' | status: ' + status + ' | solved: ' + solved + (dl ? ' | DL: ' + dl : ''));
  const mm = solved.match(/(\d+) \/ (\d+)/);
  if (mm && Number(mm[1]) >= Number(mm[2]) && Number(mm[2]) > 0) { console.log('=== ALL BLOCKS SOLVED ==='); done = true; break; }
}
if (!done) console.log('=== NOT SOLVED WITHIN ' + SECONDS + 's ===');
await browser.close();
server.close();
process.exit(done ? 0 : 1);
