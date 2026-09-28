#!/usr/bin/env node
'use strict';

// guyin-check-package.js — F.3.1/F.3.2/F.3.4 技能包完整性预检
//
// 背景（任务书v4 F.3）：本机曾出现全局安装 100 个跟踪文件缺 68 个（29 scripts＋39 references）。
// 锁最新、目录存在都不代表安装完整。固定发布版本必须带「相对路径清单＋内容哈希」，
// 并把解释器真实路径/版本与脚本可加载分层验收，缺件/损坏/混版在开写前拦住，而不是写到一半报错。
//
// 用法：
//   node guyin-check-package.js verify [--root <skills 根>]
//       按同目录 package-manifest.json 核对已安装技能包；--root 缺省按本脚本 realpath 上两级锚定。
//       退出码：0 完整可加载；1 缺件/哈希不符/解释器或脚本加载失败；2 用法或锚定错误。
//   node guyin-check-package.js build --source <skills 根> [--manifest <输出路径>]
//       维护动作：从经测试的发布源树重生成固定版本清单（不在用户安装目录运行）。
//
// 边界：只证文件完整与脚本可加载，不跑写作链路；长短篇起草/preview/发布/修订/恢复的隔离夹具
// 验收从实际加载根另跑（R7）。技能根只按 realpath 锚定，不回退混找全局或旧项目目录。

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const MANIFEST_NAME = 'package-manifest.json';
const SKILLS = [
  'guyin-story', 'guyin-write', 'guyin-short-write', 'guyin-analyze', 'guyin-short-analyze',
  'guyin-review', 'guyin-deslop', 'guyin-pitch', 'guyin-setup',
];
// 整包纳入清单的技能：guyin-write（全部运行链）、guyin-setup（部署器/模板/退役归档）、
// guyin-review（SKILL.md 外部引用 references/rubrics/* 与 quality-rubric.md）。
// 其余技能只核 SKILL.md 入口（其余资产不在写作硬依赖链上，缺入口即可定位重装）。
// _disabled/ 是已退役机器与文档的留档（仅存 git 仓库），不随发布包分发，整体排除。
const FULL_TREE_SKILLS = ['guyin-write', 'guyin-setup', 'guyin-review'];
const EXCLUDE_NAMES = new Set(['node_modules', '__pycache__', '.DS_Store', MANIFEST_NAME, '_disabled']);

const isFile = (p) => {
  try { return fs.statSync(p).isFile(); } catch { return false; }
};
const isDir = (p) => {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
};

function realRoot(p) {
  return fs.realpathSync(path.resolve(p));
}

function walk(absRoot, relPrefix, out) {
  for (const name of fs.readdirSync(absRoot).sort()) {
    if (EXCLUDE_NAMES.has(name)) continue;
    const abs = path.join(absRoot, name);
    const rel = relPrefix ? `${relPrefix}/${name}` : name;
    const st = fs.statSync(abs);
    if (st.isDirectory()) {
      walk(abs, rel, out);
    } else if (st.isFile()) {
      out.push(rel);
    }
  }
}

function roleOf(rel) {
  if (/(^|\/)SKILL\.md$/.test(rel)) return 'skill-md';
  if (rel.includes('/scripts/lib/')) return 'lib';
  if (rel.includes('/scripts/')) return 'script';
  if (rel.startsWith('guyin-setup/templates/')) return 'template';
  if (rel.startsWith('guyin-setup/legacy/')) return 'legacy';
  return 'reference';
}

function build(sourceRoot, manifestPath) {
  const root = realRoot(sourceRoot);
  const files = [];
  for (const skill of SKILLS) {
    const skillAbs = path.join(root, skill);
    if (!isDir(skillAbs)) throw new Error(`源树缺技能目录：${skill}`);
    let rels;
    if (FULL_TREE_SKILLS.includes(skill)) {
      rels = [];
      walk(skillAbs, '', rels);
    } else {
      rels = ['SKILL.md'];
    }
    for (const rel of rels.sort()) {
      const abs = path.join(skillAbs, rel);
      const buf = fs.readFileSync(abs);
      files.push({
        skill, path: rel,
        sha256: crypto.createHash('sha256').update(buf).digest('hex'),
        size: buf.length, role: roleOf(`${skill}/${rel}`),
      });
    }
  }
  const manifest = {
    schema_version: 1,
    distribution: 'guyin-story-skills',
    source: 'zstwtfanmy/guyin-story-skills',
    built_at: new Date().toISOString().slice(0, 10),
    note: '固定发布版本相对路径清单；安装后用 guyin-check-package.js verify 核对，缺件/损坏/混版 exit1',
    skills: SKILLS,
    files,
  };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  return { written: manifestPath, files: files.length, root };
}

function findPython() {
  const candidates = process.platform === 'win32'
    ? [['python', ['--version']], ['py', ['-3', '--version']], ['python3', ['--version']]]
    : [['python3', ['--version']], ['python', ['--version']]];
  for (const [cmd, args] of candidates) {
    const r = spawnSync(cmd, args, { encoding: 'utf8' });
    if (r.status === 0) {
      // Windows 下 PATH 命中可能是 shim/Store 别名：只报命令与版本字符串，真实解析由调用方按需 which -a。
      return { command: cmd, version: (r.stdout || r.stderr).trim() };
    }
  }
  return null;
}

function syntaxLoad(root, manifest, python) {
  const failures = [];
  // JS：node --check 语法加载（不执行）；缺件已在 missing 报告，此处跳过不重复计数。
  for (const f of manifest.files) {
    if (!f.path.endsWith('.js') || !['script', 'lib'].includes(f.role)) continue;
    const abs = path.join(root, f.skill, f.path);
    if (!isFile(abs)) continue;
    const r = spawnSync(process.execPath, ['--check', abs], { encoding: 'utf8' });
    if (r.status !== 0) {
      failures.push({ file: `${f.skill}/${f.path}`, kind: 'js-syntax', error: (r.stderr || '').trim().slice(0, 200) });
    }
  }
  // Python：ast.parse 语法加载（不 import、不写 __pycache__）；无解释器单独记一条。
  if (!python) {
    failures.push({ file: null, kind: 'interpreter', error: '未找到可用的 Python 3 解释器（python3/python/py -3）' });
  } else {
    for (const f of manifest.files) {
      if (!f.path.endsWith('.py')) continue;
      const abs = path.join(root, f.skill, f.path);
      if (!isFile(abs)) continue;
      const r = spawnSync(python.command, ['-B', '-c',
        'import ast,sys; ast.parse(open(sys.argv[1], encoding="utf-8").read())', abs],
        { encoding: 'utf8' });
      if (r.status !== 0) {
        failures.push({ file: `${f.skill}/${f.path}`, kind: 'py-syntax', error: (r.stderr || '').trim().slice(0, 200) });
      }
    }
  }
  return failures;
}

function verify(rootArg) {
  const ownRoot = realRoot(path.join(__dirname, '..', '..'));
  const root = rootArg ? realRoot(rootArg) : ownRoot;
  // F.3.2：技能根必须是真实包含 guyin-write 的目录；找不到就如实报，不回退搜索其他位置。
  if (!isDir(path.join(root, 'guyin-write'))) {
    return { exit: 2, result: { ok: false, error: `技能根下缺 guyin-write/：${root}（按 realpath 锚定，不回退混找）` } };
  }
  const manifestPath = path.join(root, 'guyin-setup', 'scripts', MANIFEST_NAME);
  if (!isFile(manifestPath)) {
    return {
      exit: 1,
      result: {
        ok: false, skill_root: root,
        missing_manifest: `guyin-setup/scripts/${MANIFEST_NAME}`,
        note: '无固定版本清单：安装包不完整或版本早于 F.3，重装经核验版本后再验收',
      },
    };
  }
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (e) {
    return { exit: 1, result: { ok: false, skill_root: root, error: `清单无法解析：${e.message}` } };
  }
  const missing = [];
  const mismatched = [];
  for (const f of manifest.files || []) {
    const abs = path.join(root, f.skill, f.path);
    if (!isFile(abs)) {
      missing.push(`${f.skill}/${f.path}`);
      continue;
    }
    const buf = fs.readFileSync(abs);
    if (crypto.createHash('sha256').update(buf).digest('hex') !== f.sha256) {
      mismatched.push(`${f.skill}/${f.path}`);
    }
  }
  const python = findPython();
  const loadFailures = syntaxLoad(root, manifest, python);
  const ok = missing.length === 0 && mismatched.length === 0 && loadFailures.length === 0;
  return {
    exit: ok ? 0 : 1,
    result: {
      ok,
      command: 'verify-package',
      distribution: manifest.distribution,
      manifest_built_at: manifest.built_at,
      skill_root: root,
      anchored_from: rootArg ? '--root' : 'own realpath',
      files_listed: (manifest.files || []).length,
      missing_count: missing.length,
      mismatched_count: mismatched.length,
      missing,
      mismatched,
      interpreters: { node: { command: process.execPath, version: process.version }, python },
      load_failures: loadFailures,
    },
  };
}

function main() {
  const [command, ...rest] = process.argv.slice(2);
  const opt = (name) => {
    const i = rest.indexOf(name);
    return i >= 0 ? rest[i + 1] : null;
  };
  try {
    if (command === 'verify') {
      const { exit, result } = verify(opt('--root'));
      console.log(JSON.stringify(result, null, 2));
      process.exit(exit);
    }
    if (command === 'build') {
      const source = opt('--source');
      if (!source) {
        console.error('build 需要 --source <经测试的 skills 根>');
        process.exit(2);
      }
      const out = opt('--manifest') || path.join(__dirname, MANIFEST_NAME);
      const r = build(source, out);
      console.log(JSON.stringify(r, null, 2));
      process.exit(0);
    }
    console.error('用法：guyin-check-package.js verify [--root <skills 根>] | build --source <skills 根>');
    process.exit(2);
  } catch (e) {
    console.error(`ERROR: ${e && e.message ? e.message : e}`);
    process.exit(2);
  }
}

main();
