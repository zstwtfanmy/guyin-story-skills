#!/usr/bin/env node
'use strict';

// lib/guyin-candidate-context.js — 候选/章号/书根的统一机械解析（任务书 §6.1）。
//
// 所有目标依赖检查（deliver / authority-leak / foreshadow-id / repetition …）共用本模块，
// 规则只有一套，禁止在十几个脚本里各猜一遍：
//   1. 显式优先：--project <书根> --chapter <N>（短篇/无章号文件加 --unit <N>）。
//   2. 候选是工作区草稿/深层文件（.guyuyin/work/**、drafts/v*.md、candidate.md…）时，
//      文件名不带正式章号——必须显式给章号，脚本不猜，猜了 exit 2。
//   3. 正式正文文件名（第NNN章_标题.md）可从文件名解析章号；与 --chapter/input.target
//      冲突即 exit 2。
//   4. 一切输入路径拒绝越界（..、绝对路径、符号链接）。
//
// 旧用法（只给若干文件路径、不给 --project）仍走各脚本 legacy 模式，本模块返回
// projectRoot=null——新显式模式只在 --project 出现时激活，保证存量调用不回归。

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FORMAL_CHAPTER_RE = /第0*(\d+)章.*\.md$/;

function die(message) {
  const err = new Error(message);
  err.code = 'CTX_INPUT';
  return err;
}

function parseArgs(argv) {
  const opts = {
    project: null, chapter: null, unit: null,
    boundary: null, outline: null, state: null, transaction: null,
    title: null,
    positional: [],
    flags: new Set(),
  };
  const takeValue = (arg, i, key) => {
    const inline = arg.startsWith(`${key}=`) ? arg.slice(key.length + 1) : null;
    if (inline !== null) { opts[key === '--project' ? 'project' : key.slice(2)] = inline; return i + 1; }
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) throw die(`${key} 需要参数`);
    opts[key === '--project' ? 'project' : key.slice(2)] = v;
    return i + 2;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--project') i = takeValue(arg, i, '--project') - 1;
    else if (arg === '--chapter') i = takeValue(arg, i, '--chapter') - 1;
    else if (arg === '--unit') i = takeValue(arg, i, '--unit') - 1;
    else if (arg === '--boundary') i = takeValue(arg, i, '--boundary') - 1;
    else if (arg === '--outline') i = takeValue(arg, i, '--outline') - 1;
    else if (arg === '--state') i = takeValue(arg, i, '--state') - 1;
    else if (arg === '--transaction') i = takeValue(arg, i, '--transaction') - 1;
    else if (arg === '--title') i = takeValue(arg, i, '--title') - 1;
    else if (arg.startsWith('--')) opts.flags.add(arg);
    else opts.positional.push(arg);
  }
  return opts;
}

function isPositiveInt(v) {
  return Number.isInteger(v) && v > 0;
}

function inferChapterFromName(name) {
  const m = FORMAL_CHAPTER_RE.exec(name);
  return m ? Number(m[1]) : null;
}

// 工作区/草稿类路径：不携带正式章号，禁止猜章。
function isWorkspaceRel(rel) {
  const norm = rel.replace(/\\/g, '/');
  if (norm.startsWith('.guyin/work/')) return true;
  if (/\/drafts\/v\d+\.md$/.test(norm) || /(^|\/)drafts\/v\d+\.md$/.test(norm)) return true;
  if (/(^|\/)(candidate|candidate\.md)$/.test(norm)) return true;
  return false;
}

function resolveUnder(root, rel, label) {
  if (typeof rel !== 'string' || !rel) throw die(`${label} 必须是非空路径`);
  const p = path.normalize(rel);
  if (p.split(/[\\/]/).includes('..')) throw die(`${label} 不得包含 ..：${rel}`);
  const rootRes = path.resolve(root);
  const abs = path.isAbsolute(p) ? path.resolve(p) : path.resolve(rootRes, p);
  if (abs !== rootRes && !abs.startsWith(rootRes + path.sep)) throw die(`${label} 越出书根：${rel}`);
  return abs;
}

function existingFile(abs, label) {
  let st;
  try { st = fs.statSync(abs); } catch (e) { throw die(`${label} 不存在或不可读：${abs}`); }
  if (!st.isFile()) throw die(`${label} 不是常规文件：${abs}`);
  if (st.isSymbolicLink && st.isSymbolicLink()) throw die(`${label} 拒绝符号链接：${abs}`);
  return abs;
}

function isDir(abs) {
  try { return fs.statSync(abs).isDirectory(); } catch (e) { return false; }
}

function sha256File(abs) {
  return crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
}

function hash12File(abs) { return sha256File(abs).slice(0, 12); }

function chapterFrontMatterEnd(lines) {
  if (!lines[0] || lines[0].trim() !== '---') return -1;
  let sawField = false;
  for (let i = 1; i < Math.min(lines.length, 40); i += 1) {
    const t = lines[i].trim();
    if (t === '---') return sawField ? i : -1;
    if (!t || t.startsWith('#')) continue;
    if (/^[\p{L}\p{N}_-]+:\s*/u.test(t)) sawField = true;
    else if (!sawField || !/^[ \t]+\S/.test(lines[i])) break;
  }
  return -1;
}

// 仅供首个内容行调用：遮盖章号/Markdown 格式，绝不删标题里的工序词。
function maskChapterHeading(line) {
  const re = /^\s*(?:#{1,6}[ \t]+)?第[零一二三四五六七八九十百千万两0-9]+章(?=[ \t_]|$)[_ \t]*/;
  if (!re.test(line)) return line;
  return line.replace(re, (m) => ' '.repeat(m.length))
    .replace(/[ \t]+#+[ \t]*$/, (m) => ' '.repeat(m.length));
}

// POV 豁免附件是运行证据，不扩展 input/state。路径、哈希只证完整性，真实裁决仍须人复核。
function povEvidenceFile(root, rel, label, runRel) {
  if (typeof rel !== 'string' || !rel || path.isAbsolute(rel) || path.win32.isAbsolute(rel)
      || rel.includes('\\') || rel.split('/').some((p) => !p || p === '.' || p === '..')) {
    throw die(`${label} 必须是书根内规范相对路径`);
  }
  const rootReal = fs.realpathSync(root);
  const abs = resolveUnder(root, rel, label);
  const real = fs.realpathSync(existingFile(abs, label));
  const realRel = path.relative(rootReal, real).replace(/\\/g, '/');
  if (realRel === '..' || realRel.startsWith('../') || path.isAbsolute(realRel)) {
    throw die(`${label} realpath 越出书根`);
  }
  if (runRel && (!rel.startsWith(`${runRel}/`) || !realRel.startsWith(`${runRel}/`))) {
    throw die(`${label} 不属于当前 run 工作区`);
  }
  return { abs: real, path: rel, sha256: sha256File(real) };
}

// id v1：按固定键序编码，offset/end_offset 为原文 UTF-16 的零基半开区间；行列一基。
function povHitId(candidateHash, pov, hit) {
  const identity = {
    type: 'pov-drift', candidate_sha256: candidateHash,
    pov: { name: pov.name, contract_path: pov.contract_path, contract_sha256: pov.contract_sha256 },
    hit: { subject: hit.subject, category: hit.category, line: hit.line, column: hit.column,
      offset: hit.offset, end_offset: hit.end_offset, match: hit.match, excerpt: hit.excerpt },
  };
  return `pov-drift:${crypto.createHash('sha256').update(JSON.stringify(identity)).digest('hex')}`;
}

function readPovAttachment(ctx, rel, pov, knownIds) {
  const requireThat = (ok, reason) => { if (!ok) throw die(reason); };
  const fullHash = (v) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
  const object = (v) => v && typeof v === 'object' && !Array.isArray(v);
  requireThat(object(pov) && typeof pov.name === 'string' && pov.name.trim()
    && pov.contract_path === '大纲/批次公约.md' && fullHash(pov.contract_sha256), 'POV 契约绑定不完整');
  const run = /^(\.guyin\/work\/[^/]+)\//.exec(ctx.candidateRel || '');
  requireThat(run, 'POV 豁免必须绑定当前候选的 run 工作区');
  const candidate = povEvidenceFile(ctx.projectRootAbs, ctx.candidateRel, '候选', run[1]);
  requireThat(candidate.sha256 === ctx.candidateHash, 'candidate_sha256 与当前候选不一致');
  const attachment = povEvidenceFile(ctx.projectRootAbs, rel, 'POV 豁免附件', run[1]);
  requireThat(rel.endsWith('.json'), 'POV 豁免附件必须为 JSON 文件');
  const doc = readJson(attachment.abs, 'POV 豁免附件');
  requireThat(doc.type === 'pov-drift', '附件 type 必须为 pov-drift');
  requireThat(Number.isSafeInteger(doc.chapter) && doc.chapter > 0 && doc.chapter === ctx.chapter,
    '附件 chapter 与当前章号不一致');
  requireThat(fullHash(doc.candidate_sha256) && doc.candidate_sha256 === ctx.candidateHash,
    '附件 candidate_sha256 与当前候选不一致');
  requireThat(object(doc.pov) && doc.pov.name === pov.name && doc.pov.contract_path === pov.contract_path
    && doc.pov.contract_sha256 === pov.contract_sha256, '附件 POV 名称/契约哈希与当前契约不一致');
  const contract = povEvidenceFile(ctx.projectRootAbs, pov.contract_path, 'POV 契约');
  requireThat(contract.sha256 === pov.contract_sha256, 'POV 契约已变更');
  const declared = /视角规格[：:]\s*POV=([^\s（(，；;]+)/.exec(fs.readFileSync(contract.abs, 'utf8'));
  requireThat(declared && declared[1] === pov.name, 'POV 名称与当前契约不一致');
  requireThat(Array.isArray(doc.hits) && doc.hits.length > 0, '附件 hits 必须是非空逐命中列表');
  const ids = new Set();
  for (const hit of doc.hits) {
    requireThat(object(hit) && typeof hit.id === 'string' && /^pov-drift:[a-f0-9]{64}$/.test(hit.id),
      '附件 hits 含非法/通配 id');
    requireThat(!ids.has(hit.id), `附件 hits 含重复 id：${hit.id}`);
    requireThat(knownIds instanceof Set && knownIds.has(hit.id), `附件 hits 含未知 id：${hit.id}`);
    ids.add(hit.id);
  }
  const source = doc.decision_source;
  requireThat(object(source) && fullHash(source.sha256) && typeof source.quote === 'string'
    && source.quote.trim(), 'decision_source 必须含 path/完整 sha256/非空 quote');
  const decision = povEvidenceFile(ctx.projectRootAbs, source.path, '裁决来源');
  requireThat(decision.sha256 === source.sha256, '裁决来源 sha256 不一致');
  requireThat(fs.readFileSync(decision.abs, 'utf8').includes(source.quote), '裁决来源不含逐字 quote');
  return { doc, attachment: { path: attachment.path, sha256: attachment.sha256 }, ids };
}

function validatePovExemption(ctx, finding, knownIds) {
  try {
    const e = finding.exemption;
    const requireThat = (ok, reason) => { if (!ok) throw die(reason); };
    requireThat(finding.type === 'pov-drift' && finding.candidate_sha256 === ctx.candidateHash
      && finding.chapter === ctx.chapter && finding.hit && finding.pov
      && finding.id === povHitId(ctx.candidateHash, finding.pov, finding.hit), 'finding 的 candidate/hit/contract 绑定不完整');
    requireThat(e && e.type === 'pov-drift' && e.chapter === ctx.chapter
      && e.version === ctx.candidateHash.slice(0, 12) && e.candidate_sha256 === ctx.candidateHash
      && e.hit_id === finding.id && e.pov && e.pov.name === finding.pov.name
      && e.pov.contract_path === finding.pov.contract_path
      && e.pov.contract_sha256 === finding.pov.contract_sha256, '豁免的 candidate/hit/contract 绑定不一致');
    requireThat(Number.isSafeInteger(e.entry) && e.entry > 0 && e.ledger === '追踪/豁免台账.md'
      && e.pending_ledger === '追踪/待审台账.md', '豁免台账引用不完整');
    for (const [rel, hash, label] of [[e.ledger, e.ledger_sha256, '豁免台账'],
      [e.pending_ledger, e.pending_ledger_sha256, '待审台账']]) {
      requireThat(povEvidenceFile(ctx.projectRootAbs, rel, label).sha256 === hash, `${label} 哈希已变更`);
    }
    requireThat(e.attachment && e.decision_source, '豁免附件/裁决来源引用缺失');
    const checked = readPovAttachment(ctx, e.attachment.path, finding.pov, knownIds);
    requireThat(checked.attachment.sha256 === e.attachment.sha256, '豁免附件哈希已变更');
    requireThat(checked.ids.has(finding.id), '附件未批准此 hit_id');
    for (const key of ['path', 'sha256', 'quote']) {
      requireThat(checked.doc.decision_source[key] === e.decision_source[key], `裁决来源 ${key} 不一致`);
    }
    return null;
  } catch (error) { return error.message; }
}

function readJson(abs, label) {
  let doc;
  try { doc = JSON.parse(fs.readFileSync(abs, 'utf8')); }
  catch (e) { throw die(`${label} 不是合法 JSON：${e.message}`); }
  if (!doc || typeof doc !== 'object') throw die(`${label} 必须是 JSON 对象`);
  return doc;
}

// 主入口：argv 是去掉 node+脚本名后的参数数组。
function resolveContext(argv) {
  const args = parseArgs(argv);
  const ctx = {
    explicit: args.project !== null,
    projectRoot: null, projectRootAbs: null,
    chapter: null, unit: null,
    candidateRel: null, candidateAbs: null, candidateName: null,
    candidateHash: null, candidateHash12: null,
    boundaryRel: null, boundary: null,
    outlineRel: null, outlineAbs: null,
    transactionRel: null, transactionAbs: null,
    stateRel: null,
    filesScanned: [],
    referenceFiles: [],
    flags: args.flags,
    errors: [],
  };
  if (!args.project) {
    ctx.positionalLegacy = args.positional;
    return ctx; // legacy 模式：脚本自己处理位置参数
  }

  ctx.projectRoot = args.project;
  ctx.projectRootAbs = path.resolve(args.project);
  if (!isDir(path.join(ctx.projectRootAbs, '追踪'))) {
    throw die(`--project 不是书根（缺 追踪/ 目录）：${args.project}`);
  }

  if (args.positional.length !== 1) throw die('显式模式需要恰好一个候选正文路径');
  ctx.candidateAbs = existingFile(resolveUnder(ctx.projectRootAbs, args.positional[0], '候选'), '候选');
  ctx.candidateRel = path.relative(ctx.projectRootAbs, ctx.candidateAbs).replace(/\\/g, '/');
  ctx.candidateName = path.basename(ctx.candidateRel);
  ctx.candidateHash = sha256File(ctx.candidateAbs);
  ctx.candidateHash12 = ctx.candidateHash.slice(0, 12);
  ctx.filesScanned = [ctx.candidateRel];

  // boundary（input.json，v1）
  if (args.boundary) {
    ctx.boundaryAbs = existingFile(resolveUnder(ctx.projectRootAbs, args.boundary, '--boundary'), 'boundary');
    ctx.boundaryRel = path.relative(ctx.projectRootAbs, ctx.boundaryAbs).replace(/\\/g, '/');
    ctx.boundary = readJson(ctx.boundaryAbs, 'boundary(input.json)');
  }

  // 章号：显式参数 > 正式文件名；工作区草稿必须显式。
  const inferred = inferChapterFromName(ctx.candidateName);
  if (args.chapter !== null) {
    const n = Number(args.chapter);
    if (!isPositiveInt(n)) throw die(`--chapter 必须是正整数：${args.chapter}`);
    ctx.chapter = n;
    if (inferred !== null && inferred !== n) {
      throw die(`章号冲突：文件名解析为第 ${inferred} 章，--chapter 给的是 ${n}`);
    }
  } else if (inferred !== null) {
    ctx.chapter = inferred;
  } else {
    throw die(`候选「${ctx.candidateName}」不是正式章号文件名（工作区草稿/深层路径）：必须显式 --chapter <N>`);
  }

  // boundary 交叉核对
  if (ctx.boundary && ctx.boundary.target) {
    const t = ctx.boundary.target;
    if (Number.isInteger(t.chapter) && t.chapter !== ctx.chapter) {
      throw die(`--chapter(${ctx.chapter}) 与 boundary.target.chapter(${t.chapter}) 冲突`);
    }
    if (args.title && t.title && args.title !== t.title) throw die('--title 与 boundary.target.title 冲突');
  }
  if (args.title !== null) ctx.title = args.title;

  // unit（短篇/无章号）：显式正整数；与正式文件名章号冲突要拒。
  if (args.unit !== null) {
    const n = Number(args.unit);
    if (!isPositiveInt(n)) throw die(`--unit 必须是正整数：${args.unit}`);
    if (inferred !== null && inferred !== n) throw die(`--unit ${n} 与文件名章号 ${inferred} 冲突`);
    ctx.unit = n;
  }

  // 真实细纲：显式给了就必须能读（读不了报错，不许 exit0 假通过）。
  if (args.outline) {
    ctx.outlineAbs = existingFile(resolveUnder(ctx.projectRootAbs, args.outline, '--outline'), 'outline');
    ctx.outlineRel = path.relative(ctx.projectRootAbs, ctx.outlineAbs).replace(/\\/g, '/');
  }

  // 事务（--transaction，foreshadow-id 认本章新增 ID 用）。
  if (args.transaction) {
    ctx.transactionAbs = existingFile(resolveUnder(ctx.projectRootAbs, args.transaction, '--transaction'), 'transaction');
    ctx.transactionRel = path.relative(ctx.projectRootAbs, ctx.transactionAbs).replace(/\\/g, '/');
    ctx.transaction = readJson(ctx.transactionAbs, 'transaction');
  }

  // 参考：正式正文成员（候选是检查目标，正式正文是参考；候选自身不在扫描目标外重复扫）。
  const proseDir = path.join(ctx.projectRootAbs, '正文');
  if (isDir(proseDir)) {
    for (const name of fs.readdirSync(proseDir).sort()) {
      if (name.startsWith('.')) continue;
      const abs = path.join(proseDir, name);
      let st;
      try { st = fs.statSync(abs); } catch (e) { continue; }
      if (!st.isFile() || abs === ctx.candidateAbs) continue;
      ctx.referenceFiles.push({
        rel: path.relative(ctx.projectRootAbs, abs).replace(/\\/g, '/'),
        sha256: sha256File(abs),
        chapter: inferChapterFromName(name),
      });
    }
  }

  ctx.notApplicable = (reason) => ({
    status: 'not_applicable', reason,
    target: { chapter: ctx.chapter, unit: ctx.unit, candidate: ctx.candidateRel },
    files_scanned: [],
  });

  return ctx;
}

// ---------------- 机器证据汇总（--gather）/校验（--validate-evidence），§6.3 ----------------

const { spawnSync } = require('child_process');
const SCRIPT_DIR = path.join(__dirname, '..');

function gatherArgv(raw) {
  const out = { out: null, validate: null };
  const a = [...raw];
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] === '--out') { out.out = a[i + 1]; a[i] = a[i + 1] = null; i += 1; }
    if (a[i] === '--validate-evidence') { out.validate = a[i + 1]; a[i] = a[i + 1] = null; i += 1; }
  }
  out.clean = a.filter(Boolean);
  return out;
}

function pythonExe() {
  return process.env.GUYIN_PYTHON
    || (process.platform === 'win32' ? 'python' : 'python3');
}

function runCheck(name, spec, ctx) {
  // spec: { interpreter?: 'node'|'python', script, args, target?, referenceFiles?, expectJson? }
  const interpreter = spec.interpreter || 'node';
  const bin = interpreter === 'python' ? pythonExe() : process.execPath;
  const scriptAbs = path.join(SCRIPT_DIR, spec.script);
  const target = spec.target !== false;
  const entry = {
    name,
    script: spec.script,
    interpreter,
    script_sha256: fs.existsSync(scriptAbs) ? sha256File(scriptAbs) : null,
    command: spec.args.map((x) => (x === ctx.candidateAbs ? ctx.candidateRel : x)),
    exit_code: null,
    files_scanned: [],
    target_files: target ? [ctx.candidateRel] : [],
    reference_files: spec.referenceFiles || [],
    status: 'error',
    reason: '',
    findings_count: 0,
  };
  if (!fs.existsSync(scriptAbs)) {
    entry.reason = `脚本不存在：${spec.script}`;
    return entry;
  }
  const r = spawnSync(bin, [scriptAbs, ...spec.args], { encoding: 'utf8' });
  entry.exit_code = r.status === null ? -1 : r.status;
  let parsed = null;
  try { parsed = r.stdout.trim() ? JSON.parse(r.stdout) : null; } catch (e) { parsed = null; }

  // G-5：files_scanned/target_files/status 以检查脚本自己的报告为准，不在入口预填。
  if (parsed && typeof parsed === 'object') {
    if (Array.isArray(parsed.findings)) {
      entry.findings_count = parsed.findings.length;
      // POV 保留全部逐命中结果；仅消费 candidate+hit+contract 完整且引用仍新鲜的豁免。
      const povFindings = parsed.findings.filter((f) => f.type === 'pov-drift');
      if (povFindings.length) entry.pov_findings = povFindings;
      const knownIds = new Set(povFindings.map((f) => f.id));
      const exemptions = [];
      for (const f of povFindings) {
        if (f.resolution !== 'exempted') continue;
        const reason = validatePovExemption(ctx, f, knownIds);
        if (reason) {
          delete f.resolution;
          delete f.exemption;
          f.exemption_rejection = { reason };
        } else exemptions.push(f.exemption);
      }
      if (exemptions.length) entry.exemptions = exemptions;
    }
    const reportScanned = parsed.files_scanned
      || (parsed.summary && parsed.summary.files_scanned)
      || (parsed.target_files)
      || null;
    if (Array.isArray(reportScanned)) {
      entry.files_scanned = reportScanned.map(String);
    } else if (typeof reportScanned === 'number' && reportScanned > 0) {
      // 旧式数值计数（repetition 等）：脚本自报实际扫描文件数 >0 才算读到目标。
      entry.files_scanned = [ctx.candidateRel];
    }
    if (Array.isArray(parsed.target_files)) entry.target_files = parsed.target_files.map(String);
    if (parsed.status === 'pass' || parsed.status === 'findings'
        || parsed.status === 'not_applicable' || parsed.status === 'error') {
      entry.status = parsed.status;
      if (parsed.reason) entry.reason = String(parsed.reason).slice(0, 300);
    }
  }
  if (entry.status === 'error') {
    if (r.status === 0) entry.status = 'pass';
    else if (r.status === 1) entry.status = 'findings';
    else {
      entry.status = 'error';
      entry.reason = (r.stderr || r.stdout || `exit ${r.status}`).trim().slice(0, 300);
    }
  }
  // 即便子进程误报 pass/exit 0，剩一条未豁免 POV 也不得汇总成 pass。
  if (entry.pov_findings && entry.pov_findings.some((f) => f.resolution !== 'exempted')) {
    entry.status = 'findings';
    entry.exit_code = 1;
    entry.reason = '存在未获当前逐命中豁免的 pov-drift';
  }
  // not_applicable 必须带原因（G-5）：脚本未给时补可审计默认说明，禁止空白终态。
  if (entry.status === 'not_applicable' && !entry.reason) {
    entry.reason = 'not_applicable：该检查对本候选不适用（以脚本输出为准）';
  }
  // 目标类检查：not_applicable 是合法终态（已带原因）；其余状态必须真扫到候选，零扫描＝error。
  // 报告可能给书根相对路径或绝对路径，两种都认。
  const scannedProof = new Set(entry.files_scanned);
  const candidateScanned = target && entry.status !== 'not_applicable'
    && (scannedProof.has(ctx.candidateRel) || scannedProof.has(ctx.candidateAbs));
  if (target && entry.status !== 'not_applicable' && !candidateScanned) {
    entry.status = 'error';
    entry.reason = '零扫描：检查报告未证明读到候选（files_scanned 未含候选）';
  }
  return entry;
}

function requiredChain(ctx) {
  const cand = ctx.candidateAbs;
  const b = ctx.boundaryAbs;
  const common = ['--json', '--project', ctx.projectRootAbs, '--chapter', String(ctx.chapter)];
  if (ctx.unit) common.push('--unit', String(ctx.unit));
  if (b) common.push('--boundary', b);
  const stateAbs = path.join(ctx.projectRootAbs, '追踪', '_tracking-state.json');
  const hasState = fs.existsSync(stateAbs);
  const chain = [
    () => runCheck('tracking-check', {
      interpreter: 'python', script: 'guyin-tracking-commit.py',
      args: ['check', '--project', ctx.projectRootAbs], target: false,
      referenceFiles: ['追踪/_tracking-state.json'],
    }, ctx),
    () => runCheck('rule-conflict', {
      script: 'guyin-check-rule-conflict.js',
      args: ['--json', '--project', ctx.projectRootAbs], target: false,
      referenceFiles: ['作者性/纪律冲突台账.md', '大纲/批次公约.md'],
    }, ctx),
    () => runCheck('strip', { script: 'guyin-check-strip.js', args: ['--json', cand] }, ctx),
    () => runCheck('integrity', { script: 'guyin-check-integrity.js', args: ['--json', cand] }, ctx),
    () => runCheck('beat', { script: 'guyin-check-beat.js', args: ['--json', cand] }, ctx),
    () => runCheck('degeneration', { script: 'guyin-check-degeneration.js', args: ['--json', cand] }, ctx),
    () => runCheck('ai-patterns', {
      script: 'guyin-check-ai-patterns.js',
      args: [...common, cand],
    }, ctx),
    () => runCheck('wordcount', { script: 'guyin-check-wordcount.js', args: ['--json',
      `--min=${(ctx.boundary && ctx.boundary.wordcount && ctx.boundary.wordcount.min) || 1}`,
      `--max=${(ctx.boundary && ctx.boundary.wordcount && ctx.boundary.wordcount.max) || 100000}`,
      cand] }, ctx),
    // G-5：outline-copy 是必需检查；无细纲时脚本给 not_applicable（合法终态，带原因）。
    () => runCheck('outline-copy', {
      script: 'guyin-check-outline-copy.js',
      args: [...common, ...(ctx.outlineAbs ? ['--outline', ctx.outlineAbs] : []), cand],
      referenceFiles: ctx.outlineRel ? [ctx.outlineRel] : [],
    }, ctx),
    () => runCheck('outline-deliver', {
      script: 'guyin-check-outline-deliver.js',
      args: [...common, ...(ctx.outlineAbs ? ['--outline', ctx.outlineAbs] : []), cand],
    }, ctx),
    () => runCheck('authority-leak', {
      script: 'guyin-check-authority-leak.js', args: [...common, cand],
    }, ctx),
    () => runCheck('foreshadow-id', {
      script: 'guyin-check-foreshadow-id.js',
      args: [...common, ...(ctx.transactionAbs ? ['--transaction', ctx.transactionAbs] : []), cand],
      referenceFiles: ['追踪/伏笔.md'],
    }, ctx),
    () => runCheck('repetition', {
      script: 'guyin-check-repetition.js',
      args: ['--json', '--project', ctx.projectRootAbs,
        '--unit', String(ctx.unit || ctx.chapter), '--prepublish', cand],
    }, ctx),
    // G-5：state 类检查是必需项。缺 state 不允许静默少跑：显式 error 条目阻止发布。
    ...(hasState ? [
      () => runCheck('narrative-asset', {
        script: 'guyin-check-narrative-asset.js',
        args: ['--json', `--state=${stateAbs}`, ...common.slice(1), cand],
        referenceFiles: ['追踪/_tracking-state.json'],
      }, ctx),
      () => runCheck('consistency', {
        script: 'guyin-check-consistency.js',
        args: ['--json', `--state=${stateAbs}`, ...common.slice(1), cand],
        referenceFiles: ['追踪/_tracking-state.json'],
      }, ctx),
    ] : [
      () => ({
        name: 'narrative-asset', script: 'guyin-check-narrative-asset.js', interpreter: 'node',
        script_sha256: sha256File(path.join(SCRIPT_DIR, 'guyin-check-narrative-asset.js')),
        command: [], exit_code: 2, files_scanned: [], target_files: [ctx.candidateRel],
        reference_files: ['追踪/_tracking-state.json'], status: 'error',
        reason: '缺 追踪/_tracking-state.json：state 类检查不能静默跳过（少跑检查即 error）',
        findings_count: 0,
      }),
      () => ({
        name: 'consistency', script: 'guyin-check-consistency.js', interpreter: 'node',
        script_sha256: sha256File(path.join(SCRIPT_DIR, 'guyin-check-consistency.js')),
        command: [], exit_code: 2, files_scanned: [], target_files: [ctx.candidateRel],
        reference_files: ['追踪/_tracking-state.json'], status: 'error',
        reason: '缺 追踪/_tracking-state.json：state 类检查不能静默跳过（少跑检查即 error）',
        findings_count: 0,
      }),
    ]),
  ];
  if (ctx.outlineAbs) {
    chain.push(() => runCheck('outline-slots', {
      script: 'guyin-check-outline-slots.js', args: ['--json', ctx.outlineAbs],
      target: false, referenceFiles: [ctx.outlineRel],
    }, ctx));
    chain.push(() => runCheck('opening-retention', {
      script: 'guyin-check-opening-retention.js', args: ['--json', ctx.outlineAbs],
      target: false, referenceFiles: [ctx.outlineRel],
    }, ctx));
  }
  return chain;
}

function buildEvidence(ctx) {
  const checks = requiredChain(ctx).map((fn) => fn());
  const stateAbs = path.join(ctx.projectRootAbs, '追踪', '_tracking-state.json');
  const status = checks.some((c) => c.status === 'error') ? 'error'
    : checks.some((c) => c.status === 'findings') ? 'fail' : 'pass';
  return {
    schema_version: 1,
    project: ctx.projectRoot,
    chapter: ctx.chapter,
    unit: ctx.unit,
    candidate_path: ctx.candidateRel,
    candidate_sha256: ctx.candidateHash,
    input_sha256: ctx.boundary ? sha256File(ctx.boundaryAbs) : null,
    baseline_state_sha256: fs.existsSync(stateAbs) ? sha256File(stateAbs) : null,
    assembled_at: new Date().toISOString(),
    checks,
    status,
  };
}

// G-5 必需检查集合（缺任一不得发布）：tracking/state 门、笔法治理、全文候选检查、
// 锁检查、指纹前置；outline-slots/opening-retention 仅在有真实细纲时入链。
const REQUIRED_CHECK_NAMES = ['tracking-check', 'rule-conflict', 'strip', 'integrity', 'beat',
  'degeneration', 'ai-patterns', 'wordcount', 'outline-copy', 'outline-deliver',
  'authority-leak', 'foreshadow-id', 'repetition', 'narrative-asset', 'consistency'];

// 校验一份既有证据：候选/input/state/脚本版本/扫描对象/必需检查/终态。
function validateEvidence(ctx, evidenceAbs) {
  const errors = [];
  let doc;
  try { doc = JSON.parse(fs.readFileSync(evidenceAbs, 'utf8')); }
  catch (e) { return { ok: false, errors: [`证据不是合法 JSON：${e.message}`] }; }
  if (!doc || doc.schema_version !== 1) errors.push('schema_version 必须为 1');
  if (doc.candidate_sha256 !== ctx.candidateHash) errors.push('candidate_sha256 与当前候选不一致（过期证据）');
  // G-5：input/state 绑定必须与当前调用对象一致，旧 input/state 的证据不得复用。
  const expectedInput = ctx.boundary ? sha256File(ctx.boundaryAbs) : null;
  if ((doc.input_sha256 || null) !== expectedInput) {
    errors.push(`input_sha256 不一致（证据 ${doc.input_sha256 ? '绑旧 input' : '无 input 绑定'}，须重跑）`);
  }
  const stateAbs = path.join(ctx.projectRootAbs, '追踪', '_tracking-state.json');
  const expectedState = fs.existsSync(stateAbs) ? sha256File(stateAbs) : null;
  if ((doc.baseline_state_sha256 || null) !== expectedState) {
    errors.push('baseline_state_sha256 与当前 state 不一致（state 已变，证据过期）');
  }
  if (!Array.isArray(doc.checks)) errors.push('checks 必须是数组');
  const present = new Set();
  for (const c of doc.checks || []) {
    present.add(c.name);
    const scriptAbs = path.join(SCRIPT_DIR, c.script);
    if (!c.script || !fs.existsSync(scriptAbs)) { errors.push(`${c.name}: 脚本缺失 ${c.script}`); continue; }
    if (c.script_sha256 !== sha256File(scriptAbs)) errors.push(`${c.name}: 脚本已变更，证据过期（须重跑）`);
    if (c.status === 'error') errors.push(`${c.name}: 检查状态 error（${c.reason || ''}）`);
    if (c.status === 'findings' && c.exit_code === 1) {
      errors.push(`${c.name}: 存在未处置 findings（exit 1），须先落 hard/verify 合法终态`);
    }
    // not_applicable 是合法终态（须带原因），不要求扫到候选。
    if (c.status !== 'not_applicable' && Array.isArray(c.target_files)
        && c.target_files.includes(ctx.candidateRel)) {
      const scanned = new Set(c.files_scanned || []);
      if (!scanned.has(ctx.candidateRel) && !scanned.has(ctx.candidateAbs)) {
        errors.push(`${c.name}: 零扫描（files_scanned 未含候选）`);
      }
    }
    if (c.status === 'not_applicable' && !c.reason) errors.push(`${c.name}: not_applicable 必须带原因`);
    const povFindings = Array.isArray(c.pov_findings) ? c.pov_findings : [];
    const knownIds = new Set(povFindings.map((f) => f.id));
    if (knownIds.size !== povFindings.length) errors.push(`${c.name}: 重复 POV finding id`);
    for (const f of povFindings) {
      if (f.resolution !== 'exempted') errors.push(`${c.name}: 未处置 POV hit ${f.id}`);
      else {
        const reason = validatePovExemption(ctx, f, knownIds);
        if (reason) errors.push(`${c.name}: ${f.id}: ${reason}`);
      }
    }
    const exemptions = Array.isArray(c.exemptions) ? c.exemptions : [];
    const consumed = new Set();
    for (const e of exemptions) {
      if (e.type !== 'pov-drift') continue;
      const finding = povFindings.find((f) => f.id === e.hit_id && f.resolution === 'exempted');
      if (!finding || consumed.has(e.hit_id)) errors.push(`${c.name}: 豁免缺逐命中证据或重复 hit_id`);
      else {
        const reason = validatePovExemption(ctx, { ...finding, exemption: e }, knownIds);
        if (reason) errors.push(`${c.name}: ${reason}`);
      }
      consumed.add(e.hit_id);
    }
    if (povFindings.some((f) => f.resolution === 'exempted' && !consumed.has(f.id))) {
      errors.push(`${c.name}: 逐命中豁免未完整登记`);
    }
  }
  for (const n of REQUIRED_CHECK_NAMES) if (!present.has(n)) errors.push(`缺必需检查：${n}`);
  if (doc.status === 'error' || doc.status === 'fail') errors.push(`证据汇总状态为 ${doc.status}，不能发布`);
  return { ok: errors.length === 0, errors };
}

if (require.main === module) {
  try {
    const argv = process.argv.slice(2);
    const mode = argv.includes('--gather') ? 'gather'
      : argv.includes('--validate-evidence') ? 'validate' : 'resolve';
    const { clean, out, validate } = gatherArgv(argv);
    const ctx = resolveContext(clean);
    if (!ctx.explicit) {
      console.error('显式模式：--project <书根> --chapter <N> [--unit N] [--boundary f] <候选>');
      process.exit(2);
    }
    if (mode === 'gather') {
      const doc = buildEvidence(ctx);
      if (out) {
        const abs = resolveUnder(ctx.projectRootAbs, out, '--out');
        fs.writeFileSync(abs, `${JSON.stringify(doc, null, 2)}\n`);
      }
      process.stdout.write(`${JSON.stringify(doc, null, 2)}\n`);
      process.exit(doc.status === 'pass' ? 0 : 1);
    }
    if (mode === 'validate') {
      const result = validateEvidence(ctx, resolveUnder(ctx.projectRootAbs, validate, '--validate-evidence'));
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      process.exit(result.ok ? 0 : 2);
    }
    process.stdout.write(`${JSON.stringify({
      ok: true, project: ctx.projectRoot, chapter: ctx.chapter, unit: ctx.unit,
      candidate: { rel: ctx.candidateRel, sha256: ctx.candidateHash },
      files_scanned: ctx.filesScanned,
    }, null, 2)}\n`);
    process.exit(0);
  } catch (e) {
    console.error(e.code === 'CTX_INPUT' ? `输入错误：${e.message}` : String(e));
    process.exit(2);
  }
}

module.exports = {
  parseArgs, resolveContext, resolveUnder, existingFile, inferChapterFromName,
  isWorkspaceRel, isPositiveInt, sha256File, hash12File, readJson, FORMAL_CHAPTER_RE,
  chapterFrontMatterEnd, maskChapterHeading, povEvidenceFile, povHitId, readPovAttachment, validatePovExemption,
};
