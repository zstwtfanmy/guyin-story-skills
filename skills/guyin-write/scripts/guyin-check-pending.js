#!/usr/bin/env node
'use strict';

// guyin-check-pending.js — 待审台账终态门（U1，docs/09 §二；v3-A1 终态扩六）
//
// 根因五「检测-消费断链」的封堵：章检报警"拦为待审"不再只是话术——每个 finding 一行
// 台账（追踪/待审台账.md），终态六选一（修复/豁免/契约修订/顺延/升级作者/不适用）。
// 本脚本机械查台账：未终态行存在即 exit 1；--through N 只查章号 ≤N 的行（批收尾核对用）。
//
// Fw-07（docs/12）：「升级作者」不是自终态——终态列写了升级作者，备注列还必须有
// 作者回填「已裁决：＋结论内容」（转豁免/关闭/改写等）才算闭环；只写「已裁决：」
// 冒号后无内容的仍 open（v3-A1：不能只写冒号）。
// v3-A1（任务书 §4 A1）：新增终态「不适用」——确认的误报/有功能写法走此终态，
// 备注必须含原文位置（章/行/段/L 号）与判定理由，缺证据不关闭；不消耗每卷艺术豁免
// 名额（豁免五测试名额只属于「豁免」）。未知终态值（六种之外的字串）一律视为未终态
// ——不再「任意字串都算关闭」；真正违反已确认契约仍走修复/契约修订/豁免，不借
// 「不适用」逃避。所有路径不删历史行。
//
//   - 台账缺失 → exit 0（fail-open：老项目/未部署模板不误伤；模板 create-if-absent 部署）
//   - {{...}} 占位行跳过（未实例化模板行）；分隔行/表头行/章号解析失败行跳过
//   - Report-only，永不改写——终态由消费动作（改写卡/豁免/偏差登记/作者裁决回填），不由本脚本
//
// 表格契约：| 章号 | 来源 | 报警/发现 | 终态 | 去向/备注 |——列位即协议，模板与脚本同源。
// 同步注释契约（U1/D2）：本脚本与 guyin-setup 模板 hook（templates/long/.claude/hooks/
// guyin-hook.js 的 pendingBlockers）是同一解析逻辑的两份实现——hook 为部署件随项目走、
// 脚本在技能库，运行时路径不保证可达，无法抽公共模块；改一处必改另一处
// （列位/终态判定/占位跳过/章号口径；终态六选一与「不适用」证据规则两处同改）。

const fs = require('fs');

const USAGE = `Usage: node guyin-check-pending.js [--json] [--through N] <待审台账.md>

Pending findings terminal-state gate (docs/09 §二 U1; docs/12 Fw-07; v3-A1):
  Parses 追踪/待审台账.md rows: | 章号 | 来源 | 报警/发现 | 终态 | 去向/备注 |
  A row is open when 终态 is 待审/empty, is NOT one of the six terminal states
  (修复/豁免/契约修订/顺延/升级作者/不适用), OR the state's evidence rule fails:
    - 升级作者: 备注 must contain 「已裁决：content」 (colon-only backfill stays open)
    - 不适用 (v3-A1): 备注 must contain a source position (章/行/段/L 号) AND a
      reason; position alone or empty note stays open
  --through N: check only rows whose chapter number <= N (batch close-out).
  Missing ledger → exit 0 (fail-open; template deploys create-if-absent).
Report-only: terminal states are filled by consumption (rewrite card /
exemption / deviation log / author adjudication / confirmed false-positive),
never by this script.`;

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

// 台账解析：表格行按 | 分列取位（cells[1]=章号, cells[4]=终态, cells[5]=去向/备注）。
// 跳过：非 | 行、{{...}} 占位行、分隔行（---）、章号列无数字行（表头自然落此）。
// 与 hook pendingBlockers 同口径（同步注释契约 U1/D2）。
//
// v3-A1 终态判定（六选一）：
//   - 空/待审 = open；
//   - 六种终态（修复/豁免/契约修订/顺延/升级作者/不适用）之外的字串 = open（未知值不关闭）；
//   - 「升级作者」：备注须回填「已裁决：＋内容」（只写冒号仍 open，Fw-07）；
//   - 「不适用」：备注须含原文位置（第N章/LN/行N/段N 等数字锚点）与理由
//     （去掉位置标记后 ≥6 字），缺证据 = open——不适用不是逃避通道。
// 注意：此函数与 hook 内同名同构逻辑是两份实现，改此必改彼（U1/D2 同步契约）。
const TERMINAL_STATES = ['修复', '豁免', '契约修订', '顺延', '升级作者', '不适用'];

function hasSourcePosition(note) {
  return /(第\s*0*\d+\s*章|L\s*0*\d+|\d+\s*[行段]|行\s*\d+|段\s*\d+|:\s*0*\d+)/i.test(note);
}

function notApplicableEvidence(note) {
  const n = (note || '').trim();
  if (!n || !hasSourcePosition(n)) return false;
  const reason = n.replace(/(第\s*0*\d+\s*章|L\s*0*\d+|\d+\s*[行段]|行\s*\d+|段\s*\d+|:\s*0*\d+)/gi, '').replace(/\s/g, '');
  return reason.length >= 6;
}

function rowIsOpen(state, note) {
  if (state === '' || state === '待审') return true;
  if (!TERMINAL_STATES.some((t) => state.includes(t))) return true; // v3-A1：未知终态值保持 open
  if (/升级作者/.test(state) && !/已裁决[：:]\s*\S/.test(note || '')) return true;
  if (/不适用/.test(state) && !notApplicableEvidence(note)) return true;
  return false;
}

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
    const note = cells[5] || '';
    rows.push({
      line: i + 1,
      chapter: parseInt(chMatch[1], 10),
      source: cells[2],
      finding: cells[3],
      state: state === '' ? '（空）' : state,
      open: rowIsOpen(state, note),
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
    let hint;
    if (/升级作者/.test(r.state)) {
      hint = '已升级作者但无「已裁决：＋结论」回填——作者给结论后回填备注（转豁免/关闭/改写）';
    } else if (/不适用/.test(r.state)) {
      hint = '「不适用」缺证据——备注须含原文位置（章/行/段/L 号）与判定理由（误报或有功能写法才可用，不消耗豁免名额）';
    } else {
      hint = '消费后回填：修复/豁免/契约修订/顺延/升级作者/不适用（六选一）';
    }
    console.log(`${options.input}:${r.line}: [open] 第${r.chapter}章 ${r.source}: ${r.finding}（终态=${r.state}）——${hint}`);
  }
  if (open.length === 0) {
    console.log(`pending: ${scoped.length} row(s) all terminal${options.through === null ? '' : ` (through ch${options.through})`}`);
  }
}

process.exit(open.length > 0 ? 1 : 0);
