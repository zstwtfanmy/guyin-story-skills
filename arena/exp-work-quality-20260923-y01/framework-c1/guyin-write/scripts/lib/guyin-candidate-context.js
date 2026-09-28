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
    if (Array.isArray(parsed.findings)) entry.findings_count = parsed.findings.length;
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
};
