'use strict';

const fs = require('fs');
const path = require('path');
const handling = require('./lib/guyin-handling');

const USAGE = `Usage: node guyin-check-consistency.js [--json] [--fail-on=block|hard|all] [--state=<file>] <chapter.md...>

物证/能力/地理一致性章检（T1/T2，docs/05-实战护栏路线图.md §5）。全部 verify——
须上下文核实的事实或契约风险，升级作者判读；与 guyin-check-narrative-asset.js 同一
fail-open 约定——找不到追踪/_tracking-state.json 或其中无 evidence/geo/characters
实体时静默跳过。

三规则族（宁漏不拦错，词表全部收窄到高置信形态）：
  1. 物证状态矛盾（T1，verify）：已登记物证的 keywords 与使用/处置动作同现，但登记链说它
     「尚未登场」（登记章 > 本章）或「已销毁/归档」（destroyed/archived 且本章 >
     updated_chapter）→ 报警。拦「修订旧章时引用了未来才登场的物证」与「销毁后
     仍在用」两类登记链断裂。
  2. 能力空降（T1，拦 ch32 小窦型，verify）：角色表现出「会/能/懂/擅长 X」式能力，但该
     角色快照 knowledge 列表无对应条目 → 提示登记或铺垫。能力短语与 knowledge 做
     子串粗匹配，匹配命中即静默。
  3. 地理三查（T2，verify）：① 新地名提示——到达句式「到/至/进/抵 + X州/县/府/城/镇…」
     里的地名不在 geo 台账（含别名）→ 提示登记；② 方向冲突——正文「往/朝/向 +
     方向」句同时出现台账断言的参照地（且近上下文出现断言本名），方向与断言同向
     → 按断言该方向走不到参照地（ch2「顺水往南往通州」而临清在通州以南型矛盾）；
     ③ 行程矛盾——章内相邻方向事件同轴互反（往南…又往北）且无「回/返/折」类
     回归动词 → 提示核对。跨章行程连续性留给实战认证迭代（M2）。

--fail-on=block（默认）hard/verify 任一存在即 1；hard 仅 hard；all 含 editorial（审计模式）。
Exit codes: 0=无未决阻断, 1=存在未决阻断(hard/verify), 2=执行/输入错误。`;

// 物证使用/处置动作（第二层共现词表；第一层是 evidence.keywords 命中）。
const EVIDENCE_ACTION = /拿|取|掏|摊|举|翻|递|比|捏|攥|握|摆|收|塞|揣|带|携|藏|押|缴|起获|呈|封存|入库|销|烧|毁|丢|弃|掷|摔|砸|沉/;
// 能力句式：角色名 + 近距 + 能力标记 + 能力短语（收窄动词集防泛匹配）。
const CAPABILITY_MARKER = /(?:会|能|懂得|擅长|通晓|识得)(?:说|读|写|认|解|画|仿|辨|开|修|医|治|算|背|听懂|认得)?([^，。！？、,;；]{2,16})/;
// 到达句式地名提取（地名 2-4 字 + 聚落后缀；泛指开头字过滤在代码里做）。
const ARRIVAL_PATTERN = /(?:到|至|抵|进|入|赶|行到|到了)([一-龥]{2,4}(?:州|县|府|城|镇|卫|关|渡|驿|集|埠|桥|闸|仓|口|店))/g;
// 方向事件：往/朝/向/顺水/逆水 + 单向字（复合方向东北/东南等先按含字处理，章内矛盾只对单轴判）。
const DIRECTION_EVENT = /(?:往|朝|向|顺水|逆水|一路)([东西南北])/g;
const DIRECTION_AXIS = { 东: '东西', 西: '东西', 南: '南北', 北: '南北' };
// 回归动词：出现即视为合法折返，行程矛盾不报。
const RETURN_WORDS = /回|返|折|掉头|倒回|调头|往回/;
// 到达句式提取的泛指地名首字（「了城/这镇」类不是专名）。
const GENERIC_PLACE_HEAD = new Set(['了', '的', '这', '那', '一', '半', '各', '每', '旧', '新', '大', '小']);
// 被检文件章号（文件名优先）：正文/第036章_标题.md 与 大纲/细纲_第036章.md 皆命中。
const CHAPTER_IN_NAME = /第\s*0*(\d+)\s*章/;

const options = { json: false, files: [], failOn: 'block', state: null, chapter: null };

for (let i = 2; i < process.argv.length; i += 1) {
  const arg = process.argv[i];
  if (arg === '--json') {
    options.json = true;
  } else if (arg.startsWith('--fail-on=')) {
    try {
      options.failOn = handling.parseFailOn(arg.slice('--fail-on='.length), 'block');
    } catch (error) {
      die(error.message);
    }
  } else if (arg.startsWith('--state=')) {
    options.state = arg.slice('--state='.length);
  } else if (arg === '--chapter' || arg === '--unit') {
    options.chapter = Number(process.argv[++i]);
  } else if (arg.startsWith('--chapter=')) {
    options.chapter = Number(arg.slice('--chapter='.length));
  } else if (arg === '-h' || arg === '--help') {
    process.stdout.write(`${USAGE}\n`);
    process.exit(0);
  } else if (arg === '--project' || arg === '--boundary' || arg === '--transaction' || arg === '--outline' || arg === '--title') {
    i += 1; // 候选链统一参数：本脚本不用，消费掉值不报错
  } else if (arg.startsWith('-')) {
    die(`Unknown option: ${arg}`);
  } else {
    options.files.push(arg);
  }
}
if (options.chapter !== null && !Number.isInteger(options.chapter)) die('--chapter 必须是整数');

if (options.files.length === 0) die('No files provided');

let failed = false;
const allFindings = [];

for (const file of options.files) {
  const fullPath = path.resolve(file);
  let input;
  try {
    input = fs.readFileSync(fullPath, 'utf8');
  } catch (error) {
    failed = true;
    if (!options.json) console.error(`${file}: unable to read (${error.message})`);
    continue;
  }
  const findings = scanChapter(input, fullPath).map((finding) => ({ file, ...finding }));
  allFindings.push(...findings);
}

try {
  handling.finalizeFindings(allFindings, 'guyin-check-consistency.js');
} catch (error) {
  die(error.message);
}

if (options.json) {
  process.stdout.write(`${JSON.stringify({
    findings: allFindings,
    files_scanned: options.files.map((f) => require('path').resolve(f)),
  }, null, 2)}\n`);
} else {
  for (const f of allFindings) {
    console.log(`${f.file}:${f.line}:${f.column}: [${handling.label(f)}] ${f.type}: ${f.message} (${f.excerpt})`);
  }
}

if (failed) process.exit(2);
process.exit(handling.gateTripped(allFindings, options.failOn) ? 1 : 0);

function die(message) {
  console.error(message);
  console.error(USAGE.trimEnd());
  process.exit(2);
}

function compact(text) {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length > 80 ? `${normalized.slice(0, 77)}...` : normalized;
}

// state 发现：--state 显式；否则被检文件目录的同级（正文/大纲布局）或当层（书根布局）追踪/。
function findState(chapterPath) {
  if (options.state) return path.resolve(options.state);
  const dir = path.dirname(path.resolve(chapterPath));
  const candidates = [
    path.join(dir, '..', '追踪', '_tracking-state.json'),
    path.join(dir, '追踪', '_tracking-state.json'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function loadEntities(statePath) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch (error) {
    // 显式指定的 state 读不了是真错误；自动发现的 fail-open（advisory 层缺输入宁漏不噪）。
    if (options.state) die(`unable to read tracking state ${statePath}: ${error.message}`);
    return null;
  }
  const evidence = [];
  const table = raw && typeof raw.evidence === 'object' && raw.evidence !== null ? raw.evidence : {};
  for (const v of Object.values(table)) {
    if (!v || typeof v !== 'object') continue;
    const keywords = Array.isArray(v.keywords)
      ? v.keywords.filter((k) => typeof k === 'string' && k.length >= 2)
      : [];
    if (keywords.length === 0) continue;
    evidence.push({
      id: typeof v.id === 'string' ? v.id : '?',
      name: typeof v.name === 'string' ? v.name : '',
      chapter: Number.isInteger(v.chapter) && v.chapter > 0 ? v.chapter : null,
      status: typeof v.status === 'string' ? v.status : 'held',
      holder: typeof v.holder === 'string' ? v.holder : '',
      updated: Number.isInteger(v.updated_chapter) && v.updated_chapter > 0 ? v.updated_chapter : null,
      keywords,
    });
  }
  const geo = [];
  const geoTable = raw && typeof raw.geo === 'object' && raw.geo !== null ? raw.geo : {};
  for (const v of Object.values(geoTable)) {
    if (!v || typeof v !== 'object') continue;
    const names = [v.name, ...(Array.isArray(v.aliases) ? v.aliases : [])].filter(
      (n) => typeof n === 'string' && n.length >= 2
    );
    if (names.length === 0) continue;
    geo.push({
      id: typeof v.id === 'string' ? v.id : '?',
      names,
      name: typeof v.name === 'string' ? v.name : '',
      ref: typeof v.ref === 'string' && v.ref ? v.ref : null,
      direction: typeof v.direction === 'string' ? v.direction : null,
    });
  }
  const characters = [];
  const charTable = raw && typeof raw.characters === 'object' && raw.characters !== null ? raw.characters : {};
  for (const [name, v] of Object.entries(charTable)) {
    if (!v || typeof v !== 'object') continue;
    characters.push({
      name,
      knowledge: Array.isArray(v.knowledge)
        ? v.knowledge.filter((k) => typeof k === 'string' && k.length >= 2)
        : [],
    });
  }
  return { evidence, geo, characters };
}

function scanChapter(input, fullPath) {
  const statePath = findState(fullPath);
  if (!statePath) return [];
  const entities = loadEntities(statePath);
  if (!entities) return [];
  const { evidence, geo, characters } = entities;

  const lines = input.split(/\r?\n/);
  const nameMatch = CHAPTER_IN_NAME.exec(path.basename(fullPath));
  const fileChapter = options.chapter !== null ? options.chapter : (nameMatch ? Number(nameMatch[1]) : null);
  const findings = [];

  // ── 规则 1：物证状态矛盾（keywords × 使用动作双层共现 + 登记链比对）。
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    for (const e of evidence) {
      if (!e.keywords.some((k) => line.includes(k))) continue;
      if (!EVIDENCE_ACTION.test(line)) continue;
      const statusLabels = { destroyed: '已销毁', archived: '已归档' };
      if ((e.status === 'destroyed' || e.status === 'archived') && fileChapter !== null && e.updated !== null && fileChapter > e.updated) {
        findings.push({
          line: i + 1,
          column: 1,
          type: 'evidence-status-conflict',
          severity: 'advisory',
          message: `物证 ${e.id}「${e.name}」${statusLabels[e.status]}（第${e.updated}章）却在本章使用/处置句中出现——销毁/归档后的引用要么是回叙（写明「当初」），要么登记链漏更新，核对台账。`,
          excerpt: compact(line.slice(0, 90)),
        });
        continue;
      }
      if (e.chapter !== null && fileChapter !== null && e.chapter > fileChapter) {
        findings.push({
          line: i + 1,
          column: 1,
          type: 'evidence-premature-use',
          severity: 'advisory',
          message: `物证 ${e.id}「${e.name}」登记登场章（第${e.chapter}章）晚于本章——本章却在使用它；修订旧章时要么物证本就该早登场（改台账登场章），要么此句是未来物证空降。`,
          excerpt: compact(line.slice(0, 90)),
        });
      }
    }
  }

  // ── 规则 2：能力空降（角色能力句式 × knowledge 粗匹配）。
  if (characters.length > 0) {
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      for (const c of characters) {
        let from = 0;
        let nameIdx;
        while ((nameIdx = line.indexOf(c.name, from)) !== -1) {
          const rest = line.slice(nameIdx + c.name.length, nameIdx + c.name.length + 24);
          const m = CAPABILITY_MARKER.exec(rest);
          if (m && m[1]) {
            const phrase = m[1];
            const known = c.knowledge.some((k) => k.includes(phrase) || phrase.includes(k.slice(0, 4)));
            if (!known) {
              findings.push({
                line: i + 1,
                column: nameIdx + 1,
                type: 'capability-unregistered',
                severity: 'advisory',
                message: `角色「${c.name}」表现出能力「${phrase}」，但快照 knowledge 未登记——要么补登记（章 delta 更新角色快照），要么删掉这句能力展示（ch32 型能力空降：描形状三 chapters 后突然交数值解码）。`,
                excerpt: compact(line.slice(Math.max(0, nameIdx - 6), nameIdx + c.name.length + 24)),
              });
            }
          }
          from = nameIdx + c.name.length;
        }
      }
    }
  }

  // ── 规则 3①：新地名提示（到达句式地名 × geo 台账）。
  if (geo.length > 0) {
    const knownPlaces = new Set(geo.flatMap((g) => g.names));
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      ARRIVAL_PATTERN.lastIndex = 0;
      let match;
      while ((match = ARRIVAL_PATTERN.exec(line)) !== null) {
        const place = match[1];
        if (GENERIC_PLACE_HEAD.has(place[0])) continue;
        if (knownPlaces.has(place)) continue;
        // 台账规范名的子串也算已知（「临清州」覆盖「临清」登记）。
        if (geo.some((g) => g.names.some((n) => n.includes(place) || place.includes(n)))) continue;
        findings.push({
          line: i + 1,
          column: match.index + 1,
          type: 'place-unregistered',
          severity: 'advisory',
          message: `地名「${place}」出现在到达句但 geo 台账未登记——首次登场的地名当章 delta.geo_changes 登记（规范名+别名+方位断言存正文原句）；若已登记请补别名。`,
          excerpt: compact(line.slice(Math.max(0, match.index - 6), match.index + place.length + 8)),
        });
      }
    }

    // ── 规则 3②：方向冲突（方向事件 × 断言参照地 × 近上下文本名）。
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      DIRECTION_EVENT.lastIndex = 0;
      let match;
      while ((match = DIRECTION_EVENT.exec(line)) !== null) {
        const dir = match[1];
        for (const g of geo) {
          if (!g.ref || !g.direction) continue;
          if (g.direction !== dir) continue; // 断言同向才可能冲突（反向=朝着参照地走，正确）
          if (!line.includes(g.ref)) continue;
          const context = lines.slice(Math.max(0, i - 2), i + 1).join(' ');
          if (!g.names.some((n) => context.includes(n))) continue;
          findings.push({
            line: i + 1,
            column: match.index + 1,
            type: 'direction-conflict',
            severity: 'advisory',
            message: `方向与台账断言冲突：geo ${g.id} 断言「${g.name} 在 ${g.ref} 以${g.direction}」，但从${g.name}一带往${dir}走离${g.ref}更远（ch2「顺水往南往通州」型矛盾）——核对正文方向或断言。`,
            excerpt: compact(line.slice(Math.max(0, match.index - 8), match.index + 16)),
          });
        }
      }
    }

    // ── 规则 3③：行程矛盾（章内相邻方向事件同轴互反且无回归动词）。
    const events = [];
    for (let i = 0; i < lines.length; i += 1) {
      DIRECTION_EVENT.lastIndex = 0;
      let match;
      while ((match = DIRECTION_EVENT.exec(lines[i])) !== null) {
        events.push({ line: i, dir: match[1] });
      }
    }
    for (let a = 1; a < events.length; a += 1) {
      const prev = events[a - 1];
      const cur = events[a];
      if (cur.line - prev.line > 3) continue;
      if (DIRECTION_AXIS[prev.dir] !== DIRECTION_AXIS[cur.dir] || prev.dir === cur.dir) continue;
      const between = lines.slice(prev.line, cur.line + 1).join(' ');
      if (RETURN_WORDS.test(between)) continue;
      findings.push({
        line: cur.line + 1,
        column: 1,
        type: 'route-contradiction',
        severity: 'advisory',
        message: `章内行程矛盾：第${prev.line + 1}行往${prev.dir}、第${cur.line + 1}行往${cur.dir}，间隔 ${cur.line - prev.line} 行且无「回/返/折」类回归动词——要么补转折（中途折返/改道），要么统一方向（ch15 往西 vs ch16 往东型）。`,
        excerpt: compact(lines[cur.line].slice(0, 60)),
      });
    }
  }

  return findings;
}
