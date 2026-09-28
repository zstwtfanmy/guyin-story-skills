#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const handling = require('./lib/guyin-handling');

const USAGE = `Usage: node guyin-check-reader-signal.js [--json] [--fail-on=block|hard|all] [--project <根>]

读者信号分析（P5；E1 修订）：只做基于实测追读数据的掉崖观察，不做弃书自动归因。
框架与 Arena 盲评是封闭系统，这是缺的作品心电图——作者手动录入信号（一分钟/章），
机械观察交脚本，语义终判归作者（flash 直接判「为什么掉」不可靠；
「连续两章不推主线即弃书」一类的自动归因 E1 已取消——没有读者数据不得替读者下结论）。

输入（均在 追踪/ 下）：
  读者信号.md          作者手动录入表：| 章 | 追读 | 评论关键词 |（无此文件则不出观察）
  _tracking-state.json 主线推进判据（纯机械）：该章有 timeline 揭示 / 伏笔埋设 / 定性兑付
                       任一即「有推进」——只用于掉崖表的上下文列，不产生弃书结论
  大纲/细纲_第NNN章.md 钩子类型列（可选，缺失该列留空）

输出（advisory 观察，作者看表归因）：
  reader-cliff   掉崖章：追读较前章降幅 ≥30%（|1 - 本/前|，须两章都有实测数）——
                 附 ±2 章信号表（钩子类型/主线推进/评论关键词），归因三问留给作者：
                 钩子失灵？主线停摆？还是上一章爽点透支？

处置分类（lib/guyin-handling）：reader-cliff = editorial——观察不阻断
（默认门永不因此 exit 1），终判归作者；--fail-on=all 审计模式才计入。
Exit codes: 0 = 无未决阻断; 1 = 存在未决阻断（hard/verify）; 2 = 执行/输入错误。
--fail-on=block（默认）hard+verify 计 1; hard 仅 hard; all 含 editorial（审计模式）。`;

const options = { json: false, failOn: 'block', project: null };

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
  } else if (arg.startsWith('--project=')) {
    options.project = arg.slice('--project='.length);
  } else if (arg === '--project') {
    options.project = process.argv[i + 1] || die('--project requires a value');
    i += 1;
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

function die(message) {
  console.error(message);
  console.error(USAGE.trimEnd());
  process.exit(2);
}

const root = path.resolve(options.project);

// ---------- 状态加载 ----------

let state = null;
try {
  state = JSON.parse(fs.readFileSync(path.join(root, '追踪', '_tracking-state.json'), 'utf8'));
} catch (error) { /* 无追踪：掉崖表仍可用，推进列全 unknown */ }

// 主线推进章集合（纯机械：timeline 揭示 / 伏笔埋设 / 定性兑付）
const progressChapters = new Set();
if (state) {
  for (const row of Object.values(state.timeline || {})) {
    if (row.reveal_chapter) progressChapters.add(row.reveal_chapter);
  }
  for (const row of Object.values(state.foreshadow || {})) {
    if (row.planted_chapter) progressChapters.add(row.planted_chapter);
  }
  for (const row of Object.values(state.verdicts || {})) {
    if (row.chapter) progressChapters.add(row.chapter);
  }
}

// 章摘要（信号表附摘要片段）
const summaries = new Map();
if (state) {
  for (const [ch, text] of Object.entries(state.chapter_summaries || {})) {
    summaries.set(Number(ch), typeof text === 'string' ? text : String(text));
  }
}

// ---------- 钩子类型（细纲可选） ----------

const hookTypes = new Map();
try {
  const dir = path.join(root, '大纲');
  for (const name of fs.readdirSync(dir)) {
    const m = /第\s*0*(\d+)\s*章/.exec(name);
    if (!m || !/^细纲_第\d+章.*\.md$/.test(name)) continue;
    const text = fs.readFileSync(path.join(dir, name), 'utf8');
    const hm = /章尾钩子[：:]\s*(危机|反转|期待|悬念|情绪)/.exec(text);
    if (hm) hookTypes.set(Number(m[1]), hm[1]);
  }
} catch (error) { /* 大纲目录缺失：钩子列留空 */ }

// ---------- 读者信号表解析 ----------

const signals = new Map(); // chapter -> { readers, keywords }
const signalPath = path.join(root, '追踪', '读者信号.md');
let hasSignalFile = fs.existsSync(signalPath);
if (hasSignalFile) {
  try {
    const lines = fs.readFileSync(signalPath, 'utf8').split(/\r?\n/);
    for (const line of lines) {
      const m = /^\|\s*(\d+)\s*\|/.exec(line);
      if (!m) continue;
      const cells = line.split('|').map((c) => c.trim());
      if (cells.length < 4) continue;
      const readers = Number(cells[2].replace(/[^\d.]/g, ''));
      if (!Number.isFinite(readers) || readers <= 0) continue;
      signals.set(Number(m[1]), { readers, keywords: cells[3] || '' });
    }
  } catch (error) {
    hasSignalFile = false;
  }
}

// ---------- 掉崖检测 ----------

const findings = [];
const cliffs = [];
if (signals.size >= 2) {
  const chapters = [...signals.keys()].sort((a, b) => a - b);
  for (let i = 1; i < chapters.length; i += 1) {
    const prev = signals.get(chapters[i - 1]).readers;
    const cur = signals.get(chapters[i]).readers;
    if (prev <= 0) continue;
    const drop = 1 - cur / prev;
    if (drop >= 0.3) cliffs.push({ chapter: chapters[i], prev, cur, drop });
  }
  for (const c of cliffs) {
    const table = [];
    for (let ch = c.chapter - 2; ch <= c.chapter + 2; ch += 1) {
      const s = signals.get(ch);
      if (!s) continue;
      table.push({
        chapter: ch,
        readers: s.readers,
        delta: ch === c.chapter ? `-${Math.round(c.drop * 100)}%` : '',
        hook: hookTypes.get(ch) || '',
        progress: progressChapters.has(ch) ? '有推进' : '无推进',
        keywords: s.keywords,
        summary: (summaries.get(ch) || '').slice(0, 40),
      });
    }
    findings.push({
      type: 'reader-cliff',
      severity: 'advisory',
      message: `掉崖章：第${c.chapter}章追读 ${c.prev}→${c.cur}（-${Math.round(c.drop * 100)}%）——看 ±2 章信号表归因（钩子失灵/主线停摆/前章爽点透支），终判归作者。`,
      excerpt: `第${c.chapter}章 -${Math.round(c.drop * 100)}%`,
      table,
    });
  }
}

// ---------- 输出 ----------
// E1：drop-point（连续 ≥2 章无主线推进→弃书点）已废除——追踪状态里没有主线事件
// 不等于读者弃书，无实测信号不得自动归因；「主线是否停摆」只作为掉崖表的上下文列。

const lastChapter = state ? state.last_committed_chapter : 0;

try {
  handling.finalizeFindings(findings, 'guyin-check-reader-signal');
} catch (e) {
  die(e.message);
}

const summary = {
  signal_rows: signals.size,
  has_signal_file: hasSignalFile,
  chapters_tracked: lastChapter,
  cliffs: cliffs.length,
};

if (options.json) {
  process.stdout.write(`${JSON.stringify({ summary, findings }, null, 2)}\n`);
} else {
  console.log(`# 读者信号分析（掉崖 ${summary.cliffs}）`);
  if (!hasSignalFile) console.log('');
  if (!hasSignalFile) console.log('> 未找到 追踪/读者信号.md：无实测信号，不出观察。录入格式见模板（| 章 | 追读 | 评论关键词 |）。');
  console.log('');
  for (const f of findings) {
    console.log(`⚠ [${handling.label(f)}] ${f.type}: ${f.message}`);
    if (f.table) {
      console.log('');
      console.log('  | 章 | 追读 | 降幅 | 钩子 | 主线 | 评论关键词 | 章摘要 |');
      console.log('  |----|------|------|------|------|-----------|--------|');
      for (const row of f.table) {
        console.log(`  | ${row.chapter} | ${row.readers} | ${row.delta} | ${row.hook} | ${row.progress} | ${row.keywords} | ${row.summary} |`);
      }
    }
    console.log('');
  }
}

process.exit(handling.gateTripped(findings, options.failOn) ? 1 : 0);
