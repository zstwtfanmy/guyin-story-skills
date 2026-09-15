#!/usr/bin/env node
'use strict';

// guyin-check-trial-gate.js — 真人试读手续门（Fw-06 + v3-A2，docs/框架整改任务书 §4 A2）
//
// v3-A2 定位修正（任务书 §2.3）：本门是「可审计的反馈手续门」，不是满意度认证——
// 覆盖检查验证结构与关联，不验证回答质量，更不能认证「真人身份」或「文学品质」。
// 负面的「不想看」是合法答案（保留原话，不迫使人改口）；空白/占位不是反馈。
//
// 输入：<root>/追踪/读者信号.md 的「## 试读记录」节（标题允许括注，如
// 「试读记录（活人反馈，Fw-06）」——v3-A2 修部署模板与解析器不兼容）。
// 表列按表头名定位（模板列序可调），v3-A2 新增三列：
//   版本锚：试读涉及文件的有序 章号:哈希 列表（`--hash` 子命令生成，禁止手编）；
//   相对偏好：可平/都差/更想读X稿；非比较试读注明「不适用」；
//   处置：修订@第N章 / 保留并说明原因 / 暂停 / 待处理。
//
// 机械口径（N=即将写的章号；ch1-3 写作期 N<4 静默）：
//   有效试读行 = 试读人非空 + 想不想看下一章已答（是/否/不想看都算——空白/占位不算）
//              + 版本锚与当前正文哈希匹配（正文改动后旧试读即失效）。
//   - 读者信号.md 缺失（N≥4）→ blocking trial-gate-missing（未完成手续，不再 fail-open）
//   - 无有效行覆盖 ch1-3 并集 → blocking trial-gate-missing
//   - 行有试读人但答案空白/占位 → 该行无效，trial-gate-incomplete（blocking）
//   - 版本锚缺/不匹配当前哈希 → blocking trial-gate-version（旧稿试读不能冒充新稿）
//   - 最新有效行处置：空/待处理 → blocking trial-gate-undecided（有效反馈须有作者决定）
//     暂停 → blocking trial-gate-paused（不续写）；修订@第N章 → 仅放行写第N章本身，
//     写其他新章 blocking trial-gate-revision-scope；保留 → 放行
//   - 其上：最近覆盖末端 < N-3 → advisory trial-gate-stale（每约 3 章补一次新试读）
//   - 读取异常（非缺失的 IO 错误）→ exit 2 工具错误，不当「没有问题」
//
// --hash 子命令：`--hash --project <root> --chapters 1-3` 输出版本锚串
//   （如 `第1章:ab12cd34ef56|第2章:…`），由作者/编排层复制进表——哈希由工具计算，
//   模型不得编造。Report-only，永不改写。

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const USAGE = `Usage: node guyin-check-trial-gate.js --project <book-root> --chapter N [--json] [--fail-on=blocking|all]
       node guyin-check-trial-gate.js --hash --project <book-root> --chapters 1-3

Trial-reading procedure gate (Fw-06 + v3-A2). Procedure gate, NOT satisfaction gate:
  verifies structure and version association; answers stay the author's call.
  Valid row = reader named + answer filled (negative is legal) + version anchor
  matching CURRENT chapter file hashes (stale hash = stale trial).
Before writing chapter N (N>=4):
  missing 读者信号.md / no valid rows covering ch1-3 -> blocking trial-gate-missing
  rows with blank answer                       -> blocking trial-gate-incomplete
  version anchor missing/mismatched            -> blocking trial-gate-version
  latest valid row undecided / paused          -> blocking trial-gate-undecided/-paused
  修订@第N章 disposition                        -> only writing ch N itself passes
  latest coverage end < N-3                    -> advisory trial-gate-stale
Read errors other than missing-file exit 2 (tool error, not "no problem").
--hash prints the version-anchor string for the given chapters (tool-computed,
never hand-written) to paste into the 版本锚 column.`;

const options = { json: false, failOn: 'blocking', project: null, chapter: null, hash: false, chapters: null };

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
    const v = arg.slice('--fail-on='.length);
    if (v !== 'blocking' && v !== 'all') die("--fail-on must be 'blocking' or 'all'");
    options.failOn = v;
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
    // v3-A2：缺件 = 未完成手续（N≥4 时 blocking），不再是静默放行；N<4 写作期仍静默。
    const findings = [];
    if (options.chapter >= 4) {
      findings.push({
        file: signalPath,
        line: 1,
        column: 1,
        type: 'trial-gate-missing',
        severity: 'blocking',
        message: `写第${options.chapter}章前未完成试读手续：「追踪/读者信号.md」不存在——部署模板（/guyin-setup）后找一个没读过设定/细纲的人直读 ch1-3，回填三问与获得四项；哈希用 --hash 子命令生成，不能编造。旧项目由作者显式启动补手续，不批量补造真人记录`,
        excerpt: '',
      });
    }
    if (options.json) {
      process.stdout.write(`${JSON.stringify({
        findings,
        chapter: options.chapter,
        missing: true,
        disclaimer: '手续门非满意度认证：本报告只验证结构与版本关联，不认证真人身份或文学品质；回答质量与最终处置归作者',
      }, null, 2)}\n`);
    } else if (findings.length > 0) {
      for (const f of findings) console.log(`${f.file}:${f.line}:${f.column}: [${f.severity}] ${f.type}: ${f.message}`);
    } else {
      console.log('trial-gate: no 读者信号.md (ch<4, silent)');
    }
    process.exit(findings.some((f) => f.severity === 'blocking') && (options.failOn === 'blocking' || findings.length > 0) ? 1 : 0);
  }
  // v3-A2：读取异常（权限/编码等）是工具错误，不当「没有问题」。
  console.error(`trial-gate: read error on ${signalPath}: ${error.message}`);
  process.exit(2);
}

const findings = [];
const lines = text.split(/\r?\n/);

// ---- 定位「试读记录」节（v3-A2：标题允许括注「试读记录（活人反馈，Fw-06）」） ----
function locateSection() {
  let start = -1;
  let level = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^(#{1,6})\s*试读记录(?:[（(][^）)]*[）)])?\s*[\s:：]*$/.exec(lines[i].trim());
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

// ---- 表头列位映射（v3-A2：按表头名定位，模板列序可调） ----
function headerIndexMap(headerLine) {
  const cells = headerLine.split('|').map((c) => c.trim());
  const map = {};
  cells.forEach((name, idx) => {
    if (/日期/.test(name)) map.date = idx;
    else if (/试读人/.test(name)) map.reader = idx;
    else if (/章范围/.test(name)) map.range = idx;
    else if (/想不想看/.test(name)) map.will = idx;
    else if (/版本锚/.test(name)) map.anchor = idx;
    else if (/相对偏好/.test(name)) map.pref = idx;
    else if (/处置/.test(name)) map.disposition = idx;
  });
  return map;
}

const section = locateSection();
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

// ---- 主检查（N≥4） ----
if (N >= 4) {
  const { rows, tableSeen, headerMap, headerLine } = parseRows();
  const anchor = section ? section.startLine : 1;

  if (!section || !tableSeen || rows.length === 0) {
    const detail = !section
      ? '「追踪/读者信号.md」无「## 试读记录」节（标题可带括注）'
      : (tableSeen ? '「试读记录」节内无有效试读行' : '「试读记录」节内无表格表头');
    findings.push({
      file: signalPath,
      line: anchor,
      column: 1,
      type: 'trial-gate-missing',
      severity: 'blocking',
      message: `写第${N}章前未完成试读手续：${detail}——找一个没读过设定/细纲的人直读 ch1-3，回填三问（想不想看下一章·记住了谁·想划下来的句子）与获得四项；版本锚用 --hash 生成，处置写明作者决定（Fw-06/A2）`,
      excerpt: (lines[anchor - 1] || '').trim().slice(0, 60),
    });
  } else {
    // 逐行有效性判定 + 分层报警（一报警一行，可审计）。
    const validRows = [];
    for (const row of rows) {
      const reader = cellOf(row, 'reader');
      const range = cellOf(row, 'range');
      const will = cellOf(row, 'will');
      const anchorCell = cellOf(row, 'anchor');
      const dispo = cellOf(row, 'disposition');
      const chs = parseRange(range);

      if (!reader) continue; // 无试读人＝无法证明真人，整行不计（原文照留，不报警——无反馈不算反馈）

      // 答案完整性：空白/占位不是反馈；「否/不想看」是合法负面答案，如实填即计有效。
      if (!will || /\{\{/.test(will) || /^(无|—|—-|-)$/.test(will)) {
        findings.push({
          file: signalPath,
          line: row.line,
          column: 1,
          type: 'trial-gate-incomplete',
          severity: 'blocking',
          message: `试读行（${reader}）「想不想看下一章」未填或占位——空白不是反馈；回答「否/不想看」是合法答案，如实填即可（负面反馈保留原话，不迫使人改口）`,
          excerpt: (lines[row.line - 1] || '').trim().slice(0, 60),
        });
        continue;
      }

      // 版本锚：与当前正文哈希逐章匹配。
      const anchorMap = parseVersionAnchor(anchorCell);
      if (!anchorCell || anchorMap.size === 0) {
        findings.push({
          file: signalPath,
          line: row.line,
          column: 1,
          type: 'trial-gate-version',
          severity: 'blocking',
          message: `试读行（${reader}）缺版本锚——跑 \`--hash --chapters ${chs.join(',')}\` 生成「第N章:哈希」串填入版本锚列（哈希由工具计算，不能编造）；无版本锚的试读无法证明针对当前稿`,
          excerpt: (lines[row.line - 1] || '').trim().slice(0, 60),
        });
        continue;
      }
      let versionOk = true;
      for (const c of chs) {
        const file = findChapterFile(root, c);
        if (!file) {
          findings.push({
            file: signalPath,
            line: row.line,
            column: 1,
            type: 'trial-gate-version',
            severity: 'blocking',
            message: `试读行（${reader}）涉及第${c}章，但 正文/第${pad3(c)}章_*.md 不存在——版本无法验证`,
            excerpt: '',
          });
          versionOk = false;
          break;
        }
        const current = hashFile(file);
        const recorded = anchorMap.get(c);
        if (!recorded) {
          findings.push({
            file: signalPath,
            line: row.line,
            column: 1,
            type: 'trial-gate-version',
            severity: 'blocking',
            message: `试读行（${reader}）版本锚缺第${c}章的哈希——版本锚须覆盖章范围内每一章（多章用有序文件—哈希列表，不能只存章范围）`,
            excerpt: '',
          });
          versionOk = false;
          break;
        }
        if (recorded !== current) {
          findings.push({
            file: signalPath,
            line: row.line,
            column: 1,
            type: 'trial-gate-version',
            severity: 'blocking',
            message: `试读行（${reader}）版本锚与当前第${c}章正文不匹配（记录 ${recorded}，当前 ${current}）——正文已改动，旧稿试读不能冒充新稿试读；改动后按新哈希重新完成试读手续`,
            excerpt: '',
          });
          versionOk = false;
          break;
        }
      }
      if (!versionOk) continue;

      validRows.push({ row, reader, chs, dispo, will });
    }

    if (validRows.length > 0) {
      // 覆盖 = 有效行章范围并集。
      const covered = new Set();
      for (const v of validRows) for (const c of v.chs) covered.add(c);
      const missingChs = [1, 2, 3].filter((c) => !covered.has(c));
      if (missingChs.length > 0) {
        findings.push({
          file: signalPath,
          line: headerLine,
          column: 1,
          type: 'trial-gate-missing',
          severity: 'blocking',
          message: `写第${N}章前未完成试读手续：有效试读未覆盖 ch ${missingChs.join('、')}（须覆盖 ch1-3 全部；试读人/答案/版本锚不全的行不计——见各行报警）`,
          excerpt: '',
        });
      } else {
        // 处置状态机：以最新有效行（表尾）为准。
        const latest = validRows[validRows.length - 1];
        const dispo = latest.dispo;
        const dispoFilled = dispo && !/\{\{/.test(dispo);
        // 处置关键词须起头（^），避免说明文字里提到「修订/暂停」误触发分支。
        if (!dispoFilled || /^待处理|^待定/.test(dispo)) {
          findings.push({
            file: signalPath,
            line: latest.row.line,
            column: 1,
            type: 'trial-gate-undecided',
            severity: 'blocking',
            message: `最新有效试读（${latest.reader}）的反馈尚无作者决定——处置列四选一：修订@第N章／保留并说明原因／暂停／（处理后回填）。有效反馈待处理不放行（负面反馈保留原话，停在作者决策）`,
            excerpt: (lines[latest.row.line - 1] || '').trim().slice(0, 60),
          });
        } else if (/^暂停/.test(dispo)) {
          findings.push({
            file: signalPath,
            line: latest.row.line,
            column: 1,
            type: 'trial-gate-paused',
            severity: 'blocking',
            message: `最新有效试读（${latest.reader}）处置为「暂停」——按决定不续写；恢复写作由作者显式重启并完成新试读手续`,
            excerpt: (lines[latest.row.line - 1] || '').trim().slice(0, 60),
          });
        } else if (/^修订/.test(dispo)) {
          const at = /第\s*(\d+)\s*章/.exec(dispo);
          if (!at) {
            findings.push({
              file: signalPath,
              line: latest.row.line,
              column: 1,
              type: 'trial-gate-undecided',
              severity: 'blocking',
              message: `最新有效试读（${latest.reader}）处置为「修订」但缺目标章号——写「修订@第N章」；修订只允许目标章，不开放后续新章，修订后按新哈希重新完成试读手续`,
              excerpt: '',
            });
          } else if (Number(at[1]) !== N) {
            findings.push({
              file: signalPath,
              line: latest.row.line,
              column: 1,
              type: 'trial-gate-revision-scope',
              severity: 'blocking',
              message: `最新有效试读（${latest.reader}）处置为「修订@第${at[1]}章」——修订期只允许修订目标章（当前要写第${N}章）；修订后按新哈希重新完成试读手续，再开放后续新章`,
              excerpt: '',
            });
          }
          // 修订@第N章 且正在写第N章 → 放行（大修预检另有门）
        } else if (!/^保留|^继续/.test(dispo)) {
          findings.push({
            file: signalPath,
            line: latest.row.line,
            column: 1,
            type: 'trial-gate-undecided',
            severity: 'blocking',
            message: `最新有效试读（${latest.reader}）处置值无法识别（${dispo.slice(0, 30)}）——四选一：修订@第N章／保留并说明原因／暂停／待处理`,
            excerpt: '',
          });
        }
        // 「保留并说明原因」→ 放行；负面反馈原话保留在表，不篡改为质量合格。

        // stale 检查（advisory）：覆盖末端须 ≥ N-3。
        const maxEnd = covered.size > 0 ? Math.max(...covered) : 0;
        if (maxEnd < N - 3 && findings.every((f) => f.type !== 'trial-gate-undecided'
          && f.type !== 'trial-gate-paused' && f.type !== 'trial-gate-revision-scope')) {
          findings.push({
            file: signalPath,
            line: section.startLine,
            column: 1,
            type: 'trial-gate-stale',
            severity: 'advisory',
            message: `试读已滞后：最近试读只覆盖到第${maxEnd}章，开写第${N}章前建议补一次近章试读（每约 3 章一次活人反馈，Fw-06）`,
            excerpt: (lines[section.startLine - 1] || '').trim().slice(0, 60),
          });
        }
      }
    }
    // validRows.length === 0 且无行级报警（全部行缺试读人）→ 按无有效覆盖报。
    if (validRows.length === 0 && !findings.some((f) => f.type === 'trial-gate-missing')) {
      findings.push({
        file: signalPath,
        line: headerLine,
        column: 1,
        type: 'trial-gate-missing',
        severity: 'blocking',
        message: `写第${N}章前未完成试读手续：表内无有效试读行（试读人列全空＝无法证明真人试读）——找一个没读过设定/细纲的人直读 ch1-3 回填`,
        excerpt: '',
      });
    }
  }
}

if (options.json) {
  // v3-A2 验收：报告必须明示定位——手续门，不是满意度认证（真人身份/文学品质不归脚本判）。
  process.stdout.write(`${JSON.stringify({
    findings,
    chapter: N,
    disclaimer: '手续门非满意度认证：本报告只验证结构与版本关联，不认证真人身份或文学品质；回答质量与最终处置归作者',
  }, null, 2)}\n`);
} else if (findings.length > 0) {
  for (const f of findings) {
    console.log(`${f.file}:${f.line}:${f.column}: [${f.severity}] ${f.type}: ${f.message}`);
  }
} else if (N >= 4) {
  console.log(`trial-gate: procedure complete (covering ch1-3, version matched, disposition settled)`);
}

const hasBlocking = findings.some((f) => f.severity === 'blocking');
if (options.failOn === 'blocking' ? hasBlocking : findings.length > 0) process.exit(1);
