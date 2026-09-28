// G5 用户级：仅镜像 9 个 guyin 技能到 C:/Users/PC/.agents/skills，字节一致；不碰 story*/browser-cdp。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const P = process.cwd();
const SRC = path.join(P, 'skills');
const ROOT = 'C:/Users/PC/.agents/skills';
const GUYIN = fs.readdirSync(SRC).filter(n => n.startsWith('guyin-'));

function walk(d) {
  const out = [];
  for (const n of fs.readdirSync(d)) {
    if (n === '__pycache__') continue;
    const rp = path.join(d, n);
    if (fs.statSync(rp).isDirectory()) out.push(...walk(rp));
    else if (!n.endsWith('.pyc')) out.push(rp);
  }
  return out;
}
const sha = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

let copied = 0, removed = 0, bad = 0, checked = 0;
for (const skill of GUYIN) {
  const sdir = path.join(SRC, skill), tdir = path.join(ROOT, skill);
  const sFiles = walk(sdir).map(f => path.relative(sdir, f));
  fs.mkdirSync(tdir, { recursive: true });
  const tFiles = walk(tdir).map(f => path.relative(tdir, f));
  for (const rel of sFiles) {
    fs.mkdirSync(path.dirname(path.join(tdir, rel)), { recursive: true });
    fs.copyFileSync(path.join(sdir, rel), path.join(tdir, rel));
    copied++;
  }
  for (const rel of tFiles) if (!sFiles.includes(rel)) { fs.rmSync(path.join(tdir, rel), { force: true }); removed++; }
  for (const f of walk(sdir)) { checked++; if (sha(f) !== sha(path.join(ROOT, path.relative(SRC, f)))) bad++; }
}
console.log(JSON.stringify({ copied, removed, checked, hashMismatch: bad }));
