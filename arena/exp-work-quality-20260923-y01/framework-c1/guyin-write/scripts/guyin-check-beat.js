#!/usr/bin/env node
'use strict';

// guyin-check-beat.js — 连续场景/整章的确定性预检
//
// P1 核心件：确定性可查的检查下沉为零 token 脚本；语义审读（动机/兑现/承接）
// 归当前会话 drafted 阶段全文回看（review.md；自检卡为可选问题单），本脚本不做语义判断。
//
// 四组化（任务书 §2.2）：beat 只是节奏标签，不再是字数桶/逐拍验收单位——
// 字数检测（beat-too-short / beat-too-long）与 --min/--max 已删除，正文长度
// 权威归章级 wordcount；本脚本面向连续场景/整章做确定性预检。
//
// 检查项：
//   ① 禁用词检测：正文出现「第X章/细纲/伏笔/读者/大纲」等工程词
//   ② 禁止项检测：--ban 列表的关键词零出现
//   ③ 跳写检测：括号省略（未完成输出）blocking；时间压缩词 advisory
//   ④ 连续对话检测：连续 ≥4 行纯对白（叙述余量 ≤4 字）advisory
//   ⑤ 心理词频计数：引号外内心动作词（心想/思忖…）命中数，advisory——不抑制内心戏
//   ⑥ 情绪告知计数：引号外情绪直名词（愤怒/恐惧…）命中数，advisory（show-don't-tell 提示）
//
// v3-A1 误报修复（docs/框架整改任务书 §4 A1）：
//   - 时间概述词（不多时/一番…之后等）不再判 blocking——合法概述与跳过必须展示
//     的事件须由语义检查区分，脚本只报观测值供判读；括号省略（（此处省略…））是
//     显式未完成输出，保持 blocking。
//   - dialogue-run 只累计「纯对白行」（剥引号后叙述余量 ≤4 字）——同行已有动作的
//     行不再被当作无动作对白，也不再把整段话术误报为「无动作」。
//   - mono-count 报告的是心理/情绪词命中次数（词频），不是心理独白句数——只报
//     观测值与「需结合上下文判断」，不声称已检测「心理独白过多」。
//   - 默认 --fail-on=block（处置分类口径，lib/guyin-handling.js）：advisory 不再因
//     exit 1 被调用方放大为失败；advisory 进分诊/判读，不因退出码一律发改写卡。
//
// Report-only：报警只标待审，永不自动删。与其他检查脚本同构。

const fs = require('fs');
const path = require('path');
const handling = require('./lib/guyin-handling');

const USAGE = `Usage: node guyin-check-beat.js [--json] [--fail-on=block|hard|all] [--ban=w1,w2,...] [--mono-limit=N] <file>

Deterministic pre-check for continuous scenes / whole chapters (self-check
card sink-down; beat is a rhythm label only — no wordcount buckets):
  ① meta-leak-beat    (hard; 对话行内变体 verify): 工程词泄漏（第X章/细纲/伏笔/读者/大纲）
  ② ban-violation     (hard): --ban 列表关键词出现
  ③ skip-write        (hard): 括号省略（（此处省略…）＝未完成输出）
     skip-write       (editorial): 时间压缩词命中（不多时/一番…之后等——合法
                       概述与漏写须语义区分，脚本只报观测值）
  ④ dialogue-run      (editorial): 连续 ≥4 行纯对白（剥引号后叙述余量 ≤4 字；
                       同行含动作的行不计入，不声称「无动作」）
  ⑤ mono-count        (editorial): 引号外内心动作词（心想/思忖/觉得…）命中数超
                       --mono-limit（词频观测，非独白句数；知道/明白/清楚等认知
                       半句不计数，Fw-05）——不抑制持续的、个性化的内心段落
  ⑥ emotion-tell      (editorial): 引号外情绪直名词（愤怒/恐惧/绝望…）命中数超
                       --mono-limit（直接命名情绪＝告知而非展示；情绪峰值处
                       直陈可成立，须结合上下文）

Wordcount checks abolished (任务书 §2.2): beat-too-short / beat-too-long 与
--min/--max 已删除——beat 只是节奏标签，正文长度权威归章级 wordcount；
传入 --min/--max 按未知参数退 2。

--fail-on=block（默认）hard/verify 任一存在即 1；hard 仅 hard；all 含 editorial（审计模式）。
Exit codes: 0=无未决阻断, 1=存在未决阻断(hard/verify), 2=执行/输入错误。

After this script, semantic review lives in the current session's full-chapter
read (drafted phase, review.md): motivation / promise delivery / scene continuity.
No numbered question system — reactions and consequences may be implicit or
delayed; do not demand an immediate reaction line after every action.

Report-only: findings go to the review queue, never auto-deleted.`;

// ---- 工程词词表（与 guyin-check-degeneration.js META_TIER1/TIER2 同源，beat 级全 blocking）----
const META_RE = /细纲|情节点|卷纲|功能标签|目标情绪|字数目标|章首钩子|章尾钩子|第[一二三四五六七八九十百千万两0-9]+章|本章|这一章|上一章|下一章|上章|下章|前一章|后一章|前文|后文|伏笔|读者|大纲|任务描述/;

// ---- 跳写模式（「此处省略 / 一番……之后」的确定性版）----
// v3-A1 二分：括号省略是显式「未完成输出」（blocking）；时间压缩词是通用概述笔法，
// 合法概述与「跳过必须展示的事件」须语义区分（完整章审读 / 编排层判读），只报 advisory。
const SKIP_WRITE_PLACEHOLDER = [
  { re: /[（(](此处|以下|这里|下文|后续)?\s*(省略|略)(去|过)?[^）)]{0,10}[）)]/, label: '括号省略' },
];
const SKIP_WRITE_TIME_COMPRESS = [
  { re: /一番[^，。]{0,8}之后/, label: '一番…之后' },
  { re: /随后便[是了]/, label: '随后便是/了' },
  { re: /不多时[，,便]/, label: '不多时' },
  { re: /(经过|度过)了?[^，。]{0,6}(时光|时间|岁月|日夜|工夫)/, label: '经过…时间' },
];

// ---- 心理动词（引号外叙述行中的心理活动标记，半自动计数）----
// 只在引号外（stripQuoted 后的叙述行）匹配；对话内的「想」「觉得」是角色台词不算。
// SP2（docs/11 §一）：前后字符类加 "——直引号对白外判定同样生效。
// Fw-05（docs/12）拆分：「知道／明白／清楚／疑惑／纳闷」是限知视角的合法认知半句
//（"他知道这病几年后会要他爸的命"是信息差叙事，不是心理独白），移出计数表。
// P3.2（docs/P3.2样稿诊断 B3）再拆分：内心动作词与情绪直名词分开计数——
// 心想/思忖等是合法叙述工具，持续的、个性化的内心段落不因本项被抑制；
// 愤怒/恐惧等直接命名情绪＝告知而非展示，保留 show-don't-tell 提示。两表各自 advisory。
const PSYCH_VERBS = /(?<!["「」『』“”‘’《》])(心想(?:道)?|心道|暗道|暗想|暗忖|思忖|寻思|盘算|琢磨|觉得|暗自|内心|心底|心中)(?!["「」『』“”‘’《》])/g;
const EMOTION_LABELS = /(?<!["「」『』“”‘’《》])(愤怒|暴怒|恼怒|惊怒|悲愤|震怒|狂喜|恐惧|惊恐|惊惧|惶恐|绝望|崩溃)(?!["「」『』“”‘’《》])/g;

// ---- 对话行判定（含中文引号/书名号包裹的行视为对话行）----
// SP2（docs/11 §一）：字符类加 "——直引号对白行同样判对话行（dialogue-run 检测覆盖）。
function isDialogueLine(trimmed) {
  return /["「」『』“”'']/  .test(trimmed);
}

// ---- 纯对白行判定（v3-A1）：剥引号后叙述余量 ≤4 字才算纯对白 ----
// 「"走吧。"他提起箱子。」同行已有动作——不再计入 dialogue-run 连排，
// 也不再误报「无动作/表情/环境插入」。叙述余量含标点。
function isPureDialogueLine(trimmed) {
  if (!isDialogueLine(trimmed)) return false;
  const narrative = stripQuoted(trimmed).replace(/\s/g, '');
  return narrative.length <= 4;
}

// ---- 去引号内容（复用 degeneration.js 的 stripQuoted 逻辑）----
function stripQuoted(text) {
  return text
    .replace(/「[^」]*」/g, '')
    .replace(/『[^』]*』/g, '')
    .replace(/【[^】]*】/g, '')
    .replace(/“[^”]*”/g, '')
    .replace(/'[^']*'/g, '')
    .replace(/"[^"]*"/g, '')
    .replace(/'[^']*'/g, '');
}

function compact(text) {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length > 80 ? `${normalized.slice(0, 77)}...` : normalized;
}

// ---- 参数解析 ----
const options = {
  json: false,
  failOn: 'block', // 处置分类口径（lib/guyin-handling.js）：hard/verify 计 1；editorial 走判读/分诊
  ban: [],
  monoLimit: 2,
  file: null,
};

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
      options.failOn = handling.parseFailOn(arg.slice('--fail-on='.length), 'block');
    } catch (error) {
      die(error.message);
    }
  } else if (arg.startsWith('--ban=')) {
    const raw = arg.slice('--ban='.length);
    options.ban = raw.split(',').map((s) => s.trim()).filter(Boolean);
  } else if (arg.startsWith('--mono-limit=')) {
    const n = Number(arg.slice('--mono-limit='.length));
    if (!Number.isFinite(n) || n < 0) die(`--mono-limit must be a non-negative number`);
    options.monoLimit = n;
  } else if (arg === '-h' || arg === '--help') {
    process.stdout.write(`${USAGE}\n`);
    process.exit(0);
  } else if (arg.startsWith('-')) {
    die(`Unknown option: ${arg}`);
  } else {
    options.file = arg;
  }
}

if (!options.file) die('No file provided');

// ---- 读取文件 ----
const filePath = path.resolve(options.file);
let input;
try {
  input = fs.readFileSync(filePath, 'utf8');
} catch (error) {
  console.error(`${options.file}: unable to read (${error.message})`);
  process.exit(2);
}

// ---- 解析行（剔除 frontmatter 和 markdown 标题行）----
const lines = input.split(/\r?\n/);
const content = [];
let inFrontMatter = lines[0] !== undefined && lines[0].trim() === '---';

for (let i = 0; i < lines.length; i += 1) {
  const line = lines[i];
  const trimmed = line.trim();
  if (inFrontMatter) {
    if (i > 0 && trimmed === '---') inFrontMatter = false;
    continue;
  }
  if (/^\s*#{1,6}\s/.test(line)) continue;
  if (trimmed === '') continue;
  content.push({ text: line, trimmed, lineNo: i + 1 });
}

const findings = [];

// ---- ① 工程词检测（meta-leak-beat，blocking）----
// beat 级全 blocking：beat 太短，工程词绝不该出现（对话行内的故事内讨论属例外，降 advisory）
for (const { trimmed, lineNo } of content) {
  const m = META_RE.exec(trimmed);
  if (m) {
    const dialogue = isDialogueLine(trimmed);
    findings.push({
      line: lineNo,
      column: m.index + 1,
      type: 'meta-leak-beat',
      severity: dialogue ? 'advisory' : 'blocking',
      // 对话行内变体：写手/编剧题材角色在故事内讨论创作可能合法——语义核实（verify），
      // 非对话行保持表默认 hard。
      handling: dialogue ? handling.VERIFY : undefined,
      message: `工程词泄漏：「${m[0]}」是写作流水线术语，beat 正文里不该出现。`,
      excerpt: compact(trimmed.slice(Math.max(0, m.index - 6), m.index + 18)),
      checkId: 'Q1',
    });
  }
}

// ---- ② 禁止项检测（ban-violation，blocking）----
if (options.ban.length > 0) {
  for (const { trimmed, lineNo } of content) {
    for (const ban of options.ban) {
      const idx = trimmed.indexOf(ban);
      if (idx >= 0) {
        findings.push({
          line: lineNo,
          column: idx + 1,
          type: 'ban-violation',
          severity: 'blocking',
          message: `禁止项「${ban}」出现在 beat 正文中。`,
          excerpt: compact(trimmed.slice(Math.max(0, idx - 6), idx + ban.length + 12)),
          checkId: 'Q4Q5',
        });
      }
    }
  }
}

// ---- ③ 跳写检测（skip-write）----
// 括号省略＝显式未完成输出，blocking；时间压缩词＝概述笔法观测，advisory（v3-A1）。
for (const { trimmed, lineNo } of content) {
  for (const { re, label } of SKIP_WRITE_PLACEHOLDER) {
    const m = re.exec(trimmed);
    if (m) {
      findings.push({
        line: lineNo,
        column: m.index + 1,
        type: 'skip-write',
        severity: 'blocking',
        message: `括号省略（${label}）：未完成输出直接进了正文——把省略的过程写成具体场景。`,
        excerpt: compact(trimmed.slice(Math.max(0, m.index - 6), m.index + 24)),
        checkId: 'Q6-skipwrite',
      });
      break;
    }
  }
  for (const { re, label } of SKIP_WRITE_TIME_COMPRESS) {
    const m = re.exec(trimmed);
    if (m) {
      findings.push({
        line: lineNo,
        column: m.index + 1,
        type: 'skip-write',
        severity: 'advisory',
        // 时间压缩词变体：概述笔法观测，editorial（括号省略变体保持表默认 hard）。
        handling: handling.EDITORIAL,
        message: `时间压缩词命中（${label}）：这是概述笔法的观测值，不必然是错误——是否跳过了必须展示的事件须结合本章「必须发生」的语义判断（完整章审读／编排层判读），不靠删词修复。`,
        excerpt: compact(trimmed.slice(Math.max(0, m.index - 6), m.index + 24)),
        checkId: 'Q6-skipwrite',
      });
      break;
    }
  }
}

// ---- ④ 连续纯对白检测（dialogue-run，advisory，半自动）----
// 只累计纯对白行（剥引号后叙述余量 ≤4 字）；同行含动作的行是合法插入，断开连排（v3-A1）。
let dialogueStreak = 0;
let streakStart = null;
function reportDialogueRun() {
  if (dialogueStreak >= 4) {
    findings.push({
      line: streakStart,
      column: 1,
      type: 'dialogue-run',
      severity: 'advisory',
      count: dialogueStreak,
      message: `连续 ${dialogueStreak} 行纯对白（剥引号后叙述余量 ≤4 字）——观测值，需结合上下文判断：纯对话场景可成立；若读感单调，可在行间插入动作/环境（半自动检测）`,
      excerpt: '',
      checkId: 'Q2',
    });
  }
}
for (const { trimmed, lineNo } of content) {
  if (isPureDialogueLine(trimmed)) {
    if (dialogueStreak === 0) streakStart = lineNo;
    dialogueStreak += 1;
  } else {
    reportDialogueRun();
    dialogueStreak = 0;
  }
}
reportDialogueRun(); // 文件末尾收尾

// ---- ⑤⑥ 心理/情绪词频计数（mono-count / emotion-tell，advisory，半自动）----
// 内心动作词（心想/思忖…）与情绪直名词（愤怒/恐惧…）分开计数（P3.2 拆分）：
// 内心动作词是合法叙述工具——只报观测值，不抑制持续的、个性化的内心段落；
// 情绪直名词是 show-don't-tell 提示——多数场合用身体动作/环境/言行带出，
// 但情绪峰值处的直陈也可能成立，都须结合上下文判断，不因词频本身定罪。
let monoCount = 0;
let emotionCount = 0;
const monoLines = [];
const emotionLines = [];
for (const { text, trimmed, lineNo } of content) {
  const stripped = stripQuoted(trimmed);
  const m = stripped.match(PSYCH_VERBS);
  if (m) {
    monoCount += m.length;
    monoLines.push(lineNo);
  }
  const e = stripped.match(EMOTION_LABELS);
  if (e) {
    emotionCount += e.length;
    emotionLines.push(lineNo);
  }
}
if (monoCount > options.monoLimit) {
  findings.push({
    line: monoLines[0] || 1,
    column: 1,
    type: 'mono-count',
    severity: 'advisory',
    count: monoCount,
    limit: options.monoLimit,
    message: `引号外内心动作词（心想/思忖/觉得等）命中 ${monoCount} 处（观测值，非独白句数；对话内不计）——持续、个性化的内心段落是合法写法，本项不抑制内心戏；是否堆砌须结合上下文判断，确属堆砌再进改写`,
    excerpt: '',
    checkId: 'Q3',
  });
}
if (emotionCount > options.monoLimit) {
  findings.push({
    line: emotionLines[0] || 1,
    column: 1,
    type: 'emotion-tell',
    severity: 'advisory',
    count: emotionCount,
    limit: options.monoLimit,
    message: `引号外情绪直名词（愤怒/恐惧/绝望等）命中 ${emotionCount} 处（观测值；对话内不计）——直接命名情绪＝告知而非展示，多数场合改用身体动作/环境/言行带出；情绪峰值处的直陈可以成立，结合上下文判断`,
    excerpt: '',
    checkId: 'Q3',
  });
}

// ---- 输出 ----
findings.sort((a, b) => a.line - b.line || a.column - b.column);

try {
  handling.finalizeFindings(findings, 'guyin-check-beat.js');
} catch (error) {
  die(error.message);
}

if (options.json) {
  const scriptChecks = findings.map((f) => f.checkId);
  process.stdout.write(`${JSON.stringify({
    findings,
    files_scanned: [require('path').resolve(options.file)],
    summary: {
      scriptHandled: [...new Set(scriptChecks)],
      semanticReview: 'full-chapter-read (drafted review.md)',
      banList: options.ban,
    },
  }, null, 2)}\n`);
} else {
  for (const f of findings) {
    const excerptStr = f.excerpt ? ` (${f.excerpt})` : '';
    console.log(`${filePath}:${f.line}:${f.column}: [${handling.label(f)}] ${f.type}: ${f.message}${excerptStr}`);
  }
  // 末尾 summary：脚本已查项 + 语义审读去向
  const handled = [...new Set(findings.map((f) => f.checkId))];
  console.log('');
  console.log(`[summary] 脚本已查：${handled.length > 0 ? handled.join(', ') : '（无报警）'}`);
  console.log(`[summary] 语义审读（动机/兑现/承接）归当前会话 drafted 阶段全文回看（review.md）——反应与后果可隐含可延迟`);
}

process.exit(handling.gateTripped(findings, options.failOn) ? 1 : 0);
