#!/usr/bin/env node
'use strict';

// guyin-check-pending.js — 待审台账阻断门（U1，docs/09 §二；Fw-07；v3-A1；D3 任务书 §2.4）
//
// 根因五「检测-消费断链」的封堵：章检 hard/verify finding"拦为待审"不再只是话术——
// 每个 finding 一行台账（追踪/待审台账.md）。本脚本机械查台账：当前版本在册行存在
// 未决即 exit 1；--through N 只查章号 ≤N 的行（批收尾核对用）。
//
// D3 台账契约（任务书 §2.4 后半，八列按表头名定位，列序可调）：
//   | 章号 | 来源 | 报警/发现 | 处置类别 | 正文版本 | 终态 | 决定依据 | 去向/备注 |
//   - 处置类别 ∈ {hard, verify}——editorial 留审读记录不入台账，出现在台账即数据异常
//     （exit 2）；空=缺分类，不能默认降为建议。
//   - 正文版本 = hash12（文件字节 sha256 前 12 hex，与 guyin-check-trial-gate.js --hash
//     同口径；处置时版本，修复转结改填修复后新版本）。空=按当前版本保守在册；
//     非法格式=工具错误。--project <root> 时逐章算当前正文哈希比对：不匹配的历史行
//     只是记录（superseded，不阻塞、不冒充当前裁决）；当前版本必须有自己的处置。
//   - 终态严格完整匹配（E16 修复）：未修复/修复中/未知字串均 open，不再子串命中。
//   - 「升级作者」是等待态而非结案（Fw-07/D3）：只有用户真实决定转结——终态列改
//     五终态之一＋证据——才解除；「已裁决：」字样只是线索，不自动闭单。
//   - 五终态证据（决定依据列）：修复=版本列非空＋含「复检」（关联新版本及复检结果）；
//     豁免=含「豁免台账」；契约修订=含「偏差」；顺延=含「伏笔」＋数字（去向章号）；
//     不适用=原文位置＋判定理由（去掉位置标记后 ≥6 字，v3-A1，不耗豁免名额）。
//     不得仅凭填词解除硬问题——证据门槛是最低机械校验，授权/去向/边界由主流程纪律保证。
//
//   - 台账缺失：父目录（追踪/）不存在 → exit 0（非写作项目/未部署不误拦）；父目录
//     存在但台账缺 → exit 2（已部署项目缺台账须报告停靠，不 fail-open）。空项目由
//     setup 创建合法空表。
//   - 损坏数据行（列数≠表头/章号非纯数字/处置类别或版本非法）、缺列、读取失败 →
//     exit 2，不得被静默跳过（旧版 continue 跳过即 E16 系）。
//   - Report-only，永不改写——终态由消费动作回填，不由本脚本。历史行一律保留。
//   - Exit：0=无未决阻断；1=存在未决阻断；2=执行/输入错误（不要把 1 解释为必须改正文）。
//
// 同步注释契约（U1/D2）：本脚本与 guyin-setup 模板 hook（templates/long/.claude/hooks/
// guyin-hook.js 的 pendingBlockers）是同一解析逻辑的两份实现——hook 为部署件随项目走、
// 脚本在技能库，运行时路径不保证可达，无法抽公共模块；改一处必改另一处（八列表头定位/
// 严格匹配/等待态/证据规则/版本比对/损坏即错）。章号口径与 hook 不同（hook 用 < num，
// 本脚本 --through 用 <= N），勿统一。

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const USAGE = `Usage: node guyin-check-pending.js [--json] [--through N] [--project <book-root>] <待审台账.md>

Pending findings blocking gate (docs/09 U1; Fw-07; v3-A1; D3 §2.4).
Ledger contract: 8 columns located BY HEADER NAME (order-adjustable):
  | 章号 | 来源 | 报警/发现 | 处置类别 | 正文版本 | 终态 | 决定依据 | 去向/备注 |
  - 处置类别 must be hard or verify (editorial stays in review notes, never here).
  - 正文版本 = hash12 (sha256 of chapter file bytes, first 12 hex; same as
    guyin-check-trial-gate.js --hash). Blank = conservatively treated as current.
  - 终态 strict full match: 修复/豁免/契约修订/顺延/不适用 close ONLY with
    evidence in 决定依据 (修复=new version + 复检; 豁免=豁免台账; 契约修订=偏差;
    顺延=伏笔+chapter number; 不适用=source position + reason). 升级作者 is a
    WAITING state: closes only by user decision re-filing one of the five
    terminal states — "已裁决：" wording alone never closes. 未修复/修复中/unknown
    strings stay open.
  - --project: compare each row's version against the CURRENT chapter file hash;
    mismatched rows are records only (superseded, not blocking). Chapter file
    missing = conservatively blocking.
Exit codes: 0 = no open blockers; 1 = open blockers exist; 2 = tool/input error
(corrupt rows, missing columns, invalid values, unreadable ledger, missing
ledger while 追踪/ exists). Missing ledger with no parent dir = exit 0.
Report-only: terminal states are filled by consumption, never by this script.`;

const options = { json: false, through: null, input: null, project: null };

function die(message) {
  console.error(message);
  console.error(USAGE.trimEnd());
  process.exit(2);
}

for (let i = 2; i < process.argv.length; i += 1) {
  const arg = process.argv[i];
  if (arg === '--json') {
    options.json = true;
  } else if (arg === '--through') {
    const v = process.argv[i + 1];
    if (v === undefined || !/^\d+$/.test(v)) die('--through requires a chapter number');
    options.through = Number(v);
    i += 1;
  } else if (arg.startsWith('--through=')) {
    const v = arg.slice('--through='.length);
    if (!/^\d+$/.test(v)) die('--through must be a chapter number');
    options.through = Number(v);
  } else if (arg === '--project') {
    const v = process.argv[i + 1];
    if (v === undefined || !v) die('--project requires a book root path');
    options.project = v;
    i += 1;
  } else if (arg.startsWith('--project=')) {
    const v = arg.slice('--project='.length);
    if (!v) die('--project requires a book root path');
    options.project = v;
  } else if (arg === '-h' || arg === '--help') {
    process.stdout.write(`${USAGE}\n`);
    process.exit(0);
  } else if (arg.startsWith('-')) {
    die(`Unknown option: ${arg}`);
  } else if (options.input === null) {
    options.input = arg;
  } else {
    die('Exactly one ledger file expected');
  }
}

if (options.input === null) die('No ledger file provided');

// ---------------------------------------------------------- 八列契约（表头名定位）
const COLUMNS = ['章号', '来源', '报警/发现', '处置类别', '正文版本', '终态', '决定依据', '去向/备注'];
const TERMINAL_STATES = ['修复', '豁免', '契约修订', '顺延', '不适用'];
const WAITING_STATE = '升级作者';
const LEDGER_HANDLING = ['hard', 'verify']; // editorial 不入台账（任务书 §2.4）
const HASH12_RE = /^[0-9a-f]{12}$/;

class LedgerError extends Error {}

function hasSourcePosition(note) {
  return /(第\s*0*\d+\s*章|L\s*0*\d+|\d+\s*[行段]|行\s*\d+|段\s*\d+|:\s*0*\d+)/i.test(note);
}

function notApplicableEvidence(basis) {
  const n = (basis || '').trim();
  if (!n || !hasSourcePosition(n)) return false;
  const reason = n.replace(/(第\s*0*\d+\s*章|L\s*0*\d+|\d+\s*[行段]|行\s*\d+|段\s*\d+|:\s*0*\d+)/gi, '').replace(/\s/g, '');
  return reason.length >= 6;
}

// 终态判定（严格完整匹配；证据在决定依据列）。返回 null=闭合，否则 open 原因码。
function rowOpenReason(state, version, basis) {
  if (state === '' || state === '待审') return 'pending';
  if (state === WAITING_STATE) return 'awaiting-author'; // 等待态：「已裁决：」只是线索，不转结
  if (!TERMINAL_STATES.includes(state)) return 'unknown-state'; // 未修复/修复中/未知值均 open
  if (state === '修复') {
    if (version === '') return 'no-version'; // 修复须关联新版本（版本列非空）
    if (!basis.includes('复检')) return 'missing-evidence';
    return null;
  }
  if (state === '豁免') return basis.includes('豁免台账') ? null : 'missing-evidence';
  if (state === '契约修订') return basis.includes('偏差') ? null : 'missing-evidence';
  if (state === '顺延') return (basis.includes('伏笔') && /\d/.test(basis)) ? null : 'missing-evidence';
  if (state === '不适用') return notApplicableEvidence(basis) ? null : 'missing-evidence';
  return 'unknown-state';
}

// 表格解析：第一条有效 | 行必须是含全部八列名的表头（按名定位，列序可调）；
// 其后 | 行为数据行（{{...}} 占位行与 |---| 分隔行跳过），损坏行抛 LedgerError。
function parseLedger(text, file) {
  const lines = text.split(/\r?\n/);
  const at = (i) => `${file}:${i + 1}`;
  let idx = null; // 列名 → cells 下标
  const rows = [];
  for (let i = 0; i < lines.length; i += 1) {
    const t = lines[i].trim();
    if (!t.startsWith('|')) continue;
    if (t.includes('{{')) continue; // 未实例化模板行
    if (/^[-|:\s]+$/.test(t)) continue; // |---|---| 分隔行
    const cells = t.split('|').map((c) => c.trim());
    if (idx === null) {
      // 表头行：八列名齐备（按名定位）；重复列名/缺列即错。
      const map = {};
      for (let c = 1; c < cells.length - 1; c += 1) {
        if (cells[c] === '') continue;
        if (map[cells[c]] !== undefined) throw new LedgerError(`${at(i)}: 表头列名重复「${cells[c]}」`);
        map[cells[c]] = c;
      }
      const missing = COLUMNS.filter((n) => map[n] === undefined);
      if (missing.length > 0) {
        throw new LedgerError(`${at(i)}: 台账缺列「${missing.join('、')}」（八列契约见脚本 USAGE；旧格式台账须按模板迁移）`);
      }
      idx = map;
      continue;
    }
    // 数据行：列数须与表头一致（首尾 | 产生的空 cells 各一）。
    if (cells.length - 2 !== COLUMNS.length) {
      throw new LedgerError(`${at(i)}: 损坏数据行（${cells.length - 2} 列，应为 ${COLUMNS.length}）——不得静默跳过`);
    }
    const chRaw = cells[idx['章号']];
    if (!/^\d+$/.test(chRaw)) {
      throw new LedgerError(`${at(i)}: 章号列「${chRaw}」非纯数字——损坏行报错，不跳过`);
    }
    const handling = cells[idx['处置类别']];
    if (!LEDGER_HANDLING.includes(handling)) {
      throw new LedgerError(`${at(i)}: 处置类别「${handling || '（空）'}」非法——台账只收 hard/verify（editorial 留审读记录不入台账；空=缺分类不得默认降为建议）`);
    }
    const version = cells[idx['正文版本']];
    if (version !== '' && !HASH12_RE.test(version)) {
      throw new LedgerError(`${at(i)}: 正文版本「${version}」非法——须为 hash12（guyin-check-trial-gate.js --hash 生成，禁手编）；空=按当前版本保守在册`);
    }
    rows.push({
      line: i + 1,
      chapter: parseInt(chRaw, 10),
      source: cells[idx['来源']],
      finding: cells[idx['报警/发现']],
      handling,
      version,
      state: cells[idx['终态']],
      basis: cells[idx['决定依据']],
      note: cells[idx['去向/备注']],
    });
  }
  if (idx === null) throw new LedgerError(`${file}: 未找到八列表头——台账缺失或旧格式（五列）须按模板迁移`);
  return rows;
}

// 当前正文哈希：与 guyin-check-trial-gate.js --hash 同口径（文件字节 sha256 前 12 hex）。
// 章文件匹配容忍补零差异（第1章/第001章）。
function findChapterFile(bookDir, num) {
  try {
    const dir = path.join(bookDir, '正文');
    const name = fs.readdirSync(dir).find((n) => {
      const m = /^第0*(\d+)章.*\.md$/.exec(n);
      return m !== null && parseInt(m[1], 10) === num;
    });
    return name ? path.join(dir, name) : null;
  } catch (e) {
    return null;
  }
}

function hashFile(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 12);
}

// ---------------------------------------------------------- 主流程
let text;
try {
  text = fs.readFileSync(options.input, 'utf8');
} catch (error) {
  if (error.code === 'ENOENT') {
    // 台账缺失：父目录（追踪/）不存在 = 非写作项目/未部署 → 不误拦（exit 0）；
    // 父目录存在但台账缺 = 已部署项目缺台账 → 报告停靠（exit 2，任务书 §2.4）。
    if (!fs.existsSync(path.dirname(path.resolve(options.input)))) {
      if (options.json) {
        process.stdout.write(`${JSON.stringify({ open: [], superseded: [], total: 0, missing: true }, null, 2)}\n`);
      } else {
        console.log(`pending: no ledger and no parent dir at ${options.input} (fail-open, non-book path)`);
      }
      process.exit(0);
    }
    die(`已部署项目缺台账：${options.input} 不存在而其父目录存在——走 /guyin-setup 修复或手工按模板建合法空表，不得静默放行`);
  }
  die(`台账读取失败：${error.message}`);
}

let rows;
try {
  rows = parseLedger(text, options.input);
} catch (e) {
  if (e instanceof LedgerError) die(e.message);
  throw e;
}

// 版本比对（--project 给出时）：版本匹配或空=在册；不匹配=历史记录（superseded）；
// 章文件缺失=保守在册（数据异常值得人工看，宁拦勿漏）。无 --project 全部按在册（保守）。
const currentHash = new Map();
function chapterHash(bookDir, num) {
  if (!options.project) return undefined; // 未提供参照：不比对，全部在册
  if (!currentHash.has(num)) {
    const file = findChapterFile(bookDir, num);
    currentHash.set(num, file ? hashFile(file) : null);
  }
  return currentHash.get(num);
}

const scoped = options.through === null ? rows : rows.filter((r) => r.chapter <= options.through);
const open = [];
const superseded = [];
let total = 0;
for (const r of scoped) {
  const cur = chapterHash(options.project, r.chapter);
  const inScope = cur === undefined || r.version === '' || r.version === cur || cur === null;
  if (!inScope) {
    superseded.push({ ...r, current: cur });
    continue;
  }
  total += 1;
  const reason = rowOpenReason(r.state, r.version, r.basis);
  if (reason !== null) open.push({ ...r, reason, current: cur === undefined ? null : cur });
}

if (options.json) {
  process.stdout.write(`${JSON.stringify({ open, superseded, total }, null, 2)}\n`);
} else {
  for (const r of open) {
    let hint;
    if (r.reason === 'awaiting-author') {
      hint = '「升级作者」是等待态——仅用户真实决定转结（终态列改五选一＋决定依据）才解除，「已裁决：」字样只是线索';
    } else if (r.reason === 'unknown-state') {
      hint = '终态须严格完整匹配五选一（未修复/修复中/未知字串均不闭单）';
    } else if (r.reason === 'no-version') {
      hint = '修复须关联新版本——正文版本列填修复后 hash12（--hash 生成）';
    } else if (r.reason === 'missing-evidence') {
      hint = '决定依据列缺证据：修复=新版本+复检／豁免=豁免台账／契约修订=偏差／顺延=伏笔+章号／不适用=位置+理由';
    } else {
      hint = '消费后回填：终态五选一＋决定依据（升级作者=等待态）';
    }
    console.log(`${options.input}:${r.line}: [open] 第${r.chapter}章 ${r.source}: ${r.finding}（类别=${r.handling} 终态=${r.state === '' ? '（空）' : r.state}）——${hint}`);
  }
  for (const r of superseded) {
    console.log(`${options.input}:${r.line}: [record] 第${r.chapter}章 ${r.source}: ${r.finding}（版本 ${r.version} ≠ 当前 ${r.current}）——历史裁决只记录不阻塞；当前版本须有自己的处置`);
  }
  if (open.length === 0) {
    console.log(`pending: ${total} row(s) in scope, all terminal${options.through === null ? '' : ` (through ch${options.through})`}${superseded.length > 0 ? `; ${superseded.length} superseded record(s)` : ''}`);
  }
}

process.exit(open.length > 0 ? 1 : 0);
