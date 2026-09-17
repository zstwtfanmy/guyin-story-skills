#!/usr/bin/env node
'use strict';

// guyin-check-authority-leak.js — 作者性泄漏检测（H2，docs/06-卷三开局复盘整改计划.md §1.4）
//
// 「稳住，别慌。天塌不下来」全书前 60 章 0 次、61-63 连用两次的事故机械化。
// 作者性是隐函数不是素材：精神件（气句/历次气句/一生之问/私人切口）字面出现在
// 细纲/正文 = 尺子被砌进梁。防的是抄，不防化用——角色用自己的话表达同一精神
//（「账没乱，慌什么」）是隐函数的正确落地，子串匹配天然放行。
//
// 词源（决策记录 §八-2）：作者性/气卡.md「气句」行（含默认档）
//   + 作者性/魂档案.md（一生之问/私人切口/历次气句表「气句」列）。
//   回响收编的读者原话**不入词源**（来源=追踪/读者信号.md 作者手动录入的读者评论，
//   登记去向是设定而非正文，不是正文语料）。
//   占位符防护（D11）：{{...}} 占位值、模板说明行与表头一律跳过——模板文字反成词源
//   会污染全项目检测。空词源防护（E6）：文件存在但有效词源 0 条 → advisory「词源为空」；
//   静默跳过仅限「无作者性文件」一种情形。
//
// 匹配（规范化 = 去标点去空白，双侧同口径）：
//   authority-leak-full    整句命中 → blocking
//   authority-leak-clause  整子句命中（词源按句末标点〔。！？；〕切分、逗号不切；子句去标点
//                          ≥4 字且完整出现在受检文本）→ blocking（E1：「稳住，别慌」4 字子句必报；
//                          <4 字子句不单独判——「稳住」类 2 字碎片太常见，并入整句）
//   authority-leak-block   ≥8 字连续子串命中 → blocking
//   authority-leak-suspect 5-7 字连续子串命中 → advisory（子串下限 Arena 验证后调整）
//   authority-source-empty 词源为空 → advisory（检测空转，口述覆盖或走 H3 默认档）
//
// 扫描时机：①细纲落盘前（硬门①，含复沓锚句字段——锚句洗白在此抓）②章检序列（正文，
// 兼拦声线锚复读的落地）③大修落盘后复检（走章检）④review 确定性预检（存量章/外部修订稿
// 进审查时的兜底门）。
// 报告带词源档位（口述定稿/默认档）——默认档命中是双重信号：可能是泄漏，也可能提示该
// 口述覆盖了（风险声明 D9）。blocking 级别不变（宁报不漏）。
// 豁免唯一通道：作者显式豁免（追踪/豁免台账.md，理由必须为「作者认定角色口癖」，且同步
// H1-6 双栖清理：登记角色卡 + 从魂档案退役）；五测试的共振票不适用（判方向不判字面）。

const fs = require('fs');
const path = require('path');
const handling = require('./lib/guyin-handling');

const USAGE = `Usage: node guyin-check-authority-leak.js [--json] [--fail-on=block|hard|all] [--project <项目根>] <文件...>

Authority leak detector (docs/06 §1.4 H2): literal leakage of authorial
spirit lines (气句/历次气句/一生之问/私人切口) into outlines or prose.
Word sources: 作者性/气卡.md (气句 row) + 作者性/魂档案.md (一生之问/
私人切口/历次气句). Reader quotes from 回响收编 are NOT sources.
Normalization strips punctuation and whitespace on both sides.
  blocking: full-sentence / full-clause (>=4 chars) / >=8-char substring hit
            → type=authority-leak, handling=hard（精神件字面泄漏＝H1 硬契约违约）
  advisory : 5-7-char substring hit → authority-leak-suspect, handling=verify
             / empty word source → authority-source-empty, handling=verify
Silent skip ONLY when no 作者性/ directory exists. Exemption must be logged
in 追踪/豁免台账.md by the author (character-catchphrase ruling + H1-6 dual-registration cleanup).
--fail-on=block|hard|all（默认 block）：block=hard 或 verify 任一存在即退 1；hard=仅 hard 计 1；all=含 editorial 全计（审计模式）。
Exit codes: 0=无未决阻断; 1=存在未决阻断(hard/verify); 2=执行/输入错误。`;

const options = { json: false, failOn: 'block', project: null, inputs: [] };

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
    options.inputs.push(arg);
  }
}

if (options.inputs.length === 0) die('No files provided');

// ---------- 规范化与子句切分 ----------

// 去标点（含中英文）、去空白。符号（波浪线等 \p{S}）一并去掉，双侧同口径不影响相对判断。
function normalize(text) {
  return text.replace(/[\s\p{P}\p{S}]/gu, '');
}

// 词源句按句末标点〔。！？；〕切分、逗号不切——子句是气句的停顿单元（E1 终稿：
// 按全部标点切会把「稳住，别慌」切成 2 字碎片漏报；只按句末标点切才能让 4 字子句可判）。
function splitClauses(sentence) {
  return sentence.split(/[。！？；!?;]/).map((s) => s.trim()).filter(Boolean);
}

// ---------- 词源提取 ----------

function isPlaceholder(value) {
  const trimmed = value.trim();
  if (trimmed.includes('{{')) return true; // D11：含占位标记的值一律不入词源（保守跳过）
  return trimmed.length === 0;
}

// 剥掉「（口述定稿 …）」「（默认档…）」注记并识别档位（作者性引导.md「定稿标记」纪律）。
function stripTierMark(value) {
  const m = /（\s*(口述定稿|默认档)[^）]*）/.exec(value);
  let tier = '未标注';
  if (m) tier = m[1] === '口述定稿' ? '口述定稿' : '默认档';
  if (/默认档/.test(value) && tier === '未标注') tier = '默认档'; // 兼容「默认档·未口述」等变体
  return { text: value.replace(/（\s*(?:口述定稿|默认档)[^）]*）\s*/g, '').trim(), tier };
}

// 气卡：三字段表「气句」行第 2 列（本书取值）。表头行第一列为「字段」，不匹配。
function extractFromQiCard(text, out) {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|')) continue;
    const cells = trimmed.split('|').map((c) => c.trim());
    // cells[0] 为空串（首 | 前），字段名在 cells[1]
    if (cells.length >= 3 && cells[1] === '气句') {
      const value = cells[2] || '';
      if (isPlaceholder(value)) continue;
      const { text: clean, tier } = stripTierMark(value);
      if (clean.length === 0) continue;
      out.push({ where: '气卡·气句（当前）', text: clean, tier });
    }
  }
}

// 魂档案：一生之问 / 私人切口（节正文行）+ 历次气句表「气句」列。回响收编节跳过（决策 §八-2）。
function extractFromSoulArchive(text, out) {
  const lines = text.split(/\r?\n/);
  let section = '';
  for (const line of lines) {
    const trimmed = line.trim();
    const heading = /^#{1,6}\s+(.+)$/.exec(trimmed);
    if (heading) {
      const title = heading[1];
      if (title.includes('一生之问')) section = '一生之问';
      else if (title.includes('私人切口')) section = '私人切口';
      else if (title.includes('历次气句')) section = '历次气句';
      else if (title.includes('回响收编')) section = '回响收编'; // 读者原话不入词源
      else section = '';
      continue;
    }
    if (section === '一生之问' || section === '私人切口') {
      if (!trimmed || trimmed.startsWith('>')) continue; // 状态行/说明行跳过
      if (isPlaceholder(trimmed)) continue;
      // 剥「例：…」模板示例（占位符整体跳过的兜底之外，正文态的示例行）
      const clean = trimmed.replace(/例[:：][^。！？]*$/u, '').trim();
      if (clean.length >= 4) out.push({ where: `魂档案·${section}`, text: clean, tier: '未标注' });
      continue;
    }
    if (section === '历次气句') {
      if (!trimmed.startsWith('|')) continue;
      const cells = trimmed.split('|').map((c) => c.trim());
      if (cells.length >= 4 && cells[1] === '书名') continue; // 表头
      if (cells.length >= 4 && /^[-\s|:]+$/.test(trimmed.replace(/\|/g, ''))) continue; // 分隔行
      // 第 2 列为气句列（表头「气句（本书之气的当时措辞）」）
      const value = cells[2] || '';
      if (isPlaceholder(value)) continue;
      const { text: clean, tier } = stripTierMark(value);
      if (clean.length === 0) continue;
      out.push({ where: `魂档案·历次气句${cells[1] ? `（${cells[1]}）` : ''}`, text: clean, tier });
    }
  }
}

// 定位项目根：--project 优先，否则从受检文件向上（≤4 层）找含 作者性/ 的目录。
function locateProjectRoot(file) {
  if (options.project) return path.resolve(options.project);
  let cur = path.dirname(path.resolve(file));
  for (let depth = 0; depth < 4; depth += 1) {
    if (fs.existsSync(path.join(cur, '作者性'))) return cur;
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return null;
}

const sourceCache = new Map(); // projectRoot → { sources: [...], filesSeen: boolean }

function loadSources(projectRoot) {
  if (sourceCache.has(projectRoot)) return sourceCache.get(projectRoot);
  const sources = [];
  let filesSeen = 0;
  const qi = path.join(projectRoot, '作者性', '气卡.md');
  const soul = path.join(projectRoot, '作者性', '魂档案.md');
  try {
    extractFromQiCard(fs.readFileSync(qi, 'utf8'), sources);
    filesSeen += 1;
  } catch (e) { /* 无气卡文件则跳过该源 */ }
  try {
    extractFromSoulArchive(fs.readFileSync(soul, 'utf8'), sources);
    filesSeen += 1;
  } catch (e) { /* 无魂档案文件则跳过该源 */ }
  const entry = { sources, filesSeen };
  sourceCache.set(projectRoot, entry);
  return entry;
}

// ---------- 匹配 ----------

// 一行与一个词源的命中判定。返回最高级别命中（null / {level, kind, hit}）。
function matchLine(lineNorm, source) {
  const srcNorm = normalize(source.text);
  if (srcNorm.length === 0) return null;
  if (lineNorm.includes(srcNorm)) {
    return { level: 'blocking', kind: '整句命中', hit: source.text };
  }
  for (const clause of splitClauses(source.text)) {
    const clauseNorm = normalize(clause);
    if (clauseNorm.length >= 4 && lineNorm.includes(clauseNorm)) {
      return { level: 'blocking', kind: '整子句命中', hit: clause };
    }
  }
  // 连续子串：从长到短枚举词源的规范串（上限 = 词源长度），首个命中即最长。
  const maxLen = Math.min(srcNorm.length, lineNorm.length);
  for (let len = maxLen; len >= 5; len -= 1) {
    for (let start = 0; start + len <= srcNorm.length; start += 1) {
      const sub = srcNorm.slice(start, start + len);
      if (lineNorm.includes(sub)) {
        return len >= 8
          ? { level: 'blocking', kind: `连续子串命中（${len} 字）`, hit: sub }
          : { level: 'advisory', kind: `疑似命中（${len} 字子串）`, hit: sub };
      }
    }
  }
  return null;
}

// ---------- 主流程 ----------

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
  const root = locateProjectRoot(abs);
  if (!root) continue; // 无作者性文件的项目：静默跳过（E6：唯一合法静默情形）

  const { sources, filesSeen } = loadSources(root);
  const fileFindings = [];

  if (sources.length === 0) {
    // E6：文件存在但 0 条有效词源（含全占位符）→ advisory，检测空转不能再被静默钉死
    if (filesSeen > 0) {
      fileFindings.push({
        line: 1,
        column: 1,
        type: 'authority-source-empty',
        severity: 'advisory',
        message: '词源为空，检测空转——作者性文件存在但无有效词源（占位符态）。口述覆盖（/定作者性）或走 H3 默认档（开书 Phase B 收尾检查），否则作者性泄漏无防线。',
        excerpt: '',
      });
    }
  } else {
    const lines = text.split(/\r?\n/);
    const reported = new Set(); // 同词源同文件只报最高级一条（行级去重）
    for (let i = 0; i < lines.length; i += 1) {
      const lineNorm = normalize(lines[i]);
      if (!lineNorm) continue;
      for (const source of sources) {
        if (reported.has(source.where + '|' + source.text)) continue;
        const hit = matchLine(lineNorm, source);
        if (hit) {
          fileFindings.push({
            line: i + 1,
            column: 1,
            type: hit.level === 'blocking' ? 'authority-leak' : 'authority-leak-suspect',
            severity: hit.level,
            message: `作者性字面泄漏：${hit.kind}「${hit.hit}」——词源：${source.where}${source.tier !== '未标注' ? `［${source.tier}］` : ''}。防的是抄，不防化用：改成角色自己的话（同一精神、不同措辞）即合法；豁免唯一通道=豁免台账「作者认定角色口癖」+ 双栖清理。`,
            excerpt: lines[i].trim().slice(0, 60),
          });
          if (hit.level === 'blocking') reported.add(source.where + '|' + source.text);
        }
      }
    }
  }

  allFindings.push(...fileFindings.map((f) => ({ file: input, ...f })));
}

try {
  handling.finalizeFindings(allFindings, 'guyin-check-authority-leak.js');
} catch (e) {
  die(e.message);
}

if (options.json) {
  process.stdout.write(`${JSON.stringify({ findings: allFindings }, null, 2)}\n`);
} else {
  for (const f of allFindings) {
    console.log(`${f.file}:${f.line}:${f.column}: [${handling.label(f)}] ${f.type}: ${f.message}`);
  }
  if (allFindings.length === 0 && !failed) {
    console.log(`authority-leak: no literal leakage found (${options.inputs.length} file(s) scanned)`);
  }
}

if (failed) process.exit(2);
process.exit(handling.gateTripped(allFindings, options.failOn) ? 1 : 0);
