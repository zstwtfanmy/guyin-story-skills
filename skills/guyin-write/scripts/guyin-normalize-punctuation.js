#!/usr/bin/env node
'use strict';

// guyin-normalize-punctuation.js — 正文标点确定性检查（默认逐字只读）
//
// 读写契约（任务书 v4 §6.2 / 核查清单 B-2）：
//   默认（无参数）与 --check：逐字只读，报全部 finding，按 --fail-on 口径给退出码；
//   --write：只对「隔离候选」执行明确获准的确定性修复，并另存新版本（vNNNN+1.md），
//            旧候选与正式正文永不原位改写；
//   --check --write：互斥，exit2 且零写入。
//
// --write 只修两类硬确定项：
//   markdown-divider（移除正文独立分隔线）、quote-style（仅显式 --quote-mode 时转引号）。
// 省略号/破折号/双连字符（ellipsis/em-dash/double-hyphen）为 editorial 观察：
//   功能正常的停顿与打断（……/——）逐字保留，绝不因报警批量改写；
// html-comment-unclosed 无法安全自动修复：--write 后仍残留即 exit1，不吞 hard finding。

const fs = require('fs');
const path = require('path');
const handling = require('./lib/guyin-handling');

const USAGE = `Usage: node guyin-normalize-punctuation.js [--check|--write] [--quote-mode keep|ascii|yan] [--fail-on=block|hard|all] <candidate-file...>

只读模式（默认，或显式 --check）：逐字不写，报告全部 finding。
写入模式（显式 --write）：只接受 R/drafts/vNNNN.md 隔离候选，确定性修复另存 vNNNN+1.md：
  - markdown-divider：移除正文独立 --- 分隔线（hard）
  - quote-style：仅在显式 --quote-mode=ascii|yan 时转引号（hard）
  - ellipsis/em-dash/double-hyphen 为 editorial，功能停顿/打断逐字保留，不自动改写
  - html-comment-unclosed 不自动修复；残留 hard finding 时退出 1
--check 与 --write 互斥（同时给出 exit2，零写入）。
--fail-on=block（默认）hard/verify 任一存在即 1；hard 仅 hard；all 含 editorial（审计模式）。
Exit codes: 0=无未决阻断, 1=存在未决阻断(hard/verify), 2=执行/输入错误。
`;

const options = {
  check: false,
  write: false,
  quoteMode: 'keep',
  failOn: 'block',
  files: [],
};

for (let i = 2; i < process.argv.length; i += 1) {
  const arg = process.argv[i];
  if (arg === '--check') {
    options.check = true;
  } else if (arg === '--write') {
    options.write = true;
  } else if (arg === '--quote-mode') {
    const value = process.argv[i + 1];
    if (!value) die('--quote-mode requires keep, ascii, or yan');
    options.quoteMode = value;
    i += 1;
  } else if (arg.startsWith('--quote-mode=')) {
    options.quoteMode = arg.slice('--quote-mode='.length);
  } else if (arg.startsWith('--fail-on=')) {
    try {
      options.failOn = handling.parseFailOn(arg.slice('--fail-on='.length), 'block');
    } catch (error) {
      die(error.message);
    }
  } else if (arg === '-h' || arg === '--help') {
    process.stdout.write(USAGE);
    process.exit(0);
  } else if (arg.startsWith('-')) {
    die(`Unknown option: ${arg}`);
  } else {
    options.files.push(arg);
  }
}

if (options.check && options.write) {
  die('--check 与 --write 互斥：只读与写入不能同时要求（零写入，未处理任何文件）');
}
if (!['keep', 'ascii', 'yan'].includes(options.quoteMode)) {
  die(`Invalid --quote-mode: ${options.quoteMode}`);
}
if (options.files.length === 0) {
  die('No files provided');
}

let failed = false;
const allFindings = [];

for (const file of options.files) {
  const fullPath = path.resolve(file);
  let input;
  try {
    input = fs.readFileSync(fullPath, 'utf8');
  } catch (error) {
    failed = true;
    console.error(`${file}: unable to read (${error.message})`);
    continue;
  }

  // 检测在两种模式下都全量跑（read-only 的证据；write 模式判定修复与残留）。
  const detected = detectDocument(input, options.quoteMode);
  const findings = detected.findings.map((f) => ({ file, ...f }));

  if (!options.write) {
    for (const f of findings) allFindings.push(f);
    continue;
  }

  // --write：只接受隔离候选，另存新版本，正式正文/旧候选一律不原位改。
  let target;
  try {
    target = candidateNextVersion(fullPath);
  } catch (error) {
    failed = true;
    console.error(`${file}: ${error.message}`);
    continue;
  }
  if (fs.existsSync(target.abs)) {
    failed = true;
    console.error(`${file}: 目标新版本已存在，拒绝覆盖：${path.relative(process.cwd(), target.abs)}`);
    continue;
  }

  const fixed = applyDeterministicFixes(input, options.quoteMode);
  const resolvedTypes = new Set(['markdown-divider']);
  if (options.quoteMode !== 'keep') resolvedTypes.add('quote-style');
  let applied = 0;
  for (const f of findings) {
    if (resolvedTypes.has(f.type)) {
      f.resolved = true;
      applied += 1;
    } else {
      allFindings.push(f);
    }
  }

  if (fixed.output === input) {
    console.log(`${file}: 无获准确定性修复可应用（${findings.length} 条观察未自动改写），未写新版本`);
    continue;
  }

  try {
    atomicWrite(target.abs, fixed.output);
  } catch (error) {
    failed = true;
    console.error(`${file}: 写新版本失败（${error.message}）`);
    continue;
  }
  const remaining = findings.length - applied;
  console.log(`${file}: 确定性修复 ${applied} 处 → 新版本 ${path.basename(target.abs)}`
    + `（旧版字节未动；残留观察 ${remaining} 条未自动改写）`);
}

try {
  handling.finalizeFindings(allFindings, 'guyin-normalize-punctuation.js');
} catch (error) {
  die(error.message);
}

if (!options.write) {
  for (const f of allFindings) {
    console.log(`${f.file}:${f.line}:${f.column}: [${handling.label(f)}] ${f.type}: ${f.message}`);
  }
} else {
  for (const f of allFindings) {
    console.log(`${f.file}:${f.line}:${f.column}: [${handling.label(f)}] 未自动修复 ${f.type}: ${f.message}`);
  }
}

if (failed) {
  process.exit(2);
}
if (handling.gateTripped(allFindings, options.failOn)) {
  process.exit(1);
}

function die(message) {
  console.error(message);
  console.error(USAGE.trimEnd());
  process.exit(2);
}

// 隔离候选：.guyin/work/<run_id>/drafts/vNNNN.md —— 只在此处产出下一版本。
function candidateNextVersion(absTarget) {
  const base = path.basename(absTarget);
  const m = /^v(\d+)\.md$/.exec(base);
  if (!m) {
    throw new Error('--write 只接受隔离候选（.guyin/work/<run>/drafts/vNNNN.md），'
      + '不原位改正式正文；修订请先在 run 工作区生成候选，再经 publish 安装');
  }
  const drafts = path.dirname(absTarget);
  const runDir = path.dirname(drafts);
  const workDir = path.dirname(runDir);
  const guyinDir = path.dirname(workDir);
  if (path.basename(drafts) !== 'drafts' || path.basename(workDir) !== 'work'
      || path.basename(guyinDir) !== '.guyin') {
    throw new Error('--write 只接受隔离候选（.guyin/work/<run>/drafts/vNNNN.md），'
      + '不原位改正式正文；修订请先在 run 工作区生成候选，再经 publish 安装');
  }
  const width = Math.max(4, m[1].length);
  const nextNum = parseInt(m[1], 10) + 1;
  const nextName = `v${String(nextNum).padStart(width, '0')}.md`;
  return { abs: path.join(drafts, nextName) };
}

function atomicWrite(file, text) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}

// ---------------- 检测（不产出写入决定） ----------------

function detectDocument(input, quoteMode) {
  const { lines, endings } = splitLinesKeepingEndings(input);

  const findings = [];
  let fence = null;
  let inFrontMatter = hasYamlFrontMatter(lines);
  let quoteOpen = false;
  let commentOpen = false;
  let commentStart = null;
  const commentCloseAhead = new Array(lines.length + 1).fill(false);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    commentCloseAhead[index] = lines[index].includes('-->') || commentCloseAhead[index + 1];
  }

  for (let index = 0; index < lines.length; index += 1) {
    const lineNo = index + 1;
    const line = lines[index];
    const trimmed = line.trim();

    if (commentOpen && !commentCloseAhead[index]) {
      findings.push({
        line: commentStart?.line || lineNo,
        column: commentStart?.column || 1,
        type: 'html-comment-unclosed',
        severity: 'blocking',
        message: 'HTML 注释未闭合；后续内容仍按正文检查。',
      });
      commentOpen = false;
      commentStart = null;
    }

    if (inFrontMatter) {
      if (index > 0 && trimmed === '---') inFrontMatter = false;
      continue;
    }
    if (fence) {
      if (isClosingFence(line, fence)) fence = null;
      continue;
    }
    const openingFence = parseOpeningFence(line);
    if (openingFence) {
      fence = openingFence;
      continue;
    }

    if (trimmed === '---' && !commentOpen) {
      findings.push({
        line: lineNo,
        column: line.indexOf('-') + 1,
        type: 'markdown-divider',
        severity: 'blocking',
        message: '正文中不要使用 markdown 分隔线；建议移除该行。',
      });
      continue;
    }

    const commentWasOpen = commentOpen;
    const pause = detectPausePunctuation(line, lineNo, commentOpen);
    findings.push(...pause.findings);
    commentOpen = pause.commentOpen;
    if (!commentWasOpen && commentOpen) {
      commentStart = { line: lineNo, column: Math.max(1, line.lastIndexOf('<!--') + 1) };
    } else if (!commentOpen) {
      commentStart = null;
    }

    const quoteResult = detectQuotes(line, quoteMode, quoteOpen, lineNo);
    findings.push(...quoteResult.findings);
    quoteOpen = quoteResult.quoteOpen;
  }

  if (commentOpen) {
    findings.push({
      line: commentStart?.line || lines.length,
      column: commentStart?.column || 1,
      type: 'html-comment-unclosed',
      severity: 'blocking',
      message: 'HTML 注释未闭合；后续内容仍按正文检查。',
    });
  }

  return { findings };
}

// commentStart 在注释开启行设置、闭合时清空（见 detectDocument 状态机）。

// 停顿标点只检测、不产出替换文本——功能正常的 ……/—— 受保护。
function detectPausePunctuation(line, lineNo, commentOpen) {
  const findings = [];
  const comments = htmlCommentSpans(line, commentOpen);
  const pattern = /…+|\.{3,}|——|—|--+/g;
  let match;
  while ((match = pattern.exec(line)) !== null) {
    if (insideSpans(match.index, match.index + match[0].length, comments.spans)) continue;
    findings.push({
      line: lineNo,
      column: match.index + 1,
      type: getPauseType(match[0]),
      severity: 'advisory',
      message: '停顿/打断标点为文风观察项：默认保留，不自动改写；确需调整由人在候选上手动修订。',
    });
  }
  return { findings, commentOpen: comments.open };
}

// ---------------- --write 确定性修复（仅分隔线＋显式引号转换） ----------------

function applyDeterministicFixes(input, quoteMode) {
  const { lines, endings } = splitLinesKeepingEndings(input);
  const outputLines = [];
  let fence = null;
  let inFrontMatter = hasYamlFrontMatter(lines);
  let quoteOpen = false;
  let commentOpen = false;
  const commentCloseAhead = new Array(lines.length + 1).fill(false);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    commentCloseAhead[index] = lines[index].includes('-->') || commentCloseAhead[index + 1];
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const ending = endings[index];
    const trimmed = line.trim();

    if (commentOpen && !commentCloseAhead[index]) commentOpen = false;

    if (inFrontMatter) {
      outputLines.push(line + ending);
      if (index > 0 && trimmed === '---') inFrontMatter = false;
      continue;
    }
    if (fence) {
      outputLines.push(line + ending);
      if (isClosingFence(line, fence)) fence = null;
      continue;
    }
    const openingFence = parseOpeningFence(line);
    if (openingFence) {
      fence = openingFence;
      outputLines.push(line + ending);
      continue;
    }

    // 确定性移除：正文独立分隔线（注释内/代码块/frontmatter 已在上面排除）。
    if (trimmed === '---' && !commentOpen) continue;

    // 停顿/打断标点、HTML 注释逐字保留；仅显式 --quote-mode 才动引号。
    const spanResult = htmlCommentSpans(line, commentOpen);
    commentOpen = spanResult.open;
    let outLine = line;
    if (quoteMode !== 'keep') {
      const qr = convertQuotes(line, quoteMode, quoteOpen);
      outLine = qr.line;
      quoteOpen = qr.quoteOpen;
    }
    outputLines.push(outLine + ending);
  }

  return { output: outputLines.join('') };
}

// 逐行记住原始行尾，CRLF/LF 混合保持原样，标点工具不制造整篇行尾 diff。
function splitLinesKeepingEndings(input) {
  const lines = [];
  const endings = [];
  let cursor = 0;

  while (cursor < input.length) {
    const newlineIndex = input.indexOf('\n', cursor);
    if (newlineIndex === -1) {
      lines.push(input.slice(cursor));
      endings.push('');
      break;
    }
    const crlf = newlineIndex > cursor && input[newlineIndex - 1] === '\r';
    lines.push(input.slice(cursor, crlf ? newlineIndex - 1 : newlineIndex));
    endings.push(crlf ? '\r\n' : '\n');
    cursor = newlineIndex + 1;
  }

  return { lines, endings };
}

function parseOpeningFence(line) {
  const match = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
  if (!match) return null;

  const marker = match[1];
  const rest = match[2];
  if (marker[0] === '`' && rest.includes('`')) return null;

  return { marker: marker[0], minimumLength: marker.length };
}

function isClosingFence(line, fence) {
  const marker = fence.marker === '`' ? '`' : '~';
  const match = line.match(new RegExp(`^ {0,3}(${marker}{3,})[\\t ]*$`));
  return Boolean(match && match[1].length >= fence.minimumLength);
}

function htmlCommentSpans(line, openBefore) {
  const spans = [];
  let open = openBefore;
  let cursor = 0;

  while (cursor < line.length) {
    if (open) {
      const close = line.indexOf('-->', cursor);
      if (close === -1) {
        spans.push([cursor, line.length]);
        return { spans, open: true };
      }
      spans.push([cursor, close + 3]);
      cursor = close + 3;
      open = false;
      continue;
    }
    const start = line.indexOf('<!--', cursor);
    if (start === -1) break;
    cursor = start;
    open = true;
  }

  return { spans, open };
}

function insideSpans(start, end, spans) {
  return spans.some(([spanStart, spanEnd]) => start < spanEnd && end > spanStart);
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

function getPauseType(token) {
  if (token.startsWith('-')) return 'double-hyphen';
  if (token.includes('—')) return 'em-dash';
  return 'ellipsis';
}

// 检测用：只在显式 quote-mode 下才产生 quote-style finding（keep 模式引号从不是问题）。
function detectQuotes(line, quoteMode, quoteOpen, lineNo) {
  if (quoteMode === 'keep') {
    return { line, findings: [], quoteOpen };
  }
  return convertQuotes(line, quoteMode, quoteOpen, lineNo, true);
}

function convertQuotes(line, quoteMode, quoteOpen, lineNo = 0, detect = false) {
  const findings = [];
  let output = '';

  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoteMode === 'ascii' && /[「」『』“”]/.test(ch)) {
      output += '"';
      if (detect) {
        findings.push({ line: lineNo, column: i + 1, type: 'quote-style', severity: 'blocking',
          message: '按显式 quote-mode 转为半角双引号。' });
      }
      continue;
    }
    if (quoteMode === 'yan' && (ch === '"' || ch === '“' || ch === '”')) {
      const replacement = quoteOpen || ch === '”' ? '」' : '「';
      output += replacement;
      quoteOpen = replacement === '「';
      if (detect) {
        findings.push({ line: lineNo, column: i + 1, type: 'quote-style', severity: 'blocking',
          message: '按显式 quote-mode 转为盐言引号。' });
      }
      continue;
    }
    output += ch;
  }

  return { line: output, findings, quoteOpen };
}
