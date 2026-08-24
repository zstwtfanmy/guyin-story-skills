#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const USAGE = `Usage: node guyin-check-narrative-asset.js [--json] [--fail-on=blocking|all] [--state=<file>] <chapter.md...>

事件定性资产共现检测（G2，docs/05-实战护栏路线图.md §2）。因果链环节④：ch27 兑付给
读者的「拆神=真破」在账本上不是任何实体，ch36 初稿写「戏是人家排的」没收资产时零报警
——本脚本在写章当章对正文/细纲做双层共现检测（advisory，只报不拦，升级作者判读）。

双层共现（防裸词表误伤——「不是」在对话中高频，单层必误报）：
  否定模式（不是真的/原是/送出来的/做戏/演的/排好的/一场戏/人家排的；词表标注 Arena
  验证后收紧。「从头到尾」实证不可入表：ch36 修复版档 1 重估与初稿档 2 没收同形，机械
  不可分，宁可漏不可拦错）
  × tracking-commit verdicts 实体的登记 keywords（V 编号；视图见 追踪/事件定性资产.md）
  → 同一行两者共现、且该 verdict 为既往章资产（chapter < 本章号；兑付当章建立资产不报）
  → advisory：已兑付资产正被否定翻转，须过 G1 档位仲裁。

静默条件（档位一致）：被检文件含「资产影响档位：1/2」声明——作者已在细纲仲裁并声明
动用资产；声明 0 / 缺声明 / 不可解析则照报（细纲侧缺声明的拦截归 G1 仲裁脚本）。

state 发现：--state 显式指定（不可读即报错）；否则自动发现被检文件所在目录的同级或上级
追踪/_tracking-state.json（覆盖 正文/xxx.md 与 大纲/xxx.md 两种布局）——找不到即静默
跳过：无登记实体即无可对照资产。nullified（已没收）不再报：没收后的否定叙述是合法状态。`;

// 否定模式词表（05 §2 G2；「从头到尾」实证排除，见 USAGE 注记）。
const NEGATION = /(不是真的|原是|送出来的|做戏|演的|排好的|一场戏|人家排的)/;
// 档位声明行与档位值（与 guyin-check-outline-verdict.js 同源，档 ≥1 视为已仲裁动用资产）。
const VERDICT_LINE = /资产影响档位/;
const VERDICT_TIER = /资产影响档位[^\d]{0,6}([0-2])/;
// 被检文件章号（文件名优先）：正文/第036章_标题.md 与 大纲/细纲_第036章.md 皆命中。
const CHAPTER_IN_NAME = /第\s*0*(\d+)\s*章/;

const options = { json: false, files: [], failOn: 'all', state: null };

for (let i = 2; i < process.argv.length; i += 1) {
  const arg = process.argv[i];
  if (arg === '--json') {
    options.json = true;
  } else if (arg.startsWith('--fail-on=')) {
    const v = arg.slice('--fail-on='.length);
    if (v !== 'blocking' && v !== 'all') die(`--fail-on must be 'blocking' or 'all'`);
    options.failOn = v;
  } else if (arg.startsWith('--state=')) {
    options.state = arg.slice('--state='.length);
  } else if (arg === '-h' || arg === '--help') {
    process.stdout.write(`${USAGE}\n`);
    process.exit(0);
  } else if (arg.startsWith('-')) {
    die(`Unknown option: ${arg}`);
  } else {
    options.files.push(arg);
  }
}

if (options.files.length === 0) die('No files provided');

let failed = false;
const allFindings = [];

for (const file of options.files) {
  const fullPath = path.resolve(file);
  let input;
  try {
    input = fs.readFileSync(fullPath, 'utf8');
  } catch (error) {
    failed = true;
    if (!options.json) console.error(`${file}: unable to read (${error.message})`);
    continue;
  }
  const findings = scanChapter(input, fullPath).map((finding) => ({ file, ...finding }));
  allFindings.push(...findings);
}

if (options.json) {
  process.stdout.write(`${JSON.stringify({ findings: allFindings }, null, 2)}\n`);
} else {
  for (const f of allFindings) {
    console.log(`${f.file}:${f.line}:${f.column}: [${f.severity}] ${f.type}: ${f.message} (${f.excerpt})`);
  }
}

if (failed) process.exit(2);
const hasBlocking = allFindings.some((f) => f.severity === 'blocking');
if (options.failOn === 'blocking' ? hasBlocking : allFindings.length > 0) process.exit(1);

function die(message) {
  console.error(message);
  console.error(USAGE.trimEnd());
  process.exit(2);
}

function compact(text) {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length > 80 ? `${normalized.slice(0, 77)}...` : normalized;
}

// state 发现：--state 显式；否则被检文件目录的同级（正文/大纲布局）或当层（书根布局）追踪/。
function findState(chapterPath) {
  if (options.state) return path.resolve(options.state);
  const dir = path.dirname(path.resolve(chapterPath));
  const candidates = [
    path.join(dir, '..', '追踪', '_tracking-state.json'),
    path.join(dir, '追踪', '_tracking-state.json'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function loadVerdicts(statePath) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch (error) {
    // 显式指定的 state 读不了是真错误；自动发现的 fail-open（advisory 层缺输入宁漏不噪）。
    if (options.state) die(`unable to read tracking state ${statePath}: ${error.message}`);
    return [];
  }
  const table = raw && typeof raw.verdicts === 'object' && raw.verdicts !== null ? raw.verdicts : {};
  return Object.values(table)
    .filter((v) => v && typeof v === 'object')
    .map((v) => ({
      id: typeof v.id === 'string' ? v.id : '?',
      chapter: Number.isInteger(v.chapter) && v.chapter > 0 ? v.chapter : null,
      event: typeof v.event === 'string' ? v.event : '',
      status: typeof v.status === 'string' ? v.status : 'active',
      keywords: Array.isArray(v.keywords)
        ? v.keywords.filter((k) => typeof k === 'string' && k.length >= 2)
        : [],
    }))
    .filter((v) => v.keywords.length > 0);
}

function scanChapter(input, fullPath) {
  const statePath = findState(fullPath);
  if (!statePath) return [];
  const verdicts = loadVerdicts(statePath);
  if (verdicts.length === 0) return [];

  const lines = input.split(/\r?\n/);

  // 档位一致静默：声明档 ≥1 = 作者已在细纲仲裁动用资产（0/缺声明/不可解析照报）。
  for (const line of lines) {
    if (VERDICT_LINE.test(line)) {
      const m = VERDICT_TIER.exec(line);
      if (m && Number(m[1]) >= 1) return [];
      break;
    }
  }

  // 被检文件章号（文件名优先）：解析不出则全按既往资产处理（fail-safe 宁报不漏）。
  const nameMatch = CHAPTER_IN_NAME.exec(path.basename(fullPath));
  const fileChapter = nameMatch ? Number(nameMatch[1]) : null;

  const findings = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!NEGATION.test(line)) continue; // 第一层不命中即跳过（绝大多数行）
    for (const v of verdicts) {
      if (v.status === 'nullified') continue;
      if (fileChapter !== null && v.chapter !== null && v.chapter >= fileChapter) continue;
      if (v.keywords.some((k) => line.includes(k))) {
        findings.push({
          line: i + 1,
          column: 1,
          type: 'narrative-asset-violation',
          severity: 'advisory',
          message: `已兑付资产 ${v.id}「${v.event}」${v.chapter ? `（第${v.chapter}章定性）` : ''}正被否定翻转：本行否定模式与登记关键词共现——动用/没收叙事资产须过 G1 档位仲裁（0 叠加/1 重估/2 没收须同章补偿+作者确认），升级作者判读。`,
          excerpt: compact(line.slice(0, 90)),
        });
      }
    }
  }
  return findings;
}
