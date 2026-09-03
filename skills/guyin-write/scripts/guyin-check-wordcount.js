#!/usr/bin/env node
'use strict';

// guyin-check-wordcount.js — 章字数护栏
//
// 低模型执行层最常崩的是字数：beat 写两百字就收工、拼接缺 beat。本脚本做章级兜底
// （beat 级由写作卡的字数指令管，两层各守各的）：
//   - chapter-too-short (blocking)：去空白字数 < min（目标驱动：同项目细纲「字数目标」
//     双口径 J1——区间 X-Y 取下限 X（区间下限本身是作者接受的最低值不再打折），
//     单值 T 取 T×90%；细纲缺失或无字数目标 → 缺省 3000，与 workflow-chapter 既有
//     兜底统一；--min 显式覆盖。J1 前的旧实现把「3000-3300」截为 3000 再打九折＝
//     2700 达标线，2712-2754 全部假达标，正是报告 2.6 规格偏差的机制根源）
//   - chapter-too-long  (advisory)：> max（默认 6000，提示核对 beat 切分是否失守；
//     上限维持缺省不动——报告缺陷全在缺口侧，区间上限卡点属另一件事，不做防过度设计）
//   - chapter-length-uniform (advisory，--batch)：最近 3 章实绩 max−min < 400（J2，
//     E8 均质＝平整感信号，报告 5.2 验收线指标；--uniform-gap=N 覆盖缺省——400 锚定
//     ~3000 字章型的本书尺度，不建每书配置件）
// 度量：剔除 YAML frontmatter 与 markdown 标题行后的去空白字符数（与 doc-budget 同口径）。
// 目录输入时只检 第*.md（三位章号命名约定），其余文件忽略。
// 字数标准是每本书的（细纲驱动），框架硬编码宽带必然错配——2014 字对 3000 目标是 67%
// 却能落在旧宽带 2000-6000 上过检，正是 ch63 事故的机械漏洞（docs/06 §二 O3）。
// Report-only，永不改写——报警项一律拦为待审（改写卡或豁免），同其他检查脚本。
//
// 同步注释契约（O3/D1）：本脚本与 guyin-setup 模板 hook（templates/long/.claude/hooks/
// guyin-hook.js 的 resolveChapterMin）是同一目标驱动逻辑的两份实现——hook 为部署件随项目走、
// 脚本在技能库，运行时路径不保证可达，无法抽公共模块；改一处必改另一处（比值/缺省值/细纲探测口径）。

const fs = require('fs');
const path = require('path');

const USAGE = `Usage: node guyin-check-wordcount.js [--json] [--fail-on=blocking|all] [--min=N] [--max=N] [--batch] [--uniform-gap=N] <file|dir>...

Chapter wordcount guard for low-model prose assembly:
  - chapter-too-short (blocking): visible chars < min (default: outline
    target from 大纲/细纲_第XXX章.md — range X-Y takes lower bound X,
    single value T takes T x 90%; fallback 3000; --min overrides)
  - chapter-too-long  (advisory): visible chars > --max (default 6000)
Visible chars = non-whitespace characters after stripping YAML frontmatter and
markdown heading lines. Directory input scans 第*.md only.
--batch: per-chapter checks run as usual, then a batch-variance check on the
3 highest-numbered chapters: max-min < 400 visible chars → advisory
chapter-length-uniform (E8; --uniform-gap=N overrides; skipped silently with
fewer than 3 numbered chapters).
--fail-on=blocking exits 1 only on blocking findings; default --fail-on=all exits 1 on any.
Report-only: findings go to the review queue (rewrite card or exemption), never auto-deleted.`;

const options = { json: false, failOn: 'all', min: null, max: 6000, batch: false, uniformGap: 400, inputs: [] };

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
  } else if (arg === '--batch') {
    options.batch = true;
  } else if (arg.startsWith('--uniform-gap=')) {
    const n = Number(arg.slice('--uniform-gap='.length));
    if (!Number.isFinite(n) || n <= 0) die(`--uniform-gap must be a positive number`);
    options.uniformGap = n; // 仅 --batch 下生效（J2 缺省 400，他书尺度可覆盖）
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
if (options.min !== null && options.min >= options.max) die(`--min (${options.min}) must be smaller than --max (${options.max})`);

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

// 剔除 frontmatter 与标题行后的去空白字符数（与上方度量说明同口径）。
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

// ---------- O3 目标驱动：--min 未显式给定时，探测同项目细纲「字数目标」 ----------

const DEFAULT_MIN = 3000;
const OUTLINE_TARGET_RATIO = 0.9;

function chapterNumberOf(base) {
  const m = /^第0*(\d+)章.*\.md$/.exec(base);
  return m ? Number(m[1]) : null;
}

// 从正文文件向上（≤3 层）找同级 大纲/ 目录里的 细纲_第XXX章*.md（容忍补零差异与标题后缀）。
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

// 每文件解析 blocking 下限：--min 显式指定优先；否则细纲「字数目标」双口径（区间 X-Y
// 取下限 X 不打折；单值 T 取 T×90%——J1，docs/07 §二：区间正则含全角横线变体，须先于
// 单值正则试配否则「3000-3300」被截为 3000）；再否则缺省 3000。
// X3（docs/10 §一）：情绪落点行标「跨章兑现」的章，已解析下限再降 10%——跨章 beat
// 容器承接上章弧线，字数门槛特殊放宽（本计划唯一动检查逻辑处）。
function resolveMin(file) {
  if (options.min !== null) return { min: options.min, origin: '--min 显式指定' };
  const num = chapterNumberOf(path.basename(file));
  if (num !== null) {
    const outline = locateOutline(file, num);
    if (outline) {
      const text = fs.readFileSync(outline, 'utf8');
      // X3：跨章兑现检测——情绪落点行含「跨章兑现」时，下限降 10%
      const crossChapter = text.split(/\r?\n/).some((line) =>
        line.includes('情绪落点') && line.includes('跨章兑现'));
      let result = null;
      for (const line of text.split(/\r?\n/)) {
        if (line.includes('字数目标')) {
          const range = /(\d+)\s*[-—－~～至]\s*(\d+)/.exec(line);
          if (range) {
            const low = Number(range[1]);
            result = { min: low, origin: `细纲区间下限 ${low}（目标 ${range[1]}-${range[2]}，区间不再打折 J1）` };
            break;
          }
          const m = /(\d+)/.exec(line);
          if (m) {
            const target = Number(m[1]);
            result = { min: Math.round(target * OUTLINE_TARGET_RATIO), origin: `细纲目标 ${target} × 90%` };
            break;
          }
        }
      }
      if (result && crossChapter) {
        const reduced = Math.round(result.min * 0.9);
        return { min: reduced, origin: `${result.origin} × 90%（跨章兑现 X3）` };
      }
      if (result) return result;
    }
  }
  return { min: DEFAULT_MIN, origin: `缺省 ${DEFAULT_MIN}（细纲缺失或无字数目标）` };
}

const files = [];
for (const input of options.inputs) files.push(...collectFiles(input));

const findings = [];
const chapterCounts = new Map(); // J2：章号 → { count, file }，批方差取最近 3 章用
let minSeen = Infinity;
let maxSeen = 0;
for (const file of files) {
  const text = fs.readFileSync(file, 'utf8');
  const count = visibleChars(text);
  const { min, origin } = resolveMin(file);
  const chapterNum = chapterNumberOf(path.basename(file));
  if (chapterNum !== null) chapterCounts.set(chapterNum, { count, file });
  // 目标极大的书保 advisory 语义（正常网文章目标 2000-4500 不触发）。
  const max = Math.max(options.max, min + 100);
  if (count < min) {
    findings.push({
      file,
      line: 1,
      column: 1,
      type: 'chapter-too-short',
      severity: 'blocking',
      count,
      limit: min,
      message: `章字数 ${count} 低于下限 ${min}（${origin}；低模型 beat 缺斤短两或拼接缺 beat；补写缺口 beat，勿机械注水）`,
      excerpt: '',
    });
  } else if (count > max) {
    findings.push({
      file,
      line: 1,
      column: 1,
      type: 'chapter-too-long',
      severity: 'advisory',
      count,
      limit: max,
      message: `章字数 ${count} 超过上限 ${max}（核对 beat 切分与细纲密度，是否该拆章）`,
      excerpt: '',
    });
  }
  minSeen = Math.min(minSeen, min);
  maxSeen = Math.max(maxSeen, max);
}

// ---------- J2 批内方差检查（--batch，docs/07 §二 J2） ----------
// 逐章检查照常运行——--batch 是增量不是替换，J3 批收尾一步拿到「达标率＋方差」。
// 样本取传入文件中章号最大的 3 章；不足 3 章静默跳过（样本不足不判）。
if (options.batch) {
  const recent = [...chapterCounts.entries()].sort((a, b) => a[0] - b[0]).slice(-3);
  if (recent.length === 3) {
    const counts = recent.map(([, v]) => v.count);
    const spread = Math.max(...counts) - Math.min(...counts);
    if (spread < options.uniformGap) {
      findings.push({
        file: recent[2][1].file,
        line: 1,
        column: 1,
        type: 'chapter-length-uniform',
        severity: 'advisory',
        count: counts,
        limit: options.uniformGap,
        message: `章长均质：最近 3 章实绩 max−min = ${spread} 字 < ${options.uniformGap}（E8 平整感信号，报告 5.2 验收线指标）——节律应有张弛，核对批内各章是否同一模板填充；本书刻意均质可豁免（登记待审，或 --uniform-gap=N 调本书尺度）`,
        excerpt: '',
      });
    }
  }
}

if (options.json) {
  process.stdout.write(`${JSON.stringify({ findings }, null, 2)}\n`);
} else {
  for (const f of findings) {
    console.log(`${f.file}: [${f.severity}] ${f.type}: ${f.message}`);
  }
  if (findings.length === 0 && files.length > 0) {
    console.log(`wordcount: ${files.length} file(s) within limits [${Number.isFinite(minSeen) ? minSeen : options.min}, ${maxSeen || options.max}]`);
  }
}

const tripped = findings.filter((f) => (options.failOn === 'blocking' ? f.severity === 'blocking' : true));
process.exit(tripped.length > 0 ? 1 : 0);
