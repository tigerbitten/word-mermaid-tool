// Splits corpus.txt into corpus/NNN-name.mmd. Flags after the name: crlf (Windows
// line endings), tabs (leading 4-space indents become tabs).
const fs = require('fs');
const dir = __dirname + '/corpus';
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir);
const parts = fs.readFileSync(__dirname + '/corpus.txt', 'utf8').split(/^@@@ /m).slice(1);
for (const p of parts) {
  const nl = p.indexOf('\n');
  const [name, ...flags] = p.slice(0, nl).trim().split(/\s+/);
  let body = p.slice(nl + 1);
  if (flags.includes('tabs')) body = body.replace(/^( {4})+/gm, (m) => '\t'.repeat(m.length / 4));
  if (flags.includes('crlf')) body = body.replace(/\n/g, '\r\n');
  fs.writeFileSync(`${dir}/${name}.mmd`, body);
}
console.log(parts.length + ' files');
