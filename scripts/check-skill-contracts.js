#!/usr/bin/env node
'use strict';

// check-skill-contracts.js — SKILL.md 结构契约检查
//
// 适配自上游 check-current-skill-contracts 思路，按隐笔框架的瘦身纪律收窄为三条：
//   1. frontmatter 齐全：name（guyin- 前缀）/ version（语义化）/ description（单行非空）；
//   2. 总行数 ≤ maxLines（默认 150——阶段一「SKILL.md 瘦身 <150 行」的纪律化）；
//   3. 至少两个 `## ` 段落标题（路由 + 契约类骨架，防空壳化）。
// 结构回归靠脚本兜，不靠评审眼力。

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const MAX_LINES_DEFAULT = 150;

const CONTRACTS = [
  { dir: 'guyin-story', maxLines: MAX_LINES_DEFAULT },
  { dir: 'guyin-write', maxLines: MAX_LINES_DEFAULT },
  { dir: 'guyin-short-write', maxLines: MAX_LINES_DEFAULT },
  { dir: 'guyin-analyze', maxLines: MAX_LINES_DEFAULT },
  { dir: 'guyin-short-analyze', maxLines: MAX_LINES_DEFAULT },
  { dir: 'guyin-review', maxLines: MAX_LINES_DEFAULT },
  { dir: 'guyin-deslop', maxLines: MAX_LINES_DEFAULT },
];

const failures = [];

for (const contract of CONTRACTS) {
  const rel = path.join('skills', contract.dir, 'SKILL.md');
  const abs = path.join(REPO_ROOT, rel);
  const label = `${contract.dir}/SKILL.md`;

  if (!fs.existsSync(abs)) {
    failures.push(`${label}: 文件不存在`);
    continue;
  }

  const raw = fs.readFileSync(abs, 'utf8');
  const lines = raw.split(/\r?\n/);

  // 1. frontmatter
  const fmMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fmMatch) {
    failures.push(`${label}: 缺 YAML frontmatter（--- 块）`);
    continue;
  }
  const fm = fmMatch[1];
  const nameMatch = fm.match(/^name:\s*(\S+)/m);
  const versionMatch = fm.match(/^version:\s*(\S+)/m);
  const descMatch = fm.match(/^description:\s*(.+)$/m);

  if (!nameMatch || !/^guyin-[a-z-]+$/.test(nameMatch[1])) {
    failures.push(`${label}: name 缺失或不符合 guyin- 前缀约定：${nameMatch ? nameMatch[1] : '(none)'}`);
  }
  if (!versionMatch || !/^\d+\.\d+\.\d+$/.test(versionMatch[1])) {
    failures.push(`${label}: version 缺失或非语义化（x.y.z）：${versionMatch ? versionMatch[1] : '(none)'}`);
  }
  if (!descMatch || descMatch[1].trim().length < 10) {
    failures.push(`${label}: description 缺失或过短（应含触发方式一句话）`);
  }

  // 2. 行数
  if (lines.length > contract.maxLines) {
    failures.push(`${label}: ${lines.length} 行 > 上限 ${contract.maxLines}（瘦身纪律：场景路由+不变式+文件契约，方法论进 references）`);
  }

  // 3. 段落骨架
  const sectionCount = lines.filter((l) => /^##\s/.test(l)).length;
  if (sectionCount < 2) {
    failures.push(`${label}: \`## \` 段落标题不足 2 个（当前 ${sectionCount}）`);
  }

  console.log(`${failures.some((f) => f.startsWith(`${label}:`)) ? 'FAIL' : 'ok  '}  ${label}（${lines.length} 行）`);
}

if (failures.length) {
  console.log('');
  console.log('FAIL: SKILL 契约违反');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}

console.log('');
console.log('Result: SKILL 结构契约检查通过');
