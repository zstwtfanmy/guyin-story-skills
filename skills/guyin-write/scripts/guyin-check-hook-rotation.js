#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const handling = require('./lib/guyin-handling');

const USAGE = `Usage: node guyin-check-hook-rotation.js [--json] [--fail-on=block|hard|all] [--run-threshold=N] <大纲目录 | 细纲文件...>

节奏护栏（P4，docs/04-优化路线图.md §3 P4）：钩子类型轮换 + 蓄力-爆发成对检测。
分布坍缩推论 3（04 §2.2）：跨章的任何模式重复都是坍缩——比喻如此，钩子也如此。
连续同型钩子钝化读者（连续五章危机钩，第六章读者已免疫）；爆发章的爽感一半来自
前几章的克制，Muse 判据必须与蓄力章成对出现。两条规则全部 advisory（只报不拦，
编排层提示轮换/补蓄力，升级作者定夺）。

  hook-run             连续 ≥N 章（默认 3）章尾钩子同型——须轮换类型
                       （章号相邻且均已标注才计连续；未标注章断开计数；切断型不计入）
                       handling=editorial（表达观察）
  burst-without-charge 章标「节奏标记：爆发」但前 1-2 章细纲无「节奏标记：蓄力」
                       （前章细纲不存在或本章 ≤3 则跳过——开篇 Muse 无前置可蓄）
                       handling=editorial（表达观察）
  hook-cut-entity-missing 切断型章尾钩子缺断点实体（批次末兜底 advisory，
                       落盘门 outline-slots 已 blocking 拦空实体）
                       handling=verify（须对照细纲声明核实）
  hook-cut-quota       切断型钩子本批 >2 个（advisory，可豁免：情绪峰值连续切断的刻意编排）
                       handling=editorial（表达观察）

四组化兼容声明（任务书 §2.1）：四组化细纲（references/细纲协议.md）不再声明
钩子类型与节奏标记——章尾张力由第一组读者承诺与下一章承接自然决定。本脚本为
旧格式存量细纲的兼容工具（声明了钩子类型才参与统计，未标注章不报警，存量不
追溯），检测逻辑不变。

旧格式标注（四组化前细纲的历史字段）：
  - 章尾钩子：{危机|反转|期待|悬念|情绪|切断}·{章尾13式} — {具体内容……}
    切断型（X1，第六型·特殊态）：承接改「同场景延续」（豁免事件指向），
    断点实体必填；不计入本脚本类型轮换统计；一批 ≤2 个（advisory，可豁免）
  - 节奏标记：{蓄力|爆发}（Muse 判据章标「爆发」；其前 1-2 章标「蓄力」：
    禁发散、收敛感官、降字数）

入参为目录时自动收集其下 细纲_第NNN章.md；未标注钩子类型的章不参与 run 检测
（统计进 summary.unannotated，不报警——存量细纲不追溯）。

处置分类（lib/guyin-handling.js 单一事实源；severity 保留原值作证据强度）。
--fail-on=block|hard|all（默认 block）：block=hard 或 verify 任一存在即退 1；
hard=仅 hard 计 1；all=含 editorial 全计 1（审计模式）。
Exit codes: 0=无未决阻断; 1=存在未决阻断(hard/verify); 2=执行/输入错误。`;

const options = { json: false, targets: [], failOn: 'block', runThreshold: 3 };

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
  } else if (arg.startsWith('--run-threshold=')) {
    const v = Number(arg.slice('--run-threshold='.length));
    if (!Number.isInteger(v) || v < 2) die('--run-threshold must be an integer >= 2');
    options.runThreshold = v;
  } else if (arg === '-h' || arg === '--help') {
    process.stdout.write(`${USAGE}\n`);
    process.exit(0);
  } else if (arg.startsWith('-')) {
    die(`Unknown option: ${arg}`);
  } else {
    options.targets.push(arg);
  }
}

if (options.targets.length === 0) die('No outline directory or files provided');

const HOOK_TYPES = ['危机', '反转', '期待', '悬念', '情绪', '切断'];
const HOOK_LINE = /[-*]\s*章尾钩子[：:]/;
const HOOK_TYPE = /章尾钩子[：:]\s*(危机|反转|期待|悬念|情绪|切断)/;
const RHYTHM_MARK = /[-*]\s*节奏标记[：:]\s*(蓄力|爆发)/;
const CUT_ENTITY = /实体[：:]\s*(.+)/;

// 收集细纲文件：目录 → 细纲_第NNN章.md；文件原样收。
const files = [];
let failed = false;
for (const target of options.targets) {
  const full = path.resolve(target);
  let stat;
  try {
    stat = fs.statSync(full);
  } catch (error) {
    failed = true;
    if (!options.json) console.error(`${target}: unable to stat (${error.message})`);
    continue;
  }
  if (stat.isDirectory()) {
    let entries;
    try {
      entries = fs.readdirSync(full);
    } catch (error) {
      failed = true;
      if (!options.json) console.error(`${target}: unable to read directory (${error.message})`);
      continue;
    }
    for (const name of entries.sort()) {
      if (/^细纲_第\d+章.*\.md$/.test(name)) files.push(path.join(full, name));
    }
  } else {
    files.push(full);
  }
}

// 解析每份细纲：章号（文件名优先）、钩子类型、节奏标记所在行。
const chapters = [];
for (const file of files) {
  let input;
  try {
    input = fs.readFileSync(file, 'utf8');
  } catch (error) {
    failed = true;
    if (!options.json) console.error(`${file}: unable to read (${error.message})`);
    continue;
  }
  const lines = input.split(/\r?\n/);
  const record = { file, chapter: null, hookType: null, hookLine: 0, hookText: '', mark: null, markLine: 0 };
  const nameMatch = /第\s*0*(\d+)\s*章/.exec(path.basename(file));
  if (nameMatch) record.chapter = Number(nameMatch[1]);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (record.hookType === null && HOOK_LINE.test(line)) {
      record.hookLine = i + 1;
      record.hookText = line;
      const m = HOOK_TYPE.exec(line);
      record.hookType = m ? m[1] : 'unannotated';
    }
    if (record.mark === null) {
      const m = RHYTHM_MARK.exec(line);
      if (m) {
        record.mark = m[1];
        record.markLine = i + 1;
      }
    }
  }
  chapters.push(record);
}
chapters.sort((a, b) => (a.chapter ?? 0) - (b.chapter ?? 0));

const findings = [];
const byChapter = new Map();
for (const record of chapters) {
  if (record.chapter !== null && !byChapter.has(record.chapter)) byChapter.set(record.chapter, record);
}

// 规则一：连续同型钩子（章号相邻且同型已标注）。
let runStart = null;
let runType = null;
let runLength = 0;
for (const record of chapters) {
  if (record.chapter === null || record.hookType === null || record.hookType === 'unannotated') continue;
  if (record.hookType === '切断') continue; // X1：切断型特殊态，不计入类型轮换统计（不占常规轮换位）
  const adjacent = runStart !== null && record.chapter === runStart.chapter + runLength;
  if (runType === record.hookType && adjacent) {
    runLength += 1;
  } else {
    flushRun();
    runStart = record;
    runType = record.hookType;
    runLength = 1;
  }
}
flushRun();

function flushRun() {
  if (runStart !== null && runLength >= options.runThreshold) {
    const end = runStart.chapter + runLength - 1;
    findings.push({
      file: path.relative('.', runStart.file),
      line: runStart.hookLine,
      column: 1,
      type: 'hook-run',
      severity: 'advisory',
      message: `钩子坍缩：第${runStart.chapter}-${end}章连续 ${runLength} 章${runType}钩——连续同型即钝化（04 §2.2 推论 3），须轮换类型（危机/反转/期待/悬念/情绪；切断型不计入此统计）。`,
      excerpt: `第${runStart.chapter}-${end}章 × ${runType}`,
    });
  }
  runStart = null;
  runType = null;
  runLength = 0;
}

// 规则二：爆发章无前置蓄力（仅显式「节奏标记：爆发」触发；前章细纲缺失/本章 ≤3 跳过）。
for (const record of chapters) {
  if (record.mark !== '爆发' || record.chapter === null || record.chapter <= 3) continue;
  const prev1 = byChapter.get(record.chapter - 1);
  const prev2 = byChapter.get(record.chapter - 2);
  const hasCharge = [prev1, prev2].some((p) => p && p.mark === '蓄力');
  if (hasCharge) continue;
  if (!prev1) continue; // 前章细纲不存在：无法验证，宁漏不噪
  findings.push({
    file: path.relative('.', record.file),
    line: record.markLine,
    column: 1,
    type: 'burst-without-charge',
    severity: 'advisory',
    message: `爆发章无前置蓄力：第${record.chapter}章标「爆发」但第${record.chapter - 1}-${record.chapter - 2}章无「节奏标记：蓄力」——爆发章的爽感一半来自前几章的克制；前 1-2 章补蓄力标记（禁发散、收敛感官、降字数）。`,
    excerpt: `第${record.chapter}章 × 爆发`,
  });
}

// 规则三：切断型 X1 检查——断点实体必填（防「没写完」伪装切断）+ 批内计数 advisory（≤2，可豁免）。
// 断点实体：outline-slots 已在落盘门 blocking 拦空实体，此处为批次末兜底 advisory。
const cutChapters = chapters.filter((c) => c.hookType === '切断' && c.chapter !== null);
for (const record of cutChapters) {
  const m = CUT_ENTITY.exec(record.hookText);
  if (!m || m[1].trim().length === 0) {
    findings.push({
      file: path.relative('.', record.file),
      line: record.hookLine,
      column: 1,
      type: 'hook-cut-entity-missing',
      severity: 'advisory',
      message: `切断型章尾钩子缺断点实体（断在什么半句/动作半途上）——豁免的是事件指向（承接：同场景延续），不是形态契约；无断点实体的「没写完」不得伪装成切断。`,
      excerpt: `第${record.chapter}章 × 切断`,
    });
  }
}
if (cutChapters.length > 2) {
  const list = cutChapters.map((c) => `第${c.chapter}章`).join('、');
  findings.push({
    file: path.relative('.', cutChapters[0].file),
    line: cutChapters[0].hookLine,
    column: 1,
    type: 'hook-cut-quota',
    severity: 'advisory',
    message: `切断型钩子本批 ${cutChapters.length} 个（${list}）——一批最多 1-2 个，多用则读者脱力（可豁免：情绪峰值章节连续切断的刻意编排）。`,
    excerpt: `${cutChapters.length} × 切断`,
  });
}

const summary = {
  chapters_scanned: chapters.length,
  annotated: chapters.filter((c) => c.hookType && c.hookType !== 'unannotated').length,
  unannotated: chapters.filter((c) => c.hookType === 'unannotated').length,
  burst_marked: chapters.filter((c) => c.mark === '爆发').length,
  charge_marked: chapters.filter((c) => c.mark === '蓄力').length,
  cut_marked: chapters.filter((c) => c.hookType === '切断').length,
};

try {
  handling.finalizeFindings(findings, 'guyin-check-hook-rotation.js');
} catch (e) {
  die(e.message);
}

if (options.json) {
  process.stdout.write(`${JSON.stringify({ summary, findings }, null, 2)}\n`);
} else {
  if (summary.unannotated > 0) {
    console.log(`# 已扫描 ${summary.chapters_scanned} 份细纲：${summary.annotated} 章已标注钩子类型，${summary.unannotated} 章未标注（不参与轮换检测，存量不追溯）`);
  }
  for (const f of findings) {
    console.log(`${f.file}:${f.line}:${f.column}: [${handling.label(f)}] ${f.type}: ${f.message}`);
  }
}

if (failed) process.exit(2);
process.exit(handling.gateTripped(findings, options.failOn) ? 1 : 0);

function die(message) {
  console.error(message);
  console.error(USAGE.trimEnd());
  process.exit(2);
}
