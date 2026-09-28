#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const handling = require('./lib/guyin-handling');

const USAGE = `Usage: node guyin-check-integrity.js [--json] [--fail-on=block|hard|all] <file...>

落盘前格式完整性门（F1，docs/05-实战护栏路线图.md §3）。wordcount 只查总量、
degeneration 只查占位符，以下五类「总量合格但形态崩坏」的事故全部漏检——本门补的是
「章存在且字数对，但格式已塌」的盲区（实证：ch39 塌缩 2 行 2624 字 / ch59 84 个「个」
占位错字，均全程带伤运行至 R6 收口才被发现）：

  1. avg-line-collapse  (hard) 平均行长：去空白总字符 / 非空正文行 > 400 → 全文塌缩（ch39：1312）
  2. mega-paragraph     (hard) 单段超长：单行去空白 > 800 字无换行
  3. doubled-char       (hard) 叠字：引号外连续相同功能字对（他他/我我/了了…，白名单+AABB豁免）
  4. char-storm         (hard) 同字风暴：单字频率显著超出该字常态带（分档阈值，见下）
  5. quote-mismatch     (hard) 引号配对：「」『』【』“” 或 ASCII " 开闭计数失衡

同字风暴分档（分母 = 全文 CJK 字符数；实测正常章上沿：的 4.6%、他 3.6%、题材字「银」
1.8%、个 <1%；事故样本 ch59「个」4.8%。阈值留 ≥40% 余量，均标注 Arena 验证后收紧）：
  A 档（的）> 6.5%；B 档（了是一他我你那着在不人有这说去来）> 5%；
  C 档（个和就都）> 2.5%；其余任意 CJK 字 > 3%。
全文 CJK < 800 字不跑风暴检测（短片段频率波动大，本门只做章级 gate）。

五条全部 hard（处置分类见 lib/guyin-handling.js）：不过不落盘，回执行层重拼。
--fail-on=block（默认）hard/verify 任一存在即 1；hard 仅 hard；all 含 editorial（审计模式）。
Exit codes: 0=无未决阻断, 1=存在未决阻断(hard/verify), 2=执行/输入错误。
执行点：写章循环第 4 步拼接后、第 5 步落盘前；
同时排进章检序列兜底存量文件。Report-only：本脚本永不改写，报警一律拦为待审。`;

// 规则 1：塌缩判定。正常章（60 章实测）均长 20-60 字/行；400 是「全文挤成几条巨行」的崩坏级。
const AVG_LINE_COLLAPSE = 400;
// 规则 2：单段超长。正常单段 ≤300 字（ai-patterns 的 advisory 线是 200），800 为崩坏级。
const MEGA_PARAGRAPH_CHARS = 800;
// 规则 4：风暴分档阈值（比例，分母为 CJK 字符数）。
const STORM_MIN_CJK = 800;
const STORM_TIERS = [
  { chars: new Set(['的']), threshold: 0.065 },
  { chars: new Set(['了', '是', '一', '他', '我', '你', '那', '着', '在', '不', '人', '有', '这', '说', '去', '来']), threshold: 0.05 },
  { chars: new Set(['个', '和', '就', '都']), threshold: 0.025 },
];
const STORM_ANY_THRESHOLD = 0.03;
// 规则 3：叠字。只查引号外「功能字/代词」连续叠对——语义字叠词（慢慢/悄悄/潺潺/哈哈）合法面
// 太宽，白名单收不全必误报；模型打转的指纹恰是功能字叠复（他他/我我/了了），语义交 verbatim-repeat。
// 「上/下/天/地/个/说/来/去」不入集合：上上策/下下策/天天/地地(方言)/个个/说说看/来来去去有合法面。
const DOUBLED_CHARS = new Set(['他', '她', '它', '我', '你', '谁', '的', '了', '是', '在', '有', '这', '那', '不', '跟', '把', '被', '就']);
// 规则 5：引号/括号对。
const QUOTE_PAIRS = [['「', '」'], ['『', '』'], ['【', '】'], ['“', '”']];

const options = { json: false, files: [], failOn: 'block' };

for (let i = 2; i < process.argv.length; i += 1) {
  const arg = process.argv[i];
  if (arg === '--json') {
    options.json = true;
  } else if (arg.startsWith('--fail-on=')) {
    try {
      options.failOn = handling.parseFailOn(arg.slice('--fail-on='.length), 'block');
    } catch (error) {
      die(error.message);
    }
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
  const findings = scanDocument(input).map((finding) => ({ file, ...finding }));
  allFindings.push(...findings);
}

try {
  handling.finalizeFindings(allFindings, 'guyin-check-integrity.js');
} catch (error) {
  die(error.message);
}

if (options.json) {
  process.stdout.write(`${JSON.stringify({
    findings: allFindings,
    files_scanned: options.files.map((f) => require('path').resolve(f)),
  }, null, 2)}\n`);
} else {
  for (const f of allFindings) {
    console.log(`${f.file}:${f.line}:${f.column}: [${handling.label(f)}] ${f.type}: ${f.message} (${f.excerpt})`);
  }
}

if (failed) process.exit(2);
process.exit(handling.gateTripped(allFindings, options.failOn) ? 1 : 0);

function die(message) {
  console.error(message);
  console.error(USAGE.trimEnd());
  process.exit(2);
}

function scanDocument(input) {
  const lines = input.split(/\r?\n/);
  const content = []; // { text, trimmed, lineNo } 正文行（剥 frontmatter/代码围栏/标题）
  let fence = null;
  let inFrontMatter = hasYamlFrontMatter(lines);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    if (inFrontMatter) {
      if (index > 0 && trimmed === '---') inFrontMatter = false;
      continue;
    }
    const fenceMarker = /^(?:`{3,}|~{3,})/.exec(trimmed);
    if (fence) {
      if (fenceMarker && trimmed[0] === fence) fence = null;
      continue;
    }
    if (fenceMarker) {
      fence = trimmed[0];
      continue;
    }
    if (/^\s*#{1,6}\s/.test(trimmed)) continue; // 标题行不参与行长/密度统计
    content.push({ text: line, trimmed, lineNo: index + 1 });
  }

  const findings = [];
  findings.push(...findCollapse(content));
  findings.push(...findDoubledChars(content, input));
  findings.push(...findCharStorm(content));
  findings.push(...findQuoteMismatch(content, input));
  findings.sort((a, b) => a.line - b.line || a.column - b.column);
  return findings;
}

// 规则 1+2：塌缩与巨段。口径 = 去空白全部字符（与 05 记录「2624 字 / 2 行」同口径）。
function findCollapse(content) {
  const findings = [];
  const body = content.filter((c) => c.trimmed.length > 0);
  if (body.length === 0) return findings;
  const totalChars = body.reduce((sum, c) => sum + c.trimmed.replace(/\s/g, '').length, 0);
  const avg = totalChars / body.length;
  if (avg > AVG_LINE_COLLAPSE) {
    findings.push({
      line: body[0].lineNo,
      column: 1,
      type: 'avg-line-collapse',
      severity: 'blocking',
      message: `全文塌缩：${body.length} 个非空行承载 ${totalChars} 字（均长 ${Math.round(avg)} > ${AVG_LINE_COLLAPSE}），疑似拼接/落盘事故。回执行层重拼，禁止直接落盘。`,
      excerpt: compact(body[0].trimmed.slice(0, 40)),
    });
  }
  for (const c of body) {
    const len = c.trimmed.replace(/\s/g, '').length;
    if (len > MEGA_PARAGRAPH_CHARS) {
      findings.push({
        line: c.lineNo,
        column: 1,
        type: 'mega-paragraph',
        severity: 'blocking',
        message: `单段超长：本行 ${len} 字无换行（>${MEGA_PARAGRAPH_CHARS}），按镜头断段后重拼。`,
        excerpt: compact(c.trimmed.slice(0, 40)),
      });
    }
  }
  return findings;
}

// 去掉成对引号内片段（叠字只查引号外叙述；对话内口吃/拟声叠词是台词自由）。
function stripQuoted(text) {
  return text
    .replace(/「[^」]*」/g, '')
    .replace(/『[^』]*』/g, '')
    .replace(/【[^】]*】/g, '')
    .replace(/“[^”]*”/g, '')
    .replace(/‘[^’]*’/g, '')
    .replace(/"[^"\n]*"/g, '')
    .replace(/'[^'\n]*'/g, '');
}

// 规则 3：功能字叠对。AABB 豁免：叠对后紧跟另一叠对（和和美美/干干净净）。
function findDoubledChars(content) {
  const findings = [];
  for (const { trimmed, lineNo } of content) {
    const bare = stripQuoted(trimmed);
    const chars = Array.from(bare);
    for (let i = 0; i + 1 < chars.length; i += 1) {
      const c = chars[i];
      if (!DOUBLED_CHARS.has(c) || chars[i + 1] !== c) continue;
      // AABB 豁免：后两字也构成叠对
      if (i + 3 < chars.length && chars[i + 2] === chars[i + 3] && chars[i + 2] !== c) continue;
      // AAA+ 豁免：三连及以上多拟声/强调（他他他口吃形态交 verbatim-repeat 与人工）
      if (i + 2 < chars.length && chars[i + 2] === c) continue;
      findings.push({
        line: lineNo,
        column: i + 1,
        type: 'doubled-char',
        severity: 'blocking',
        message: `代词/功能字叠复「${c}${c}」：疑似模型打转或字符错乱，重写本句。`,
        excerpt: compact(bare.slice(Math.max(0, i - 6), i + 10)),
      });
      break; // 每行报一处即可
    }
  }
  return findings;
}

// 规则 4：同字风暴（分档阈值）。
function findCharStorm(content) {
  const findings = [];
  const text = content.map((c) => c.trimmed).join('');
  const cjk = [...text].filter((ch) => /[\u4e00-\u9fff]/.test(ch));
  if (cjk.length < STORM_MIN_CJK) return findings;
  const freq = new Map();
  for (const ch of cjk) freq.set(ch, (freq.get(ch) || 0) + 1);
  const tierOf = new Map();
  for (let t = 0; t < STORM_TIERS.length; t += 1) {
    for (const ch of STORM_TIERS[t].chars) tierOf.set(ch, STORM_TIERS[t].threshold);
  }
  const flagged = [];
  for (const [ch, count] of freq) {
    const ratio = count / cjk.length;
    const threshold = tierOf.has(ch) ? tierOf.get(ch) : STORM_ANY_THRESHOLD;
    if (ratio > threshold) flagged.push({ ch, count, ratio, threshold });
  }
  flagged.sort((a, b) => b.ratio - a.ratio);
  for (const { ch, count, ratio, threshold } of flagged.slice(0, 3)) {
    findings.push({
      line: content[0] ? content[0].lineNo : 1,
      column: 1,
      type: 'char-storm',
      severity: 'blocking',
      message: `同字风暴：「${ch}」出现 ${count} 次（${(ratio * 100).toFixed(2)}%，档阈值 ${(threshold * 100).toFixed(1)}%），疑似占位错字风暴/模型退化，逐处核对替换。`,
      excerpt: `${ch}×${count} / CJK ${cjk.length} 字`,
    });
  }
  return findings;
}

// 规则 5：引号/括号配对（全文计数，含引号内——配对是格式事实，与豁免无关）。
function findQuoteMismatch(content, input) {
  const findings = [];
  const text = input;
  for (const [open, close] of QUOTE_PAIRS) {
    const o = countOccurrences(text, open);
    const c = countOccurrences(text, close);
    if (o !== c) {
      findings.push({
        line: 1,
        column: 1,
        type: 'quote-mismatch',
        severity: 'blocking',
        message: `引号配对失衡：「${open}」${o} 个 vs 「${close}」${c} 个——疑似截断/漏收引号，逐段补齐。`,
        excerpt: `${open}=${o}, ${close}=${c}`,
      });
    }
  }
  const ascii = countOccurrences(text, '"');
  if (ascii % 2 === 1) {
    findings.push({
      line: 1,
      column: 1,
      type: 'quote-mismatch',
      severity: 'blocking',
      message: `引号配对失衡：ASCII 双引号共 ${ascii} 个（奇数），半角/全角混用或漏收，统一为中文引号。`,
      excerpt: `"=${ascii}`,
    });
  }
  return findings;
}

function countOccurrences(text, ch) {
  let n = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === ch) n += 1;
  }
  return n;
}

function hasYamlFrontMatter(lines) {
  if (!lines[0] || lines[0].trim() !== '---') return false;
  let sawYamlField = false;
  for (let i = 1; i < Math.min(lines.length, 40); i += 1) {
    const trimmed = lines[i].trim();
    if (trimmed === '---') return sawYamlField;
    if (/^[A-Za-z0-9_-]+:\s*/.test(trimmed)) sawYamlField = true;
  }
  return false;
}

function compact(text) {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length > 80 ? `${normalized.slice(0, 77)}...` : normalized;
}
