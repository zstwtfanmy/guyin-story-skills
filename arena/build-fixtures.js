#!/usr/bin/env node
'use strict';

// arena/build-fixtures.js — P0 合成夹具构建器（任务书 §0.2 / §7.1 / §7.4）
//
// 在独立 arena 目录建立可反复核验的合成书根（不触碰任何活书）：
//   arena/fixtures/long/book/   长篇合成书：§7.1 init 输入（修表铺），state rev0
//   arena/fixtures/short/book/  短篇合成书：短篇协议（固定单元 1），state rev0
// 已初始化的书根不覆盖重建；--force 仅重建本脚本生成的夹具目录。
//
// 用法：node arena/build-fixtures.js [--force] [--json]

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const REPO = path.resolve(__dirname, '..');
const PYSCRIPT = path.join(REPO, 'skills', 'guyin-write', 'scripts', 'guyin-tracking-commit.py');
const TEMPLATE_LEDGER = path.join(
  REPO, 'skills', 'guyin-setup', 'templates', 'long', '追踪', '待审台账.md');
const FIX_ROOT = path.join(REPO, 'arena', 'fixtures');

const sha256 = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

const LONG_INIT = {
  schema_version: 1,
  book_title: '试写',
  last_chapter: 0,
  context: {
    position: { volume: '第一卷', volume_start_chapter: 1, story_time: '首日清晨', scene: '修表铺' },
  },
};

const SHORT_INIT = {
  schema_version: 1,
  book_title: '试写短篇',
  last_chapter: 0,
  context: {
    position: { volume: '短篇', volume_start_chapter: 1, story_time: '婚日', scene: '巷口' },
  },
};

function runPy(args, cwd) {
  const r = spawnSync('python', [PYSCRIPT, ...args], { encoding: 'utf8', cwd: cwd || REPO });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function buildFixture(kind, initDoc) {
  const root = path.join(FIX_ROOT, kind);
  const book = path.join(root, 'book');
  const statePath = path.join(book, '追踪', '_tracking-state.json');
  const result = {
    kind, book: path.relative(REPO, book), initialized_now: false,
    init_exit: null, check_exit: null, check_stdout: '', state_sha256: null, error: null,
  };

  if (fs.existsSync(statePath) && !process.argv.includes('--force')) {
    const rr = runPy(['check', '--project', book]);
    result.check_exit = rr.status;
    result.check_stdout = (rr.stdout + rr.stderr).trim();
    result.state_sha256 = sha256(statePath);
    result.note = '已存在初始化书根，未覆盖；仅重跑 check 核验';
    return result;
  }

  fs.rmSync(book, { recursive: true, force: true });
  fs.mkdirSync(path.join(book, '追踪', '角色状态'), { recursive: true });
  fs.mkdirSync(path.join(book, '正文'), { recursive: true });
  fs.copyFileSync(TEMPLATE_LEDGER, path.join(book, '追踪', '待审台账.md'));

  const initPath = path.join(root, 'init.input.json');
  fs.writeFileSync(initPath, JSON.stringify(initDoc, null, 2) + '\n', 'utf8');

  const ri = runPy(['init', '--project', book, '--input', initPath]);
  result.init_exit = ri.status;
  if (ri.status !== 0) {
    result.error = (ri.stderr || ri.stdout).trim();
    return result;
  }
  result.initialized_now = true;

  const rc = runPy(['check', '--project', book]);
  result.check_exit = rc.status;
  result.check_stdout = (rc.stdout + rc.stderr).trim();
  result.state_sha256 = sha256(statePath);
  return result;
}

const outcomes = [
  buildFixture('long', LONG_INIT),
  buildFixture('short', SHORT_INIT),
];

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(outcomes, null, 2));
} else {
  for (const o of outcomes) {
    console.log(`== ${o.kind} ==`);
    console.log(`  book: ${o.book}`);
    console.log(`  init_exit=${o.init_exit} check_exit=${o.check_exit}`);
    console.log(`  state_sha256=${o.state_sha256}`);
    if (o.note) console.log(`  note: ${o.note}`);
    if (o.error) console.log(`  ERROR: ${o.error}`);
    if (o.check_stdout) console.log(`  check: ${o.check_stdout.split('\n').join('\n  ')}`);
  }
}

process.exit(outcomes.every((o) => o.init_exit === 0 && o.check_exit === 0) ? 0 : 1);
