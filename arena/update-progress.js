#!/usr/bin/env node
'use strict';

// arena/update-progress.js — 任务书 §0.2 实施进度文件维护器
// 只读写 arena/implementation-progress.json；changed_files 的 SHA-256 由本脚本真实计算，
// 不接受调用者手填哈希。用法示例：
//   node arena/update-progress.js --complete P0 --current P1.1 \
//     --add-arena --add skills/guyin-write/SKILL.md \
//     --test '{"name":"...","command":"...","exit_code":0,"source":"1830b0e"}' \
//     --next-action "P1.1 ..."
// --reset-test-log 可清空 tests 重新记账（默认追加，同名 name 覆盖）。

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const REPO = path.resolve(__dirname, '..');
const PROGRESS = path.join(REPO, 'arena', 'implementation-progress.json');

function arg(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : null;
}
function has(flag) { return process.argv.includes(flag); }

function sha256(rel) {
  return crypto.createHash('sha256').update(fs.readFileSync(path.join(REPO, rel))).digest('hex');
}
function walk(relDir) {
  const abs = path.join(REPO, relDir);
  if (!fs.existsSync(abs)) return [];
  return fs.readdirSync(abs, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(relDir, e.name).replace(/\\/g, '/');
    return e.isDirectory() ? walk(p) : [p];
  });
}

const SELF = 'arena/implementation-progress.json';
const doc = fs.existsSync(PROGRESS)
  ? JSON.parse(fs.readFileSync(PROGRESS, 'utf8'))
  : {
      spec_version: 'v4', source_baseline: '1830b0e', head_at_start: '1655383',
      completed_steps: [], current_step: null, changed_files: [], tests: [], blockers: [],
      next_action: null,
    };

doc.updated_at = new Date().toISOString();

if (arg('--current')) doc.current_step = arg('--current');
if (arg('--complete')) {
  const step = arg('--complete');
  if (!doc.completed_steps.includes(step)) doc.completed_steps.push(step);
  if (!doc.current_step) doc.current_step = step;
}
if (arg('--next-action')) doc.next_action = arg('--next-action');
if (arg('--blocker')) doc.blockers.push({ at: doc.updated_at, detail: arg('--blocker') });
if (arg('--clear-blockers')) doc.blockers = [];
if (has('--reset-test-log')) doc.tests = [];

let wanted = new Set((doc.changed_files || []).map((e) => e.path));
if (has('--add-arena')) {
  const preExisting = ['arena/基准/', 'arena/对战记录/'];
  for (const f of walk('arena')) {
    if (f === SELF || preExisting.some((d) => f.startsWith(d))) continue;
    wanted.add(f);
  }
  wanted.add('arena/update-progress.js');
}
for (const raw of (arg('--add') || '').split(',').map((s) => s.trim()).filter(Boolean)) {
  wanted.add(raw.replace(/\\/g, '/'));
}
for (const raw of (arg('--remove') || '').split(',').map((s) => s.trim()).filter(Boolean)) {
  wanted.delete(raw.replace(/\\/g, '/'));
}
const changed = [];
for (const rel of [...wanted].sort()) {
  const abs = path.join(REPO, rel);
  if (!fs.existsSync(abs)) { changed.push({ path: rel, sha256: null, note: 'deleted' }); continue; }
  changed.push({ path: rel, sha256: sha256(rel) });
}
doc.changed_files = changed;

const testDir = path.join(REPO, 'arena', 'progress-tests');
if (fs.existsSync(testDir)) {
  for (const f of fs.readdirSync(testDir).filter((n) => n.endsWith('.json')).sort()) {
    const entry = JSON.parse(fs.readFileSync(path.join(testDir, f), 'utf8'));
    entry.record_file = `arena/progress-tests/${f}`;
    doc.tests = doc.tests.filter((t) => t.name !== entry.name);
    doc.tests.push(entry);
  }
}

fs.writeFileSync(PROGRESS, JSON.stringify(doc, null, 2) + '\n', 'utf8');
console.log(`progress updated: completed=[${doc.completed_steps.join(', ')}] current=${doc.current_step} changed_files=${doc.changed_files.length} tests=${doc.tests.length}`);
