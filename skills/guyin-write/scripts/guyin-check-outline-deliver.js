#!/usr/bin/env node
'use strict';

// guyin-check-outline-deliver.js — 细纲承诺交付检查（S3+S4，docs/07；R1/K2，docs/08）
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
//   outline-hook-offtail     S4：章尾钩子声明的实体未落在正文最后约 200 字——E2 章
//                            尾稀释：钩子写进了细纲，收尾却被别的画面顶出去
//   outline-anchor-missing   R1：复沓锚句声明的原话未在正文一字不差出现——锚句
//                            免报通道免的是誊抄指控、不免落地义务（该抄的没抄）
//   outline-hook-quote-mismatch R1：章尾钩子行引号语未在正文一字不差出现——钩子
//                            引了一句没人说过的话（S4 幽灵引语的机械封堵）
//   outline-signature-preempted K2：本章正文包含其他章声明的签名句（锚句/钩子引语）
//                            且本章细纲未声明复用——提前释放或归属被抢（S3 跨章
//                            剧透）；已声明复用（复沓仪式）静默
//
// 输入正文文件/目录（章检链第 7 步同源），按章号向上（≤3 层）找 大纲/细纲_第N章*.md。
// 术语表/实体/锚句提取是启发式（先剥括注再切分、破折号/冒号截断、长度闸滤残渣），解析
// 失败一律静默跳过——提取器失手不得变成噪音源（v1.1 注记）；细纲缺失同样静默（契约
// 存在性归落盘门 outline-slots 管，本脚本只查「有契约时履行没」）。
// Report-only，永不改写——报警项一律拦为待审（补写或豁免登记），同其他检查脚本。

const fs = require('fs');
const path = require('path');

const USAGE = `Usage: node guyin-check-outline-deliver.js [--json] [--fail-on=blocking|all] <正文文件|正文目录>...

Outline promise delivery check (docs/07 S3+S4, docs/08 R1/K2), the write-side
twin of outline-slots (which guards "contract signed" pre-write; this guards
"contract honored" post-write):
  outline-term-missing     (advisory) term from the outline's term-anchor line
                           never appears in the prose (the anchor scene is gone)
  outline-term-unanchored  (advisory) term's first occurrence is not inside
                           quotation marks (dialogue-level anchoring missed)
  outline-hook-offtail     (advisory) hook entity absent from the last ~200
                           visible chars (hook pushed out of the ending)
  outline-anchor-missing   (advisory) declared repetition anchor sentence not
                           verbatim in the prose (declared but never delivered)
  outline-hook-quote-mismatch (advisory) hook quotes a line no character ever
                           says verbatim (ghost quote, S4)
  outline-signature-preempted (advisory) prose contains another chapter's
                           declared signature line without declaring reuse
                           (cross-chapter spoiler, S3; declared ritual echoes
                           stay silent)
Heuristic parsing (paren strip, 、-split, dash/colon cut, length gates) fails
silent on malformed values; missing outlines are skipped silently.
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

const TERM_MIN = 2;     // 术语最短字数（单字不是术语）
const TERM_MAX = 10;    // 超过视为解析残渣，静默丢弃
const ENTITY_MAX = 20;  // 钩子实体长度闸（模板残留「{挂在什么具体物…}」在此被滤）
const TAIL_CHARS = 200; // S4 压尾窗口：正文去空白末 N 字

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

// 章尾钩子行「实体：X」→ S4 目标词。分号截断（承接声明在实体后），剥圆括注与花括号
// 模板残留，长度闸滤残渣。解析失败返回 null（静默——无实体归 outline-slots 拦）。
function extractHookEntity(hookLine) {
  const m = /实体[:：]\s*([^；;]+)/.exec(hookLine);
  if (!m) return null;
  const base = m[1].replace(/[（(][^）)]*[）)]/g, '').replace(/[{}]/g, '').trim();
  if (base.length < TERM_MIN || base.length > ENTITY_MAX) return null;
  return base;
}

// ---- R1/K2 签名句供给 ----

const SIG_MIN = 6; // 签名句最短长度（含标点）——短于 6 字的句子通用性太强，跨章匹配全是噪音

// 去空白正文（锚句/引语一字不差判定用：正文排版空白不算差异）。
const stripWs = (s) => s.replace(/\s/g, '');

// 「复沓锚句」行 → 锚句数组（R1 落地检查 + K2 签名句登记）。支持两种形态：
// 引号式（「原话」/“原话”嵌在行内）与落点式（点N：原话；点N：原话——按「点N：/情节点N：」
// 前缀切分后剥前缀）。值「无」起头＝无锚句，静默。长度闸滤残渣，fail-open。
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

// 「章尾钩子」行内引号语 → 钩子引语数组（R1 引语一致性：钩子引用的原话必须有人真的说过）。
function extractHookQuotes(hookLine) {
  if (!hookLine) return [];
  const quotes = [];
  const re = /[「“]([^」”]{6,})[」”]/g;
  let m;
  while ((m = re.exec(hookLine)) !== null) {
    const t = stripWs(m[1]);
    if (t.length >= SIG_MIN && !quotes.includes(t)) quotes.push(t);
  }
  return quotes;
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

  // S4 钩子实体压尾（治 E2：钩子写进了细纲，收尾被别的画面顶出去）
  const hookLine = firstLineWith(lines, (l) => l.includes('章尾钩子'));
  if (hookLine) {
    const entity = extractHookEntity(hookLine);
    if (entity) {
      const tail = body.replace(/\s/g, '').slice(-TAIL_CHARS);
      if (!tail.includes(entity)) {
        push('outline-hook-offtail', `钩子未压尾：章尾钩子实体「${entity}」未落在正文最后 ${TAIL_CHARS} 字内——E2 章尾稀释形态，张力点被收束动作顶出去；末段切回钩子实体或删稀释段`, entity);
      }
    }
  }

  // R1 锚句落地 + 钩子引语一致（治 S4 幽灵引语 + 该抄没抄）
  const bodyWs = stripWs(body);
  const anchors = extractAnchors(lines);
  for (const a of anchors) {
    if (!bodyWs.includes(a)) {
      push('outline-anchor-missing', `复沓锚句未落地：「${a.slice(0, 30)}」未在正文一字不差出现——锚句免报通道免的是誊抄指控、不免落地义务；补写锚句落点或登记执行偏差`, a);
    }
  }
  const hookQuotes = extractHookQuotes(hookLine);
  for (const q of hookQuotes) {
    if (!bodyWs.includes(q)) {
      push('outline-hook-quote-mismatch', `钩子引语幽灵化：章尾钩子引「${q.slice(0, 30)}」正文无人一字不差说过——S4 幽灵引语形态（引的是细纲设计不是角色原话）；改钩子引真实原话或让角色真的说出`, q);
    }
  }
  chapterRecords.push({ num, display, bodyWs, own: new Set([...anchors, ...hookQuotes]) });
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

if (options.json) {
  process.stdout.write(`${JSON.stringify({ findings: allFindings }, null, 2)}\n`);
} else {
  for (const f of allFindings) {
    console.log(`${f.file}:${f.line}:${f.column}: [${f.severity}] ${f.type}: ${f.message}`);
  }
  if (allFindings.length === 0 && !failed) {
    console.log(`outline-deliver: ${filesChecked} chapter(s) contracts honored`);
  }
}

if (failed) process.exit(2);
const hasBlocking = allFindings.some((f) => f.severity === 'blocking');
if (options.failOn === 'blocking' ? hasBlocking : allFindings.length > 0) process.exit(1);
