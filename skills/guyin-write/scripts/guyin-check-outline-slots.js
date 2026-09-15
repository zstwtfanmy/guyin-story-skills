#!/usr/bin/env node
'use strict';

// guyin-check-outline-slots.js — 细纲槽位完整性门（O2，docs/06-卷三开局复盘整改计划.md §二）
//
// 根因一「硬门不查槽位」的封堵：61-63 细纲 beat 化后字段整体丢失，outline-verdict 与
// hook-rotation 对缺失字段都无事可查，缺失零成本。本脚本机械查八槽位（字段定义唯一权威
// 在 references/细纲协议.md，O1）：
//
//   blocking ×5：
//     outline-missing-hook      章尾钩子行缺失 / 无六型 / 无实体 / 无承接声明
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
//   advisory ×3（docs/09）：
//     outline-instruction-echo  写作指令区与前章归一化逐字相同且非「无」（B2：批次不变量
//                               应上移 大纲/批次公约.md，逐章复读=指令放错层；三章同填「无」合法）
//     outline-scene-floor-conflict 场景下限声明 > 涉及场景清单条目数（B4：ch63 细纲自相矛盾
//                               形态；清单值「无」=未登记场景不比较，豁免声明跳过）
//   advisory ×1（v3-A3，任务书 §4 A3）：
//     outline-genre-contract-missing 设定/题材定位.md 缺失/必要节缺/占位未实例化——
//                               细纲⑥⑦的对照依赖文件；只查结构不打分（不是 genre-fit
//                               评分器），「未定」「不适用＋说明」是合法显式决定放行
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
            / qiyun-coord coverage (S2+Y2: scans 作者性/气卡.md and
              设定/气韵卡.md, only lines containing 当前; silent when no
              card or no such line — volume-plan rows don't count)
            / instruction-echo (B2: instruction block identical to previous
              chapter's, non-「无」— batch invariants belong in 大纲/批次公约.md)
            / scene-floor-conflict (B4: declared scene floor exceeds the
              scene-list entry count — ch63 self-contradiction shape)
            / genre-contract-missing (v3-A3: 设定/题材定位.md absent or its
              读者契约 / 终局底牌与升级台阶 sections missing/placeholder —
              structure-only dependency check, NOT a genre-fit scorer;
              「未定」/「不适用＋说明」are legal explicit decisions)
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

// 六型钩子（与 hook-rotation 的轮换检测共用类型集，职责分离：那边管已标注章的连续同型，这边管有没有标注；切断型为 X1 特殊态）。
const HOOK_TYPES = ['危机', '反转', '期待', '悬念', '情绪', '切断'];

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
  if (/同场景延续/.test(rest)) return true; // X1：切断型豁免事件指向，承接改「同场景延续」（断点实体仍由 entityOk 管）
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
      push('outline-missing-hook', 'blocking', hook.line, '章尾钩子未声明六型（危机/反转/期待/悬念/情绪/切断）——轮换检测与张力判定的机械标注位');
    }
    if (!entityOk(hook.text)) {
      push('outline-missing-hook', 'blocking', hook.line, '章尾钩子缺实体声明（挂在什么具体物/人/话上）——情绪钩子合法（有实体），情绪收束句不合法（无实体）；切断型断点实体同此管');
    }
    if (!carryoverOk(hook.text)) {
      push('outline-missing-hook', 'blocking', hook.line, '章尾钩子缺承接声明（承接：第X章{事件}；完结章可写「承接：无（完结收束）」；切断型可写「承接：同场景延续」）——不指向下一章任何事件的是状态判词不是钩子');
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

  // B4 场景下限自洽（docs/09 §一）：下限行声明的场景数 > 涉及场景清单条目数 → 细纲内部
  // 自相矛盾（ch63：自设 ≥3 场而清单只列 2 处）。豁免声明跳过；清单值「无」＝未登记场景
  // 不比较（清单喂卡用途与下限剧情约束不同层，机械比较只对已列条目负责）。
  if (sceneFloor && scenes) {
    const floorText = sceneFloor.text;
    if (!/豁免/.test(floorText)) {
      const floorMatch = /≥\s*(\d+)\s*场/.exec(floorText);
      if (floorMatch) {
        const floor = Number(floorMatch[1]);
        const listVal = scenes.text.replace(/^.*涉及场景[^：:]*[：:]/, '').trim();
        if (listVal && !/^无/.test(listVal)) {
          const count = listVal.split(/[、,，;；]/).filter((s) => s.trim()).length;
          if (count < floor) {
            push('outline-scene-floor-conflict', 'advisory', scenes.line,
              `场景下限声明 ≥${floor} 场，涉及场景清单仅 ${count} 条——细纲内部自相矛盾（ch63 形态）；补场景、调下限或声明豁免；B4`);
          }
        }
      }
    }
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
