#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const USAGE = `Usage: node guyin-check-flesh.js [--json] [--project <根>] <角色名> <正文目录 | 正文文件...>
       node guyin-check-flesh.js [--json] [--project <根>] --all <正文目录 | 正文文件...>

人物显影器（P6，docs/04-优化路线图.md §3 P6 第 3 条）：跨章行为链诊断。
review「角色对话」视角查单章声线；本脚本查**跨章行为链对设定弧线的累计偏移**——
本地扫描正文抽角色行为句（就近人名规则，70-80% 准确率够诊断用），
与角色卡特质轴机械比对，断裂初筛靠规则，终判归作者。

  flesh-trait-break  设定 vs 呈现断裂：角色卡标某特质轴，正文中该角色反特质
                     行为词 ≥3 次且正特质 0 次（「设定说果决、正文里躲了三次」
                     形态）——终判归作者：可能是有意的成长弧（先怯后勇），
                     也可能是执行层没接住设定。advisory，只报不拦。

  tool-character     配角工具化（P6-4）：连续 ≥3 章登场且每章行为句全为对话
                     （递话形态，占比 ≥80%）或连续 ≥5 章登场但每章行为句 ≤2
                     （影子戏份）——群像死亡形态：配角全变功能性 NPC。advisory。

角色卡从 设定/角色/{角色名}.md 读（自由 markdown，特质轴按关键词命中提取；
无卡则跳过断裂比对只出行为链）。--all 输出全部角色戏份概览（P6-4 姊妹，
角色名 = 角色卡文件名 ∪ _tracking-state.json characters 键）。`;

const options = { json: false, all: false, project: null, character: null, targets: [] };

for (let i = 2; i < process.argv.length; i += 1) {
  const arg = process.argv[i];
  if (arg === '--json') {
    options.json = true;
  } else if (arg === '--all') {
    options.all = true;
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
  } else if (options.all || options.character) {
    options.targets.push(arg);
  } else {
    options.character = arg;
  }
}

if (options.targets.length === 0) die('No chapter directory or files provided');
if (!options.all && !options.character) die('Character name required (or use --all)');

// ---------- 文件收集：目录 → 第NNN章.md ----------

const files = [];
let failed = false;
for (const target of options.targets) {
  const full = path.resolve(target);
  let stat;
  try {
    stat = fs.statSync(full);
  } catch (error) {
    failed = true;
    if (!options.json) console.error(`${target}: unable to stat (${error.message})`);
    continue;
  }
  if (stat.isDirectory()) {
    let entries;
    try {
      entries = fs.readdirSync(full);
    } catch (error) {
      failed = true;
      if (!options.json) console.error(`${target}: unable to read directory (${error.message})`);
      continue;
    }
    for (const name of entries.sort()) {
      if (/^第\d+章.*\.md$/.test(name)) files.push(path.join(full, name));
    }
  } else {
    files.push(full);
  }
}

const CHAPTER_FILE = /第\s*0*(\d+)\s*章/;

// ---------- 项目根定位：--project 优先，否则从目标目录向上找 追踪/ ----------

function locateRoot() {
  if (options.project) return path.resolve(options.project);
  for (const file of files) {
    let cur = path.dirname(file);
    for (let depth = 0; depth < 4; depth += 1) {
      if (fs.existsSync(path.join(cur, '追踪'))) return cur;
      const parent = path.dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
  }
  return null;
}

const root = locateRoot();

// ---------- 特质轴（机械可查，可演进）：角色卡命中 pros 即认定该轴设定存在 ----------

const TRAIT_AXES = [
  { trait: '果决', pros: ['果决', '果断', '雷厉', '干脆', '决然', '杀伐果断'], antis: ['犹豫', '迟疑', '徘徊', '退缩', '举棋不定', '不敢上前'] },
  { trait: '冷静', pros: ['冷静', '沉着', '镇定', '沉得住气'], antis: ['慌乱', '惊慌', '失措', '手忙脚乱', '发了慌', '心里发慌'] },
  { trait: '勇敢', pros: ['勇敢', '悍勇', '无畏', '骁勇'], antis: ['躲避', '退缩', '绕开', '不敢', '避战'] },
  { trait: '温和', pros: ['温和', '和善', '温声', '好脾气'], antis: ['呵斥', '冷笑', '讥讽', '怒骂', '喝骂', '疾言厉色'] },
  { trait: '谨慎', pros: ['谨慎', '小心', '审慎', '留神'], antis: ['贸然', '鲁莽', '大意', '轻敌', '孟浪'] },
  { trait: '精明', pros: ['精明', '聪慧', '洞察', '算无遗策', '明察'], antis: ['没想到', '失算', '中了计', '被蒙在鼓里', '竟没察觉'] },
];

const NEG_WORDS = ['怒', '愤', '恨', '怨', '悲', '哭', '痛', '苦', '沉', '慌', '怕', '惧', '惊', '呆', '愣', '颤', '抖', '哀'];
const POS_WORDS = ['笑', '喜', '乐', '暖', '安心', '轻松', '甜', '稳'];

function countHits(text, words) {
  let hits = 0;
  for (const w of words) {
    let from = 0;
    for (;;) {
      const at = text.indexOf(w, from);
      if (at < 0) break;
      hits += 1;
      from = at + w.length;
    }
  }
  return hits;
}

// ---------- 角色卡读取（无卡 → 特质轴为空，fail-open）----------

function readCharacterCard(name) {
  if (!root) return '';
  const card = path.join(root, '设定', '角色', `${name}.md`);
  try {
    return fs.readFileSync(card, 'utf8');
  } catch (error) {
    return '';
  }
}

function loadCharacterNames() {
  const names = new Set();
  if (root) {
    const dir = path.join(root, '设定', '角色');
    try {
      for (const name of fs.readdirSync(dir)) {
        if (name.endsWith('.md') && name !== 'README.md') names.add(name.slice(0, -3));
      }
    } catch (error) { /* 目录缺失 fail-open */ }
    const statePath = path.join(root, '追踪', '_tracking-state.json');
    try {
      const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      if (state && typeof state === 'object' && state.characters) {
        for (const name of Object.keys(state.characters)) names.add(name);
      }
    } catch (error) { /* fail-open */ }
  }
  return [...names];
}

// ---------- 行为链提取：句含角色名即归属（就近人名规则）----------

// 引号感知切分：句号在「」内不切（否则「……。」被从中间切开，引号对匹配不到，话轮系统性丢失）。
function splitSentences(text) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    let buf = '';
    let inQuote = false;
    for (const ch of line) {
      buf += ch;
      if (ch === '「') inQuote = true;
      else if (ch === '」') inQuote = false;
      else if (!inQuote && (ch === '。' || ch === '！' || ch === '？')) {
        out.push(buf);
        buf = '';
      }
    }
    if (buf.trim()) out.push(buf);
  }
  return out;
}

function quoteRatio(sentence) {
  let inQuote = false;
  let quoted = 0;
  for (const ch of sentence) {
    if (ch === '「') inQuote = true;
    else if (ch === '」') inQuote = false;
    else if (inQuote) quoted += 1;
  }
  return sentence.length > 0 ? quoted / sentence.length : 0;
}

function quoteTexts(sentence) {
  const out = [];
  const re = /「([^」]*)」/g;
  let m;
  while ((m = re.exec(sentence)) !== null) out.push(m[1]);
  return out;
}

// 每章统计：行为句数、对话比、情绪词频、特质轴命中、话轮长度序列。
function analyzeCharacter(name, chapterFiles, card) {
  const chapters = [];
  const traitHits = new Map(TRAIT_AXES.map((a) => [a.trait, { pro: 0, anti: 0, antiSamples: [] }]));
  const turns = [];
  for (const file of chapterFiles) {
    const nameMatch = CHAPTER_FILE.exec(path.basename(file));
    const chapter = nameMatch ? Number(nameMatch[1]) : null;
    let input;
    try {
      input = fs.readFileSync(file, 'utf8');
    } catch (error) {
      failed = true;
      if (!options.json) console.error(`${file}: unable to read (${error.message})`);
      continue;
    }
    const sentences = splitSentences(input);
    let own = 0;
    let dialogue = 0;
    let neg = 0;
    let pos = 0;
    const chapterAnti = [];
    // 引文归属继承：名字行/含名句之后的引文主导行（「xxx」独立成行）也归属该角色——
    // 分行对话是网文常态；连续引文行持续继承，非引文普通句重置。
    // 例外：「引文」XX说（说话人后缀）形态——引文行自身含说话动词则不继承，
    // 说话人另有其人，归前句角色必误。
    const SAY_VERBS = /(说|道|问|答|喊)/;
    let prevOwned = false;
    for (const sentence of sentences) {
      const hasName = sentence.includes(name);
      const qr = quoteRatio(sentence);
      const quoteLead = qr > 0.5 && sentence.trim().startsWith('「') && !SAY_VERBS.test(sentence);
      const owned = hasName || (quoteLead && prevOwned);
      prevOwned = hasName || (quoteLead && prevOwned);
      if (!owned) continue;
      if (hasName) own += 1;
      if (qr > 0.2) dialogue += 1;
      neg += countHits(sentence, NEG_WORDS);
      pos += countHits(sentence, POS_WORDS);
      for (const t of quoteTexts(sentence)) turns.push({ chapter, len: t.length });
      for (const axis of TRAIT_AXES) {
        const hit = traitHits.get(axis.trait);
        const anti = countHits(sentence, axis.antis);
        if (anti > 0) {
          hit.anti += anti;
          if (chapterAnti.length < 6) chapterAnti.push(`${axis.trait}:${sentence.trim().slice(0, 24)}`);
        }
        hit.pro += countHits(sentence, axis.pros);
      }
    }
    if (own > 0) chapters.push({ chapter, sentences: own, dialogue, neg, pos, anti: chapterAnti });
  }
  return { name, chapters, traitHits, turns, card };
}

// ---------- 断裂检测：卡含 pros 某轴 + 正文反特质 ≥3 且正特质 0 ----------

function detectBreaks(analysis) {
  const findings = [];
  if (!analysis.card) return findings;
  for (const axis of TRAIT_AXES) {
    const inCard = axis.pros.some((w) => analysis.card.includes(w));
    if (!inCard) continue;
    const hit = analysis.traitHits.get(axis.trait);
    if (hit.anti >= 3 && hit.pro === 0) {
      findings.push({
        type: 'flesh-trait-break',
        severity: 'advisory',
        message: `设定 vs 呈现断裂（${analysis.name}·${axis.trait}）：角色卡标「${axis.trait}」，正文反特质行为 ${hit.anti} 次、正特质 0 次——终判归作者：有意成长弧（先怯后勇）须在细纲声明，否则属执行层没接住设定。`,
        excerpt: `${analysis.name} × ${axis.trait}轴（反特质×${hit.anti}）`,
      });
    }
  }
  return findings;
}

// ---------- 工具人检测（P6-4）：连续章段形态判据，全机械 ----------

function detectToolRole(analysis) {
  const findings = [];
  const chs = analysis.chapters.filter((c) => c.chapter !== null).sort((a, b) => a.chapter - b.chapter);
  // 章号连续递增才成段（跳章不算连续）
  const segments = [];
  let seg = [];
  for (const c of chs) {
    if (seg.length && c.chapter === seg[seg.length - 1].chapter + 1) seg.push(c);
    else {
      if (seg.length) segments.push(seg);
      seg = [c];
    }
  }
  if (seg.length) segments.push(seg);
  for (const s of segments) {
    const range = `第${s[0].chapter}-${s[s.length - 1].chapter}章`;
    if (s.length >= 3 && s.every((c) => c.sentences >= 2 && c.dialogue / c.sentences >= 0.8)) {
      findings.push({
        type: 'tool-character',
        severity: 'advisory',
        message: `配角工具化（${analysis.name}·递话）：连续 ${s.length} 章行为句全为对话（${range}）——群像死亡形态：只剩递话功能。终判归作者：对话流角色也可能是刻意留白，但需给独立行为或立场。`,
        excerpt: `${analysis.name} ${range} 仅递话`,
      });
    }
    if (s.length >= 5 && s.every((c) => c.sentences <= 2)) {
      findings.push({
        type: 'tool-character',
        severity: 'advisory',
        message: `配角工具化（${analysis.name}·影子戏份）：连续 ${s.length} 章登场但每章行为句 ≤2（${range}）——出场无显影，纯背景板。终判归作者。`,
        excerpt: `${analysis.name} ${range} 影子戏份`,
      });
    }
  }
  return findings;
}

// ---------- 对话呼吸 ----------

function breathOf(turns) {
  if (turns.length === 0) return { turns: 0 };
  const lens = turns.map((t) => t.len);
  const avg = Math.round(lens.reduce((a, b) => a + b, 0) / lens.length);
  const short = lens.filter((l) => l <= 8).length;
  let alternation = 0;
  for (let i = 1; i < lens.length; i += 1) {
    if (Math.abs(lens[i] - lens[i - 1]) > 40) alternation += 1;
  }
  return {
    turns: turns.length,
    avg_len: avg,
    max_len: Math.max(...lens),
    min_len: Math.min(...lens),
    short_ratio: Number((short / lens.length).toFixed(2)),
    alternation_ratio: lens.length > 1 ? Number((alternation / (lens.length - 1)).toFixed(2)) : 0,
  };
}

// ---------- 主流程 ----------

const chapterFiles = [...files].sort((a, b) => {
  const ca = Number((CHAPTER_FILE.exec(path.basename(a)) || [])[1] || 0);
  const cb = Number((CHAPTER_FILE.exec(path.basename(b)) || [])[1] || 0);
  return ca - cb;
});

const findings = [];
const reports = [];
let breath = null;

if (options.all) {
  const names = loadCharacterNames();
  const rows = [];
  for (const name of names) {
    const analysis = analyzeCharacter(name, chapterFiles, readCharacterCard(name));
    const total = analysis.chapters.reduce((a, c) => a + c.sentences, 0);
    const chaptersPresent = analysis.chapters.length;
    if (total === 0) continue;
    rows.push({ name, sentences: total, chapters: chaptersPresent, dialogue: analysis.chapters.reduce((a, c) => a + c.dialogue, 0) });
    for (const f of detectBreaks(analysis)) findings.push(f);
    for (const f of detectToolRole(analysis)) findings.push(f);
  }
  rows.sort((a, b) => b.sentences - a.sentences);
  if (options.json) {
    process.stdout.write(`${JSON.stringify({ summary: { characters: rows.length }, roles: rows, findings }, null, 2)}\n`);
  } else {
    console.log('# 戏份概览（--all，按行为句数降序）');
    for (const r of rows) console.log(`- ${r.name}：${r.sentences} 句行为 / ${r.chapters} 章登场 / 对话 ${r.dialogue} 句`);
    for (const f of findings) console.log(`[advisory] ${f.type}: ${f.message}`);
  }
} else {
  const analysis = analyzeCharacter(options.character, chapterFiles, readCharacterCard(options.character));
  findings.push(...detectBreaks(analysis));
  findings.push(...detectToolRole(analysis));
  breath = breathOf(analysis.turns);
  const axes = [];
  for (const axis of TRAIT_AXES) {
    const inCard = analysis.card && axis.pros.some((w) => analysis.card.includes(w));
    const hit = analysis.traitHits.get(axis.trait);
    axes.push({ trait: axis.trait, in_card: Boolean(inCard), pro: hit.pro, anti: hit.anti });
  }
  const summary = {
    character: analysis.name,
    chapters_present: analysis.chapters.length,
    sentences: analysis.chapters.reduce((a, c) => a + c.sentences, 0),
    has_card: Boolean(analysis.card),
    breaks: findings.length,
  };
  if (options.json) {
    process.stdout.write(`${JSON.stringify({ summary, chapters: analysis.chapters, axes, breath, findings }, null, 2)}\n`);
  } else {
    console.log(`# 人物显影：${analysis.name}`);
    console.log('');
    console.log(`> 跨章行为链诊断（P6-3）：设定 vs 呈现断裂 + 弧线。终判归作者。`);
    console.log('');
    console.log('| 章 | 行为句 | 对话句 | 负情绪 | 正情绪 |');
    console.log('|---|---|---|---|---|');
    for (const c of analysis.chapters) {
      console.log(`| ${c.chapter} | ${c.sentences} | ${c.dialogue} | ${c.neg} | ${c.pos} |`);
    }
    console.log('');
    console.log('## 特质轴比对（卡 vs 正文）');
    for (const a of axes) {
      const mark = a.in_card ? '设定✓' : '—';
      const flag = a.in_card && a.anti >= 3 && a.pro === 0 ? ' ⚠ 疑似断裂' : '';
      console.log(`- ${a.trait}：${mark}｜正文 正特质×${a.pro}、反特质×${a.anti}${flag}`);
    }
    console.log('');
    console.log(`## 对话呼吸：话轮 ${breath.turns}｜均长 ${breath.avg_len} 字｜最长 ${breath.max_len}｜最短 ${breath.min_len}｜短话轮占比 ${Math.round((breath.short_ratio || 0) * 100)}%｜长短交替率 ${Math.round((breath.alternation_ratio || 0) * 100)}%`);
    for (const f of findings) console.log('');
    for (const f of findings) console.log(`⚠ [advisory] ${f.type}: ${f.message}`);
  }
}

if (failed) process.exit(2);
if (!options.json && findings.length > 0) process.exit(1);
