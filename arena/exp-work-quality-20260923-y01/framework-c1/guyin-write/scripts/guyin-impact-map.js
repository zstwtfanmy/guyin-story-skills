#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const handling = require('./lib/guyin-handling');

const USAGE = `Usage: node guyin-impact-map.js [--json] [--project <根>] <关键词> [<关键词>...]

结构手术影响面清单（P5，docs/04-优化路线图.md §3 P5 第 1 条）：砍线/并线前的一键查询。
「人类作者在负向决策上最痛苦（沉没成本），协议替作者把痛苦变成清单」——
flash 只出候选线清单与统计，砍不砍终判归作者。

七路检索（读 追踪/_tracking-state.json，纯查询零写盘，多关键词 OR）：

  dangling      悬空债：涉线且状态「已埋」的伏笔——砍线后成悬空债，必须处置
                （明收/暗收/改线，处置协议见完书场景同款过堂）
  events        涉线 timeline 事件（objective_fact/reader_knowledge/story_time/characters）
  characters    涉线角色（name/identity/state/goal）
  verdicts      涉线定性（event/verdict/keywords）——砍线即没收已兑付资产，
                按 G1 须同章补偿（04 §3 G1）
  evidence/geo  涉线物证/地理（name/anchor/holder/aliases/keywords）
  scenes        涉线场景（name/anchor/current/keywords）
  patch_chapters 补丁目标章 = 章摘要命中 ∪ 伏笔埋设章 ∪ 事件揭示章——分批补丁指令的范围

角色卡关键词命中角色后，该角色名自动并入检索（角色→其事件/伏笔的关联扩散，
一级扩散即止防雪崩）。

处置分类（lib/guyin-handling）：impact-dangling-foreshadow / impact-verdict-asset /
impact-patch-spread = verify（结构手术前须过堂核实）。本脚本是信息查询不是门：
永远 exit 0（无阻断语义，无 --fail-on），handling 只随 warnings 盖章输出，
供下游待审流程（砍线过堂/G1 补偿）消费。`;

const options = { json: false, project: null, terms: [] };

for (let i = 2; i < process.argv.length; i += 1) {
  const arg = process.argv[i];
  if (arg === '--json') {
    options.json = true;
  } else if (arg.startsWith('--project=')) {
    options.project = arg.slice('--project='.length);
  } else if (arg === '--project') {
    options.project = process.argv[i + 1] || die('--project requires a value');
    i += 1;
  } else if (arg === '-h' || arg === '--help') {
    process.stdout.write(`${USAGE}\n`);
    process.exit(0);
  } else if (arg.startsWith('-')) {
    die(`Unknown option: ${arg}`);
  } else {
    options.terms.push(arg);
  }
}

if (options.terms.length === 0) die('At least one keyword required');
if (!options.project) die('--project is required (project root containing 追踪/)');

function die(message) {
  console.error(message);
  console.error(USAGE.trimEnd());
  process.exit(2);
}

const root = path.resolve(options.project);
const statePath = path.join(root, '追踪', '_tracking-state.json');
let state;
try {
  state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
} catch (error) {
  die(`unable to read ${statePath}: ${error.message}`);
}

// ---------- 匹配器：任一关键词命中即真 ----------

function hit(...texts) {
  const blob = texts.filter((t) => typeof t === 'string').join('｜');
  return options.terms.some((term) => blob.includes(term));
}

const expanded = new Set(options.terms);
function expandWith(name) {
  if (!expanded.has(name)) expanded.add(name);
}
function hitExpanded(...texts) {
  const blob = texts.filter((t) => typeof t === 'string').join('｜');
  for (const term of expanded) if (blob.includes(term)) return true;
  return false;
}

// ---------- 七路检索 ----------

const result = {
  keyword: options.terms,
  dangling: [],
  events: [],
  characters: [],
  verdicts: [],
  evidence: [],
  geo: [],
  scenes: [],
  patch_chapters: [],
  warnings: [],
};

// 角色：名字或字段命中 → 名字并入检索集（一级扩散）
for (const [name, snap] of Object.entries(state.characters || {})) {
  if (hit(name, snap.identity, snap.state, snap.goal)) {
    result.characters.push({ name, identity: snap.identity, state: snap.state, goal: snap.goal });
    expandWith(name);
  }
}

// 伏笔：summary 命中；「已埋」状态单列悬空债
for (const row of Object.values(state.foreshadow || {})) {
  if (!hitExpanded(row.summary)) continue;
  const entry = {
    id: row.id, summary: row.summary, status: row.status, importance: row.importance,
    planted_chapter: row.planted_chapter,
    planned_resolution_chapter: row.planned_resolution_chapter ?? null,
  };
  if (row.status === '已埋') result.dangling.push(entry);
  if (row.planted_chapter) result.patch_chapters.push(row.planted_chapter);
}

// timeline 事件：一级扩散关键词再扫（角色名关联事件）
for (const row of Object.values(state.timeline || {})) {
  if (!hitExpanded(row.story_time, row.objective_fact, row.reader_knowledge, ...(row.characters || []))) continue;
  result.events.push({
    id: row.id, fact: row.objective_fact, characters: row.characters || [],
    reveal_status: row.reveal_status, reveal_chapter: row.reveal_chapter ?? null,
  });
  if (row.reveal_chapter) result.patch_chapters.push(row.reveal_chapter);
}

// 定性/物证/地理/场景
for (const row of Object.values(state.verdicts || {})) {
  if (hitExpanded(row.event, row.verdict, ...(row.keywords || []))) {
    result.verdicts.push({ id: row.id, chapter: row.chapter, event: row.event, verdict: row.verdict, status: row.status });
  }
}
for (const row of Object.values(state.evidence || {})) {
  if (hitExpanded(row.name, row.anchor, row.holder, ...(row.keywords || []))) {
    result.evidence.push({ id: row.id, chapter: row.chapter, name: row.name, status: row.status, holder: row.holder });
  }
}
for (const row of Object.values(state.geo || {})) {
  if (hitExpanded(row.name, ...(row.aliases || []), row.anchor, ...(row.keywords || []))) {
    result.geo.push({ id: row.id, chapter: row.chapter, name: row.name, status: row.ref ? 'relative' : 'registered' });
  }
}
for (const row of Object.values(state.scenes || {})) {
  if (hitExpanded(row.name, row.anchor, row.current, ...(row.keywords || []))) {
    result.scenes.push({ id: row.id, chapter: row.chapter, name: row.name, status: row.status, current: row.current });
    if (row.chapter) result.patch_chapters.push(row.chapter);
  }
}

// 章摘要：命中即补丁目标章
for (const [ch, text] of Object.entries(state.chapter_summaries || {})) {
  if (hitExpanded(text)) result.patch_chapters.push(Number(ch));
}

result.patch_chapters = [...new Set(result.patch_chapters)].sort((a, b) => a - b);

// ---------- 风险分级 ----------

const warnings = [];
if (result.dangling.length > 0) {
  warnings.push({
    type: 'impact-dangling-foreshadow',
    severity: 'advisory',
    message: `悬空债 ×${result.dangling.length}：砍线将使「已埋」伏笔失去回收路径——逐条过堂（明收/暗收/改线），禁静默蒸发（读者记得的债都是资产）。`,
  });
}
if (result.verdicts.length > 0) {
  warnings.push({
    type: 'impact-verdict-asset',
    severity: 'advisory',
    message: `已兑付定性 ×${result.verdicts.length}：涉线 verdict 是读者已领的叙事资产——砍线即没收，按 G1 须同章补偿，否则旧爽点变骗局。`,
  });
}
if (result.patch_chapters.length > 12) {
  warnings.push({
    type: 'impact-patch-spread',
    severity: 'advisory',
    message: `补丁面过宽（${result.patch_chapters.length} 章涉线）：优先评估「残留处置=留作闲笔」而非全量补丁——砍线的成本轴就在这里。`,
  });
}
result.warnings = warnings;

try {
  handling.finalizeFindings(warnings, 'guyin-impact-map');
} catch (e) {
  die(e.message);
}

// ---------- 输出 ----------

const summary = {
  keyword: options.terms,
  dangling: result.dangling.length,
  events: result.events.length,
  characters: result.characters.length,
  verdicts: result.verdicts.length,
  evidence: result.evidence.length,
  geo: result.geo.length,
  scenes: result.scenes.length,
  patch_chapters: result.patch_chapters.length,
};

if (options.json) {
  process.stdout.write(`${JSON.stringify({ summary, result }, null, 2)}\n`);
} else {
  console.log(`# 影响面清单（关键词：${options.terms.join('、')}）`);
  console.log('');
  console.log('> 结构手术前置查询（P5-1）：砍不砍终判归作者。悬空债必须过堂，定性资产须同章补偿。');
  console.log('');
  if (result.dangling.length) {
    console.log('## 悬空债（已埋未回收，砍线即悬空）');
    for (const f of result.dangling) console.log(`- ${f.id}｜${f.summary}｜埋于第${f.planted_chapter}章｜${f.importance}｜计划回收 ${f.planned_resolution_chapter ?? '未定'}`);
    console.log('');
  }
  if (result.verdicts.length) {
    console.log('## 已兑付定性（砍线即没收，G1 同章补偿）');
    for (const v of result.verdicts) console.log(`- ${v.id}｜第${v.chapter}章｜${v.event}｜${v.verdict}｜${v.status}`);
    console.log('');
  }
  if (result.events.length) {
    console.log('## 涉线事件');
    for (const e of result.events) console.log(`- ${e.id}｜${e.fact}｜${e.characters.join('、') || '无角色'}｜${e.reveal_status}${e.reveal_chapter ? `（第${e.reveal_chapter}章）` : ''}`);
    console.log('');
  }
  if (result.characters.length) {
    console.log('## 涉线角色');
    for (const c of result.characters) console.log(`- ${c.name}｜${c.identity}｜${c.state}｜目标：${c.goal}`);
    console.log('');
  }
  if (result.evidence.length) {
    console.log('## 涉线物证');
    for (const w of result.evidence) console.log(`- ${w.id}｜${w.name}｜${w.status}｜持有：${w.holder}`);
  }
  if (result.geo.length) {
    console.log('## 涉线地理');
    for (const g of result.geo) console.log(`- ${g.id}｜${g.name}｜${g.status}`);
  }
  if (result.scenes.length) {
    console.log('## 涉线场景');
    for (const s of result.scenes) console.log(`- ${s.id}｜${s.name}｜${s.status}｜${s.current}`);
  }
  if (result.patch_chapters.length) {
    console.log('');
    console.log(`## 补丁目标章（${result.patch_chapters.length} 章）：${result.patch_chapters.map((c) => `第${c}章`).join('、')}`);
  }
  for (const w of warnings) console.log('');
  for (const w of warnings) console.log(`⚠ [${handling.label(w)}] ${w.type}: ${w.message}`);
}

process.exit(0);
