#!/usr/bin/env node
'use strict';

// guyin-check-wordcount.js — 章字数护栏
//
// 低模型执行层最常崩的是字数：beat 写两百字就收工、拼接缺 beat。本脚本做章级兜底
// （beat 级由写作卡的字数指令管，两层各守各的）：
//   - chapter-too-short (blocking)：去空白字数 < min（默认 2000，低模型档 3-4 beat 下限）
//   - chapter-too-long  (advisory)：> max（默认 6000，提示核对 beat 切分是否失守）
// 度量：剔除 YAML frontmatter 与 markdown 标题行后的去空白字符数（与 doc-budget 同口径）。
// 目录输入时只检 第*.md（三位章号命名约定），其余文件忽略。
// Report-only，永不改写——报警项一律拦为待审（改写卡或豁免），同其他检查脚本。

const fs = require('fs');
const path = require('path');

const USAGE = `Usage: node guyin-check-wordcount.js [--json] [--fail-on=blocking|all] [--min=N] [--max=N] <file|dir>...

Chapter wordcount guard for low-model prose assembly:
  - chapter-too-short (blocking): visible chars < --min (default 2000)
  - chapter-too-long  (advisory): visible chars > --max (default 6000)
Visible chars = non-whitespace characters after stripping YAML frontmatter and
markdown heading lines. Directory input scans 第*.md only.
--fail-on=blocking exits 1 only on blocking findings; default --fail-on=all exits 1 on any.
Report-only: findings go to the review queue (rewrite card or exemption), never auto-deleted.`;

const options = { json: false, failOn: 'all', min: 2000, max: 6000, inputs: [] };

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
  } else if (arg.startsWith('--min=')) {
    const n = Number(arg.slice('--min='.length));
    if (!Number.isFinite(n) || n <= 0) die(`--min must be a positive number`);
    options.min = n;
  } else if (arg.startsWith('--max=')) {
    const n = Number(arg.slice('--max='.length));
    if (!Number.isFinite(n) || n <= 0) die(`--max must be a positive number`);
    options.max = n;
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
if (options.min >= options.max) die(`--min (${options.min}) must be smaller than --max (${options.max})`);

function collectFiles(input) {
  const abs = path.resolve(input);
  let stat;
  try {
    stat = fs.statSync(abs);
  } catch (error) {
    console.error(`${input}: unable to read (${error.message})`);
    process.exit(2);
  }
  if (stat.isFile()) return [abs];
  return fs.readdirSync(abs)
    .filter((name) => name.startsWith('第') && name.endsWith('.md'))
    .sort()
    .map((name) => path.join(abs, name));
}

// 剔除 frontmatter 与标题行后的去空白字符数。
function visibleChars(text) {
  const lines = text.split(/\r?\n/);
  const body = [];
  let inFrontMatter = lines[0] !== undefined && lines[0].trim() === '---';
  let frontMatterClosed = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (inFrontMatter) {
      if (i > 0 && line.trim() === '---') {
        inFrontMatter = false;
        frontMatterClosed = true;
      }
      continue;
    }
    if (/^\s*#{1,6}\s/.test(line)) continue; // markdown 标题行不计
    body.push(line);
  }
  void frontMatterClosed;
  return body.join('\n').replace(/\s/g, '').length;
}

const files = [];
for (const input of options.inputs) files.push(...collectFiles(input));

const findings = [];
for (const file of files) {
  const text = fs.readFileSync(file, 'utf8');
  const count = visibleChars(text);
  if (count < options.min) {
    findings.push({
      file,
      line: 1,
      column: 1,
      type: 'chapter-too-short',
      severity: 'blocking',
      count,
      limit: options.min,
      message: `章字数 ${count} 低于下限 ${options.min}（低模型 beat 缺斤短两或拼接缺 beat；补写缺口 beat，勿机械注水）`,
      excerpt: '',
    });
  } else if (count > options.max) {
    findings.push({
      file,
      line: 1,
      column: 1,
      type: 'chapter-too-long',
      severity: 'advisory',
      count,
      limit: options.max,
      message: `章字数 ${count} 超过上限 ${options.max}（核对 beat 切分与细纲密度，是否该拆章）`,
      excerpt: '',
    });
  }
}

if (options.json) {
  process.stdout.write(`${JSON.stringify({ findings }, null, 2)}\n`);
} else {
  for (const f of findings) {
    console.log(`${f.file}: [${f.severity}] ${f.type}: ${f.message}`);
  }
  if (findings.length === 0 && files.length > 0) {
    console.log(`wordcount: ${files.length} file(s) within [${options.min}, ${options.max}]`);
  }
}

const tripped = findings.filter((f) => (options.failOn === 'blocking' ? f.severity === 'blocking' : true));
process.exit(tripped.length > 0 ? 1 : 0);
