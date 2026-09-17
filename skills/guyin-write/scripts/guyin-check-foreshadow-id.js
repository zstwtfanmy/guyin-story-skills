#!/usr/bin/env node
'use strict';

// guyin-check-foreshadow-id.js — 伏笔编号台账机械校验（Fw-09 C2，docs/12 批次 C）
//
// 追影实证需求：追踪/伏笔.md 是 tracking-commit 事务维护的人类可读视图，手改与合并会产生
//   重号（两个 F007 指不同事）、空号（数据行无 ID）、以及正文/大纲里引用了台账没登记的 F 号。
// 语义（伏笔是否回收、回收章对不对）归 tracking-commit 与 outline-deliver；本脚本只做编号会计：
//
//   hard   foreshadow-duplicate-id          同一 F 号在台账出现多行
//   hard   foreshadow-empty-id              台账数据行（非表头/分隔/{{占位}}）无任何 F 编号
//   verify foreshadow-ref-unregistered      正文/*.md 或 大纲/细纲_*.md 引用了台账未登记的 F 号
//
// 编号空间注意：大纲/ 下的规划文件（伏笔规划台账/总纲/卷纲，含「待埋」未来编号）本身是
// 编号登记源，不扫；只扫 正文/ 全部 .md 与 大纲/细纲_第NNN章.md——细纲提及未埋设编号时报
// advisory 由作者判读（本章埋设 vs 规划性提及），机械门只负责把不一致摆上台面。
//
// 兼容两种台账列序（setup 模板 6 列「编号」开头 / 追影 8 列「ID」开头）：不绑列号，
// 在每行 cells 里寻找 F 编号；追踪视图与 .workbuddy 不扫。
//
// 台账文件缺失、或表中无任何数据行（空项目/模板态）→ 静默 exit 0（fail-open）。
// 处置分类（lib/guyin-handling）：empty/duplicate-id=hard（编号工程错误）；ref-unregistered=
// verify（悬空引用，须核实是笔误还是漏登记）。--fail-on=block（默认）hard+verify 任一即
// exit 1（进待审台账，登记/修复/豁免后解除）；--fail-on=all 为审计模式。Report-only。

const fs = require('fs');
const path = require('path');

const handling = require('./lib/guyin-handling');

const USAGE = `Usage: node guyin-check-foreshadow-id.js --project <book-root> [--json] [--fail-on=block|hard|all]

Foreshadow ID ledger gate (Fw-09 C2):
  hard   foreshadow-duplicate-id       duplicate F-id rows in 追踪/伏笔.md
  hard   foreshadow-empty-id           ledger data row without F-id
  verify foreshadow-ref-unregistered   F-id referenced in 正文/ or 大纲/细纲_*.md but not registered
                                       (planning ledgers/总纲/卷纲 are registration sources, not scanned)
  Missing ledger / no data rows -> silent exit 0 (fail-open).
Exit codes: 0 = 无未决阻断; 1 = 存在未决阻断（hard/verify，进待审台账——登记/修复/豁免后解除）;
  2 = 执行/输入错误。--fail-on=block（默认）hard+verify 计 1; hard 仅 hard; all 含 editorial（审计模式）。`;

const options = { json: false, failOn: 'block', project: null };

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
  } else if (arg === '--project') {
    options.project = process.argv[i + 1];
    if (options.project === undefined) die('--project requires a value');
    i += 1;
  } else if (arg.startsWith('--project=')) {
    options.project = arg.slice('--project='.length);
  } else if (arg === '-h' || arg === '--help') {
    process.stdout.write(`${USAGE}\n`);
    process.exit(0);
  } else if (arg.startsWith('-')) {
    die(`Unknown option: ${arg}`);
  } else {
    die(`Unexpected argument: ${arg}`);
  }
}

if (!options.project) die('--project is required (project root)');

const root = path.resolve(options.project);
const ledgerPath = path.join(root, '追踪', '伏笔.md');

const findings = [];

// F 编号：F + 2-4 位数字（F01 / F001 / F0001），规范化为 F+三位补零
const ID_PATTERN = /\bF0*(\d{1,4})\b/g;
function normId(raw) {
  const m = /^F0*(\d{1,4})$/i.exec(raw.trim());
  if (!m) return null;
  return `F${Number(m[1]).toString().padStart(3, '0')}`;
}
function findIdsInLine(line) {
  const ids = [];
  let m;
  ID_PATTERN.lastIndex = 0;
  while ((m = ID_PATTERN.exec(line)) !== null) {
    ids.push(`F${Number(m[1]).toString().padStart(3, '0')}`);
  }
  return ids;
}

const registered = new Set();
let dataRows = 0;

if (fs.existsSync(ledgerPath)) {
  const lines = fs.readFileSync(ledgerPath, 'utf8').split(/\r?\n/);
  const seen = new Map(); // id -> first line
  for (let i = 0; i < lines.length; i += 1) {
    const t = lines[i].trim();
    if (!t.startsWith('|')) continue;
    if (t.includes('{{')) continue;
    if (/^[-|:\s]+$/.test(t)) continue; // 分隔行
    const cells = t.split('|').map((c) => c.trim());
    if (cells.length < 6) continue; // 不像台账行
    // 表头行：首数据列为 ID/编号 字样
    if (/^(ID|编号)$/i.test(cells[1] || '')) continue;

    const ids = [];
    for (const c of cells) {
      const id = normId(c);
      if (id) ids.push(id);
    }

    if (ids.length === 0) {
      dataRows += 1;
      findings.push({
        file: ledgerPath,
        line: i + 1,
        column: 1,
        type: 'foreshadow-empty-id',
        severity: 'advisory',
        message: '伏笔台账数据行无 F 编号——手改/合并漏号，补编号或删行（Fw-09 C2）',
        excerpt: t.slice(0, 80),
      });
      continue;
    }

    dataRows += 1;
    for (const id of ids) {
      if (seen.has(id)) {
        findings.push({
          file: ledgerPath,
          line: i + 1,
          column: 1,
          type: 'foreshadow-duplicate-id',
          severity: 'advisory',
          message: `伏笔编号 ${id} 重号（首见第 ${seen.get(id)} 行）——同一编号不得指两件事，先在台账仲裁重编再提交（Fw-09 C2）`,
          excerpt: t.slice(0, 80),
        });
      } else {
        seen.set(id, i + 1);
      }
      registered.add(id);
    }
  }
}

// 引用未登记：扫 正文/ 全部 .md 与 大纲/ 下细纲_*.md（规划台账/总纲/卷纲是编号登记源，不扫；
// 台账本身在 追踪/，不扫；.workbuddy 等临时目录不扫）
if (dataRows > 0) {
  const scanJobs = [];
  const proseDir = path.join(root, '正文');
  const outlineDir = path.join(root, '大纲');
  for (const [dir, filter] of [
    [proseDir, () => true],
    [outlineDir, (name) => /^细纲_.*\.md$/.test(name)],
  ]) {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      continue; // 目录缺失（空项目）→ 跳过
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      if (entry.name.startsWith('_')) continue; // _archive 等
      if (!filter(entry.name)) continue;
      scanJobs.push(path.join(dir, entry.name));
    }
  }
  for (const file of scanJobs) {
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      const ids = findIdsInLine(lines[i]);
      if (ids.length === 0) continue;
      for (const id of ids) {
        if (!registered.has(id)) {
          findings.push({
            file,
            line: i + 1,
            column: 1,
            type: 'foreshadow-ref-unregistered',
            severity: 'advisory',
            message: `引用伏笔 ${id} 但 追踪/伏笔.md 未登记——先补登记（或改引用），悬空编号不得进正文/细纲（Fw-09 C2）`,
            excerpt: lines[i].trim().slice(0, 80),
          });
        }
      }
    }
  }
}

try {
  handling.finalizeFindings(findings, 'guyin-check-foreshadow-id');
} catch (e) {
  die(e.message);
}

if (options.json) {
  process.stdout.write(`${JSON.stringify({ findings, registered: [...registered].sort() }, null, 2)}\n`);
} else if (findings.length > 0) {
  for (const f of findings) {
    console.log(`${f.file}:${f.line}:${f.column}: [${handling.label(f)}] ${f.type}: ${f.message}`);
  }
} else if (dataRows === 0) {
  console.log('foreshadow-id: no ledger data rows (silent)');
} else {
  console.log(`foreshadow-id: ${registered.size} registered, no id conflicts`);
}

process.exit(handling.gateTripped(findings, options.failOn) ? 1 : 0);
