#!/usr/bin/env node
'use strict';

// guyin-check-outline-slots.js — 细纲槽位完整性门（O2，docs/06-卷三开局复盘整改计划.md §二）
//
// 根因一「硬门不查槽位」的封堵：61-63 细纲 beat 化后字段整体丢失，outline-verdict 与
// hook-rotation 对缺失字段都无事可查，缺失零成本。本脚本机械查八槽位（字段定义唯一权威
// 在 references/细纲协议.md，O1）：
//
//   blocking ×5：
//     outline-missing-hook      章尾钩子行缺失 / 无五型 / 无实体 / 无承接章号
//     outline-missing-wordcount 字数目标行缺失或不含数字，或场景与对手戏下限行缺失
//     outline-missing-multiline 情节安排节 / 主线行 / 感情线·关系线行缺失
//     outline-missing-anchor    复沓锚句字段行缺失（值可写「无」）
//     outline-missing-holdback  禁止提前释放字段行缺失（值可写「无」）
//   advisory ×5：
//     outline-missing-scenes    涉及场景清单字段行缺失
//     outline-missing-terms     术语锚点字段行缺失（值可写「无」）
//     outline-missing-contract  契约风险结论行缺失
//     outline-missing-timecheck 时序自检行缺失（P1，docs/07：E1 时序倒错源头封堵，advisory 起步）
//     qiyun-coord-uncovered     气卡坐标区间未覆盖本章（S2，fail-open：无气卡/无区间静默）
//
// 存量策略：只拦落盘门场景（新建/修订细纲落盘前），存量章不追溯（与 hook-rotation 一致）。
// 复沓锚句字段值命中作者性词源归 guyin-check-authority-leak.js 管（锚句洗白在那抓），本脚本只查存在性。
// Report-only，永不改写——报警项一律拦为待审（补槽位后重检），同其他检查脚本。

const fs = require('fs');
const path = require('path');

const USAGE = `Usage: node guyin-check-outline-slots.js [--json] [--fail-on=blocking|all] <细纲文件...>

Chapter outline slot integrity gate (docs/06 §二 O2):
  blocking: hook / wordcount+scene floor / multi-line / anchor line / holdback line
  advisory: scene list / term anchors / contract-risk line / time-check (P1)
            / qiyun-coord coverage (S2, silent when no card or no ranges)
Slot definitions live in guyin-write/references/细纲协议.md (single authority).
Only guards the pre-write gate; existing chapters are not retro-scanned.
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

// 五型钩子（与 hook-rotation 的轮换检测共用类型集，职责分离：那边管已标注章的连续同型，这边管有没有标注）。
const HOOK_TYPES = ['危机', '反转', '期待', '悬念', '情绪'];

function firstLineWith(lines, predicate) {
  for (let i = 0; i < lines.length; i += 1) {
    if (predicate(lines[i])) return { text: lines[i], line: i + 1 };
  }
  return null;
}

// 「承接：第64章…」或完结豁免「承接：无（完结收束）」。
function carryoverOk(hookLine) {
  const m = /承接[:：]\s*(.*)/.exec(hookLine);
  if (!m) return false;
  const rest = m[1].trim();
  if (/完结\s*收束/.test(rest)) return true; // E4：完结章无下章可指
  return /第\s*0*(\d+)\s*章/.test(rest);
}

function entityOk(hookLine) {
  const m = /实体[:：]\s*(.*)/.exec(hookLine);
  return Boolean(m && m[1].trim().length > 0);
}

function typeOk(hookLine) {
  return HOOK_TYPES.some((t) => hookLine.includes(t));
}

function scanSlots(text) {
  const findings = [];
  const lines = text.split(/\r?\n/);

  const push = (type, severity, line, message) => {
    findings.push({
      line,
      column: 1,
      type,
      severity,
      message,
      excerpt: (lines[line - 1] || '').trim().slice(0, 60),
    });
  };

  // --- blocking ×5 ---

  const hook = firstLineWith(lines, (l) => l.includes('章尾钩子'));
  if (!hook) {
    push('outline-missing-hook', 'blocking', 1, '章尾钩子行缺失——细纲契约槽位（beat 版细纲的事故形态，见 references/细纲协议.md）');
  } else {
    if (!typeOk(hook.text)) {
      push('outline-missing-hook', 'blocking', hook.line, '章尾钩子未声明五型（危机/反转/期待/悬念/情绪）——轮换检测与张力判定的机械标注位');
    }
    if (!entityOk(hook.text)) {
      push('outline-missing-hook', 'blocking', hook.line, '章尾钩子缺实体声明（挂在什么具体物/人/话上）——情绪钩子合法（有实体），情绪收束句不合法（无实体）');
    }
    if (!carryoverOk(hook.text)) {
      push('outline-missing-hook', 'blocking', hook.line, '章尾钩子缺承接章号（承接：第X章{事件}；完结章可写「承接：无（完结收束）」）——不指向下一章任何事件的是状态判词不是钩子');
    }
  }

  const wordcount = firstLineWith(lines, (l) => l.includes('字数目标'));
  if (!wordcount || !/\d/.test(wordcount.text)) {
    push('outline-missing-wordcount', 'blocking', 1, '字数目标行缺失或不含数字——章检字数下限的唯一驱动源（目标×90%，guyin-check-wordcount.js）');
  }
  const sceneFloor = firstLineWith(lines, (l) => /场景/.test(l) && /(对手戏|下限)/.test(l));
  if (!sceneFloor) {
    push('outline-missing-wordcount', 'blocking', 1, '场景与对手戏下限行缺失（默认 ≥2 场 / ≥1 对手戏；低压/过场章可声明豁免并写理由）——ch63 单场景 2014 字双缺的事故槽位');
  }

  const arrangement = firstLineWith(lines, (l) => /#{2,4}\s*情节安排/.test(l));
  if (!arrangement) {
    push('outline-missing-multiline', 'blocking', 1, '情节安排节缺失——多线节拍的容器');
  }
  const mainline = firstLineWith(lines, (l) => l.includes('主线'));
  if (!mainline) {
    push('outline-missing-multiline', 'blocking', 1, '主线推进行缺失——多线节拍的主线行');
  }
  const relation = firstLineWith(lines, (l) => l.includes('感情线') || l.includes('关系线'));
  if (!relation) {
    push('outline-missing-multiline', 'blocking', 1, '感情线/关系线行缺失（值可写「无显性，但关系变化为…」）——行必须在，值可弱化');
  }

  const anchor = firstLineWith(lines, (l) => l.includes('复沓锚句'));
  if (!anchor) {
    push('outline-missing-anchor', 'blocking', 1, '复沓锚句字段行缺失（值可写「无」）——锚句是 outline-copy 的免报通道，字段缺失即免报通道失控');
  }

  const holdback = firstLineWith(lines, (l) => l.includes('禁止提前释放'));
  if (!holdback) {
    push('outline-missing-holdback', 'blocking', 1, '禁止提前释放字段行缺失（值可写「无」）——契约层显式声明，防「靠卷纲兜底」的隐性放空');
  }

  // --- advisory ×3 ---

  const scenes = firstLineWith(lines, (l) => l.includes('涉及场景'));
  if (!scenes) {
    push('outline-missing-scenes', 'advisory', 1, '涉及场景清单字段行缺失（喂 cards {{场景锚点行}}）');
  }

  const terms = firstLineWith(lines, (l) => l.includes('术语锚点'));
  if (!terms) {
    push('outline-missing-terms', 'advisory', 1, '术语锚点字段行缺失（值可写「无」）——新术语密集批次的首现台词级锚定位，报告 B8 的机制化');
  }

  const contract = firstLineWith(lines, (l) => l.includes('契约风险'));
  if (!contract) {
    push('outline-missing-contract', 'advisory', 1, '契约风险结论行缺失（判定标准=七检⑥⑦，见 references/细纲协议.md）');
  }

  const timecheck = firstLineWith(lines, (l) => l.includes('时序自检'));
  if (!timecheck) {
    push('outline-missing-timecheck', 'advisory', 1, '时序自检行缺失（出场顺序＝时间顺序/插叙显式标注/beat 时间轴走查）——P1 源头治 E1 时序倒错：细纲即代码，排序 bug 在高保真管线 1:1 传导（ch61 实证）；advisory 起步（O2 先例），Arena 验证后议升 blocking');
  }

  // Q1 情绪落点：目标情绪行只管章级起终点，落点行管章内分布——情绪欠账写前可见、写后可查。
  // 行缺失或「@点N/@情节点N」标记 <3（低压/过场章豁免后 <2）报 advisory；值「无」静默
  // （行必须在值可无，比照锚句哲学）。ch36 起项目侧实践过、06 建制时意外遗漏的资产。
  const emotion = firstLineWith(lines, (l) => l.includes('情绪落点'));
  if (!emotion) {
    push('outline-missing-emotion-beats', 'advisory', 1, '情绪落点行缺失（每章 ≥3 次情绪落点：①情绪@点N 格式）——只有章级目标情绪没有章内分布，情绪欠账写前不可见（ch62 塌方+情绪平的实证形态）；Q1');
  } else {
    const val = emotion.text.replace(/^.*情绪落点[^：:]*[：:]/, '');
    if (val.trim() && !val.trim().startsWith('无')) {
      const marks = (emotion.text.match(/@\s*(?:情节点|点)\s*\d/g) || []).length;
      const exempt = /豁免|低压|过场/.test(emotion.text);
      const floor = exempt ? 2 : 3;
      if (marks < floor) {
        push('outline-missing-emotion-beats', 'advisory', 1, `情绪落点计数不足：仅 ${marks} 个（${exempt ? '低压/过场章下限 2' : '下限 3'}）——补落点或声明豁免；Q1`);
      }
    }
  }

  return findings;
}

// ---------- S2 气卡坐标覆盖预检（docs/07 §二 S2） ----------
// 尊重 06 决策不收编气卡，只加预检：落盘门查该章细纲时顺带扫项目 作者性/气卡.md 的
// 章号区间，本章不落在任何区间 → advisory 停靠提醒刷新，报时贴原文坐标行供作者目检。
// fail-open（v1.1 钉死）：气卡缺失或全文无区间 → 静默跳过——框架模板气卡本无坐标节
// （坐标是项目自定义资产），「无区间也报」会让每个项目每次补纲都假警报。时机：补纲
// 落盘门（新卷首批细纲建档时），早于写章循环第 1 步的卷首检查；第 1 步停靠纪律不动。
const QIYUN_RANGE = /第?\s*(\d+)\s*[-—－~～至]\s*(\d+)?/g;

function locateQiyunCard(outlinePath) {
  let cur = path.dirname(path.resolve(outlinePath));
  for (let depth = 0; depth < 3; depth += 1) {
    const candidate = path.join(cur, '作者性', '气卡.md');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return null;
}

// 逐行扫区间（含全角横线变体）：「61-63」「第61-63章」「61至65」；尾数缺失视为无效区间跳过。
function qiyunRanges(text) {
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    QIYUN_RANGE.lastIndex = 0;
    let m;
    while ((m = QIYUN_RANGE.exec(line)) !== null) {
      const lo = Number(m[1]);
      const hi = m[2] !== undefined ? Number(m[2]) : null;
      if (hi !== null && hi >= lo && line.trim()) rows.push({ lo, hi, line: line.trim() });
    }
  }
  return rows;
}

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
  const findings = scanSlots(text).map((f) => ({ file: input, ...f }));
  allFindings.push(...findings);

  // S2 坐标覆盖预检：仅在章号可解析的细纲文件上跑（气卡缺失/无区间静默，见上）。
  const chapterMatch = /^细纲_第0*(\d+)章/.exec(path.basename(abs));
  if (chapterMatch) {
    const chapter = Number(chapterMatch[1]);
    const cardPath = locateQiyunCard(abs);
    let cardText = null;
    if (cardPath) {
      try {
        cardText = fs.readFileSync(cardPath, 'utf8');
      } catch (error) {
        cardText = null; // 读不了不报（fail-open）
      }
    }
    if (cardText) {
      const rows = qiyunRanges(cardText);
      if (rows.length > 0 && !rows.some((r) => chapter >= r.lo && chapter <= r.hi)) {
        allFindings.push({
          file: input,
          line: 1,
          column: 1,
          type: 'qiyun-coord-uncovered',
          severity: 'advisory',
          message: `气卡坐标未覆盖第 ${chapter} 章（现有区间 ${rows.map((r) => `${r.lo}-${r.hi}`).join('、')}）——新卷开卷先刷新 作者性/气卡.md 坐标节再续写（F5：坐标停旧卷，气韵对位失真）；停靠刷新，原文目检：「${rows[0].line.slice(0, 50)}」`,
          excerpt: '',
        });
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
    console.log(`outline-slots: ${options.inputs.length} file(s) all slots present`);
  }
}

if (failed) process.exit(2);
const hasBlocking = allFindings.some((f) => f.severity === 'blocking');
if (options.failOn === 'blocking' ? hasBlocking : allFindings.length > 0) process.exit(1);
