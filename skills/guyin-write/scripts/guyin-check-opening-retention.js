#!/usr/bin/env node
'use strict';

// guyin-check-opening-retention.js — 开篇留存门（Fw-01，docs/12 整改计划）
//
// 事故根因：追影 ch001-003 细纲没有任何「主角当下要干什么/凭什么看得下去」的运行时槽位，
// 主角目标是内向的「确认自己回到了什么时候」，开篇三章无外向抓手、无能力实证、无情绪热度，
// 留存设计全靠作者临场。本脚本把 consult/opening-design.md 的开篇知识
// （主角目标+卖点 / 1000 字内实证 / 三章内基点）接成落盘硬门。
//
// 仅对文件名 细纲_第00N章（N=1-3）生效；其余章号静默 exit 0（黄金三章契约不外推）。
// 四字段（定义唯一权威在 references/细纲协议.md「黄金三章附加契约」节）：
//   当下目标 / 能力实证 / 情绪温度 / 即兑钩子
// 机械口径（只管存在性与兑现章号，语义质量留给自检卡 Q9-Q11）：
//   - 任一字段行缺失，或值为空/「无…」/未渲染占位 {{...}} → blocking（opening-retention-missing）
//   - 即兑钩子行须含近期兑现章号（兑现：第N章，N≤5；行内任意「第N章」兜底解析）；
//     缺失或 N>5 → blocking——禁止三条钩子全长周期
// 存量策略：只拦新建/修订 ch001-003 细纲的落盘门，存量章不追溯（同 outline-slots）。
// Report-only，永不改写——报警一律拦为待审，补字段后重检，同其他检查脚本。

const fs = require('fs');
const path = require('path');

const USAGE = `Usage: node guyin-check-opening-retention.js [--json] [--fail-on=blocking|all] <细纲文件...>

Golden-three-chapters retention gate (Fw-01, docs/12):
  Only active for 细纲_第00N章 with N=1-3; other chapters pass silently.
  blocking opening-retention-missing:
    - any of 当下目标/能力实证/情绪温度/即兑钩子 line missing, empty, 「无」, or {{placeholder}}
    - 即兑钩子 lacks a near-term payoff chapter (兑现：第N章, N<=5)
Field semantics live in references/细纲协议.md §黄金三章附加契约; semantic quality
(外向目标/真热度) is enforced by self-check card Q9-Q11, not here.
--fail-on=blocking exits 1 only on blocking findings; default --fail-on=all exits 1 on any.`;

const options = { json: false, failOn: 'all', inputs: [] };

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
    if (v !== 'blocking' && v !== 'all') die(`--fail-on must be 'blocking' or 'all'`);
    options.failOn = v;
  } else if (arg === '-h' || arg === '--help') {
    process.stdout.write(`${USAGE}\n`);
    process.exit(0);
  } else if (arg.startsWith('-')) {
    die(`Unknown option: ${arg}`);
  } else {
    options.inputs.push(arg);
  }
}

if (options.inputs.length === 0) die('No outline files provided');

// 四留存字段：key=行内标记，hint=缺失/空值时报警文案里的要求。
const RETENTION_FIELDS = [
  {
    key: '当下目标',
    hint: '主角本章外向、可执行、读者可见动作的目标（「确认自己回来了」这类内向状态判不合格）',
  },
  {
    key: '能力实证',
    hint: '一次可被读者指认的事件展示（只展示，禁止解释来源；1000 字内落第一下）',
  },
  {
    key: '情绪温度',
    hint: '本章至少一次 热／怒／笑 的事件落点（纯冷认证不合格）',
  },
  {
    key: '即兑钩子',
    hint: '至少 1 条近期兑现钩子（实体：…；兑现：第N章，N≤5；禁止三条钩子全长周期）',
  },
];
const MAX_PAYOFF_CHAPTER = 5;

function firstLineWith(lines, predicate) {
  for (let i = 0; i < lines.length; i += 1) {
    if (predicate(lines[i])) return { text: lines[i], line: i + 1 };
  }
  return null;
}

// 取「字段名：值」的值；去列表符号与 markdown 粗体。空白/「无」起头/{{占位}} 都算未填。
function fieldValue(line, key) {
  const m = new RegExp(`${key}[：:]\\s*(.*)$`).exec(line);
  if (!m) return '';
  return m[1].replace(/^[-*\s]+/, '').replace(/\*/g, '').trim();
}

function valueFilled(value) {
  if (!value) return false;
  if (/^无/.test(value)) return false;
  if (/\{\{/.test(value)) return false;
  return true;
}

// 即兑钩子兑现章号：优先「兑现：第N章」，没有则取行内任意「第N章」兜底。
// 返回 { chapter, line } 或 null。
function payoffChapter(hookLine) {
  const declared = /兑现[^。\n]{0,12}?第\s*0*(\d+)\s*章/.exec(hookLine);
  if (declared) return Number(declared[1]);
  const any = /第\s*0*(\d+)\s*章/.exec(hookLine);
  return any ? Number(any[1]) : null;
}

function scanRetention(text) {
  const findings = [];
  const lines = text.split(/\r?\n/);

  const push = (line, message) => {
    findings.push({
      line,
      column: 1,
      type: 'opening-retention-missing',
      severity: 'blocking',
      message,
      excerpt: (lines[line - 1] || '').trim().slice(0, 60),
    });
  };

  for (const field of RETENTION_FIELDS) {
    const hit = firstLineWith(lines, (l) => l.includes(field.key));
    if (!hit) {
      push(1, `开篇留存字段「${field.key}」行缺失（仅 ch001-003 blocking）——${field.hint}；字段定义见 references/细纲协议.md「黄金三章附加契约」（Fw-01）`);
      continue;
    }
    const value = fieldValue(hit.text, field.key);
    if (!valueFilled(value)) {
      push(hit.line, `开篇留存字段「${field.key}」未填实（空值/「无」/{{占位}} 均判缺失）——${field.hint}（Fw-01）`);
      continue;
    }
    if (field.key === '即兑钩子') {
      const chapter = payoffChapter(hit.text);
      if (chapter === null) {
        push(hit.line, `即兑钩子缺近期兑现章号（须写「兑现：第N章」，N≤${MAX_PAYOFF_CHAPTER}）——前三章禁止三条钩子全长周期，读者要在前 5 章拿到第一笔兑付（Fw-01）`);
      } else if (chapter > MAX_PAYOFF_CHAPTER) {
        push(hit.line, `即兑钩子兑现章号第 ${chapter} 章 > ${MAX_PAYOFF_CHAPTER}——前三章钩子必须有一笔近期兑付，长周期钩子另放别条（Fw-01）`);
      }
    }
  }

  return findings;
}

const allFindings = [];
let failed = false;

for (const input of options.inputs) {
  const abs = path.resolve(input);
  let text;
  try {
    text = fs.readFileSync(abs, 'utf8');
  } catch (error) {
    failed = true;
    if (!options.json) console.error(`${input}: unable to read (${error.message})`);
    continue;
  }

  // 仅 ch001-003 生效；章号不可解析或非黄金三章 → 静默（契约不外推，fail-open）。
  const chapterMatch = /^细纲_第0*(\d+)章/.exec(path.basename(abs));
  if (!chapterMatch) continue;
  const chapter = Number(chapterMatch[1]);
  if (chapter < 1 || chapter > 3) continue;

  const findings = scanRetention(text).map((f) => ({ file: input, ...f }));
  allFindings.push(...findings);
}

if (options.json) {
  process.stdout.write(`${JSON.stringify({ findings: allFindings }, null, 2)}\n`);
} else {
  for (const f of allFindings) {
    console.log(`${f.file}:${f.line}:${f.column}: [${f.severity}] ${f.type}: ${f.message}`);
  }
  if (allFindings.length === 0 && !failed) {
    console.log(`opening-retention: ${options.inputs.length} file(s) checked, golden-three retention fields present`);
  }
}

if (failed) process.exit(2);
const hasBlocking = allFindings.some((f) => f.severity === 'blocking');
if (options.failOn === 'blocking' ? hasBlocking : allFindings.length > 0) process.exit(1);
