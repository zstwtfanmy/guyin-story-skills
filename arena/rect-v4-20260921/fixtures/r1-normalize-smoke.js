'use strict';
// R1 (B-2) 手工烟测：normalize 读写契约。临时夹具，正式回归在 tests/run-tests.js。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '../../..');
const SCRIPT = path.join(root, 'skills', 'guyin-write', 'scripts', 'guyin-normalize-punctuation.js');
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'guyin-r1-'));
const drafts = path.join(base, 'book', '.guyin', 'work', 'r1', 'drafts');
fs.mkdirSync(drafts, { recursive: true });
fs.mkdirSync(path.join(base, 'book', '正文'), { recursive: true });
const cand = path.join(drafts, 'v0001.md');
const content = '他停住……等等——再进来吧。\n她用“引号”说话。\n---\n';
fs.writeFileSync(cand, content, 'utf8');
const h0 = fs.readFileSync(cand);
const run = (args) => spawnSync('node', [SCRIPT, ...args], { encoding: 'utf8' });
let r;

r = run([cand]);
console.log('default exit', r.status, '(want 1: divider hard)');
console.log('default read-only:', fs.readFileSync(cand).equals(h0));

r = run(['--check', cand]);
console.log('--check exit', r.status, '(want 1), read-only:', fs.readFileSync(cand).equals(h0));

r = run(['--check', '--write', cand]);
console.log('--check --write exit', r.status, '(want 2), no v0002:', !fs.existsSync(path.join(drafts, 'v0002.md')));

const formal = path.join(base, 'book', '正文', '第001章_试.md');
fs.writeFileSync(formal, '---\n正文。\n', 'utf8');
r = run(['--write', formal]);
console.log('--write formal exit', r.status, '(want 2), formal untouched:',
  fs.readFileSync(formal, 'utf8') === '---\n正文。\n');

r = run(['--write', cand]);
const v2 = path.join(drafts, 'v0002.md');
console.log('--write candidate exit', r.status, '(want 0), v0002 exists:', fs.existsSync(v2));
console.log('v0001 untouched:', fs.readFileSync(cand).equals(h0));
const out2 = fs.existsSync(v2) ? fs.readFileSync(v2, 'utf8') : '';
console.log('pause preserved:', out2.includes('……') && out2.includes('——'));
console.log('divider removed:', !out2.includes('---'));
console.log('quote kept in keep mode:', out2.includes('“') && out2.includes('”'));

r = run(['--write', '--quote-mode', 'ascii', v2]);
const v3 = path.join(drafts, 'v0003.md');
const out3 = fs.existsSync(v3) ? fs.readFileSync(v3, 'utf8') : '';
console.log('ascii v0003 exists:', fs.existsSync(v3), 'ascii quote:', out3.includes('"说话"'),
  'no curly:', !out3.includes('“'));

const c2 = path.join(drafts, 'v0010.md');
fs.writeFileSync(c2, '正常文本，没有任何问题。\n', 'utf8');
r = run(['--write', c2]);
console.log('clean candidate no new version:', !fs.existsSync(path.join(drafts, 'v0011.md')),
  'exit', r.status, '(want 0)');

const c3 = path.join(drafts, 'v0020.md');
fs.writeFileSync(c3, '正文\n<!-- 未闭合注释\n后续内容。\n', 'utf8');
r = run(['--write', c3]);
const v21 = path.join(drafts, 'v0021.md');
console.log('unclosed comment exit', r.status, '(want 1), v0021 still written:', fs.existsSync(v21),
  'comment preserved:', fs.existsSync(v21) && fs.readFileSync(v21, 'utf8').includes('<!--'));
