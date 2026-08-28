#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const USAGE = `Usage: node guyin-check-repetition.js [--json] [--fail-on=blocking|all] [--commit] [--project <根>] <正文文件... | 正文目录>

段落指纹库（P6，docs/04-优化路线图.md §3 P6）：跨章复读检测。
单文件密度检查拦不住跨章复读——那是 flash 级模型分布坍缩的直接产物（04 §2.2），
是最常见的中期死因之一。本脚本维护段落指纹库（<项目>/追踪/段落指纹库.json）：
新章入库前先查历史，相似度达阈值报「疑似重复描写」。

  para-repeat-near    bigram Jaccard ≥ 0.90（近乎照抄）——处置直达改写卡：两段原文
                      并排 + 方向「换比喻域」。其中约七成可直接删，但脚本只标不删，
                      删令由作者确认
  para-repeat-pattern Jaccard 0.72-0.90（换词复读/结构雷同）——升级作者，结合意象
                      台账判「有意回环还是坍缩」：回环是意图，坍缩是分布，flash 判不了

两条全部 advisory（只标不拦）。查询只比对叙述段（≥40 字且引号内字符占比 <50%），
台词与短句不进指纹库。--commit 在追踪提交时固化终稿指纹（同章旧指纹先清再插，幂等）。

意象台账（P6-2，与指纹库同源）：--commit 同时扫叙述段比喻句按域登记（追踪/意象台账.md），
「人物之眼」改写协议的消费端——换域，而不是换词。

  imagery-domain-run   同域比喻滑窗内密度过高（3 章窗口内同域 ≥3 次）——同一比喻域
                       反复采撷即该域疲劳，改写时换域不换词（消费台账选未用域）

与 04 原案的偏差（实测对撞，实测赢）：原案「64 位 SimHash + 海明距离 ≤3」，实测段落级
换词复读（仅换 4 个名词）海明距离即达 10——SimHash 为文档级设计，短段落 70 个 bigram
中 12 对扰动足以翻转 10 位，对坍缩真形态（换名词复用整段结构）钝感不足。改用字符
bigram 集合的 Jaccard 相似度（实测换 4 词复读 ≈0.83，随机不同段 <0.3），倒排索引加速，
同阈值两档分级不变。`;

const NEAR_THRESHOLD = 0.9;
const PATTERN_THRESHOLD = 0.72;
const IMAGERY_WINDOW = 3; // 滑窗章数
const IMAGERY_RUN = 3;    // 窗内同域次数阈值

// 比喻标记词：多字优先，单字「如」需排除复合词（如果/如何/如今/如此/例如/不如/犹如/宛如/譬如）。
const METAPHOR_WORDS = ['仿佛', '宛如', '恍若', '如同', '好似', '犹如', '好像', '恰似', '像', '似', '如'];
const RU_EXCLUDE_NEXT = ['何', '果', '今', '此', '同', '例'];
const RU_EXCLUDE_PREV = ['不', '犹', '宛', '譬', '假'];

// 比喻域关键词表（机械可查，可演进）：按命中关键词数取多者，平局取先。
const DOMAINS = [
  { name: '自然', keys: ['风', '雨', '雪', '云', '雾', '霜', '露', '山', '河', '江', '海', '溪', '湖', '月', '日', '星', '雷', '潮'] },
  { name: '动物', keys: ['兽', '鸟', '鱼', '虫', '蛇', '狼', '虎', '鹰', '犬', '马', '蝉', '蚁', '鹤', '猫', '鼠'] },
  { name: '器物', keys: ['刀', '剑', '锁', '镜', '灯', '钟', '琴', '鼓', '秤', '尺', '网', '线', '针', '绳', '匣', '锯', '钉'] },
  { name: '身体', keys: ['骨', '血', '心', '手', '眼', '喉', '脊', '背', '皮', '发', '眉', '指', '脉'] },
  { name: '食物', keys: ['茶', '酒', '盐', '糖', '米', '面', '药', '汤', '油', '醋', '饭', '菜'] },
  { name: '商贾', keys: ['账', '票', '银', '钱', '买', '卖', '商', '价', '市', '当'] },
  { name: '宗教', keys: ['香', '神', '佛', '鬼', '魂', '符', '庙', '经', '咒', '妖', '碑'] },
  { name: '建筑', keys: ['墙', '门', '窗', '梁', '檐', '井', '牢', '塔', '桥', '阶'] },
];

const options = { json: false, commit: false, project: null, targets: [], failOn: 'all' };

for (let i = 2; i < process.argv.length; i += 1) {
  const arg = process.argv[i];
  if (arg === '--json') {
    options.json = true;
  } else if (arg === '--commit') {
    options.commit = true;
  } else if (arg.startsWith('--project=')) {
    options.project = arg.slice('--project='.length);
  } else if (arg === '--project') {
    options.project = process.argv[i + 1] || die('--project requires a value');
    i += 1;
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
    options.targets.push(arg);
  }
}

if (options.targets.length === 0) die('No chapter file or directory provided');

// ---------- 文件收集：目录 → 第NNN章.md；文件原样 ----------

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

// ---------- 指纹库定位：--project 优先，否则从目标目录向上找 追踪/ ----------

function locateLibrary(chapterDirs) {
  if (options.project) return path.join(path.resolve(options.project), '追踪', '段落指纹库.json');
  for (const dir of chapterDirs) {
    let cur = dir;
    for (let depth = 0; depth < 4; depth += 1) {
      const candidate = path.join(cur, '追踪');
      if (fs.existsSync(candidate)) return path.join(candidate, '段落指纹库.json');
      const parent = path.dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
  }
  return null;
}

const chapterDirs = [...new Set(files.map((f) => path.dirname(f)))];
const libraryPath = files.length > 0 ? locateLibrary(chapterDirs) : null;

// ---------- 段落 bigram 集合（去重排序，即段落指纹）----------

function gramsOf(text) {
  const grams = new Set();
  for (let i = 0; i + 1 < text.length; i += 1) {
    grams.add(text.slice(i, i + 2));
  }
  return [...grams].sort();
}

// ---------- 段落切分与叙述段过滤 ----------

function isNarrative(para) {
  if (para.length < 40) return false;
  let inQuote = false;
  let quoted = 0;
  for (const ch of para) {
    if (ch === '“' || ch === '「') inQuote = true;
    else if (ch === '”' || ch === '」') inQuote = false;
    else if (inQuote) quoted += 1;
  }
  return quoted * 2 < para.length;
}

// ---------- 意象台账（P6-2）：比喻句抽取 + 域分类 + 角色就近归属 ----------

// 人名词典：_tracking-state.json 的 characters 键（缺失则角色不归属，fail-open）。
function loadCharacterNames() {
  if (!libraryPath) return [];
  const statePath = path.join(path.dirname(libraryPath), '_tracking-state.json');
  try {
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    return state && typeof state === 'object' && state.characters ? Object.keys(state.characters) : [];
  } catch (error) {
    return [];
  }
}

// 标记词位置（-1 = 非比喻句）；域分类优先取喻体侧（标记词后），喻体无命中再退回全句。
function metaphorAnchor(sentence) {
  for (let i = 0; i < sentence.length; i += 1) {
    for (const word of METAPHOR_WORDS) {
      if (!sentence.startsWith(word, i)) continue;
      if (word === '如') {
        const next = sentence[i + 1] || '';
        const prev = sentence[i - 1] || '';
        if (RU_EXCLUDE_NEXT.includes(next) || RU_EXCLUDE_PREV.includes(prev)) continue;
        return i;
      }
      return i;
    }
  }
  return -1;
}

function classifyDomain(sentence) {
  let best = null;
  let bestHits = 0;
  for (const domain of DOMAINS) {
    let hits = 0;
    for (const key of domain.keys) {
      if (sentence.includes(key)) hits += 1;
    }
    if (hits > bestHits) {
      best = domain.name;
      bestHits = hits;
    }
  }
  return best;
}

// 角色就近归属：比喻句内人名优先，否则同段落最后出现的人名（70-80% 准确率够登记用）。
function nearestCharacter(sentence, para, names) {
  if (names.length === 0) return '';
  for (const name of names) {
    if (sentence.includes(name)) return name;
  }
  let found = '';
  let at = -1;
  for (const name of names) {
    const pos = para.lastIndexOf(name);
    if (pos > at) {
      at = pos;
      found = name;
    }
  }
  return found;
}

// 叙述段 → 比喻句登记条目（句切分按 。！？；，保留句内完整语境）。
function extractMetaphors(para, chapter, names) {
  const out = [];
  for (const sentence of para.split(/[。！？]/)) {
    const s = sentence.trim();
    const anchor = s ? metaphorAnchor(s) : -1;
    if (anchor < 0) continue;
    const domain = classifyDomain(s.slice(anchor + 1)) || classifyDomain(s) || '未分类';
    out.push({
      chapter,
      domain,
      character: nearestCharacter(s, para, names),
      excerpt: s.slice(0, 40),
    });
  }
  return out;
}

// ---------- 指纹库读写（schema 2：加 imagery 节；v1 无 imagery 视为空）----------

const LIB_SCHEMA = 2;

function loadLibrary() {
  if (!libraryPath) return { schema_version: LIB_SCHEMA, entries: [], imagery: [] };
  let raw;
  try {
    raw = fs.readFileSync(libraryPath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { schema_version: LIB_SCHEMA, entries: [], imagery: [] };
    throw error;
  }
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch (error) {
    die(`${libraryPath}: unable to parse library (${error.message})`);
  }
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.entries)) {
    die(`${libraryPath}: library must contain an "entries" array`);
  }
  if (!Array.isArray(doc.imagery)) doc.imagery = [];
  for (const e of doc.entries) {
    if (!Array.isArray(e.grams)) {
      die(`${libraryPath}: entry ${e.chapter || '?'}-${e.para || '?'} missing "grams" (rebuild with --commit)`);
    }
  }
  return doc;
}

// 倒排索引：bigram → 库内条目下标。候选命中计数即交集大小，天然完成剪枝。
function buildInverted(entries) {
  const inverted = new Map();
  for (let i = 0; i < entries.length; i += 1) {
    for (const gram of entries[i].grams) {
      if (!inverted.has(gram)) inverted.set(gram, []);
      inverted.get(gram).push(i);
    }
  }
  return inverted;
}

// ---------- 主流程 ----------

const library = loadLibrary();
const inverted = buildInverted(library.entries);
const characterNames = loadCharacterNames();
const findings = [];
const pending = [];        // --commit 待入库指纹
const pendingImagery = []; // --commit 待入库比喻句
const batchImagery = [];   // 本批已处理章的比喻句（同批多章时窗口统计需要）
const batchChapters = new Set();
const scannedChapters = []; // I1 欠账检测：本批受检正文章号
let paragraphsScanned = 0;

for (const file of files) {
  const nameMatch = CHAPTER_FILE.exec(path.basename(file));
  if (!nameMatch) {
    failed = true;
    if (!options.json) console.error(`${file}: filename must match 第NNN章.md`);
    continue;
  }
  const chapter = Number(nameMatch[1]);
  let input;
  try {
    input = fs.readFileSync(file, 'utf8');
  } catch (error) {
    failed = true;
    if (!options.json) console.error(`${file}: unable to read (${error.message})`);
    continue;
  }
  const lines = input.split(/\r?\n/);
  let chapterPara = 0;
  const currentImagery = [];
  for (let i = 0; i < lines.length; i += 1) {
    const para = lines[i].trim();
    if (!isNarrative(para)) continue;
    chapterPara += 1;
    paragraphsScanned += 1;
    currentImagery.push(...extractMetaphors(para, chapter, characterNames));
    const grams = gramsOf(para);
    // 查历史：倒表计数 = 交集大小 → Jaccard；同章旧指纹不比（重写场景先清后插）。
    const hits = new Map();
    for (const gram of grams) {
      for (const id of inverted.get(gram) || []) {
        hits.set(id, (hits.get(id) || 0) + 1);
      }
    }
    let best = null;
    for (const [id, common] of hits) {
      const entry = library.entries[id];
      if (entry.chapter === chapter) continue;
      const jac = common / (grams.length + entry.grams.length - common);
      if (jac >= PATTERN_THRESHOLD && (best === null || jac > best.jac)) {
        best = { entry, jac };
      }
    }
    if (best) {
      const near = best.jac >= NEAR_THRESHOLD;
      findings.push({
        file: path.relative('.', file),
        line: i + 1,
        column: 1,
        type: near ? 'para-repeat-near' : 'para-repeat-pattern',
        severity: 'advisory',
        message: near
          ? `疑似照抄（相似度 ${best.jac.toFixed(2)}）：与第${best.entry.chapter}章（${best.entry.file} 第${best.entry.para}段）几乎相同——处置直达改写卡：两段原文并排，方向「换比喻域」；约七成可直接删，删令由作者确认。`
          : `换词复读（相似度 ${best.jac.toFixed(2)}）：与第${best.entry.chapter}章（${best.entry.file} 第${best.entry.para}段）结构雷同——升级作者结合意象台账判「有意回环还是坍缩」：回环是意图，坍缩是分布。`,
        excerpt: para.slice(0, 60),
        match: {
          chapter: best.entry.chapter,
          file: best.entry.file,
          para: best.entry.para,
          excerpt: best.entry.excerpt,
          similarity: Number(best.jac.toFixed(4)),
        },
      });
    }
    if (options.commit) {
      pending.push({
        chapter,
        para: chapterPara,
        excerpt: para.slice(0, 60),
        file: path.basename(file),
        grams,
      });
    }
  }

  if (options.commit) pendingImagery.push(...currentImagery);
  batchImagery.push(...currentImagery);
  batchChapters.add(chapter);
  scannedChapters.push(chapter);

  // 意象域密度（P6-2）：本章参与后，滑窗（IMAGERY_WINDOW 章）内同域 ≥IMAGERY_RUN 次
  // 才报——历史旧密度不在本章参与时不报（已在密度形成那章报过）。同批多章时窗口
  // 取「库内旧数据（排除本批章）+ 本批已处理章」，重跑幂等。
  const domainCount = new Map();
  for (const m of currentImagery) domainCount.set(m.domain, (domainCount.get(m.domain) || 0) + 1);
  const windowStart = chapter - IMAGERY_WINDOW + 1;
  const windowImagery = library.imagery
    .filter((e) => e.chapter >= windowStart && e.chapter < chapter && !batchChapters.has(e.chapter))
    .concat(batchImagery.filter((e) => e.chapter >= windowStart && e.chapter < chapter));
  for (const e of windowImagery) {
    domainCount.set(e.domain, (domainCount.get(e.domain) || 0) + 1);
  }
  const chapterDomainHits = new Set(currentImagery.map((m) => m.domain));
  for (const [domain, count] of domainCount) {
    if (count >= IMAGERY_RUN && chapterDomainHits.has(domain)) {
      findings.push({
        file: path.relative('.', file),
        line: 1,
        column: 1,
        type: 'imagery-domain-run',
        severity: 'advisory',
        message: `比喻域疲劳：「${domain}」域在近 ${IMAGERY_WINDOW} 章窗口内出现 ${count} 次——同一域反复采撷即坍缩；改写时查意象台账换域不换词（人物之眼）。`,
        excerpt: `第${chapter}章 × ${domain}域`,
      });
    }
  }
}

// ---------- --commit：同章旧指纹/旧意象先清再插，写盘 + 台账视图 ----------

// 台账视图：域聚合表 + 明细，人物之眼改写协议的查询端。
function renderImageryView(imagery) {
  const lines = [
    '# 意象台账',
    '',
    '> 比喻/闲笔资产登记（P6-2）：哪个域、被谁用过几次。「人物之眼」改写协议的消费端——**换域，而不是换词**。',
    '> 改写时查此表：某域已被同一角色反复采撷就换未用域，换词不换域仍是坍缩。',
    '',
  ];
  if (imagery.length === 0) {
    lines.push('> 暂无比喻句登记（叙述段含「像/如/仿佛」等标记词时自动登记）。');
    return `${lines.join('\n')}\n`;
  }
  const byDomain = new Map();
  for (const m of imagery) {
    if (!byDomain.has(m.domain)) byDomain.set(m.domain, []);
    byDomain.get(m.domain).push(m);
  }
  lines.push('| 域 | 次数 | 角色分布 | 最近章 |');
  lines.push('|---|---|---|---|');
  for (const [domain, items] of [...byDomain.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const roles = new Map();
    for (const m of items) {
      const r = m.character || '未归属';
      roles.set(r, (roles.get(r) || 0) + 1);
    }
    const roleText = [...roles.entries()].map(([r, c]) => `${r}(${c})`).join(' ');
    const lastChapter = Math.max(...items.map((m) => m.chapter));
    lines.push(`| ${domain} | ${items.length} | ${roleText} | 第${lastChapter}章 |`);
  }
  lines.push('', '## 明细（最近 100 条）');
  for (const m of [...imagery].sort((a, b) => b.chapter - a.chapter).slice(0, 100)) {
    lines.push(`- 第${m.chapter}章｜${m.domain}｜${m.character || '—'}｜「${m.excerpt}」`);
  }
  return `${lines.join('\n')}\n`;
}

let committed = 0;
if (options.commit && pending.length > 0) {
  const touchedChapters = [...new Set(pending.map((e) => e.chapter))];
  library.entries = library.entries.filter((e) => !touchedChapters.includes(e.chapter));
  library.entries.push(...pending);
  library.imagery = library.imagery.filter((e) => !touchedChapters.includes(e.chapter));
  library.imagery.push(...pendingImagery);
  library.schema_version = LIB_SCHEMA;
  if (libraryPath) {
    try {
      fs.mkdirSync(path.dirname(libraryPath), { recursive: true });
      fs.writeFileSync(libraryPath, `${JSON.stringify(library, null, 2)}\n`, 'utf8');
      fs.writeFileSync(path.join(path.dirname(libraryPath), '意象台账.md'), renderImageryView(library.imagery), 'utf8');
      committed = pending.length;
    } catch (error) {
      failed = true;
      if (!options.json) console.error(`${libraryPath}: unable to write library (${error.message})`);
    }
  } else {
    failed = true;
    if (!options.json) console.error('--commit requires a project root (use --project or run inside 正文/)');
  }
}

// ---------- I1 指纹库欠账检测（章检模式，docs/06 §三） ----------
// 库最大登记章号 < 受检正文最大章号 → blocking。时序依据（E3）：写章循环第 6 步（追踪
// 提交+指纹固化）先于第 7 步章检——章检时当前章应已入库，落后 1 章即欠账、无容差（勿按
// 「章检先于提交」的直觉加 off-by-one 容差；库 ≥ 受检——如回炉重检旧章——不报）。
// --commit 模式不查（commit 本身就是补齐动作）。存量欠账项目首跑必红是设计行为（D10）：
// 白银案录现状指纹库到 ch61、正文到 ch63，下次章检首跑即报，须先 --commit 补登 62/63。
if (!options.commit && scannedChapters.length > 0 && libraryPath) {
  const targetMax = Math.max(...scannedChapters);
  const libraryMax = library.entries.reduce((acc, e) => Math.max(acc, e.chapter), 0);
  if (libraryMax < targetMax) {
    findings.push({
      file: path.relative('.', files[0]),
      line: 1,
      column: 1,
      type: 'fingerprint-arrears',
      severity: 'blocking',
      message: `指纹库欠账：库登记至第 ${libraryMax} 章，受检正文至第 ${targetMax} 章——第 ${libraryMax + 1} 章起未固化，先跑 --commit 补齐再过章检（写章循环第 6 步：追踪提交+指纹固化为原子双命令）`,
      excerpt: '',
    });
  }
}

const summary = {
  files_scanned: files.length,
  paragraphs_scanned: paragraphsScanned,
  library_entries: library.entries.length,
  near_hits: findings.filter((f) => f.type === 'para-repeat-near').length,
  pattern_hits: findings.filter((f) => f.type === 'para-repeat-pattern').length,
  imagery_hits: findings.filter((f) => f.type === 'imagery-domain-run').length,
  arrears_hits: findings.filter((f) => f.type === 'fingerprint-arrears').length,
  committed,
};

if (options.json) {
  process.stdout.write(`${JSON.stringify({ summary, findings }, null, 2)}\n`);
} else {
  if (summary.library_entries === 0 && !options.commit) {
    console.log(`# 指纹库为空（首章或未 --commit 过）：${summary.paragraphs_scanned} 段叙述段暂无历史可比`);
  }
  for (const f of findings) {
    console.log(`${f.file}:${f.line}:${f.column}: [${f.severity}] ${f.type}: ${f.message}`);
  }
  if (options.commit && committed > 0) {
    console.log(`# 已固化 ${committed} 段指纹入库（${summary.library_entries} 条在库）`);
  }
}

if (failed) process.exit(2);
const hasBlocking = findings.some((f) => f.severity === 'blocking');
if (options.failOn === 'blocking' ? hasBlocking : findings.length > 0) process.exit(1);

function die(message) {
  console.error(message);
  console.error(USAGE.trimEnd());
  process.exit(2);
}
