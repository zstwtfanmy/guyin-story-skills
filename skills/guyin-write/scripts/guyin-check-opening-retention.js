#!/usr/bin/env node
'use strict';

// guyin-check-opening-retention.js — 开篇留存门（Fw-01，docs/12 整改计划；v3-B1 粒度统一）
//
// 事故根因：追影 ch001-003 细纲没有任何「主角当下要干什么/凭什么看得下去」的运行时槽位，
// 主角目标是内向的「确认自己回到了什么时候」，开篇三章无外向抓手、无能力实证、无情绪热度，
// 留存设计全靠作者临场。本脚本把 consult/opening-design.md 的开篇知识
// （主角目标+卖点 / 1000 字内实证 / 三章内基点）接成落盘硬门。
//
// 仅对文件名 细纲_第00N章（N=1-3）生效；其余章号静默 exit 0（黄金三章契约不外推）。
// 四字段（定义唯一权威在 references/细纲协议.md「黄金三章附加契约」节）：
//   当下目标 / 能力实证 / 情绪温度 / 即兑钩子
//
// v3-B1（任务书 §5 B1）即兑钩子粒度统一——「每章强迫造一笔」改「前三章整体至少一笔」：
//   - 每章即兑钩子行仍必填（行在值实），值三选一标注角色：
//       承担（须含「兑现：第N章」显式字段）/ 承接（引用承担章的钩子）/ 不承担（说明回报在哪章）
//     未标注角色的旧格式若含「兑现：第N章」按承担处理；
//   - 兑现字段只认显式「兑现：第N章」——行内任意「第N章」不再冒充兑付（B1 点名）；
//   - 窗口：默认 ≤5（开篇约定现行窗口，不是全题材文学定律）；行内「窗口：第N章」为作者
//     显式约定的特殊开篇窗口，按 N 放宽；
//   - 整体校验：同批输入含 ≥2 个黄金三章细纲时，三章至少一章有效承担；单章输入只做
//     结构校验（整体校验留给批量落盘门，不强迫单章造钩子）。
//
// 情绪温度（B1）：热/怒/笑只是示例不是全集——恐惧、好奇、怜惜、荒诞、关系兴趣等经
// 具体情节成立的回报同样合法，选型对照 设定/题材定位.md 主要阅读回报；机械只查
// 落点声明存在，不判情绪词合不合法（hint 文案引导）。
//
// 存量策略：只拦新建/修订 ch001-003 细纲的落盘门，存量章不追溯（同 outline-slots）。
// Report-only，永不改写——报警一律拦为待审，补字段后重检，同其他检查脚本。

const fs = require('fs');
const path = require('path');

const USAGE = `Usage: node guyin-check-opening-retention.js [--json] [--fail-on=blocking|all] <细纲文件...>

Golden-three-chapters retention gate (Fw-01, docs/12; v3-B1 granularity):
  Only active for 细纲_第00N章 with N=1-3; other chapters pass silently.
  blocking opening-retention-missing:
    - any of 当下目标/能力实证/情绪温度/即兑钩子 line missing, empty, 「无」, or {{placeholder}}
    - 即兑钩子 role: 承担 (must carry 显式「兑现：第N章」; inline bare 第N章 no longer
      counts as payoff) / 承接 (references the carrying chapter) / 不承担 (states
      which chapter carries the payoff)
    - payoff chapter must be <= window (default 5; explicit 「窗口：第N章」 in the
      line widens it — author-declared special opening, B1)
    - when 2+ golden-chapter files are given in one run: at least one chapter
      among them carries a valid 承担 (whole-opening granularity, not per-chapter)
Field semantics live in references/细纲协议.md §黄金三章附加契约; semantic quality
(外向目标/真热度) is enforced by self-check card Q9-Q11, not here.
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

if (options.inputs.length === 0) die('No outline files provided');

// 四留存字段：key=行内标记，hint=缺失/空值时报警文案里的要求。
// v3-B1：情绪温度不再是 热/怒/笑 封闭集——按 设定/题材定位.md 主要阅读回报选型，
// 恐惧/好奇/怜惜/荒诞/关系兴趣经具体情节成立即合法；hint 只引导不封闭值域。
const RETENTION_FIELDS = [
  {
    key: '当下目标',
    hint: '主角本章外向、可执行、读者可见动作的目标（「确认自己回来了」这类内向状态判不合格）',
  },
  {
    key: '能力实证',
    hint: '一次可被读者指认的事件展示（只展示，禁止解释来源；1000 字内落第一下）',
  },
  {
    key: '情绪温度',
    hint: '本章至少一次落点情绪的事件（热/怒/笑/惧/奇/悯/荒诞感/关系兴趣——对照 设定/题材定位.md 主要阅读回报选型，经具体情节成立；纯冷认证不合格）',
  },
  {
    key: '即兑钩子',
    hint: '近期回报的角色声明：承担（兑现：第N章，N≤窗口）／承接（引用承担章）／不承担（说明回报在哪章）——前三章整体至少一章承担，不强迫每章造钩子（v3-B1）',
  },
];
const DEFAULT_PAYOFF_WINDOW = 5;

function firstLineWith(lines, predicate) {
  for (let i = 0; i < lines.length; i += 1) {
    if (predicate(lines[i])) return { text: lines[i], line: i + 1 };
  }
  return null;
}

// 取「字段名：值」的值；去列表符号与 markdown 粗体。空白/「无」起头/{{占位}} 都算未填。
function fieldValue(line, key) {
  const m = new RegExp(`${key}[：:]\\s*(.*)$`).exec(line);
  if (!m) return '';
  return m[1].replace(/^[-*\s]+/, '').replace(/\*/g, '').trim();
}

function valueFilled(value) {
  if (!value) return false;
  if (/^无/.test(value)) return false;
  if (/\{\{/.test(value)) return false;
  return true;
}

// v3-B1 即兑钩子角色解析：
//   承担＝显式「兑现：第N章」（行内任意「第N章」不再冒充兑付，B1 点名）；
//   承接＝值含「承接」并引用承担章；不承担＝值声明回报在别章；
//   未标注角色但含「兑现：第N章」的旧格式按承担处理（向后兼容）。
// 窗口＝显式「窗口：第N章」行内声明（作者特殊开篇约定）＞默认 5。
// 返回 { role: 'carry'|'defer'|'pass'|'undeclared', payoff, window } 或 null（无行）。
function hookRole(hookLine) {
  const payoff = /兑现[^。\n]{0,12}?第\s*0*(\d+)\s*章/.exec(hookLine);
  const windowMatch = /窗口[^。\n]{0,12}?第\s*0*(\d+)\s*章/.exec(hookLine);
  const win = windowMatch ? Number(windowMatch[1]) : null;
  if (payoff) return { role: 'carry', payoff: Number(payoff[1]), window: win };
  if (/不承担/.test(hookLine)) return { role: 'pass', payoff: null, window: win };
  if (/承接/.test(hookLine)) return { role: 'defer', payoff: null, window: win };
  return { role: 'undeclared', payoff: null, window: win };
}

function scanRetention(text) {
  const findings = [];
  const lines = text.split(/\r?\n/);

  const push = (line, message) => {
    findings.push({
      line,
      column: 1,
      type: 'opening-retention-missing',
      severity: 'blocking',
      message,
      excerpt: (lines[line - 1] || '').trim().slice(0, 60),
    });
  };

  let carriesPayoff = false;

  for (const field of RETENTION_FIELDS) {
    const hit = firstLineWith(lines, (l) => l.includes(field.key));
    if (!hit) {
      push(1, `开篇留存字段「${field.key}」行缺失（仅 ch001-003 blocking）——${field.hint}；字段定义见 references/细纲协议.md「黄金三章附加契约」（Fw-01）`);
      continue;
    }
    const value = fieldValue(hit.text, field.key);
    if (!valueFilled(value)) {
      push(hit.line, `开篇留存字段「${field.key}」未填实（空值/「无」/{{占位}} 均判缺失）——${field.hint}（Fw-01）`);
      continue;
    }
    if (field.key === '即兑钩子') {
      const role = hookRole(hit.text);
      const win = role.window || DEFAULT_PAYOFF_WINDOW;
      if (role.role === 'carry') {
        if (role.payoff > win) {
          push(hit.line, `即兑钩子兑现章号第 ${role.payoff} 章 > 窗口第 ${win} 章——近期兑付须落在窗口内（默认 ≤${DEFAULT_PAYOFF_WINDOW}；特殊开篇在行内显式写「窗口：第N章」由作者约定，不自动生成豁免）（Fw-01/v3-B1）`);
        } else {
          carriesPayoff = true;
        }
      } else if (role.role === 'undeclared') {
        push(hit.line, `即兑钩子未声明角色——值须三选一：承担（含「兑现：第N章」，N≤窗口）／承接（引用承担章）／不承担（说明回报在哪章）；前三章整体至少一章承担，本章不承担不强迫造钩子（v3-B1）`);
      }
      // defer / pass：结构合法，整体校验在主循环做（跨章）。
    }
  }

  return { findings, carriesPayoff };
}

const allFindings = [];
let failed = false;
const goldenRuns = [];
let anyCarries = false;

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

  // 仅 ch001-003 生效；章号不可解析或非黄金三章 → 静默（契约不外推，fail-open）。
  const chapterMatch = /^细纲_第0*(\d+)章/.exec(path.basename(abs));
  if (!chapterMatch) continue;
  const chapter = Number(chapterMatch[1]);
  if (chapter < 1 || chapter > 3) continue;

  const { findings, carriesPayoff } = scanRetention(text);
  allFindings.push(...findings.map((f) => ({ file: input, ...f })));
  goldenRuns.push({ input, chapter });
  if (carriesPayoff) anyCarries = true;
}

// v3-B1 整体粒度：同批输入含 ≥2 个黄金三章细纲时，三章中至少一章有效承担近期回报
//（「每章强迫造一笔」改「前三章整体至少一笔」）；单章输入只做结构校验，整体校验
// 留给批量落盘门——单章修订不因整体缺承担而拦。
if (goldenRuns.length >= 2 && !anyCarries) {
  allFindings.push({
    file: goldenRuns[0].input,
    line: 1,
    column: 1,
    type: 'opening-retention-missing',
    severity: 'blocking',
    message: `开篇三章（${goldenRuns.map((g) => `第${g.chapter}章`).join('、')}）无一章承担近期回报——前三章整体至少一章的即兑钩子含「兑现：第N章」（N≤窗口）；其余章可标承接/不承担，不强迫每章造钩子（v3-B1 粒度统一）`,
    excerpt: '',
  });
}

if (options.json) {
  process.stdout.write(`${JSON.stringify({ findings: allFindings }, null, 2)}\n`);
} else {
  for (const f of allFindings) {
    console.log(`${f.file}:${f.line}:${f.column}: [${f.severity}] ${f.type}: ${f.message}`);
  }
  if (allFindings.length === 0 && !failed) {
    console.log(`opening-retention: ${options.inputs.length} file(s) checked, golden-three retention fields present`);
  }
}

if (failed) process.exit(2);
const hasBlocking = allFindings.some((f) => f.severity === 'blocking');
if (options.failOn === 'blocking' ? hasBlocking : allFindings.length > 0) process.exit(1);
