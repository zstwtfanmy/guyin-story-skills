#!/usr/bin/env node
'use strict';

// guyin-check-pending.js — 待审台账终态门（U1，docs/09-收尾闭环与批次公约加固计划.md §二）
//
// 根因五「检测-消费断链」的封堵：章检报警"拦为待审"不再只是话术——每个 finding 一行
// 台账（追踪/待审台账.md），终态五选一（修复/豁免/契约修订/顺延/升级作者），无第六态。
// 本脚本机械查台账：未终态行（终态=「待审」或空）存在即 exit 1；--through N 只查
// 章号 ≤N 的行（批收尾核对用）。
//
//   - 台账缺失 → exit 0（fail-open：老项目/未部署模板不误伤；模板 create-if-absent 部署）
//   - {{...}} 占位行跳过（未实例化模板行）；分隔行/表头行/章号解析失败行跳过
//   - Report-only，永不改写——终态由消费动作（改写卡/豁免/偏差登记）回填，不由本脚本
//
// 表格契约：| 章号 | 来源 | 报警/发现 | 终态 | 去向/备注 |——列位即协议，模板与脚本同源。
// 同步注释契约（U1/D2）：本脚本与 guyin-setup 模板 hook（templates/long/.claude/hooks/
// guyin-hook.js 的 pendingBlockers）是同一解析逻辑的两份实现——hook 为部署件随项目走、
// 脚本在技能库，运行时路径不保证可达，无法抽公共模块；改一处必改另一处
// （列位/终态判定/占位跳过/章号口径）。

const fs = require('fs');

const USAGE = `Usage: node guyin-check-pending.js [--json] [--through N] <待审台账.md>

Pending findings terminal-state gate (docs/09 §二 U1):
  Parses 追踪/待审台账.md rows: | 章号 | 来源 | 报警/发现 | 终态 | 去向/备注 |
  A row is open when 终态 is 待审 or empty. Any open row → exit 1.
  --through N: check only rows whose chapter number <= N (batch close-out).
  Missing ledger → exit 0 (fail-open; template deploys create-if-absent).
Report-only: terminal states are filled by consumption (rewrite card /
exemption / deviation log), never by this script.`;

const options = { json: false, through: null, input: null };

function die(message) {
  console.error(message);
  console.error(USAGE.trimEnd());
  process.exit(2);
}

for (let i = 2; i < process.argv.length; i += 1) {
  const arg = process.argv[i];
  if (arg === '--json') {
    options.json = true;
  } else if (arg === '--through') {
    const v = process.argv[i + 1];
    if (v === undefined || !/^\d+$/.test(v)) die('--through requires a chapter number');
    options.through = Number(v);
    i += 1;
  } else if (arg.startsWith('--through=')) {
    const v = arg.slice('--through='.length);
    if (!/^\d+$/.test(v)) die('--through must be a chapter number');
    options.through = Number(v);
  } else if (arg === '-h' || arg === '--help') {
    process.stdout.write(`${USAGE}\n`);
    process.exit(0);
  } else if (arg.startsWith('-')) {
    die(`Unknown option: ${arg}`);
  } else if (options.input === null) {
    options.input = arg;
  } else {
    die('Exactly one ledger file expected');
  }
}

if (options.input === null) die('No ledger file provided');

// 台账解析：表格行按 | 分列取位（cells[1]=章号, cells[4]=终态）。
// 跳过：非 | 行、{{...}} 占位行、分隔行（---）、章号列无数字行（表头自然落此）。
// 与 hook pendingBlockers 同口径（同步注释契约 U1/D2）。
function parseLedger(text) {
  const rows = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const t = lines[i].trim();
    if (!t.startsWith('|')) continue;
    if (t.includes('{{')) continue; // 未实例化模板行
    if (/^[-|:\s]+$/.test(t)) continue; // |---|---| 分隔行
    const cells = t.split('|').map((c) => c.trim());
    if (cells.length < 6) continue; // 不足五列不是数据行
    const chMatch = /(\d+)/.exec(cells[1]);
    if (!chMatch) continue; // 表头/章号缺失行
    const state = cells[4] || '';
    rows.push({
      line: i + 1,
      chapter: parseInt(chMatch[1], 10),
      source: cells[2],
      finding: cells[3],
      state: state === '' ? '（空）' : state,
      open: state === '' || state === '待审',
    });
  }
  return rows;
}

let text;
try {
  text = fs.readFileSync(options.input, 'utf8');
} catch (error) {
  // fail-open：台账缺失 = 无报警历史（老项目/未部署模板），放行且提示。
  if (options.json) {
    process.stdout.write(`${JSON.stringify({ open: [], total: 0, missing: true }, null, 2)}\n`);
  } else {
    console.log(`pending: no ledger at ${options.input} (fail-open)`);
  }
  process.exit(0);
}

const rows = parseLedger(text);
const scoped = options.through === null ? rows : rows.filter((r) => r.chapter <= options.through);
const open = scoped.filter((r) => r.open);

if (options.json) {
  process.stdout.write(`${JSON.stringify({ open, total: scoped.length }, null, 2)}\n`);
} else {
  for (const r of open) {
    console.log(`${options.input}:${r.line}: [open] 第${r.chapter}章 ${r.source}: ${r.finding}（终态=${r.state}）——消费后回填：修复/豁免/契约修订/顺延/升级作者`);
  }
  if (open.length === 0) {
    console.log(`pending: ${scoped.length} row(s) all terminal${options.through === null ? '' : ` (through ch${options.through})`}`);
  }
}

process.exit(open.length > 0 ? 1 : 0);
