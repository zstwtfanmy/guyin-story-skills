#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const USAGE = `Usage: node guyin-check-outline-verdict.js [--json] [--fail-on=blocking|all] <outline.md...>

细纲资产影响三档声明仲裁（G1，docs/05-实战护栏路线图.md §2）。因果链环节①：正确答案
（"一半是送的"）就在细纲辅助字段里，但情节点序列（卡片的唯一取数源）是全盘表述，没有任何
环节仲裁这个矛盾——本脚本在细纲落盘前机械判档（实证：ch36 细纲档位冲突，执行层照全盘表述
写出 S1「戏是人家排的」，外部修复后的定性实际是档 1「赢是真的，被算计的是专注度」）。

三档（「资产影响档位」声明行，模板字段见 workflow-setup.md 细纲模板）：
  0 纯叠加    既往关键事件定性不变，新信息叠加（支付：无）
  1 部分动用  事件部分维度重估，资产重定价不没收（支付：无）
  2 全盘否定  事件定性被推翻，资产没收（支付：同章补偿声明 + 作者确认，缺一阻断）

机械判档规则（触发不靠意图词表——识破/复盘/反转这类词 flash 会漏判；靠引用与句式检测）：
  既往章引用    细纲引用既往章节编号（chNN / 第N章，N < 本章号）→ 必须有档位声明；
                G2 verdicts 事件名/关键词引用（--state 或 大纲/ 同级 追踪/ 自动发现）同判
  翻转句+引用   「不是A，是B / 不是A而是B」句式 + 既往引用（章号或事件名） → 机械判档 ≥1
  全称量词共现  「从头到尾/每一步都/全是/都是」与既往引用或翻转句同行 → 机械判档 2
  档位冲突      行动成本/人心节拍字段含限定语（一半/半是/某种程度）而细纲含全盘翻转表述
                → 冲突报警，升级作者仲裁
  缺声明        触发任一而细纲无「资产影响档位」行 → 落盘拦截（blocking）
  声明低于判档  声明档 < 机械判档 → advisory（人工仲裁优先于机械判定，确认后可放行）
  档2缺补偿    声明档 2 而行内无「补偿」→ advisory 提醒支付条件（缺一阻断）

G2 verdicts 实体已接入引用检测：--state 显式指定追踪 state，或细纲位于 大纲/ 下时自动
发现同级 追踪/_tracking-state.json（缺失则跳过，只查章号）；细纲引用既往章（chapter <
本章号）verdict 的事件名或关键词即算既往引用。词表均标注 Arena 验证后收紧。

G3 契约对照（advisory，宁可漏不可拦错）：细纲位于 大纲/ 下时自动发现同级 追踪/契约对账矩阵.md
（或 --contracts=<file> 显式指定），解析机械对照区的 C 编号登记行（固定列序：
契约ID|卷号|契约类型|定性关键词|方向|摘要|状态）：
  命中「叠加」契约 + 细纲否定定性（机械判档 ≥1） → 契约越界（实证：ch36 「送出来的」
    否定方向对卷2 危机「误信干净账」叠加方向登记项）
  否定定性 + 零命中 → 未登记契约提醒补录
  命中「否定」契约 + 否定定性 → 方向一致放行（合法推翻须提前登记）
矩阵不存在或解析不出登记行则跳过（自由文本起步，粗对照必有漏报）。`;

// 既往章引用：ch26 / 第26章（跳过「第X阶段第Y章」结构位置行；本章号自身与未来章不算）。
const CH_REF = /(?:ch\s*(\d+)|第\s*(\d+)\s*章)/gi;
// 翻转句：「不是A，是B」/「不是A而是B」。命中片段供档位冲突的语境展示。
const FLIP = /不是[^，。；\n「」『』“”‘’]{1,25}?(?:[，,]\s*(?:也?是)|而是)/;
// 全称量词（05 §2 G1 词表，Arena 验证后收紧）。
const UNIVERSAL = /(从头到尾|每一步都|每一步皆是|全是|都是)/;
// 辅助字段限定语：与全盘翻转表述冲突的信号（ch36 实证：「如今认它一半是送的」）。
const QUALIFIER_FIELD = /^-\s*(?:行动成本|人心节拍)/;
const QUALIFIER = /(一半|半是|某种程度|一部分|部分是)/;
// 档位声明行与档位值。
const VERDICT_LINE = /资产影响档位/;
const VERDICT_TIER = /资产影响档位[^\d]{0,6}([0-2])/;

const options = { json: false, files: [], failOn: 'all', contracts: null, state: null };

// 契约矩阵缓存：多文件同矩阵只解析一次。声明必须先于主循环的 loadContracts 调用，防 TDZ。
const contractsCache = new Map();
// verdicts 缓存：同一 state 只解析一次（同 contractsCache 防TdZ考量，先于主循环声明）。
const verdictsCache = new Map();

for (let i = 2; i < process.argv.length; i += 1) {
  const arg = process.argv[i];
  if (arg === '--json') {
    options.json = true;
  } else if (arg.startsWith('--fail-on=')) {
    const v = arg.slice('--fail-on='.length);
    if (v !== 'blocking' && v !== 'all') die(`--fail-on must be 'blocking' or 'all'`);
    options.failOn = v;
  } else if (arg.startsWith('--contracts=')) {
    options.contracts = arg.slice('--contracts='.length);
  } else if (arg.startsWith('--state=')) {
    options.state = arg.slice('--state='.length);
  } else if (arg === '-h' || arg === '--help') {
    process.stdout.write(`${USAGE}\n`);
    process.exit(0);
  } else if (arg.startsWith('-')) {
    die(`Unknown option: ${arg}`);
  } else {
    options.files.push(arg);
  }
}

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
  const findings = scanOutline(input, loadContracts(fullPath), loadVerdicts(fullPath)).map((finding) => ({ file, ...finding }));
  allFindings.push(...findings);
}

if (options.json) {
  process.stdout.write(`${JSON.stringify({ findings: allFindings }, null, 2)}\n`);
} else {
  for (const f of allFindings) {
    console.log(`${f.file}:${f.line}:${f.column}: [${f.severity}] ${f.type}: ${f.message} (${f.excerpt})`);
  }
}

if (failed) process.exit(2);
const hasBlocking = allFindings.some((f) => f.severity === 'blocking');
if (options.failOn === 'blocking' ? hasBlocking : allFindings.length > 0) process.exit(1);

function die(message) {
  console.error(message);
  console.error(USAGE.trimEnd());
  process.exit(2);
}

function scanOutline(input, contracts = [], verdicts = []) {
  const lines = input.split(/\r?\n/);

  // 本章号：文件首个「第 N 章」（细纲标题行，模板首行即有；无标题行时返回 null，跳过引用判定）。
  let chapterNo = null;
  for (const line of lines) {
    const m = /第\s*(\d+)\s*章/.exec(line);
    if (m) { chapterNo = Number(m[1]); break; }
  }

  const declared = { tier: null, line: null, text: null };
  const pastRef = { hit: false, line: null, text: null };
  const flip = { hit: false, line: null, text: null };
  const tier2 = { hit: false, line: null, text: null };
  const qualifier = { hit: false, line: null, text: null };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const lineNo = i + 1;

    if (declared.tier === null && VERDICT_LINE.test(line)) {
      const m = VERDICT_TIER.exec(line);
      declared.tier = m ? Number(m[1]) : null; // 有声明行但档位不可解析 → tier 保持 null，按缺声明处理
      declared.line = lineNo;
      declared.text = line;
    }

    // 既往章引用（「第X阶段第Y章」是结构位置不是引用，跳过）。
    if (!pastRef.hit && chapterNo !== null && !line.includes('阶段')) {
      CH_REF.lastIndex = 0;
      let m;
      while ((m = CH_REF.exec(line)) !== null) {
        const ref = Number(m[1] || m[2]);
        if (ref < chapterNo) {
          pastRef.hit = true;
          pastRef.line = lineNo;
          pastRef.text = line;
          break;
        }
      }
    }

    // G2 verdicts 事件名引用：细纲提及既往章已登记定性的事件名/关键词（G1 方案表
    // 「翻转句+既往事件」的取数面；兑付当章/未来章的 verdict 不算既往资产）。
    if (!pastRef.hit && verdicts.length > 0) {
      for (const v of verdicts) {
        if (chapterNo !== null && v.chapter >= chapterNo) continue;
        const tokens = [v.event, ...v.keywords].filter((t) => t && t.length >= 2);
        if (tokens.some((t) => line.includes(t))) {
          pastRef.hit = true;
          pastRef.line = lineNo;
          pastRef.text = line;
          break;
        }
      }
    }

    // 翻转句（全篇：核心事件/爽点/情节点/高潮/节拍表都是细纲表述的取数面）。
    if (!flip.hit) {
      const m = FLIP.exec(line);
      if (m) {
        flip.hit = true;
        flip.line = lineNo;
        flip.text = m[0];
      }
    }

    // 全称量词与既往引用/翻转句同行共现 → 机械判档 2。
    if (!tier2.hit && UNIVERSAL.test(line) && !line.includes('阶段')) {
      const hasRefHere = chapterNo !== null && (() => {
        CH_REF.lastIndex = 0;
        let m;
        while ((m = CH_REF.exec(line)) !== null) {
          if (Number(m[1] || m[2]) < chapterNo) return true;
        }
        return false;
      })();
      if (hasRefHere || FLIP.test(line)) {
        tier2.hit = true;
        tier2.line = lineNo;
        tier2.text = line;
      }
    }

    // 辅助字段限定语（档位冲突的其中一翼）。
    if (!qualifier.hit && QUALIFIER_FIELD.test(line) && QUALIFIER.test(line)) {
      qualifier.hit = true;
      qualifier.line = lineNo;
      qualifier.text = line;
    }
  }

  // 机械判档：翻转句+既往引用 → ≥1；全称量词共现 → 2。
  let inferred = 0;
  if (flip.hit && pastRef.hit) inferred = 1;
  if (tier2.hit) inferred = 2;

  const findings = [];
  const firstTrigger = pastRef.hit ? pastRef : flip.hit ? flip : tier2;

  // 缺声明：任何触发（既往引用/翻转句/全称量词共现/限定语冲突）而细纲无档位行 → 落盘拦截。
  const triggered = pastRef.hit || flip.hit || tier2.hit || qualifier.hit;
  if (triggered && declared.tier === null) {
    findings.push({
      line: firstTrigger.line || 1,
      column: 1,
      type: 'verdict-declaration-missing',
      severity: 'blocking',
      message: `缺「资产影响档位」声明：细纲${pastRef.hit ? '引用既往章/事件' : ''}${flip.hit ? '含翻转句' : ''}${tier2.hit ? '含全称量词复盘（机械判档 2）' : ''}——补声明行（0 叠加/1 重估/2 没收须同章补偿+作者确认）后再落盘。`,
      excerpt: compact((firstTrigger.text || '').slice(0, 60)),
    });
  }

  // 档位冲突：辅助字段限定语 vs 全盘翻转表述——正确答案就藏在辅助字段里（ch36：「一半」），
  // 情节点却按全盘写。这是编排层无仲裁能力的最大盲区，一律升级作者。
  if (qualifier.hit && flip.hit) {
    findings.push({
      line: qualifier.line,
      column: 1,
      type: 'verdict-tier-conflict',
      severity: 'blocking',
      message: `档位冲突：辅助字段含限定语而细纲含全盘翻转表述——限定的到底是「一半」还是「全盘」？升级作者仲裁后补声明（机械判档 ${inferred}）。`,
      excerpt: compact(`限定语：${(qualifier.text || '').slice(0, 40)} ｜ 翻转句：${(flip.text || '').slice(0, 30)}`),
    });
  }

  // 声明低于机械判档：人工仲裁优先于机械判定，advisory 提醒确认而非拦截。
  if (declared.tier !== null && declared.tier < inferred) {
    findings.push({
      line: declared.line,
      column: 1,
      type: 'verdict-tier-suspect',
      severity: 'advisory',
      message: `声明档 ${declared.tier} 低于机械判档 ${inferred}：若为作者仲裁结果，确认后放行；否则按机械判档修正声明。`,
      excerpt: compact((declared.text || '').slice(0, 60)),
    });
  }

  // 档 2 支付条件：同章补偿声明 + 作者确认，缺一阻断（05 §2 三档表）。
  if (declared.tier === 2 && !(declared.text || '').includes('补偿')) {
    findings.push({
      line: declared.line,
      column: 1,
      type: 'verdict-tier2-uncompensated',
      severity: 'advisory',
      message: `档 2（全盘否定）支付条件未声明：须同章补偿声明 + 作者确认——在声明行写明补偿（没收资产当章兑付等值或超值）后才可落盘。`,
      excerpt: compact((declared.text || '').slice(0, 60)),
    });
  }

  // G3 契约对照（05 §2 G3，M1）：命中「叠加」契约而细纲含否定定性 → 越界（advisory，只提醒不拦
  // ——粗对照必有漏报，宁可漏不可拦错）；否定定性零命中 → 未登记契约提醒。否定定性信号与
  // G1 机械判档 ≥1 同源，日常修辞翻转句不触发。
  const negSignal = inferred >= 1;
  if (contracts.length > 0) {
    const lines = input.split(/\r?\n/);
    const hits = contracts.filter((c) => c.keywords.some((k) => input.includes(k)));
    let hitLine = null;
    for (let i = 0; i < lines.length && hitLine === null; i += 1) {
      if (hits.some((c) => c.keywords.some((k) => lines[i].includes(k)))) hitLine = i + 1;
    }
    for (const c of hits) {
      if (c.direction === '叠加' && negSignal) {
        findings.push({
          line: hitLine || 1,
          column: 1,
          type: 'contract-violation',
          severity: 'advisory',
          message: `契约越界：命中 ${c.id}（${c.type}·叠加「${c.keywords.join('、')}」）而细纲含否定定性（机械判档 ${inferred}）——叠加契约只许叠加演进，全盘否定即没收资产；对照 G1 档位与补偿声明，升级作者仲裁。`,
          excerpt: compact(`矩阵 ${c.id}：${c.direction}｜${c.keywords.join('、')}`),
        });
      }
    }
    if (negSignal && hits.length === 0) {
      findings.push({
        line: (flip.hit && flip.line) || (tier2.hit && tier2.line) || 1,
        column: 1,
        type: 'contract-unregistered',
        severity: 'advisory',
        message: '未登记契约：细纲含否定定性（机械判档 ≥1）而矩阵零命中——若为新的危机/反转契约，先在 追踪/契约对账矩阵.md 机械对照区补录再落盘。',
        excerpt: compact((flip.text || tier2.text || '').slice(0, 60)),
      });
    }
  }

  findings.sort((a, b) => a.line - b.line || a.column - b.column);
  return findings;
}

function compact(text) {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length > 80 ? `${normalized.slice(0, 77)}...` : normalized;
}

// 契约矩阵发现：--contracts 显式指定，否则细纲在 大纲/ 下时自动找同级 追踪/契约对账矩阵.md。
function loadContracts(outlinePath) {
  let matrix = options.contracts;
  if (!matrix) {
    const dir = path.dirname(path.resolve(outlinePath));
    if (path.basename(dir) !== '大纲') return [];
    const guess = path.join(path.dirname(dir), '追踪', '契约对账矩阵.md');
    if (!fs.existsSync(guess)) return [];
    matrix = guess;
  }
  if (contractsCache.has(matrix)) return contractsCache.get(matrix);
  let contracts = [];
  try {
    contracts = parseContracts(fs.readFileSync(matrix, 'utf8'));
  } catch (e) {
    contracts = []; // fail-open：读不了矩阵跳过对照
  }
  contractsCache.set(matrix, contracts);
  return contracts;
}

// verdicts 发现：--state 显式指定，否则细纲在 大纲/ 下时自动找同级 追踪/_tracking-state.json。
function loadVerdicts(outlinePath) {
  let stateFile = options.state;
  if (!stateFile) {
    const dir = path.dirname(path.resolve(outlinePath));
    if (path.basename(dir) !== '大纲') return [];
    stateFile = path.join(path.dirname(dir), '追踪', '_tracking-state.json');
  }
  if (verdictsCache.has(stateFile)) return verdictsCache.get(stateFile);
  let verdicts = [];
  try {
    const raw = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    const table = raw && typeof raw.verdicts === 'object' && raw.verdicts !== null ? raw.verdicts : {};
    verdicts = Object.values(table)
      .filter((v) => v && typeof v === 'object')
      .map((v) => ({
        chapter: Number.isInteger(v.chapter) && v.chapter > 0 ? v.chapter : null,
        event: typeof v.event === 'string' ? v.event : '',
        keywords: Array.isArray(v.keywords)
          ? v.keywords.filter((k) => typeof k === 'string' && k.length >= 2)
          : [],
      }))
      .filter((v) => v.event.length >= 2 || v.keywords.length > 0);
  } catch (e) {
    verdicts = []; // fail-open：读不了 state 跳过事件名检测，只查章号
  }
  verdictsCache.set(stateFile, verdicts);
  return verdicts;
}

// 机械对照区登记行：| C002 | 2 | 危机 | 干净账、误信 | 叠加 | 摘要 | 状态 |（固定列序）。
function parseContracts(text) {
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!/^\|\s*C\d+/.test(trimmed)) continue;
    const cells = trimmed.replace(/^\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());
    if (cells.length < 5) continue;
    const direction = cells[4] === '叠加' || cells[4] === '否定' ? cells[4] : null;
    if (!direction) continue;
    const keywords = cells[3].split(/[、,，]/).map((k) => k.trim()).filter((k) => k.length >= 2);
    if (keywords.length === 0) continue;
    rows.push({ id: cells[0], volume: cells[1], type: cells[2], keywords, direction });
  }
  return rows;
}
