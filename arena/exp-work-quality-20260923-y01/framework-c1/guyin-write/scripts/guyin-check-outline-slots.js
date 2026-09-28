#!/usr/bin/env node
'use strict';

// guyin-check-outline-slots.js — 细纲槽位完整性门（O2，docs/06 §二；四组化，任务书 §2.1）
//
// 根因一「硬门不查槽位」的封堵：61-63 细纲 beat 化后字段整体丢失，outline-verdict 与
// hook-rotation 对缺失字段都无事可查，缺失零成本。本脚本机械查四组协议区块与保留行
//（字段定义唯一权威在 references/细纲协议.md，O1）：
//
//   blocking ×7（四组协议区块 + 保留行，任务书 §2.1 四组化）：
//     outline-missing-group-1   「一、本章要交付什么」区块缺失
//     outline-missing-group-2   「二、人为何这样行动」区块缺失
//     outline-missing-group-3   「三、场景如何承接」区块缺失
//     outline-missing-group-4   「四、哪些不能擅改」区块缺失
//     outline-missing-wordcount 字数目标行缺失或不含数字（章检字数下限唯一驱动源）
//     outline-missing-anchor    复沓锚句字段行缺失（值可写「无」）
//     outline-missing-holdback  禁止提前释放字段行缺失（值可写「无」）
//   advisory ×3：
//     outline-missing-terms     术语锚点字段行缺失（值可写「无」）
//     qiyun-coord-uncovered     气卡坐标区间未覆盖本章（S2，fail-open：无气卡/无区间静默）
//     outline-instruction-echo  写作指令区与前章归一化逐字相同且非「无」（B2：批次不变量
//                               应上移 大纲/批次公约.md，逐章复读=指令放错层；三章同填「无」合法）
//   advisory ×1（v3-A3，任务书 §4 A3）：
//     outline-genre-contract-missing 设定/题材定位.md 缺失/必要节缺/占位未实例化——
//                               第一组「读者承诺」的对照依赖文件；只查结构不打分（不是
//                               genre-fit 评分器），「未定」「不适用＋说明」是合法显式决定放行
//
// 已废除槽位（任务书 §2.1：删掉的栏目不能仍由脚本强制补回）：章尾钩子（五型/实体/承接）、
// 多线节拍（情节安排节/主线/感情线行）、涉及场景清单、契约风险结论行、时序自检行、
// 情绪落点、场景与对手戏下限——新格式细纲无这些字段不再报错；存量旧格式细纲不追溯
//（修订该章时按四组重写）。
//
// 存量策略：只拦落盘门场景（新建/修订细纲落盘前），存量章不追溯（与 hook-rotation 一致）。
// 复沓锚句字段值命中作者性词源归 guyin-check-authority-leak.js 管（锚句洗白在那抓），本脚本只查存在性。
// Report-only，永不改写——报警项一律拦为待审（补槽位后重检），同其他检查脚本。

const fs = require('fs');
const path = require('path');
const handling = require('./lib/guyin-handling');

const USAGE = `Usage: node guyin-check-outline-slots.js [--json] [--fail-on=block|hard|all] <细纲文件...>

Chapter outline slot integrity gate (docs/06 §二 O2; four-group contract, 任务书 §2.1):
  hard: outline-missing-group-1..4 (四组协议区块：本章要交付什么/人为何这样行动/
        场景如何承接/哪些不能擅改——loose heading match, 缺哪组报哪组)
        / outline-missing-wordcount (字数目标行存在且含数字)
        / outline-missing-anchor (复沓锚句行) / outline-missing-holdback (禁止提前释放行)
  editorial: outline-missing-terms (术语锚点行，值可「无」)
            / qiyun-coord coverage (S2+Y2: scans 作者性/气卡.md and
              设定/气韵卡.md, only lines containing 当前; silent when no
              card or no such line — volume-plan rows don't count)
            / instruction-echo (B2: instruction block identical to previous
              chapter's, non-「无」— batch invariants belong in 大纲/批次公约.md)
  verify: genre-contract-missing (v3-A3: 设定/题材定位.md absent or its
              读者契约 / 终局底牌与升级台阶 sections missing/placeholder —
              structure-only dependency check, NOT a genre-fit scorer;
              「未定」/「不适用＋说明」are legal explicit decisions)
Abolished slots (任务书 §2.1 — deleted fields must not be forced back):
  章尾钩子 / 多线节拍（情节安排·主线·感情线）/ 涉及场景清单 / 契约风险结论行 /
  时序自检行 / 情绪落点 / 场景与对手戏下限 — legacy outlines are not retro-scanned.
Slot definitions live in guyin-write/references/细纲协议.md (single authority).
Only guards the pre-write gate; existing chapters are not retro-scanned.
Handling classes (lib/guyin-handling.js; severity 保留原值作证据强度):
  hard     = outline-missing-group-1..4 / -wordcount / -anchor / -holdback
             (槽位缺失＝确定工程错误，细纲不完整)
  verify   = outline-genre-contract-missing (依赖缺件，须核实)
  editorial= outline-missing-terms / qiyun-coord-uncovered /
             outline-instruction-echo (表达观察)
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

if (options.inputs.length === 0) die('No outline files provided');

// 四组协议区块（任务书 §2.1 四组化）：标题匹配宽松——##~###### 任一级、「一/1」类数字
// 变体、「、/．/.」分隔符均可；缺哪组报哪组（hard）。beat 切分不是细纲格式——字段整体
// 缺失＝设计意图无声丢失（61-63 实证），四组齐备是落盘门的底线。
const GROUP_BLOCKS = [
  { id: 1, title: '本章要交付什么', label: '一、本章要交付什么' },
  { id: 2, title: '人为何这样行动', label: '二、人为何这样行动' },
  { id: 3, title: '场景如何承接', label: '三、场景如何承接' },
  { id: 4, title: '哪些不能擅改', label: '四、哪些不能擅改' },
];

function firstLineWith(lines, predicate) {
  for (let i = 0; i < lines.length; i += 1) {
    if (predicate(lines[i])) return { text: lines[i], line: i + 1 };
  }
  return null;
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

  // --- 四组协议区块（blocking ×4，任务书 §2.1 四组化）---
  for (const group of GROUP_BLOCKS) {
    const re = new RegExp(`#{2,6}\\s*[一二三四1-4]\\s*[、.．]?\\s*${group.title}`);
    if (!lines.some((l) => re.test(l))) {
      push(`outline-missing-group-${group.id}`, 'blocking', 1,
        `四组协议区块缺失：「${group.label}」——细纲四组化契约（references/细纲协议.md，任务书 §2.1）；beat 切分不是细纲格式，契约字段缺失即设计意图无声丢失（61-63 实证）`);
    }
  }

  // --- 保留行（blocking ×3 + advisory ×1；行必须在，值可「无」——字数目标除外，须含数字）---

  const wordcount = firstLineWith(lines, (l) => l.includes('字数目标'));
  if (!wordcount || !/\d/.test(wordcount.text)) {
    push('outline-missing-wordcount', 'blocking', 1, '字数目标行缺失或不含数字——章检字数下限的唯一驱动源（区间取下限/单值×90%，guyin-check-wordcount.js）');
  }

  const anchor = firstLineWith(lines, (l) => l.includes('复沓锚句'));
  if (!anchor) {
    push('outline-missing-anchor', 'blocking', 1, '复沓锚句字段行缺失（值可写「无」）——锚句是 outline-copy 的免报通道，字段缺失即免报通道失控');
  }

  const holdback = firstLineWith(lines, (l) => l.includes('禁止提前释放'));
  if (!holdback) {
    push('outline-missing-holdback', 'blocking', 1, '禁止提前释放字段行缺失（值可写「无」）——契约层显式声明，防「靠卷纲兜底」的隐性放空');
  }

  const terms = firstLineWith(lines, (l) => l.includes('术语锚点'));
  if (!terms) {
    push('outline-missing-terms', 'advisory', 1, '术语锚点字段行缺失（值可写「无」）——新术语密集批次的首现台词级锚定位，报告 B8 的机制化');
  }

  return findings;
}

// ---------- S2 气卡坐标覆盖预检（docs/07 §二 S2；Y2 路径核验修正，docs/09 §三） ----------
// 尊重 06 决策不收编气卡，只加预检：落盘门查该章细纲时顺带扫项目气卡坐标行，本章不落
// 在任何区间 → advisory 停靠提醒刷新，报时贴原文坐标行供作者目检。
// fail-open（v1.1 钉死）：气卡缺失或全文无「当前」坐标行 → 静默跳过——框架模板气卡
// 坐标节未实例化时无区间，「无区间也报」会让每个项目每次补纲都假警报。时机：补纲
// 落盘门（新卷首批细纲建档时），早于写章循环第 1 步的卷首检查；第 1 步停靠纪律不动。
const QIYUN_RANGE = /第?\s*(\d+)\s*[-—－~～至]\s*(\d+)?/g;

// Y2 核验结论：白银案录把坐标写在 设定/气韵卡.md（项目自定义名），旧版只找
// 作者性/气卡.md → 永远 fail-open，坐标停在 ch28-32 五轮无警报。候选扩为两处，
// 都存在则都扫、区间合并——坐标资产写哪侧是项目决策，机械侧不猜。
function locateQiyunCards(outlinePath) {
  const found = [];
  let cur = path.dirname(path.resolve(outlinePath));
  for (let depth = 0; depth < 3; depth += 1) {
    for (const rel of [['作者性', '气卡.md'], ['设定', '气韵卡.md']]) {
      const candidate = path.join(cur, ...rel);
      if (fs.existsSync(candidate) && !found.includes(candidate)) found.push(candidate);
    }
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return found;
}

// 逐行扫区间（含全角横线变体）：「61-63」「第61-63章」「ch28-32」「61至65」；尾数缺失视为无效区间跳过。
// Y2 口径收窄：只认含「当前」的坐标行（当前阶段/当前坐标）——气韵卡的卷级规划表
// （「卷3（61-130）」）与散点 ch 引用会让全文乱扫永远绿灯（坐标停在旧段却无警报的
// 假覆盖形态）；规划/回顾行不构成「写作时必对」的覆盖声明。
function qiyunRanges(text) {
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.includes('当前')) continue;
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

// ---------- B2 指令区复读门（docs/09 §一） ----------
// 写作指令区提取：#### 写作指令 标题行到下一区块标题之间的正文行。归一化＝剥全部空白。
// 「全区为无」判定：区块内所有字段值均为「无」或区块为空——三章同填「无」是合法状态
// （执行偏差区同理），复读门只打真实指令的逐字复读（61-63 比喻域三章同值的形态）。
function instructionBody(text) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => /#{2,4}\s*写作指令/.test(l));
  if (start === -1) return null;
  const body = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^#{2,4}\s/.test(lines[i])) break;
    body.push(lines[i]);
  }
  return body;
}

function normalizeInstruction(body) {
  return (body || []).join('').replace(/\s/g, '');
}

function instructionIsNone(body) {
  const vals = (body || [])
    .map((l) => l.replace(/^[-*]\s*/, '').replace(/^[^：:]*[：:]/, '').trim())
    .filter((v) => v !== '');
  return vals.length === 0 || vals.every((v) => /^无/.test(v));
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

    // B2 指令区复读门：细纲 N-1 存在且两章写作指令区归一化逐字相同、且非「无」→ advisory。
    // 前章细纲缺失/读失败/任一章无指令区 → 静默（fail-open，与 S2 同哲学）。
    try {
      const dir = path.dirname(abs);
      const prevName = fs.readdirSync(dir).find((n) => {
        const m = /^细纲_第0*(\d+)章.*\.md$/.exec(n);
        return m !== null && Number(m[1]) === chapter - 1;
      });
      if (prevName) {
        const prevText = fs.readFileSync(path.join(dir, prevName), 'utf8');
        const curBody = instructionBody(text);
        const prevBody = instructionBody(prevText);
        if (curBody !== null && prevBody !== null) {
          const curNorm = normalizeInstruction(curBody);
          if (curNorm && curNorm === normalizeInstruction(prevBody) && !instructionIsNone(curBody)) {
            allFindings.push({
              file: input,
              line: 1,
              column: 1,
              type: 'outline-instruction-echo',
              severity: 'advisory',
              message: `写作指令区与前章（第 ${chapter - 1} 章）归一化逐字相同——批次不变量（比喻域/引号规格/收束位轮换）上移 大纲/批次公约.md，本章无特有指令写「无」；B2`,
              excerpt: '',
            });
          }
        }
      }
    } catch (error) {
      /* 前章读失败 → 静默 */
    }

    const rows = [];
    for (const cardPath of locateQiyunCards(abs)) {
      try {
        rows.push(...qiyunRanges(fs.readFileSync(cardPath, 'utf8')));
      } catch (error) {
        /* 读失败静默（fail-open） */
      }
    }
    if (rows.length > 0 && !rows.some((r) => chapter >= r.lo && chapter <= r.hi)) {
      allFindings.push({
        file: input,
        line: 1,
        column: 1,
        type: 'qiyun-coord-uncovered',
        severity: 'advisory',
        message: `气卡坐标未覆盖第 ${chapter} 章（现有区间 ${rows.map((r) => `${r.lo}-${r.hi}`).join('、')}）——新卷/建批先刷新气卡「当前阶段」坐标行（作者性/气卡.md 或 设定/气韵卡.md，建批硬前置）再续写（F5：坐标停旧段，气韵对位失真）；停靠刷新，原文目检：「${rows[0].line.slice(0, 50)}」`,
        excerpt: '',
      });
    }
  }
}

// ---------- v3-A3 书级题材/读者契约依赖检查（任务书 §4 A3） ----------
// 细纲⑥阶段位置判据与⑦契约评级对照 设定/题材定位.md（细纲协议单权威引用），落盘门顺带
// 校验该依赖文件存在与必要节有可用内容。只查结构（节在＋非占位），不检测题材与收放
// 风格是否匹配、不打分（A3：不新增 genre-fit 好看评分器）。advisory 起步（O2 先例）；
// 存量不追溯——只在新建/修订细纲的落盘门触发。
// 合法值：非必要信息「未定」、非升级型「不适用＋替代说明」都算作者显式决定，机械放行；
// 占位判定＝节体剥去 {{...}} 序列与注释/空白后无实质内容（模板未实例化形态）。
function locateGenreFile(outlinePath) {
  let cur = path.dirname(path.resolve(outlinePath));
  for (let depth = 0; depth < 4; depth += 1) {
    const candidate = path.join(cur, '设定', '题材定位.md');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return null;
}

function sectionBody(text, titleRe) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => titleRe.test(l));
  if (start === -1) return null;
  const body = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^#{1,2}\s/.test(lines[i])) break;
    body.push(lines[i]);
  }
  return body;
}

function sectionHasSubstance(body) {
  const stripped = (body || [])
    .filter((l) => !l.trim().startsWith('>'))
    .join('')
    .replace(/\{\{[^}]*\}\}/g, '')
    .replace(/[-*|#\s]/g, '');
  return stripped.length >= 10;
}

function genreContractFindings() {
  const first = options.inputs[0];
  const genrePath = locateGenreFile(first);
  if (!genrePath) {
    return {
      type: 'outline-genre-contract-missing',
      severity: 'advisory',
      message: '设定/题材定位.md 不存在——书级读者契约与终局底牌的依赖文件缺失（细纲⑥⑦对照源）；部署 /guyin-setup 模板后开书 Phase B 填写，存量项目由作者显式决定是否补建（v3-A3，不批量追补）',
    };
  }
  let text;
  try {
    text = fs.readFileSync(genrePath, 'utf8');
  } catch (error) {
    return {
      type: 'outline-genre-contract-missing',
      severity: 'advisory',
      message: `设定/题材定位.md 读取失败（${error.message}）——依赖文件不可读，按缺件处理（v3-A3）`,
    };
  }
  const checks = [
    ['## 读者契约', /#{2,3}\s*读者契约/, '读者契约（主要阅读回报等）'],
    ['## 终局底牌与升级台阶', /#{2,3}\s*终局底牌与升级台阶/, '终局底牌与升级台阶（阶段性期待与终局储备）'],
  ];
  for (const [, titleRe, label] of checks) {
    const body = sectionBody(text, titleRe);
    if (body === null) {
      return {
        type: 'outline-genre-contract-missing',
        severity: 'advisory',
        message: `设定/题材定位.md 缺「${label}」节——进细纲前必要内容（v3-A3：开书 Phase B 落盘；混合题材按主＋副填，非升级型写「不适用＋替代阶段说明」）`,
      };
    }
    if (!sectionHasSubstance(body)) {
      return {
        type: 'outline-genre-contract-missing',
        severity: 'advisory',
        message: `设定/题材定位.md「${label}」节仍是占位/空白——{{...}} 未实例化不是可用内容；阅读回报与阶段边界是进细纲前的必要内容（非必要项才允许「未定」，非升级型写「不适用＋替代阶段说明」，不伪造市场事实）（v3-A3）`,
      };
    }
  }
  return null;
}

const genreFinding = genreContractFindings();
if (genreFinding) {
  allFindings.push({ file: options.inputs[0], line: 1, column: 1, ...genreFinding });
}

try {
  handling.finalizeFindings(allFindings, 'guyin-check-outline-slots.js');
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
    console.log(`outline-slots: ${options.inputs.length} file(s) four groups + retained lines present`);
  }
}

if (failed) process.exit(2);
process.exit(handling.gateTripped(allFindings, options.failOn) ? 1 : 0);
