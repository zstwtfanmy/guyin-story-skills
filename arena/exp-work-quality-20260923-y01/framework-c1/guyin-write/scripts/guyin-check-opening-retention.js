#!/usr/bin/env node
'use strict';

// guyin-check-opening-retention.js — 开篇留存门（Fw-01，docs/12；四组化，任务书 §2.1）
//
// 事故根因：追影 ch001-003 细纲没有任何「主角当下要干什么/凭什么看得下去」的运行时槽位，
// 主角目标是内向的「确认自己回到了什么时候」，开篇三章无外向抓手，留存设计全靠作者临场。
// 本脚本把开篇入口声明接成落盘硬门。
//
// 仅对文件名 细纲_第00N章（N=1-3）生效；其余章号静默 exit 0（黄金三章契约不外推）。
// 四组化后开篇附加不设独立字段：第一组「读者承诺」行承担入口声明责任，行值写全三件
// 事——当下目标（外向可执行）/ 入口体验（凭什么读下去）/ 近期回报（前三章整体至少
// 兑现或明确指向一笔，不强迫每章造钩子）。机械只查（字段定义唯一权威在
// references/细纲协议.md「开篇附加」节）：
//
//   outline-opening-promise-missing (hard)  ch001-003 第一组区块内「读者承诺」行
//                                缺失、空值、「无」或 {{占位}}
//
// 语义质量（目标是否外向、体验是否真成立、回报是否落在窗口内）留给审读，不机械判定。
//
// 旧格式兼容（存量不追溯）：细纲含四留存字段（当下目标/能力实证/情绪温度/即兑钩子）
// 任一字段行，视为已满足——Fw-01 原格式是合法历史格式，跳过新检查；JSON 输出记
// legacy_four_fields: true，非 JSON 模式打一行提示。修订该章细纲时并入四组。
//
// 存量策略：只拦新建/修订 ch001-003 细纲的落盘门，存量章不追溯（同 outline-slots）。
// Report-only，永不改写——报警一律拦为待审，补字段后重检，同其他检查脚本。

const fs = require('fs');
const path = require('path');

const handling = require('./lib/guyin-handling');

const USAGE = `Usage: node guyin-check-opening-retention.js [--json] [--fail-on=block|hard|all] <细纲文件...>

Golden-three-chapters opening gate (Fw-01, docs/12; four-group contract, 任务书 §2.1):
  Only active for 细纲_第00N章 with N=1-3; other chapters pass silently.
  hard outline-opening-promise-missing:
    - the 第一组「读者承诺」 line missing, empty, 「无」, or {{placeholder}}
      (the line carries the opening entry declaration — 当下目标/入口体验/近期回报;
       semantic quality is enforced by review, not here)
  Legacy compat: outlines still carrying any of the four retention fields
    (当下目标/能力实证/情绪温度/即兑钩子) are honored as legal history —
    check skipped, JSON records legacy_four_fields: true.
Field semantics live in references/细纲协议.md §开篇附加; semantic quality
(外向目标/真体验) is enforced by review, not here.
Exit codes: 0 = 无未决阻断; 1 = 存在未决阻断（hard/verify，补字段/豁免后解除）;
  2 = 执行/输入错误。--fail-on=block（默认）hard+verify 计 1; hard 仅 hard; all 含 editorial（审计模式）。`;

const options = { json: false, failOn: 'block', inputs: [] };

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
    try {
      options.failOn = handling.parseFailOn(arg.slice('--fail-on='.length));
    } catch (e) {
      die(e.message);
    }
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

// 旧格式四留存字段（Fw-01 原格式）：任一字段行在场 → 存量合法，跳过新检查（不追溯）。
// 认字段行形态（- 字段名：值），正文值里偶尔提及词名不算。
const LEGACY_FIELD_RE = /[-*]\s*(当下目标|能力实证|情绪温度|即兑钩子)\s*[：:]/;

// 第一组区块标题（与 outline-slots 四组检查同口径宽松匹配）。
const GROUP1_RE = /#{2,6}\s*[一二三四1-4]\s*[、.．]?\s*本章要交付什么/;

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

// 第一组区块内的「读者承诺」行：区块起点（标题行下一行）到下一标题行为止。
// 区块标题缺失时退化为全文查找——结构缺失归 outline-slots 拦，本脚本只管承诺行在不在。
function promiseLine(lines) {
  const start = lines.findIndex((l) => GROUP1_RE.test(l));
  if (start === -1) return firstLineWith(lines, (l) => l.includes('读者承诺'));
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^#{1,6}\s/.test(lines[i])) break; // 区块到下一标题为止
    if (lines[i].includes('读者承诺')) return { text: lines[i], line: i + 1 };
  }
  return null;
}

function scanOpening(text) {
  const findings = [];
  const lines = text.split(/\r?\n/);

  const legacy = lines.some((l) => LEGACY_FIELD_RE.test(l));
  if (legacy) return { findings, legacy };

  const push = (line, message) => {
    findings.push({
      line,
      column: 1,
      type: 'outline-opening-promise-missing',
      severity: 'blocking',
      message,
      excerpt: (lines[line - 1] || '').trim().slice(0, 60),
    });
  };

  const hit = promiseLine(lines);
  if (!hit) {
    push(1, '开篇入口声明缺失：第一组区块内无「读者承诺」行（仅 ch001-003 blocking）——行值写全当下目标/入口体验/近期回报三件事（写产生体验的处境与行动，不填情绪词、不写口号；前三章整体至少兑现或明确指向一笔，不强迫每章造钩子）；字段定义见 references/细纲协议.md「开篇附加」（Fw-01/任务书 §2.1）');
    return { findings, legacy };
  }
  const value = fieldValue(hit.text, '读者承诺');
  if (!valueFilled(value)) {
    push(hit.line, '开篇入口声明未填实（空值/「无」/{{占位}} 均判缺失）——读者承诺行承担开篇入口声明：当下目标/入口体验/近期回报（Fw-01/任务书 §2.1）');
  }
  return { findings, legacy };
}

const allFindings = [];
let failed = false;
const legacyFiles = [];

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

  const { findings, legacy } = scanOpening(text);
  allFindings.push(...findings.map((f) => ({ file: input, ...f })));
  if (legacy) legacyFiles.push(input);
}

try {
  handling.finalizeFindings(allFindings, 'guyin-check-opening-retention');
} catch (e) {
  die(e.message);
}

if (options.json) {
  const payload = { findings: allFindings };
  if (legacyFiles.length > 0) payload.legacy_four_fields = true;
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
} else {
  for (const f of allFindings) {
    console.log(`${f.file}:${f.line}:${f.column}: [${handling.label(f)}] ${f.type}: ${f.message}`);
  }
  for (const file of legacyFiles) {
    console.log(`opening-retention: ${file} 为旧格式细纲（四留存字段在场）——合法历史格式，存量不追溯，跳过读者承诺检查`);
  }
  if (allFindings.length === 0 && !failed) {
    console.log(`opening-retention: ${options.inputs.length} file(s) checked, golden-three opening promise present`);
  }
}

if (failed) process.exit(2);
process.exit(handling.gateTripped(allFindings, options.failOn) ? 1 : 0);
