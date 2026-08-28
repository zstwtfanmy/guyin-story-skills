#!/usr/bin/env node
'use strict';

// check-doc-budget.js — 热路径文档预算守卫（防 skill / 卡片 / agent 模板无声膨胀）
//
// 适配自上游 oh-story-claudecode check-doc-budget.sh（去 bash 壳的 node 直跑版，Windows 友好）。
// 背景：SKILL.md 与任务卡是每次会话 / 每个 beat 都要付的 token。逐条加规则每次只贵一点点，
// 累积起来就是日更路径翻倍。本守卫给热路径文件设上限，超了就红——要么删等量旧文本，
// 要么显式在 doc-budget.json 里调高预算。
// 度量：去掉所有空白后的字符数（中英文都算，改标点/换行/缩进不影响读数）。
// 冷路径（references/consult、exemplars、docs、拆文库）不登记，不受限。
//
// 用法：node scripts/check-doc-budget.js [--dump]
//   --dump 只列当前用量与预算余量，不判定（调预算用）。

const fs = require('fs');
const path = require('path');

const MANIFEST = path.join(__dirname, 'doc-budget.json');
const REPO_ROOT = path.resolve(__dirname, '..');
const dumpOnly = process.argv.includes('--dump');

if (!fs.existsSync(MANIFEST)) {
  console.error(`FAIL: 预算清单缺失：${MANIFEST}`);
  process.exit(1);
}

const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));

// 去空白字符数：改标点/换行/缩进不影响，加删正文才影响。
const weigh = (rel) => {
  const abs = path.join(REPO_ROOT, rel);
  if (!fs.existsSync(abs)) return null;
  return fs.readFileSync(abs, 'utf8').replace(/\s/g, '').length;
};

const fail = [];
const note = [];

console.log('热路径文档预算');
console.log(''.padEnd(70, '-'));
console.log('  用量 /   预算  余量  文件');

for (const entry of manifest.files) {
  const used = weigh(entry.path);
  if (used === null) {
    fail.push(`预算登记的文件不存在：${entry.path}（改名/删除后请同步 doc-budget.json）`);
    continue;
  }
  const left = entry.budget - used;
  const mark = left < 0 ? 'OVER' : 'ok';
  console.log(`  ${String(used).padStart(6)} / ${String(entry.budget).padStart(6)} ${String(left).padStart(6)}  ${entry.path}  [${mark}]`);
  if (left < 0) {
    fail.push(`${entry.path} 超预算 ${-left} 字（${used} > ${entry.budget}）：${entry.why}`);
  } else {
    // 锁紧提示只在建议值真能降时发（ceil(用量/100)*100 ≥ budget 时提示「降到当前值」是空转噪声，
    // 会淹没真锁紧信号）；余量 ≥5% 只是触发门槛。
    const suggested = Math.ceil(used / 100) * 100;
    if (left >= Math.ceil(entry.budget * 0.05) && suggested < entry.budget) {
      note.push(`${entry.path} 比预算低 ${left} 字，可把 budget 降到 ${suggested} 锁住这次精简`);
    }
  }
}

console.log('');
console.log('路径合计（一次会话真正付的量）');
console.log(''.padEnd(70, '-'));
for (const group of manifest.paths || []) {
  let total = 0;
  let missing = false;
  for (const rel of group.files) {
    const used = weigh(rel);
    if (used === null) { missing = true; continue; }
    total += used;
  }
  if (missing) continue;
  const left = group.budget - total;
  console.log(`  ${String(total).padStart(6)} / ${String(group.budget).padStart(6)} ${String(left).padStart(6)}  ${group.label}  [${left < 0 ? 'OVER' : 'ok'}]`);
  if (left < 0) {
    fail.push(`路径「${group.label}」超预算 ${-left} 字（${total} > ${group.budget}）`);
  }
}

if (note.length) {
  console.log('');
  console.log('提示（不阻断）：');
  for (const n of note) console.log(`  - ${n}`);
}

if (dumpOnly) {
  console.log('');
  console.log('Result: --dump 模式，不判定');
  process.exit(0);
}

if (fail.length) {
  console.log('');
  console.log('FAIL: 热路径文档超预算');
  for (const f of fail) console.log(`  - ${f}`);
  console.log('');
  console.log('处理顺序：① 先找同一文件里能删的旧文本（重复指令、已被脚本确定性拦住的规则、');
  console.log('设计理由旁白、只在极少数场景才用得上的分支），删等量再提交；');
  console.log('② 确实是必须加的新规则，就在 scripts/doc-budget.json 调高 budget，');
  console.log('并在提交说明里写清为什么这段值得每个用户每次会话都付。');
  process.exit(1);
}

console.log('');
console.log('Result: 热路径文档预算检查通过');
