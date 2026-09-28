#!/usr/bin/env node
'use strict';

// guyin-check-trial-gate.js — 用户验收检查点门（Fw-06 + v3-A2 + E1）
//
// E1 定位（任务书 §3 E）：固定的「第4章必须第三方试读」改为**用户确认的验收检查点**——
//   新书默认前三章后停（隐式默认检查点：覆盖 ch1-3，第 4 章开写前到点）；
//   续写按本次选定连续段在「## 验收检查点」表显式登记（覆盖范围/到点章/状态）。
//   不增加第三方准入负担：反馈来源「用户验收」（作者本人以读者身份验收）与
//   「独立读者」（没读过设定/细纲的人）都有效；「模型审读」如实记录但永不顶替人。
//
// 仍是「可审计的反馈手续门」，不是满意度认证——验证结构与版本关联，不验证回答质量，
// 不认证「真人身份」或「文学品质」。负面「不想看」是合法答案（保留原话，不迫使人改口）；
// 空白/占位不是反馈。旧反馈保留在表内，但版本锚不符当前正文即不可冒充当前版本验收。
//
// 输入：<root>/追踪/读者信号.md
//   「## 验收检查点」节：| 段 | 覆盖范围 | 到点章 | 状态 |
//     状态：启用（默认）/ 暂停（到点即拦，不续写）/ 延期@第K章（检查点移到 K，
//           验收段顺延为 段起点～K-1；延期是显式手续，不能静默豁免）。
//     该节缺失或无有效行 → 隐式默认：新书前三章（覆盖 1-3，到点章 4）。
//   「## 试读记录」节（标题允许括注）表列按表头名定位，E1 新增/改动：
//     来源：用户验收 / 独立读者 / 模型审读（模型行不计入有效验收）；
//     版本锚：有序 章号:哈希 列表（`--hash` 生成，禁止手编）；
//     相对偏好：可平/都差/更想读X稿/不适用；
//     处置：修订@第N章 / 保留并说明原因 / 暂停 / 待处理。
//   旧表无「来源」列：旧行暂按有效人类反馈计（不追溯），出 editorial 提示补登。
//
// 机械口径（N=即将写的章号；无到点检查点时静默）：
//   到点检查点 = 到点章 ≤ N；其所需覆盖 = 状态启用：登记范围；延期@K：起点～K-1。
//   - 读者信号.md 缺失且有到点检查点（默认即 N≥4）→ hard trial-gate-missing
//   - 到点检查点状态「暂停」→ hard trial-gate-paused
//   - 有效验收行 = 试读人非空 + 来源∈{用户验收,独立读者} + 想不想看下一章已答
//              + 版本锚与当前正文哈希匹配（旧稿试读不能冒充新稿）
//   - 答案空白/占位 → trial-gate-incomplete；来源空（新表）→ trial-gate-incomplete-source；
//     仅有模型审读行覆盖 → trial-gate-source（模型不能顶替人）
//   - 覆盖缺口 → trial-gate-missing（点名缺哪些 ch）
//   - 最新有效行处置：空/待处理 → trial-gate-undecided；暂停 → trial-gate-paused；
//     修订@第N章 → 仅放行写第N章本身，否则 trial-gate-revision-scope；保留 → 放行
//   - 无阻断且最近验收覆盖末端 < N-3、又未登记更远的检查点 → verify trial-gate-stale
//     （提示作者登记下一续写连续段，不替作者定节奏）
//   - 读取异常（非缺失的 IO 错误）→ exit 2 工具错误，不当「没有问题」
//
// --hash 子命令：`--hash --project <root> --chapters 1-3` 输出版本锚串，由作者/编排层
//   复制进表——哈希由工具计算，模型不得编造。Report-only，永不改写。

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const handling = require('./lib/guyin-handling');

const USAGE = `Usage: node guyin-check-trial-gate.js --project <book-root> --chapter N [--json] [--fail-on=block|hard|all]
       node guyin-check-trial-gate.js --hash --project <book-root> --chapters 1-3

User-acceptance checkpoint gate (Fw-06 + E1). Checkpoints are user-confirmed, not a
  fixed third-party requirement: new books default to a stop after ch1-3 (due before
  ch4); continuations register the selected continuous segment in the 验收检查点 table.
  Valid acceptance row = reader named + source 用户验收/独立读者 (模型审读 never counts)
  + answer filled (negative is legal) + version anchor matching CURRENT file hashes.
At a due checkpoint (到点章 <= N):
  missing 读者信号.md / coverage gap          -> hard trial-gate-missing
  checkpoint status 暂停                       -> hard trial-gate-paused
  blank answer / blank source (new table)     -> hard trial-gate-incomplete/-incomplete-source
  only 模型审读 rows cover the segment         -> hard trial-gate-source
  version anchor missing/mismatched           -> hard trial-gate-version
  latest valid row undecided / paused         -> hard trial-gate-undecided/-paused
  修订@第N章 disposition                        -> only writing ch N itself passes
  no due checkpoint / satisfied + far from next-> silent (a verify trial-gate-stale
                                                  nudge when coverage end < N-3 and no
                                                  later checkpoint is registered)
Old tables without a 来源 column: legacy rows still count, one editorial nudge.
Read errors other than missing-file exit 2 (tool error, not "no problem").
Exit codes: 0 = 无未决阻断; 1 = 存在未决阻断（hard/verify）; 2 = 执行/输入错误。
--fail-on=block（默认）hard+verify 计 1; hard 仅 hard; all 含 editorial（审计模式）。
--hash prints the version-anchor string for the given chapters (tool-computed,
  never hand-written) to paste into the 版本锚 column.`;

const options = { json: false, failOn: 'block', project: null, chapter: null, hash: false, chapters: null };

function die(message) {
  console.error(message);
  console.error(USAGE.trimEnd());
  process.exit(2);
}

function parseChaptersArg(raw) {
  const out = new Set();
  for (const part of String(raw).split(/[,，、;；\s]+/).filter(Boolean)) {
    const nums = (part.match(/\d+/g) || []).map(Number);
    if (nums.length === 1) {
      out.add(nums[0]);
    } else if (nums.length === 2 && /[-–—~～至到]/.test(part) && nums[0] <= nums[1]) {
      for (let c = nums[0]; c <= nums[1]; c += 1) out.add(c);
    }
  }
  return [...out];
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
  } else if (arg === '--hash') {
    options.hash = true;
  } else if (arg === '--chapters' || arg.startsWith('--chapters=')) {
    const v = arg === '--chapters' ? process.argv[i + 1] : arg.slice('--chapters='.length);
    if (v === undefined || !/\d/.test(v)) die('--chapters requires chapter numbers (e.g. 1-3 or 1,2,3)');
    options.chapters = v;
    if (arg === '--chapters') i += 1;
  } else if (arg === '--project') {
    options.project = process.argv[i + 1];
    if (options.project === undefined) die('--project requires a value');
    i += 1;
  } else if (arg.startsWith('--project=')) {
    options.project = arg.slice('--project='.length);
  } else if (arg === '--chapter') {
    const v = process.argv[i + 1];
    if (v === undefined || !/^\d+$/.test(v)) die('--chapter requires a chapter number');
    options.chapter = Number(v);
    i += 1;
  } else if (arg.startsWith('--chapter=')) {
    const v = arg.slice('--chapter='.length);
    if (!/^\d+$/.test(v)) die('--chapter must be a chapter number');
    options.chapter = Number(v);
  } else if (arg === '-h' || arg === '--help') {
    process.stdout.write(`${USAGE}\n`);
    process.exit(0);
  } else if (arg.startsWith('-')) {
    die(`Unknown option: ${arg}`);
  } else {
    die(`Unexpected argument: ${arg}`);
  }
}

if (!options.project) die('--project is required (project root containing 追踪/)');
if (options.hash) {
  if (!options.chapters) die('--hash requires --chapters (e.g. 1-3)');
  const root = path.resolve(options.project);
  const parts = [];
  for (const c of parseChaptersArg(options.chapters).sort((a, b) => a - b)) {
    const file = findChapterFile(root, c);
    if (!file) die(`--hash: 第${c}章正文文件未找到（正文/第${pad3(c)}章_*.md）`);
    parts.push(`第${c}章:${hashFile(file)}`);
  }
  // 分隔符用「；」——不能用「|」，否则在 markdown 表格列内会被切列（实测教训）。
  process.stdout.write(`${parts.join('；')}\n`);
  process.exit(0);
}
if (options.chapter === null) die('--chapter is required (chapter about to be written)');

const root = path.resolve(options.project);
const signalPath = path.join(root, '追踪', '读者信号.md');

// ---- 章文件定位与哈希 ----
function pad3(n) {
  return String(n).padStart(3, '0');
}

function findChapterFile(bookRoot, chapter) {
  const dir = path.join(bookRoot, '正文');
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch (error) {
    return null;
  }
  const prefix = `第${pad3(chapter)}章`;
  const hit = entries.find((e) => e.startsWith(prefix) && e.endsWith('.md'));
  return hit ? path.join(dir, hit) : null;
}

function hashFile(file) {
  const content = fs.readFileSync(file);
  return crypto.createHash('sha256').update(content).digest('hex').slice(0, 12);
}

let text;
try {
  text = fs.readFileSync(signalPath, 'utf8');
} catch (error) {
  if (error.code === 'ENOENT') {
    // E1：缺件时只有隐式默认检查点（新书前三章，到点章 4）。N≥4＝到点 → blocking；
    // N<4 写作期静默。续写项目的显式检查点登记在本文件内，文件缺即无显式登记。
    const findings = [];
    if (options.chapter >= 4) {
      findings.push({
        file: signalPath,
        line: 1,
        column: 1,
        type: 'trial-gate-missing',
        severity: 'blocking',
        message: `写第${options.chapter}章前默认验收检查点（新书前三章，覆盖 ch1-3）未完成：「追踪/读者信号.md」不存在——部署模板（/guyin-setup）后由用户本人验收（用户验收）或找一位没读过设定/细纲的独立读者直读 ch1-3，回填反馈；版本锚用 --hash 子命令生成，不能编造。续写在「验收检查点」表登记本次连续段；旧项目由作者显式启动补手续，不批量补造反馈记录`,
        excerpt: '',
      });
    }
    try {
      handling.finalizeFindings(findings, 'guyin-check-trial-gate');
    } catch (e) {
      die(e.message);
    }
    if (options.json) {
      process.stdout.write(`${JSON.stringify({
        findings,
        chapter: options.chapter,
        missing: true,
        disclaimer: '验收检查点门非满意度认证：只验证结构与版本关联，不认证真人身份或文学品质；来源限用户验收/独立读者，模型审读不能顶替人；回答质量与最终处置归作者',
      }, null, 2)}\n`);
    } else if (findings.length > 0) {
      for (const f of findings) console.log(`${f.file}:${f.line}:${f.column}: [${handling.label(f)}] ${f.type}: ${f.message}`);
    } else {
      console.log('trial-gate: no 读者信号.md (no due checkpoint, silent)');
    }
    process.exit(handling.gateTripped(findings, options.failOn) ? 1 : 0);
  }
  // v3-A2：读取异常（权限/编码等）是工具错误，不当「没有问题」。
  console.error(`trial-gate: read error on ${signalPath}: ${error.message}`);
  process.exit(2);
}

const findings = [];
const lines = text.split(/\r?\n/);

// ---- 节定位（标题允许括注，如「试读记录（用户验收/独立读者，Fw-06）」） ----
function locateSectionBy(titleRe) {
  let start = -1;
  let level = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const m = titleRe.exec(lines[i].trim());
    if (m) { start = i; level = m[1].length; break; }
  }
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    const m = /^(#{1,6})\s*\S/.exec(lines[i].trim());
    if (m && m[1].length <= level) { end = i; break; }
  }
  return { startLine: start + 1, endLine: end };
}

const section = locateSectionBy(/^(#{1,6})\s*试读记录(?:[（(][^）)]*[）)])?\s*[\s:：]*$/);
const checkpointSection = locateSectionBy(/^(#{1,6})\s*验收检查点(?:[（(][^）)]*[）)])?\s*[\s:：]*$/);

// ---- 章范围 → 章号数组 ----
function parseRange(cell) {
  const out = new Set();
  for (const part of cell.split(/[,，、;；\s]+/).filter(Boolean)) {
    const nums = (part.match(/\d+/g) || []).map(Number);
    if (nums.length === 1) {
      out.add(nums[0]);
    } else if (nums.length === 2 && /[-–—~～至到]/.test(part) && nums[0] <= nums[1]) {
      for (let c = nums[0]; c <= nums[1]; c += 1) out.add(c);
    }
  }
  return [...out];
}

// ---- 版本锚解析：第N章:hash 的有序映射 ----
function parseVersionAnchor(cell) {
  const map = new Map();
  const re = /第\s*(\d+)\s*章[：:]([0-9a-fA-F]{8,64})/g;
  let m;
  while ((m = re.exec(cell)) !== null) {
    map.set(Number(m[1]), m[2].toLowerCase());
  }
  return map;
}

// ---- 试读表表头列位映射（按表头名定位，模板列序可调） ----
function headerIndexMap(headerLine) {
  const cells = headerLine.split('|').map((c) => c.trim());
  const map = {};
  cells.forEach((name, idx) => {
    if (/日期/.test(name)) map.date = idx;
    else if (/来源/.test(name)) map.source = idx;
    else if (/试读人/.test(name)) map.reader = idx;
    else if (/章范围/.test(name)) map.range = idx;
    else if (/想不想看/.test(name)) map.will = idx;
    else if (/版本锚/.test(name)) map.anchor = idx;
    else if (/相对偏好/.test(name)) map.pref = idx;
    else if (/处置/.test(name)) map.disposition = idx;
  });
  return map;
}

const N = options.chapter;

// 逐行解析试读表。
function parseRows() {
  if (!section) return { rows: [], tableSeen: false, headerMap: null, headerLine: 0 };
  let tableSeen = false;
  let headerMap = null;
  let headerLine = 0;
  const rows = [];
  for (let i = section.startLine; i < section.endLine; i += 1) { // 1-based
    const t = lines[i - 1] && lines[i - 1].trim();
    if (!t || !t.startsWith('|')) continue;
    if (t.includes('{{')) continue; // 模板占位行跳过（不是反馈）
    if (/^[-|:\s]+$/.test(t)) continue; // 分隔行
    const cells = t.split('|').map((c) => c.trim());
    if (/章范围/.test(t) && /试读人/.test(t) && cells.length >= 4) {
      // 表头行
      tableSeen = true;
      headerLine = i;
      headerMap = headerIndexMap(t);
      continue;
    }
    if (cells.length < 4) continue;
    rows.push({ line: i, cells, headerMap });
  }
  return { rows, tableSeen, headerMap, headerLine };
}

function cellOf(row, key) {
  if (!row.headerMap || row.headerMap[key] === undefined) return '';
  return (row.cells[row.headerMap[key]] || '').trim();
}

// ---- E1：反馈来源分类。模型审读如实留档但永不顶替人；空串=未填 ----
function classifySource(cell) {
  if (/模型/.test(cell)) return 'model';
  if (/用户|本人/.test(cell)) return 'user';
  if (/独立/.test(cell)) return 'reader';
  return '';
}

// ---- E1：验收检查点登记解析（| 段 | 覆盖范围 | 到点章 | 状态 |） ----
function parseCheckpointStatus(cell) {
  if (/^暂停/.test(cell)) return { kind: 'paused' };
  const postponed = /延期[^0-9]*(\d+)/.exec(cell);
  if (postponed) return { kind: 'postponed', to: Number(postponed[1]) };
  return { kind: 'active' };
}

function parseCheckpoints() {
  if (!checkpointSection) return { rows: null, malformed: [], headerLine: 0 };
  let colMap = null;
  let headerLine = 0;
  const rows = [];
  const malformed = [];
  for (let i = checkpointSection.startLine; i < checkpointSection.endLine; i += 1) {
    const t = lines[i - 1] && lines[i - 1].trim();
    if (!t || !t.startsWith('|')) continue;
    if (t.includes('{{')) continue;
    if (/^[-|:\s]+$/.test(t)) continue;
    const cells = t.split('|').map((c) => c.trim());
    if (/覆盖范围/.test(t) && /到点章/.test(t)) {
      colMap = {};
      cells.forEach((name, idx) => {
        if (/覆盖范围/.test(name)) colMap.range = idx;
        else if (/到点章/.test(name)) colMap.trigger = idx;
        else if (/状态/.test(name)) colMap.status = idx;
        else if (/段|名称|检查点/.test(name)) colMap.label = idx;
      });
      headerLine = i;
      continue;
    }
    if (!colMap || cells.length < 5) continue;
    const label = (cells[colMap.label] || '').trim() || `第${i}行检查点`;
    const rng = parseRange(cells[colMap.range] || '');
    const trigM = /\d+/.exec((cells[colMap.trigger] || '').trim());
    if (rng.length === 0 || !trigM) {
      malformed.push({ line: i, text: t.slice(0, 80) });
      continue;
    }
    const rawStatus = (cells[colMap.status] || '').trim();
    const st = parseCheckpointStatus(rawStatus);
    rows.push({
      line: i,
      label,
      start: Math.min(...rng),
      end: Math.max(...rng),
      origTrigger: Number(trigM[0]),
      trigger: st.kind === 'postponed' ? st.to : Number(trigM[0]),
      kind: st.kind,
      rawStatus,
    });
  }
  return { rows, malformed, headerLine };
}

// 检查点所需验收覆盖：延期@K → 验收段顺延为起点～K-1（连续段）。
function requiredChapters(cp) {
  const end = cp.kind === 'postponed' ? Math.max(cp.end, cp.trigger - 1) : cp.end;
  const out = [];
  for (let c = cp.start; c <= end; c += 1) out.push(c);
  return out;
}

// 隐式默认：新书前三章后停（任务书 §3 E：新书可默认前三章后停）。
const IMPLICIT_DEFAULT = [{
  line: 1, label: '新书前三章（默认）', start: 1, end: 3,
  origTrigger: 4, trigger: 4, kind: 'active', rawStatus: '启用', implicit: true,
}];

// ---- 主检查（N≥4；无到点检查点则静默） ----
if (N >= 4) {
  const cpParsed = parseCheckpoints();
  // 节内有有效登记行 → 以登记为准（续写）；无节或零行 → 隐式新书默认。
  // 有畸形行（范围/到点章无法解析）→ 不回退默认，直接拦（宁停勿猜）。
  const explicit = cpParsed.rows !== null && cpParsed.rows.length > 0;
  const checkpoints = explicit ? cpParsed.rows : IMPLICIT_DEFAULT.map((cp) => ({ ...cp }));

  for (const bad of cpParsed.malformed) {
    findings.push({
      file: signalPath,
      line: bad.line,
      column: 1,
      type: 'trial-gate-checkpoint-bad',
      severity: 'blocking',
      message: `「验收检查点」表该行无法解析（覆盖范围或到点章缺章号）——登记格式「段 | 范围（如 12-18） | 到点章 | 状态（启用/暂停/延期@第K章）」；删行或修正后再写，不回退默认检查点`,
      excerpt: bad.text,
    });
  }

  const due = checkpoints.filter((cp) => cp.trigger <= N);
  const dueNonPaused = due.filter((cp) => cp.kind !== 'paused');
  const needSet = new Set();
  for (const cp of dueNonPaused) for (const c of requiredChapters(cp)) needSet.add(c);

  if (due.length > 0) {
    // 到点检查点状态「暂停」→ 不续写（先于一切文书判定）。
    for (const cp of due.filter((cp) => cp.kind === 'paused')) {
      findings.push({
        file: signalPath,
        line: cp.line,
        column: 1,
        type: 'trial-gate-paused',
        severity: 'blocking',
        message: `验收检查点「${cp.label}」（覆盖 ch${cp.start}-${cp.end}）状态为「暂停」——按用户决定停写；恢复由作者把状态改回「启用」并完成到点验收`,
        excerpt: (lines[cp.line - 1] || '').trim().slice(0, 60),
      });
    }

    if (dueNonPaused.length > 0) {
      const { rows, tableSeen, headerMap, headerLine } = parseRows();

      if (!section || !tableSeen || rows.length === 0) {
        const cpLabel = dueNonPaused.map((cp) => `${cp.label}（ch${cp.start}-${requiredChapters(cp).slice(-1)[0]}）`).join('、');
        const detail = !section
          ? '「追踪/读者信号.md」无「## 试读记录」节（标题可带括注）'
          : (tableSeen ? '「试读记录」节内无有效反馈行' : '「试读记录」节内无表格表头');
        findings.push({
          file: signalPath,
          line: section ? section.startLine : (checkpointSection ? checkpointSection.startLine : 1),
          column: 1,
          type: 'trial-gate-missing',
          severity: 'blocking',
          message: `写第${N}章前到点验收检查点未完成：${cpLabel}。${detail}——由用户本人验收（来源填「用户验收」）或一位没读过设定/细纲的独立读者直读该连续段并回填；版本锚用 --hash 生成；模型审读不计入有效验收`,
          excerpt: (lines[(section ? section.startLine : 1) - 1] || '').trim().slice(0, 60),
        });
      } else {
        // 旧表兼容：无来源列 → 旧行暂按人类反馈计，只出一次 editorial 补登提示。
        const legacyTable = !headerMap || headerMap.source === undefined;
        // 逐行有效性判定（只审与到点覆盖段相交的行）+ 分层报警（一行一报，可审计）。
        const validRows = [];
        const modelRows = [];
        for (const row of rows) {
          const reader = cellOf(row, 'reader');
          const range = cellOf(row, 'range');
          const will = cellOf(row, 'will');
          const anchorCell = cellOf(row, 'anchor');
          const dispo = cellOf(row, 'disposition');
          const sourceCell = cellOf(row, 'source');
          const chsAll = parseRange(range);
          const chs = chsAll.filter((c) => needSet.has(c));

          if (!reader) continue; // 无验收人＝整行不计（原文照留，不报警——无反馈不算反馈）
          if (chs.length === 0) continue; // 不涉及到点段的行（未来段/无关段）本检查点不审

          // E1 来源门：模型审读留档但不进入有效验收，也不要求其文书完整。
          const source = classifySource(sourceCell);
          if (!legacyTable && source === 'model') {
            modelRows.push({ row, reader, chs });
            continue;
          }
          if (!legacyTable && source === '') {
            findings.push({
              file: signalPath,
              line: row.line,
              column: 1,
              type: 'trial-gate-incomplete-source',
              severity: 'blocking',
              message: `反馈行（${reader}）「来源」列未填或无法识别——三选一：用户验收（作者本人以读者身份验收）/独立读者（没读过设定/细纲的人）/模型审读（留档但不能顶替人）`,
              excerpt: (lines[row.line - 1] || '').trim().slice(0, 60),
            });
            continue;
          }

          // 答案完整性：空白/占位不是反馈；「否/不想看」是合法负面答案，如实填即计有效。
          if (!will || /\{\{/.test(will) || /^(无|—|—-|-)$/.test(will)) {
            findings.push({
              file: signalPath,
              line: row.line,
              column: 1,
              type: 'trial-gate-incomplete',
              severity: 'blocking',
              message: `反馈行（${reader}）「想不想看下一章」未填或占位——空白不是反馈；回答「否/不想看」是合法答案，如实填即可（负面反馈保留原话，不迫使人改口）`,
              excerpt: (lines[row.line - 1] || '').trim().slice(0, 60),
            });
            continue;
          }

          // 版本锚：与当前正文哈希逐章匹配（只核到点段内的章）。
          const anchorMap = parseVersionAnchor(anchorCell);
          if (!anchorCell || anchorMap.size === 0) {
            findings.push({
              file: signalPath,
              line: row.line,
              column: 1,
              type: 'trial-gate-version',
              severity: 'blocking',
              message: `反馈行（${reader}）缺版本锚——跑 \`--hash --chapters ${chs.join(',')}\` 生成「第N章:哈希」串填入版本锚列（哈希由工具计算，不能编造）；无版本锚无法证明针对当前稿`,
              excerpt: (lines[row.line - 1] || '').trim().slice(0, 60),
            });
            continue;
          }
          let versionOk = true;
          for (const c of chs) {
            const file = findChapterFile(root, c);
            if (!file) {
              findings.push({
                file: signalPath, line: row.line, column: 1,
                type: 'trial-gate-version', severity: 'blocking',
                message: `反馈行（${reader}）涉及第${c}章，但 正文/第${pad3(c)}章_*.md 不存在——版本无法验证`,
                excerpt: '',
              });
              versionOk = false;
              break;
            }
            const current = hashFile(file);
            const recorded = anchorMap.get(c);
            if (!recorded) {
              findings.push({
                file: signalPath, line: row.line, column: 1,
                type: 'trial-gate-version', severity: 'blocking',
                message: `反馈行（${reader}）版本锚缺第${c}章的哈希——版本锚须覆盖章范围内每一章（多章用有序「第N章:哈希」列表，不能只存章范围）`,
                excerpt: '',
              });
              versionOk = false;
              break;
            }
            if (recorded !== current) {
              findings.push({
                file: signalPath, line: row.line, column: 1,
                type: 'trial-gate-version', severity: 'blocking',
                message: `反馈行（${reader}）版本锚与当前第${c}章正文不匹配（记录 ${recorded}，当前 ${current}）——正文已改动，旧反馈不能冒充当前版本验收；改动后按新哈希重新完成验收`,
                excerpt: '',
              });
              versionOk = false;
              break;
            }
          }
          if (!versionOk) continue;

          validRows.push({ row, reader, chs, dispo, will, legacy: legacyTable });
        }

        // 逐检查点判覆盖与处置。
        for (const cp of dueNonPaused) {
          const need = requiredChapters(cp);
          const covered = new Set();
          for (const v of validRows) for (const c of v.chs) if (need.includes(c)) covered.add(c);
          const missingChs = need.filter((c) => !covered.has(c));
          if (missingChs.length > 0) {
            findings.push({
              file: signalPath,
              line: cp.line,
              column: 1,
              type: 'trial-gate-missing',
              severity: 'blocking',
              message: `验收检查点「${cp.label}」未完成：有效验收未覆盖 ch${cp.start}-${need[need.length - 1]}（缺 ch${missingChs.join('、ch')}；来源/答案/版本锚不全的行不计——见各行报警）`,
              excerpt: (lines[cp.line - 1] || '').trim().slice(0, 60),
            });
            // 缺口上只有模型审读行 → 明确点出「模型不能顶替人」。
            const modelHit = modelRows.filter((m) => m.chs.some((c) => missingChs.includes(c))).pop();
            if (modelHit) {
              findings.push({
                file: signalPath,
                line: modelHit.row.line,
                column: 1,
                type: 'trial-gate-source',
                severity: 'blocking',
                message: `覆盖缺口上的反馈行（${modelHit.reader}）来源是模型审读——模型意见可留档参考，但不能顶替用户验收/独立读者；到点验收须补人类反馈`,
                excerpt: (lines[modelHit.row.line - 1] || '').trim().slice(0, 60),
              });
            }
            continue;
          }
          // 处置状态机：以覆盖该检查点的最新有效行（表尾）为准。
          const controllers = validRows.filter((v) => v.chs.some((c) => need.includes(c)));
          const latest = controllers[controllers.length - 1];
          const dispo = latest.dispo;
          const dispoFilled = dispo && !/\{\{/.test(dispo);
          // 处置关键词须起头（^），避免说明文字里提到「修订/暂停」误触发分支。
          if (!dispoFilled || /^待处理|^待定/.test(dispo)) {
            findings.push({
              file: signalPath, line: latest.row.line, column: 1,
              type: 'trial-gate-undecided', severity: 'blocking',
              message: `最新有效反馈（${latest.reader}）尚无作者决定——处置列四选一：修订@第N章／保留并说明原因／暂停／待处理。有效反馈待处理不放行（负面反馈保留原话，停在作者决策）`,
              excerpt: (lines[latest.row.line - 1] || '').trim().slice(0, 60),
            });
          } else if (/^暂停/.test(dispo)) {
            findings.push({
              file: signalPath, line: latest.row.line, column: 1,
              type: 'trial-gate-paused', severity: 'blocking',
              message: `最新有效反馈（${latest.reader}）处置为「暂停」——按决定不续写；恢复写作由作者显式重启并完成新验收`,
              excerpt: (lines[latest.row.line - 1] || '').trim().slice(0, 60),
            });
          } else if (/^修订/.test(dispo)) {
            const at = /第\s*(\d+)\s*章/.exec(dispo);
            if (!at) {
              findings.push({
                file: signalPath, line: latest.row.line, column: 1,
                type: 'trial-gate-undecided', severity: 'blocking',
                message: `最新有效反馈（${latest.reader}）处置为「修订」但缺目标章号——写「修订@第N章」；修订只允许目标章，不开放后续新章，修订后按新哈希重新完成验收`,
                excerpt: '',
              });
            } else if (Number(at[1]) !== N) {
              findings.push({
                file: signalPath, line: latest.row.line, column: 1,
                type: 'trial-gate-revision-scope', severity: 'blocking',
                message: `最新有效反馈（${latest.reader}）处置为「修订@第${at[1]}章」——修订期只允许修订目标章（当前要写第${N}章）；修订后按新哈希重新完成验收，再开放后续新章`,
                excerpt: '',
              });
            }
            // 修订@第N章 且正在写第N章 → 放行（大修预检另有门）
          } else if (!/^保留|^继续/.test(dispo)) {
            findings.push({
              file: signalPath, line: latest.row.line, column: 1,
              type: 'trial-gate-undecided', severity: 'blocking',
              message: `最新有效反馈（${latest.reader}）处置值无法识别（${dispo.slice(0, 30)}）——四选一：修订@第N章／保留并说明原因／暂停／待处理`,
              excerpt: '',
            });
          }
          // 「保留并说明原因」→ 放行；负面反馈原话保留在表，不篡改为质量合格。
        }

        // 旧表来源列补登提示（一次，editorial 不阻断）。
        if (legacyTable && validRows.some((v) => v.legacy)) {
          findings.push({
            file: signalPath,
            line: headerLine,
            column: 1,
            type: 'trial-gate-source-legacy',
            severity: 'advisory',
            message: '旧版试读表无「来源」列：旧行暂按人类反馈计（不追溯），请在表头补「来源」列并给各行补登 用户验收/独立读者/模型审读（模型审读不计入有效验收）',
            excerpt: (lines[headerLine - 1] || '').trim().slice(0, 60),
          });
        }
      }
    }
  }

  // 检查点节奏提醒（verify，非强制节奏）：所有到点检查点无阻断时，若最近验收覆盖
  // 末端 < N-3 且没有登记更远的检查点，提示作者为续写连续段登记下一检查点。
  const hardLike = findings.some((f) => f.type !== 'trial-gate-stale' && f.type !== 'trial-gate-source-legacy');
  if (!hardLike) {
    let acceptEnd = 0;
    const { rows } = parseRows();
    for (const r of rows) {
      const reader = cellOf(r, 'reader');
      if (!reader) continue;
      const source = classifySource(cellOf(r, 'source'));
      if (source === 'model') continue;
      for (const c of parseRange(cellOf(r, 'range'))) if (c > acceptEnd) acceptEnd = c;
    }
    const hasFutureCheckpoint = checkpoints.some((cp) => cp.trigger > N);
    if (acceptEnd < N - 3 && !hasFutureCheckpoint) {
      const citeLine = checkpointSection ? checkpointSection.startLine : (section ? section.startLine : 1);
      findings.push({
        file: signalPath,
        line: citeLine,
        column: 1,
        type: 'trial-gate-stale',
        severity: 'advisory',
        message: `已超出最近验收覆盖末端（ch${acceptEnd}）约 3 章：续写请在「验收检查点」表登记本次选定的连续段（到点章/状态），到点前完成用户验收或独立读者反馈；不强制第三方，节奏由作者定`,
        excerpt: (lines[citeLine - 1] || '').trim().slice(0, 60),
      });
    }
  }
}

try {
  handling.finalizeFindings(findings, 'guyin-check-trial-gate');
} catch (e) {
  die(e.message);
}

if (options.json) {
  // E1 验收：报告必须明示定位——检查点手续门，不是满意度认证；模型不顶替人。
  process.stdout.write(`${JSON.stringify({
    findings,
    chapter: N,
    disclaimer: '验收检查点门非满意度认证：只验证结构与版本关联，不认证真人身份或文学品质；来源限用户验收/独立读者，模型审读不能顶替人；回答质量与最终处置归作者',
  }, null, 2)}\n`);
} else if (findings.length > 0) {
  for (const f of findings) {
    console.log(`${f.file}:${f.line}:${f.column}: [${handling.label(f)}] ${f.type}: ${f.message}`);
  }
} else if (N >= 4) {
  console.log('trial-gate: checkpoints clear (due acceptance covered, version matched, disposition settled)');
}

process.exit(handling.gateTripped(findings, options.failOn) ? 1 : 0);
