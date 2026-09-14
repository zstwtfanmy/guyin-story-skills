#!/usr/bin/env node
'use strict';

// guyin-check-trial-gate.js — 真人试读门（Fw-06，docs/12 整改计划）
//
// 事故根因：追影开篇三章在框架内自证（细纲槽位/章检/自检卡）全链路闭环，却没有任何
// 一次「活人不看设定直接读」的外部校验——主角被动、对话零信息这类问题，机器指标只能
// 给启发式信号，真人三问（想不想看下一章/记住了谁/想划下来的句子）一眼可见。本脚本把
// 「ch003 落盘后、ch004 开写前必须有一次真人试读」接成机械门。
//
// 输入：<root>/追踪/读者信号.md 的「## 试读记录」表（模板预置，列位即协议）：
//   | 日期 | 试读人 | 章范围 | 想不想看下一章 | 记住了谁 | 想划下来的句子 |
//   | 能力实证 | 当下目标 | 情绪热度 | 我猜对了 |
//   章范围支持：1-3 / 1~3 / 1至3 / 1,2,3 / 单章 3；多行区间取并集。
//
// 机械口径（只查覆盖，不评答案质量——三问怎么答是作者的事）：
//   - N<4：静默（ch1-3 写作期不需要试读；试读发生在 ch3 落盘之后）
//   - N≥4：所有试读行章范围并集未完整覆盖 ch1-3 → blocking（trial-gate-missing）
//   - 其上：最近试读覆盖末端 < N-3 → advisory（trial-gate-stale，每约 3 章该有一次新试读）
//   - 试读人列为空的行不计入覆盖（无法证明是真人试读）；{{占位}} 行跳过
//
// fail-open：读者信号.md 缺失 → exit 0（老项目/未部署模板）；文件在但无「试读记录」节
// 或表内无有效行 → 按未试读判（模板已部署而不填，正是本门要拦的）。
// Report-only，永不改写。

const fs = require('fs');
const path = require('path');

const USAGE = `Usage: node guyin-check-trial-gate.js --project <book-root> --chapter N [--json] [--fail-on=blocking|all]

Real-reader trial gate (Fw-06, docs/12):
  Reads 追踪/读者信号.md §试读记录. Before writing chapter N:
    N<4            silent
    N>=4, no trial rows covering ch1-3 (union) -> blocking trial-gate-missing
    latest coverage end < N-3                  -> advisory trial-gate-stale
  Missing 读者信号.md -> exit 0 (fail-open); section/table present but empty -> blocking.
--fail-on=blocking (default) exits 1 only on blocking; --fail-on=all includes advisory.`;

const options = { json: false, failOn: 'blocking', project: null, chapter: null };

function die(message) {
  console.error(message);
  console.error(USAGE.trimEnd());
  process.exit(2);
}

for (let i = 2; i < process.argv.length; i += 1) {
  const arg = process.argv[i];
  if (arg === '--json') {
    options.json = true;
  } else if (arg.startsWith('--fail-on=')) {
    const v = arg.slice('--fail-on='.length);
    if (v !== 'blocking' && v !== 'all') die("--fail-on must be 'blocking' or 'all'");
    options.failOn = v;
  } else if (arg === '--project') {
    options.project = process.argv[i + 1];
    if (options.project === undefined) die('--project requires a value');
    i += 1;
  } else if (arg.startsWith('--project=')) {
    options.project = arg.slice('--project='.length);
  } else if (arg === '--chapter') {
    const v = process.argv[i + 1];
    if (v === undefined || !/^\d+$/.test(v)) die('--chapter requires a chapter number');
    options.chapter = Number(v);
    i += 1;
  } else if (arg.startsWith('--chapter=')) {
    const v = arg.slice('--chapter='.length);
    if (!/^\d+$/.test(v)) die('--chapter must be a chapter number');
    options.chapter = Number(v);
  } else if (arg === '-h' || arg === '--help') {
    process.stdout.write(`${USAGE}\n`);
    process.exit(0);
  } else if (arg.startsWith('-')) {
    die(`Unknown option: ${arg}`);
  } else {
    die(`Unexpected argument: ${arg}`);
  }
}

if (!options.project) die('--project is required (project root containing 追踪/)');
if (options.chapter === null) die('--chapter is required (chapter about to be written)');

const signalPath = path.join(path.resolve(options.project), '追踪', '读者信号.md');

let text;
try {
  text = fs.readFileSync(signalPath, 'utf8');
} catch (error) {
  if (options.json) {
    process.stdout.write(`${JSON.stringify({ findings: [], missing: true }, null, 2)}\n`);
  } else {
    console.log(`trial-gate: no 读者信号.md (fail-open)`);
  }
  process.exit(0);
}

const findings = [];
const lines = text.split(/\r?\n/);

// 定位「试读记录」节（# 级标题起始，到下一个同级或更高级标题为止；至少取到文末）。
function locateSection() {
  let start = -1;
  let level = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^(#{1,6})\s*试读记录[\s:：]*$/.exec(lines[i].trim());
    if (m) { start = i; level = m[1].length; break; }
  }
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    const m = /^(#{1,6})\s*\S/.exec(lines[i].trim());
    if (m && m[1].length <= level) { end = i; break; }
  }
  return { startLine: start + 1, endLine: end };
}

// 章范围 → 章号数组：按 , ， 、 ; ； 分段，每段 1 个数字=单章；
// 2 个数字且中间是连接符（- – — ~ ～ 至 到）=闭区间。解析不了返回 []。
function parseRange(cell) {
  const out = new Set();
  for (const part of cell.split(/[,，、;；\s]+/).filter(Boolean)) {
    const nums = (part.match(/\d+/g) || []).map(Number);
    if (nums.length === 1) {
      out.add(nums[0]);
    } else if (nums.length === 2 && /[-–—~～至到]/.test(part) && nums[0] <= nums[1]) {
      for (let c = nums[0]; c <= nums[1]; c += 1) out.add(c);
    }
  }
  return [...out];
}

const section = locateSection();
const covered = new Set();
let tableSeen = false;

if (section) {
  for (let i = section.startLine; i < section.endLine; i += 1) { // 1-based 行号遍历
    const t = lines[i - 1] && lines[i - 1].trim();
    if (!t || !t.startsWith('|')) continue;
    if (t.includes('{{')) continue;
    if (/^[-|:\s]+$/.test(t)) continue;
    const cells = t.split('|').map((c) => c.trim());
    if (cells.length < 4) continue;
    if (/章范围/.test(t)) continue; // 表头行
    tableSeen = true;
    // 固定列位协议：cells[1]=日期 cells[2]=试读人 cells[3]=章范围。
    const reader = cells[2] || '';
    const range = cells[3] || '';
    if (!reader) continue; // 无试读人＝无法证明真人试读，不计覆盖
    for (const c of parseRange(range)) covered.add(c);
  }
}

const N = options.chapter;
if (N >= 4) {
  const missingChs = [1, 2, 3].filter((c) => !covered.has(c));
  if (!section || !tableSeen || missingChs.length > 0) {
    const anchor = section ? section.startLine : 1;
    const detail = !section
      ? '「追踪/读者信号.md」无「## 试读记录」节'
      : (tableSeen
        ? `现有试读未覆盖 ch ${missingChs.join('、')}（须覆盖 ch1-3 全部）`
        : '「试读记录」节内无有效试读行');
    findings.push({
      file: signalPath,
      line: anchor,
      column: 1,
      type: 'trial-gate-missing',
      severity: 'blocking',
      message: `写第${N}章前缺真人试读：${detail}——找一个没读过设定/细纲的人直读 ch1-3，回填三问（想不想看下一章·记住了谁·想划下来的句子）与获得四项（Fw-06）`,
      excerpt: (lines[anchor - 1] || '').trim().slice(0, 60),
    });
  } else {
    // 首试读合格后，每约 3 章提醒一次新试读：覆盖末端须 ≥ N-3。
    const maxEnd = covered.size > 0 ? Math.max(...covered) : 0;
    if (maxEnd < N - 3) {
      findings.push({
        file: signalPath,
        line: section.startLine,
        column: 1,
        type: 'trial-gate-stale',
        severity: 'advisory',
        message: `试读已滞后：最近试读只覆盖到第${maxEnd}章，开写第${N}章前建议补一次近章试读（每约 3 章一次活人反馈，Fw-06）`,
        excerpt: (lines[section.startLine - 1] || '').trim().slice(0, 60),
      });
    }
  }
}

if (options.json) {
  process.stdout.write(`${JSON.stringify({ findings, chapter: N }, null, 2)}\n`);
} else if (findings.length > 0) {
  for (const f of findings) {
    console.log(`${f.file}:${f.line}:${f.column}: [${f.severity}] ${f.type}: ${f.message}`);
  }
} else if (N >= 4) {
  console.log(`trial-gate: ch1-3 trial coverage present (latest covers ch${covered.size ? Math.max(...covered) : 0})`);
}

const hasBlocking = findings.some((f) => f.severity === 'blocking');
if (options.failOn === 'blocking' ? hasBlocking : findings.length > 0) process.exit(1);
