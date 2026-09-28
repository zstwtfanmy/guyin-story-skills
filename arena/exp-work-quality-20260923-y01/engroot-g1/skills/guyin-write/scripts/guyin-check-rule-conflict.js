#!/usr/bin/env node
'use strict';

// guyin-check-rule-conflict.js — 笔法纪律冲突台账门（Fw-04，docs/12 整改计划）
//
// 事故根因：追影项目在模板外自创了 语言纪律.md / 执行层一页纸.md 等笔法文件，条款互相
// 打架（卷纲定「主角嬉皮笑脸」，一页纸禁令「主角不搞笑」），无字段要求、无冲突仲裁，
// 执行层同时收到相反指令。框架不试图让脚本理解语义矛盾——本脚本只做两件机械事：
//
//   1. 项目存在自创笔法文件（作者性/语言纪律.md 或 大纲/执行层一页纸.md）→ 治理激活：
//      作者性/纪律冲突台账.md 缺失 → verify（rule-conflict-ledger-missing）。
//      两件笔法文件都不存在 → 静默（项目无自创笔法，不需要本治理，fail-open）。
//   2. 台账数据行（非 {{占位}}/分隔/表头）「仲裁结论」列（cells[4]）为空或「无」起头
//      → verify（rule-conflict-unadjudicated，附行号）——冲突不过仲裁不得继续堆新纪律。
//
// 处置分类（lib/guyin-handling）：两类均 verify（治理件缺失/未仲裁，须补台账或作者仲裁）。
// --fail-on=block（默认）verify 即 exit 1（进待审台账，仲裁/补台账后解除）；
// --fail-on=all 为审计模式。Report-only，永不改写。

const fs = require('fs');
const path = require('path');

const handling = require('./lib/guyin-handling');

const USAGE = `Usage: node guyin-check-rule-conflict.js --project <book-root> [--json] [--fail-on=block|hard|all]

Self-authored style-rule conflict ledger gate (Fw-04, docs/12):
  Activated only when 作者性/语言纪律.md or 大纲/执行层一页纸.md exists.
  verify rule-conflict-ledger-missing     作者性/纪律冲突台账.md absent while rules exist
  verify rule-conflict-unadjudicated      ledger row with empty 仲裁结论 column
  No style-rule files -> silent exit 0 (fail-open for projects without self-authored rules).
Exit codes: 0 = 无未决阻断; 1 = 存在未决阻断（hard/verify，进待审台账——补台账/仲裁后解除）;
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
const ruleFiles = [
  path.join(root, '作者性', '语言纪律.md'),
  path.join(root, '大纲', '执行层一页纸.md'),
];
const ledgerPath = path.join(root, '作者性', '纪律冲突台账.md');

const findings = [];
const governanceActive = ruleFiles.some((p) => fs.existsSync(p));

if (governanceActive) {
  let text = null;
  try {
    text = fs.readFileSync(ledgerPath, 'utf8');
  } catch (error) {
    findings.push({
      file: ledgerPath,
      line: 1,
      column: 1,
      type: 'rule-conflict-ledger-missing',
      severity: 'advisory',
      message: '项目已有自创笔法文件（语言纪律.md/执行层一页纸.md）但无「作者性/纪律冲突台账.md」——冲突无仲裁位，按 guyin-setup Fw-04 模板建账（开书 Phase C 收尾与每批建批走查）',
      excerpt: '',
    });
  }

  if (text !== null) {
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      const t = lines[i].trim();
      if (!t.startsWith('|')) continue;
      if (t.includes('{{')) continue;
      if (/^[-|:\s]+$/.test(t)) continue;
      if (/冲突双方/.test(t)) continue; // 表头
      const cells = t.split('|').map((c) => c.trim());
      if (cells.length < 7) continue; // 六列协议（首尾空 cell 共 8）
      // cells[1]=编号 cells[2]=冲突双方 cells[3]=冲突实质 cells[4]=仲裁结论 cells[5]=优先级 cells[6]=日期
      const verdict = cells[4] || '';
      if (verdict === '' || /^无/.test(verdict)) {
        findings.push({
          file: ledgerPath,
          line: i + 1,
          column: 1,
          type: 'rule-conflict-unadjudicated',
          severity: 'advisory',
          message: `纪律冲突行${cells[1] ? `（${cells[1]}）` : ''}无仲裁结论——冲突须作者裁决（谁为准/按场拆分/按章型分配）并回填优先级与日期后才闭环（Fw-04）`,
          excerpt: t.slice(0, 80),
        });
      }
    }
  }
}

try {
  handling.finalizeFindings(findings, 'guyin-check-rule-conflict');
} catch (e) {
  die(e.message);
}

if (options.json) {
  process.stdout.write(`${JSON.stringify({ findings, governanceActive }, null, 2)}\n`);
} else if (findings.length > 0) {
  for (const f of findings) {
    console.log(`${f.file}:${f.line}:${f.column}: [${handling.label(f)}] ${f.type}: ${f.message}`);
  }
} else {
  console.log(governanceActive
    ? 'rule-conflict: ledger present, no unadjudicated conflict rows'
    : 'rule-conflict: no self-authored style-rule files (silent)');
}

process.exit(handling.gateTripped(findings, options.failOn) ? 1 : 0);
