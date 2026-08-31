#!/usr/bin/env node
'use strict';

// guyin-check-strip.js — 成稿剥离门禁（K3，docs/08-过保真管线接口契约加固计划.md）
//
// 正文文件结构契约：只允许一个章标题，无小节标题、无「承接」段、无任何工序标记。
// v3 实证三类 S 级硬伤的落盘面封堵：生成端产出结构化草稿（带「## 声线锚」小节、
// 末尾「承接：第62章……」大纲尾巴）直接落盘为终稿——管线契约止于内容、未及形态，
// 执行层返回什么形态就落什么形态。
//
//   strip-extra-heading  (blocking) 章标题之外出现任何 markdown 标题（## 声线锚/
//                         ## 封档 等脚手架小节——S1 形态）
//   strip-carryover     (blocking) 「承接：第…」大纲尾巴充当结尾（ch61/ch63 实证形态）
//   strip-framework-word(advisory) 框架工序词泄漏（情节点/细纲/写作指令/伏笔…——S2
//                         兜底：指令措辞自由不可全机械，宁报不拦，拦截权归五测试）
//
// 词表只收跨书通用工序词，书特定泄漏词归项目短语黑名单通道（06 同款决策：框架给机制
// 不给词表）。「卷\d」形态带白名单（案卷/卷宗是查案题材正当词）；错报由 advisory
// 通道消化。输入正文文件/目录（章检链第 7 步 + 拼章落盘前同源）。
// Report-only，永不改写——报警项一律拦为待审（剥离改写或豁免登记），同其他检查脚本。

const fs = require('fs');
const path = require('path');

const USAGE = `Usage: node guyin-check-strip.js [--json] [--fail-on=blocking|all] <正文文件|正文目录>...

Prose structure gate (docs/08 K3): a finished chapter file contains exactly one
chapter heading and nothing else structural.
  strip-extra-heading   (blocking) any markdown heading beyond the chapter title
  strip-carryover       (blocking) outline carry-over tail ("承接：第…") posing as ending
  strip-framework-word  (advisory) framework process words leaked into prose (S2 backstop)
Heuristic word list ships generic process terms only; book-specific leaks belong
to the project phrase blacklist channel.
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

if (options.inputs.length === 0) die('No prose file or directory provided');

function collectFiles(input) {
  const abs = path.resolve(input);
  let stat;
  try {
    stat = fs.statSync(abs);
  } catch (error) {
    return { error: `${input}: unable to read (${error.message})` };
  }
  if (stat.isFile()) return { files: [{ abs, display: input }] };
  let entries;
  try {
    entries = fs.readdirSync(abs);
  } catch (error) {
    return { error: `${input}: unable to read directory (${error.message})` };
  }
  return {
    files: entries.sort()
      .filter((name) => /^第\d+章.*\.md$/.test(name))
      .map((name) => ({ abs: path.join(abs, name), display: path.join(input, name) })),
  };
}

const CH_TITLE = /^#{1,2}\s*第[0-9一二三四五六七八九十百千零两]+章/;
const ANY_HEADING = /^\s*#{1,6}\s+\S/;
const CARRYOVER = /承接[：:]?\s*第/;
// 工序词表（跨书通用；「卷\d」带案/宗白名单——查案题材正当词）
const FRAMEWORK_WORDS = [
  /情节点/, /声线锚/, /写作指令/, /必须发生/, /复沓锚句/, /章尾钩子/,
  /细纲/, /大纲/, /伏笔/, /beat/i, /推理[≤<]/,
];
const VOL_NUM = /(?<![案宗])卷[0-9一二三四五六七八九十百]/;

const allFindings = [];
let failed = false;

const inputFiles = [];
for (const input of options.inputs) {
  const collected = collectFiles(input);
  if (collected.error) {
    failed = true;
    if (!options.json) console.error(collected.error);
    continue;
  }
  inputFiles.push(...collected.files);
}

for (const { abs, display } of inputFiles) {
  let text;
  try {
    text = fs.readFileSync(abs, 'utf8');
  } catch (error) {
    failed = true;
    if (!options.json) console.error(`${display}: unable to read (${error.message})`);
    continue;
  }

  // 剥 YAML frontmatter：元数据不参与结构判定
  const lines = text.split(/\r?\n/);
  const bodyLines = [];
  let inFront = lines[0] !== undefined && lines[0].trim() === '---';
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (inFront) {
      if (i > 0 && line.trim() === '---') inFront = false;
      continue;
    }
    bodyLines.push({ line, no: i + 1 });
  }

  const push = (type, severity, no, message, excerpt) => {
    allFindings.push({
      file: display,
      line: no,
      column: 1,
      type,
      severity,
      message,
      excerpt,
    });
  };

  // blocking①：结构脚手架——只允许一个章标题，其余任何标题行都是工序残留
  let titleSeen = false;
  for (const { line, no } of bodyLines) {
    if (!ANY_HEADING.test(line)) continue;
    if (CH_TITLE.test(line) && !titleSeen) {
      titleSeen = true;
      continue;
    }
    push('strip-extra-heading', 'blocking', no,
      `章标题之外出现标题行（S1 脚手架残留形态：「${line.trim().slice(0, 30)}」）——成稿只允许一个章标题，声线锚/封档等小节是工序产物不是正文；剥离后落盘`,
      line.trim().slice(0, 60));
  }

  // blocking②：大纲尾巴充当结尾
  for (const { line, no } of bodyLines) {
    if (CARRYOVER.test(line)) {
      push('strip-carryover', 'blocking', no,
        `「承接：第…」大纲尾巴混入正文（S1 形态：章末承接声明是细纲字段不是收束段）——剥离该段，收束落到结尾设定的具体动作/画面`,
        line.trim().slice(0, 60));
    }
  }

  // advisory：框架工序词泄漏（S2 兜底——指令措辞自由不可全机械，宁报不拦）
  for (const { line, no } of bodyLines) {
    for (const re of FRAMEWORK_WORDS) {
      if (re.test(line)) {
        push('strip-framework-word', 'advisory', no,
          `框架工序词泄漏疑似：「${re.source}」出现在正文（S2 形态——细纲元语言被执行成正文）——分诊：确属泄漏则剥离改写，世界内正当用法（如军事题材「伏笔」）则豁免登记`,
          line.trim().slice(0, 60));
        break; // 每行只报一次，避免同行多词刷屏
      }
    }
    if (VOL_NUM.test(line)) {
      push('strip-framework-word', 'advisory', no,
        `卷册自引用疑似：「${VOL_NUM.exec(line)[0]}」——卷N 是章节坐标不是世界内词汇（案卷/卷宗已白名单）；分诊：泄漏则改世界内说法，正当（书卷名号）则豁免`,
        line.trim().slice(0, 60));
    }
  }
}

if (options.json) {
  process.stdout.write(`${JSON.stringify({ findings: allFindings }, null, 2)}\n`);
} else {
  for (const f of allFindings) {
    console.log(`${f.file}:${f.line}:${f.column}: [${f.severity}] ${f.type}: ${f.message}`);
  }
  if (allFindings.length === 0 && !failed) {
    console.log(`strip: ${inputFiles.length} file(s) clean`);
  }
}

if (failed) process.exit(2);
const hasBlocking = allFindings.some((f) => f.severity === 'blocking');
if (options.failOn === 'blocking' ? hasBlocking : allFindings.length > 0) process.exit(1);
