#!/usr/bin/env node
'use strict';

// guyin-check-outline-deliver.js — 细纲承诺交付检查（S3，docs/07；R1/K2，docs/08；四组化，任务书 §2.1）
//
// 与 outline-slots（落盘门查「契约签了没」）对偶：落盘后查「契约履行没」。高保真管线
// 1:1 传导，细纲承诺不兑现＝设计意图无声丢失：F7「勘合」锚定连续两章「细纲有、正文无」
// （v1 报告 B8 复发），纯纪律无卡点。advisory 为主（引号判定与实体词形变有边界
// 情况，宁报不拦——拦截权归五测试）：
//
//   outline-term-missing     S3：细纲「术语锚点」列出的术语正文完全未出现——锚定戏
//                            整场漏写（B8 的真形态）
//   outline-term-unanchored  S3：术语首现不在引号对白内——首现直接进叙述层就是
//                            「社会脸」式工艺词泄漏的正文版（读者视角无人教过他这个词）
//   outline-anchor-missing   R1：复沓锚句声明的原话未在正文一字不差出现——锚句
//                            免报通道免的是誊抄指控、不免落地义务（该抄的没抄）
//   outline-signature-preempted K2：本章正文包含其他章声明的签名句（仅复沓锚句——
//                            世界内实体原话）且本章细纲未声明复用——提前释放或
//                            归属被抢（S3 跨章剧透）；已声明复用（复沓仪式）静默
//
// 四组化（任务书 §2.1）：章尾钩子字段已废除——outline-hook-offtail /
// outline-hook-quote-mismatch 随之删除；签名句聚合从「锚句+钩子引语」收窄为仅复沓锚句。
// 章尾是否有钩、钩多强，由第一组读者承诺与下一章承接自然决定，审读按阅读体验判断。
//
// 输入正文文件/目录（章检链第 7 步同源），按章号向上（≤3 层）找 大纲/细纲_第N章*.md。
// 术语表/锚句提取是启发式（先剥括注再切分、破折号/冒号截断、长度闸滤残渣），解析
// 失败一律静默跳过——提取器失手不得变成噪音源（v1.1 注记）；细纲缺失同样静默（契约
// 存在性归落盘门 outline-slots 管，本脚本只查「有契约时履行没」）。
// Report-only，永不改写——报警项一律拦为待审（补写或豁免登记），同其他检查脚本。

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const handling = require('./lib/guyin-handling');
const candidateContext = require('./lib/guyin-candidate-context');

const TERM_MIN = 2;     // 术语最短字数（单字不是术语）
const TERM_MAX = 10;    // 超过视为解析残渣，静默丢弃
const SIG_MIN = 6;      // 签名句最短长度
const stripWs = (s) => s.replace(/\s/g, '');

// ---- 显式模式（任务书 §6.1/§6.2：--project/--chapter/--boundary/--outline 对候选）----
function runExplicitDeliver() {
  let ctx;
  try {
    ctx = candidateContext.resolveContext(process.argv.slice(2));
  } catch (e) {
    console.error(e.code === 'CTX_INPUT' ? `输入错误：${e.message}` : String(e));
    process.exit(2);
  }
  const asJson = ctx.flags.has('--json');
  const failOpt = [...ctx.flags].find((f) => f.startsWith('--fail-on='));
  const failOn = failOpt ? handling.parseFailOn(failOpt.slice('--fail-on='.length)) : 'block';
  const findings = [];
  const push = (type, severity, message, excerpt) => findings.push({
    file: ctx.candidateRel, line: 1, column: 1, type, severity, handling: severity, message,
    excerpt: excerpt || undefined,
  });
  const candidateRaw = fs.readFileSync(ctx.candidateAbs, 'utf8');
  const candidateText = candidateRaw.replace(/\r\n/g, '\n');
  const locks = (ctx.boundary && Array.isArray(ctx.boundary.locks)) ? ctx.boundary.locks : [];

  // exact 锁：逐字落地，只统一换行，不洗标点/空白（§4.2/§6.2）。
  for (const lock of locks.filter((l) => l && l.kind === 'exact')) {
    const want = String(lock.text || '').replace(/\r\n/g, '\n');
    if (want && !candidateText.includes(want)) {
      push('candidate-exact-lock-missing', 'hard',
        `exact 锁未逐字落地：「${String(lock.text).slice(0, 30)}」（只统一文件换行；补写或由用户改锁）`,
        String(lock.text).slice(0, 40));
    }
  }
  // semantic 锁：只交人工全文核对，脚本不冒充判定。
  for (const lock of locks.filter((l) => l && l.kind === 'semantic')) {
    push('candidate-semantic-lock-review', 'verify',
      `semantic 锁待人工全文核对（换说法合法、含义变了不合法）：「${String(lock.text || '').slice(0, 40)}」`,
      String(lock.text || '').slice(0, 40));
  }

  // 真实细纲（--outline）：显式给了才查；术语可在叙述或对白清楚引入，不再强制对白首现。
  let outlineChecked = false;
  if (ctx.outlineAbs) {
    outlineChecked = true;
    const lines = fs.readFileSync(ctx.outlineAbs, 'utf8').split(/\r?\n/);
    const termsLine = lines.find((l) => l.includes('术语锚点'));
    if (termsLine) {
      for (const term of extractTerms(termsLine)) {
        if (!candidateText.includes(term)) {
          push('outline-term-missing', 'advisory',
            `细纲声明的新术语「${term}」未在候选出现；可在叙述或对白中清楚引入`, term);
        }
      }
    }
    for (const a of extractAnchors(lines)) {
      if (!candidateText.replace(/\s/g, '').includes(a)) {
        push('outline-anchor-missing', 'advisory',
          `复沓锚句未落地：「${a.slice(0, 30)}」未逐字出现`, a.slice(0, 40));
      }
    }
  }

  const hasLocks = locks.some((l) => l.kind === 'exact' || l.kind === 'semantic');
  const status = findings.some((f) => f.severity === 'hard') ? 'fail'
    : findings.some((f) => f.severity === 'verify') ? 'findings'
    : (outlineChecked || hasLocks) ? 'pass' : 'not_applicable';
  const report = {
    script: 'guyin-check-outline-deliver.js',
    script_sha256: candidateContext.sha256File(__filename),
    status,
    reason: status === 'not_applicable'
      ? '无真实细纲（--outline）且 input 无 exact/semantic 锁：细纲交付检查不适用（不造四组过门）'
      : undefined,
    target: { chapter: ctx.chapter, unit: ctx.unit, candidate: ctx.candidateRel, candidate_sha256: ctx.candidateHash },
    files_scanned: ctx.filesScanned,
    target_files: [ctx.candidateRel],
    reference_files: ctx.referenceFiles.map((f) => f.rel),
    outline: ctx.outlineRel || null,
    findings,
  };
  if (asJson) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else {
    for (const f of findings) console.log(`${f.file}: [${handling.label(f)}] ${f.type}: ${f.message}`);
    console.log(`outline-deliver(explicit): ${status}`);
  }
  // hard/verify 默认阻断（semantic 是“待人工核对”，须经全文回看消费）；editorial audit 另算。
  process.exit(handling.gateTripped(findings, failOn) ? 1 : 0);
}

if (process.argv.slice(2).includes('--project')) runExplicitDeliver();


const USAGE = `Usage: node guyin-check-outline-deliver.js [--json] [--fail-on=block|hard|all] <正文文件|正文目录>...

Outline promise delivery check (docs/07 S3, docs/08 R1/K2), the write-side
twin of outline-slots (which guards "contract signed" pre-write; this guards
"contract honored" post-write):
  outline-term-missing     (advisory) term from the outline's term-anchor line
                           never appears in the prose (the anchor scene is gone)
  outline-term-unanchored  (advisory) term's first occurrence is not inside
                           quotation marks (dialogue-level anchoring missed)
  outline-anchor-missing   (advisory) declared repetition anchor sentence not
                           verbatim in the prose (declared but never delivered)
  outline-signature-preempted (advisory) prose contains another chapter's
                           declared signature line (repetition anchors only —
                           世界内实体原话) without declaring reuse
                           (cross-chapter spoiler, S3; declared ritual echoes
                           stay silent)
Hook rules abolished (任务书 §2.1): 章尾钩子字段已随四组化删除——
outline-hook-offtail / outline-hook-quote-mismatch no longer emitted;
signature aggregation narrowed to repetition anchors only.
Heuristic parsing (paren strip, 、-split, dash/colon cut, length gates) fails
silent on malformed values; missing outlines are skipped silently.
Handling classes (lib/guyin-handling.js; severity 保留 advisory 原值作证据
强度): all four rules verify——细纲承诺 vs 正文履行的契约风险，须上下文核实
(outline-term-missing / outline-term-unanchored / outline-anchor-missing /
outline-signature-preempted).
--fail-on=block|hard|all (default block): block exits 1 on hard or verify;
hard on hard only; all on any finding (audit mode).
Exit codes: 0=无未决阻断; 1=存在未决阻断(hard/verify); 2=执行/输入错误.`;

const options = { json: false, failOn: 'block', inputs: [] };

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

function chapterNumberOf(base) {
  const m = /^第0*(\d+)章.*\.md$/.exec(base);
  return m ? Number(m[1]) : null;
}

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

// 从正文文件向上（≤3 层）找同级 大纲/ 目录里的 细纲_第XXX章*.md（同 wordcount 探测口径）。
function locateOutline(file, num) {
  let cur = path.dirname(path.resolve(file));
  for (let depth = 0; depth < 3; depth += 1) {
    let entries;
    try {
      entries = fs.readdirSync(path.join(cur, '大纲'));
    } catch (e) {
      const parent = path.dirname(cur);
      if (parent === cur) break;
      cur = parent;
      continue;
    }
    const target = entries.find((name) => {
      const m = /^细纲_第0*(\d+)章.*\.md$/.exec(name);
      return m !== null && Number(m[1]) === num;
    });
    if (target) return path.join(cur, '大纲', target);
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return null;
}

function firstLineWith(lines, predicate) {
  for (let i = 0; i < lines.length; i += 1) {
    if (predicate(lines[i])) return lines[i];
  }
  return null;
}

// 正文检体：剥 YAML frontmatter 与 markdown 标题行——章节名含术语不算落地（标题是
// 元数据不是锚定戏），frontmatter 更不该参与首现判定。
function proseBody(text) {
  const lines = text.split(/\r?\n/);
  const body = [];
  let inFront = lines[0] !== undefined && lines[0].trim() === '---';
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (inFront) {
      if (i > 0 && line.trim() === '---') inFront = false;
      continue;
    }
    if (/^\s*#{1,6}\s/.test(line)) continue;
    body.push(line);
  }
  return body.join('\n');
}

// 首现位置是否在引号对白内：双引号与直角引号两组独立布尔（中文正文引号不嵌套，
// 布尔翻转比深度计数抗错位）。引号不配对只影响局部判定——advisory 宁报不拦。
// SP2（docs/11 §一）：直引号 " 同形开闭，走 dq 翻转——Y1 拍板新章统一直引号后，
// 术语首现落在 "..." 内须判对白（迁移前误报 outline-term-unanchored）。
function inQuoteAt(text, pos) {
  let dq = false;
  let corner = false;
  for (let i = 0; i < pos; i += 1) {
    const ch = text[i];
    if (ch === '“') dq = true;
    else if (ch === '”') dq = false;
    else if (ch === '「') corner = true;
    else if (ch === '」') corner = false;
    else if (ch === '"') dq = !dq; // 直引号开闭同形，翻转计数
  }
  return dq || corner;
}

// 「术语锚点」行 → 术语数组。顺序敏感：括注是「谁、在什么情境」锚定说明，其内含
// 顿号，必须先剥（换成顿号防前后术语粘连）再切；破折号/冒号后是说明文字，切去；
// 长度闸 2-10 字 + 含汉字滤解析残渣。值以「无」起头＝无新术语，静默。
function extractTerms(line) {
  const m = /术语锚点[:：]\s*(.*)/.exec(line);
  if (!m) return [];
  const raw = m[1].trim();
  if (!raw || raw.startsWith('无')) return [];
  const cleaned = raw.replace(/[（(][^）)]*[）)]/g, '、');
  const terms = [];
  for (const item of cleaned.split('、')) {
    const base = item.split(/[—:：－~～·,，;；]/)[0].trim();
    if (base.length < TERM_MIN || base.length > TERM_MAX) continue;
    if (!/[\u4e00-\u9fff]/.test(base)) continue;
    if (!terms.includes(base)) terms.push(base);
  }
  return terms;
}

// ---- R1/K2 签名句供给（SIG_MIN/stripWs 常量见文件顶部）----

// 「复沓锚句」行 → 锚句数组（R1 落地检查 + K2 签名句登记——四组化后签名句仅此来源）。
// 支持两种形态：引号式（「原话」/“原话”嵌在行内）与落点式（点N：原话；点N：原话——按
// 「点N：/情节点N：」前缀切分后剥前缀）。值「无」起头＝无锚句，静默。长度闸滤残渣，fail-open。
function extractAnchors(lines) {
  const line = firstLineWith(lines, (l) => l.includes('复沓锚句'));
  if (!line) return [];
  const m = /复沓锚句[:：]\s*(.*)/.exec(line);
  if (!m) return [];
  const raw = m[1].trim();
  if (!raw || raw.startsWith('无')) return [];
  const anchors = [];
  const quoted = raw.match(/[「“]([^」”]{6,})[」”]/g) || [];
  for (const q of quoted) {
    const t = stripWs(q.slice(1, -1));
    if (t.length >= SIG_MIN && !anchors.includes(t)) anchors.push(t);
  }
  if (anchors.length > 0) return anchors;
  const parts = raw.split(/(?=(?:点|情节点)\s*\d+\s*[：:])/);
  for (const part of parts) {
    const base = stripWs(part.replace(/^\s*(?:点|情节点)\s*\d+\s*[：:]\s*/, '').replace(/^[「“]|[」”]$/g, ''));
    if (base.length >= SIG_MIN && /[\u4e00-\u9fff]/.test(base) && !anchors.includes(base)) anchors.push(base);
  }
  return anchors;
}

const allFindings = [];
const chapterRecords = []; // K2 跨章签名句核对用：每章 {num, display, bodyWs, own:Set}
let failed = false;
let filesChecked = 0;

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
  const num = chapterNumberOf(path.basename(abs));
  if (num === null) continue; // 非正文章件静默跳过
  let text;
  try {
    text = fs.readFileSync(abs, 'utf8');
  } catch (error) {
    failed = true;
    if (!options.json) console.error(`${display}: unable to read (${error.message})`);
    continue;
  }
  const outlinePath = locateOutline(abs, num);
  if (!outlinePath) continue; // 细纲缺失静默：契约存在性归落盘门
  let outline;
  try {
    outline = fs.readFileSync(outlinePath, 'utf8');
  } catch (error) {
    continue; // 细纲读不了不报（fail-open，提取器失手不得变成噪音源）
  }
  filesChecked += 1;
  const body = proseBody(text);
  const lines = outline.split(/\r?\n/);
  const push = (type, message, excerpt) => {
    allFindings.push({
      file: display,
      line: 1,
      column: 1,
      type,
      severity: 'advisory',
      message,
      excerpt,
    });
  };

  // S3 术语锚点落地（治 F7/B8：锚定戏漏写、首现未台词级锚定）
  const termsLine = firstLineWith(lines, (l) => l.includes('术语锚点'));
  if (termsLine) {
    for (const term of extractTerms(termsLine)) {
      const pos = body.indexOf(term);
      if (pos < 0) {
        push('outline-term-missing', `细纲设计的锚定戏正文漏写：「${term}」全章未出现（F7/B8 形态——细纲承诺 1:1 传导，不兑现＝设计意图无声丢失；补写锚定戏或回细纲登记执行偏差）`, term);
      } else if (!inQuoteAt(body, pos)) {
        push('outline-term-unanchored', `术语「${term}」首现不在引号对白内——首现直接进叙述层是「社会脸」式工艺词泄漏（读者视角无人教过他这个词）；补一句台词级锚定（谁、在什么情境、说出/写出该术语）`, term);
      }
    }
  }

  // R1 锚句落地（治该抄没抄）
  const bodyWs = stripWs(body);
  const anchors = extractAnchors(lines);
  for (const a of anchors) {
    if (!bodyWs.includes(a)) {
      push('outline-anchor-missing', `复沓锚句未落地：「${a.slice(0, 30)}」未在正文一字不差出现——锚句免报通道免的是誊抄指控、不免落地义务；补写锚句落点或登记执行偏差`, a);
    }
  }
  chapterRecords.push({ num, display, bodyWs, own: new Set(anchors) });
}

// K2 跨章签名句归属（治 S3 跨章剧透）：本章正文包含其他章声明的签名句且本章未声明
// 复用——复沓仪式（各章细纲均声明同一锚句）静默，未声明的跨章出现报 preempted。
// 方向：owner > 本章 = 提前释放；owner < 本章 = 归属被抢/未登记复用。
if (chapterRecords.length > 1) {
  for (const rec of chapterRecords) {
    for (const other of chapterRecords) {
      if (other.num === rec.num) continue;
      for (const sig of other.own) {
        if (rec.own.has(sig)) continue; // 已声明复用（复沓仪式）
        if (rec.bodyWs.includes(sig)) {
          const dir = other.num > rec.num
            ? `提前释放第 ${other.num} 章签名句（S3 跨章剧透——招牌句/核心证据被本章角色提前说出）`
            : `复述第 ${other.num} 章签名句未在本章细纲登记复用（归属被抢或复沓漏登记——复用须在本章「复沓锚句」声明）`;
          allFindings.push({
            file: rec.display,
            line: 1,
            column: 1,
            type: 'outline-signature-preempted',
            severity: 'advisory',
            message: `${dir}：「${sig.slice(0, 30)}」`,
            excerpt: sig,
          });
        }
      }
    }
  }
}

try {
  handling.finalizeFindings(allFindings, 'guyin-check-outline-deliver.js');
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
    console.log(`outline-deliver: ${filesChecked} chapter(s) contracts honored`);
  }
}

if (failed) process.exit(2);
process.exit(handling.gateTripped(allFindings, options.failOn) ? 1 : 0);
