const fs = require('fs');
const path = require('path');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const m = html.match(/<script type="module">([\s\S]*?)<\/script>/);
if (!m) { console.error('no module script found'); process.exit(1); }
const js = m[1];
function section(start, end) {
  let i0 = js.indexOf(start);
  i0 = js.lastIndexOf('/*', i0);
  let i1 = js.indexOf(end);
  i1 = js.indexOf('*/', i1) + 2;
  return js.slice(i0, i1);
}
const core = section('LT-CORE-BEGIN', 'LT-CORE-END') + '\n' + section('wire format v3 + CRC32', 'PHYSICAL-CORE-BEGIN') + '\n' + section('PHYSICAL-CORE-BEGIN', 'PHYSICAL-CORE-END');
fs.writeFileSync(path.join(__dirname, 'core.js'), core);
console.log('wrote core.js (' + core.length + ' bytes)');
