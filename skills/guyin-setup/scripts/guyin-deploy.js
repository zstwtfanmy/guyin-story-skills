#!/usr/bin/env node
'use strict';
/*
 * guyin-deploy.js — 隐笔脚手架部署与受管 agent 退役（P3.1，单模型自由执笔版）
 *
 * 子命令：
 *   install --dest <书根> [--kind long|long+short] [--title <书名>]
 *   preview --dest <书根>
 *   retire  --dest <书根> --approve <rel,rel,...> [--confirm-source <sha256>]
 *   status  --dest <书根>
 *
 * 设计约束（任务书 §8.2/§8.3/§9，T25-T27）：
 *  - 新分发不含任何 writer/checker 受管 agent；install 全程非交互、不问 model。
 *  - 旧项目同名 agent 先做来源核对：与 legacy/agents-v0.8 归档字节一致＝受管，
 *    字节不符＝自定义/来源不明，只列预览、永不自动删。
 *  - 退役只处理显式批准的受管文件：先备份（MANIFEST.txt）再删；重复执行幂等。
 *  - 进度账本记录 source_hash；实施中断后源码哈希不符必须凭新预览重新核对
 *    （--confirm-source 带新哈希），禁止照旧账本假报完成。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const SKILL_DIR = path.resolve(__dirname, '..');
const TEMPLATES = path.join(SKILL_DIR, 'templates');
const LONG_TPL = path.join(TEMPLATES, 'long');
const SHORT_TPL = path.join(TEMPLATES, 'short');
const LEGACY_AGENTS = path.join(SKILL_DIR, 'legacy', 'agents-v0.8');
const DEPLOY_MARKER = '.guyin-deployed';
const PROGRESS_LEDGER = path.join('.guyin', 'upgrade-progress.json');

// 受管部署件：相对书根 → v0.8 归档字节（识别受管/自定义的唯一依据）
const MANAGED_AGENT_RELS = [
  ['.claude/agents/guyin-beat-writer.md', 'claude/guyin-beat-writer.md'],
  ['.claude/agents/guyin-checker.md', 'claude/guyin-checker.md'],
  ['.opencode/agents/guyin-beat-writer.md', 'opencode/guyin-beat-writer.md'],
  ['.opencode/agents/guyin-checker.md', 'opencode/guyin-checker.md'],
  ['.codex/agents/guyin-beat-writer.toml', 'codex/guyin-beat-writer.toml'],
  ['.codex/agents/guyin-checker.toml', 'codex/guyin-checker.toml'],
];

// install：部署件可安全刷新；其余一律 create-if-absent
const REPLACE_FILES = [
  '.opencode/commands/guyin.md',
];

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}
function shaFile(abs) {
  return sha256(fs.readFileSync(abs));
}
function emit(obj, code = 0) {
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
  process.exitCode = code;
}
function fail(message, code = 2, extra = {}) {
  emit({ ok: false, error: message, ...extra }, code);
  process.exit(code);
}
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) { out[key] = true; }
      else { out[key] = next; i += 1; }
    } else {
      out._.push(a);
    }
  }
  return out;
}
function walkFiles(root) {
  const out = [];
  if (!fs.existsSync(root)) return out;
  for (const ent of fs.readdirSync(root, { withFileTypes: true })) {
    const abs = path.join(root, ent.name);
    if (ent.isDirectory()) out.push(...walkFiles(abs));
    else out.push(abs);
  }
  return out;
}
function posixRel(base, abs) {
  return path.relative(base, abs).split(path.sep).join('/');
}
function todayUTC() {
  return new Date().toISOString().slice(0, 10);
}
function isFile(p) {
  try { return fs.statSync(p).isFile(); } catch (e) { return false; }
}
function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch (e) { return false; }
}

// 受管识别器版本：任一归档字节变化 → source_hash 变 → 旧进度账本失效重核
function managedSourceHash() {
  const parts = [];
  for (const [rel, arc] of MANAGED_AGENT_RELS) {
    const abs = path.join(LEGACY_AGENTS, arc);
    parts.push(`${rel}:${fs.existsSync(abs) ? shaFile(abs) : 'MISSING'}`);
  }
  return sha256(Buffer.from(parts.join('\n'), 'utf8'));
}
function managedHashMap() {
  const map = new Map();
  for (const [rel, arc] of MANAGED_AGENT_RELS) {
    const abs = path.join(LEGACY_AGENTS, arc);
    if (fs.existsSync(abs)) map.set(rel, shaFile(abs));
  }
  return map;
}

function scanAgents(dest) {
  const expected = managedHashMap();
  const managed = [];
  const custom = [];
  const unknown = [];
  for (const [rel] of MANAGED_AGENT_RELS) {
    const abs = path.join(dest, rel);
    if (!isFile(abs)) continue;
    const digest = shaFile(abs);
    if (expected.get(rel) === digest) {
      managed.push({ rel, sha256: digest, size: fs.statSync(abs).size });
    } else {
      custom.push({ rel, sha256: digest, size: fs.statSync(abs).size, reason: 'hash_mismatch' });
    }
  }
  for (const dir of ['.claude/agents', '.opencode/agents', '.codex/agents']) {
    const absDir = path.join(dest, dir);
    if (!fs.existsSync(absDir)) continue;
    for (const f of fs.readdirSync(absDir)) {
      const rel = `${dir}/${f}`;
      if (MANAGED_AGENT_RELS.some(([r]) => r === rel)) continue;
      unknown.push(rel);
    }
  }
  return { managed, custom, unknown };
}

function loadLedger(dest) {
  const abs = path.join(dest, PROGRESS_LEDGER);
  if (!isFile(abs)) return null;
  try {
    return JSON.parse(fs.readFileSync(abs, 'utf8'));
  } catch (e) {
    return { schema_version: 1, corrupted: true };
  }
}

function cmdInstall({ dest, kind = 'long', title }) {
  if (!dest) fail('install 缺 --dest <书根>');
  if (kind !== 'long' && kind !== 'long+short') fail('--kind 只支持 long 或 long+short');
  const root = path.resolve(dest);
  fs.mkdirSync(root, { recursive: true });

  // 铁律：新分发不含受管 agent（防止 legacy/旧打包回流）
  for (const [rel] of MANAGED_AGENT_RELS) {
    if (fs.existsSync(path.join(LONG_TPL, rel))) {
      fail(`模板内仍存在已退役受管 agent：${rel}（分发被阻断，请检查模板构建）`);
    }
  }

  const installed = [];
  const skipped = [];
  const replaced = [];
  const copyIfAbsent = (absSrc, rel) => {
    const absDst = path.join(root, rel);
    if (fs.existsSync(absDst)) { skipped.push(rel); return; }
    fs.mkdirSync(path.dirname(absDst), { recursive: true });
    let buf = fs.readFileSync(absSrc);
    if (rel === 'AGENTS.md') {
      const bookName = title || path.basename(root);
      buf = Buffer.from(buf.toString('utf8').replace(/\{书名\}/g, bookName), 'utf8');
    }
    fs.writeFileSync(absDst, buf);
    installed.push(rel);
  };

  for (const abs of walkFiles(LONG_TPL)) {
    const rel = posixRel(LONG_TPL, abs);
    if (REPLACE_FILES.includes(rel)) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), fs.readFileSync(abs));
      replaced.push(rel);
      continue;
    }
    copyIfAbsent(abs, rel);
  }

  if (kind === 'long+short') {
    for (const abs of walkFiles(SHORT_TPL)) {
      const relShort = posixRel(SHORT_TPL, abs); // 大纲/xxx.md
      copyIfAbsent(abs, relShort);
    }
  }

  const marker = path.join(root, DEPLOY_MARKER);
  const prev = fs.existsSync(marker) ? JSON.parse(fs.readFileSync(marker, 'utf8')) : null;
  const record = {
    deployed_at: (prev && prev.deployed_at) || new Date().toISOString(),
    redeployed_at: prev ? new Date().toISOString() : null,
    guyin_version: '0.10.0',
    form: kind,
    distribution: 'single-model-free-write',
    managed_agents: 'retired',
  };
  fs.writeFileSync(marker, JSON.stringify(record, null, 2), 'utf8');

  emit({
    ok: true, command: 'install', dest: root, kind,
    installed, replaced, skipped,
    managed_agents_distributed: false,
  });
}

function cmdPreview({ dest }) {
  if (!dest) fail('preview 缺 --dest <书根>');
  const root = path.resolve(dest);
  if (!isDir(root)) fail(`目标目录不存在：${root}`);
  const scan = scanAgents(root);
  const ledger = loadLedger(root);
  const sourceHash = managedSourceHash();
  const stale = !!(ledger && !ledger.corrupted && ledger.source_hash && ledger.source_hash !== sourceHash);
  const corrupted = !!(ledger && ledger.corrupted);
  // 以实际文件重新核对账本（T27：不信旧账本的完成声明）
  const drift = [];
  if (ledger && Array.isArray(ledger.retired)) {
    for (const rel of ledger.retired) {
      if (fs.existsSync(path.join(root, rel))) drift.push(rel);
    }
  }
  emit({
    ok: true, command: 'preview', dest: root, source_hash: sourceHash,
    managed_retire: scan.managed,
    custom_same_name: scan.custom,
    unknown_agents: scan.unknown,
    ledger: ledger ? {
      exists: true, corrupted,
      source_hash: ledger.source_hash || null,
      retired: ledger.retired || [],
      stale_progress: stale,
      drift_returns: drift,
    } : { exists: false },
    require_confirm_source: stale || corrupted,
    hint: scan.managed.length
      ? '受管 agent 可退役：把 managed_retire 的 rel 传给 retire --approve；custom_same_name/unknown 不会被删。'
      : '无受管退役项；同名自定义文件已保留。',
  });
}

function cmdRetire({ dest, approve, 'confirm-source': confirmSource }) {
  if (!dest) fail('retire 缺 --dest <书根>');
  const root = path.resolve(dest);
  if (!approve || approve === true) fail('retire 缺 --approve <rel,rel,...>：只处理显式批准的受管文件');
  const requested = String(approve).split(',').map((s) => s.trim()).filter(Boolean);
  const sourceHash = managedSourceHash();
  const scan = scanAgents(root);
  const managedRels = new Set(scan.managed.map((m) => m.rel));
  const customRels = new Set(scan.custom.map((m) => m.rel));

  const illegal = requested.filter((r) => !MANAGED_AGENT_RELS.some(([rel]) => rel === r));
  if (illegal.length) fail(`批准目标含非受管路径（拒绝）：${illegal.join(', ')}`, 2, { preserve: true });
  const blockedCustom = requested.filter((r) => customRels.has(r));
  if (blockedCustom.length) {
    fail(`同名文件字节与受管归档不符＝自定义/来源不明，须人工核对，不得按受管退役：${blockedCustom.join(', ')}`, 2,
      { preserve: true, custom_same_name: scan.custom });
  }

  const ledger = loadLedger(root);
  if (ledger && ledger.corrupted) {
    fail('进度账本损坏：先按 preview 实际结果重新核对，再带 --confirm-source 续跑', 4,
      { source_hash: sourceHash });
  }
  if (ledger && ledger.source_hash && ledger.source_hash !== sourceHash) {
    if (confirmSource !== sourceHash) {
      fail('部署源哈希与进度账本不符（实施中断后源码已变）：请先重新 preview 核对实际差异，'
        + '再用本次输出的 source_hash 带 --confirm-source 续跑——旧账本不得当作完成证据', 4,
        { expected_source_hash: sourceHash, ledger_source_hash: ledger.source_hash,
          actual_managed_remaining: scan.managed.map((m) => m.rel) });
    }
  }

  const backupDirRel = path.join('.guyin', 'upgrade-backup', todayUTC()).split(path.sep).join('/');
  const backupDir = path.join(root, backupDirRel);
  fs.mkdirSync(backupDir, { recursive: true });
  const manifestLines = [];
  const retired = [];
  const already = [];
  for (const rel of requested) {
    if (!managedRels.has(rel)) {
      // 已不在现场（上次中断时已删）→ 幂等跳过，不重复备份，但按实际现场补记进新账本
      if ((ledger && Array.isArray(ledger.retired) && ledger.retired.includes(rel)) || !isFile(path.join(root, rel))) {
        already.push(rel);
      }
      continue;
    }
    const abs = path.join(root, rel);
    const dst = path.join(backupDir, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(abs, dst);
    manifestLines.push(`${rel}\t${shaFile(abs)}\t-> ${backupDirRel}/${rel}`);
    fs.unlinkSync(abs);
    retired.push(rel);
    // 空 agents 目录一并清掉，不留空壳
    const agentsDir = path.dirname(abs);
    if (isDir(agentsDir) && fs.readdirSync(agentsDir).length === 0) {
      fs.rmdirSync(agentsDir);
    }
  }
  if (manifestLines.length) {
    fs.appendFileSync(path.join(backupDir, 'MANIFEST.txt'),
      `# ${new Date().toISOString()} source_hash=${sourceHash}\n${manifestLines.join('\n')}\n`, 'utf8');
  }

  const mergedRetired = Array.from(new Set([
    ...((ledger && ledger.retired) || []),
    ...retired,
    ...already,
  ])).sort();
  const ledgerAbs = path.join(root, PROGRESS_LEDGER);
  fs.mkdirSync(path.dirname(ledgerAbs), { recursive: true });
  fs.writeFileSync(ledgerAbs, JSON.stringify({
    schema_version: 1,
    source_hash: sourceHash,
    completed_at: new Date().toISOString(),
    retired: mergedRetired,
  }, null, 2), 'utf8');

  const after = scanAgents(root);
  emit({
    ok: true, command: 'retire',
    retired_now: retired, already_retired: already,
    backup_dir: manifestLines.length || fs.existsSync(path.join(backupDir, 'MANIFEST.txt')) ? backupDirRel : null,
    custom_preserved: after.custom.map((c) => c.rel),
    unknown_preserved: after.unknown,
    remaining_managed: after.managed.map((m) => m.rel),
  });
}

function cmdStatus({ dest }) {
  if (!dest) fail('status 缺 --dest <书根>');
  const root = path.resolve(dest);
  const marker = path.join(root, DEPLOY_MARKER);
  const scan = scanAgents(root);
  const ledger = loadLedger(root);
  const sourceHash = managedSourceHash();
  const drift = ledger && Array.isArray(ledger.retired)
    ? ledger.retired.filter((rel) => fs.existsSync(path.join(root, rel))) : [];
  emit({
    ok: true, command: 'status',
    deployed: isFile(marker) ? JSON.parse(fs.readFileSync(marker, 'utf8')) : null,
    managed_remaining: scan.managed.map((m) => m.rel),
    custom_preserved: scan.custom.map((c) => c.rel),
    unknown_preserved: scan.unknown,
    ledger_stale: !!(ledger && ledger.source_hash && ledger.source_hash !== sourceHash),
    drift_returns: drift,
    source_hash: sourceHash,
  });
}

function main() {
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  if (command === 'install') return cmdInstall(args);
  if (command === 'preview') return cmdPreview(args);
  if (command === 'retire') return cmdRetire(args);
  if (command === 'status') return cmdStatus(args);
  fail('用法：guyin-deploy.js <install|preview|retire|status> ...', 64);
}
main();
