'use strict';

// tests/run-tests.js — 纯工程回归测试（零依赖，node 直跑，Windows 友好）
//
// §6 口径：工程 CI 只允许测纯工程事项（文件存在、部署成功）。
// 本文件只断言：
//   1. 技能包完整性：package-manifest verify 退出码 0（缺件/损坏/混版即失败）；
//   2. guyin-setup 模板结构：关键文件存在 + 反向检查（不得含 hook/settings/受管 agent）；
//   3. 部署 smoke：temp 目录跑 guyin-deploy.js install，验证落位、占位符替换、幂等；
//   4. 部署件刷新与 create-if-absent 语义：重跑不覆盖用户内容。
// 不测任何写作质量、文学性内容；测试输出与注释不得出现文学性背书措辞。

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const SETUP = path.join(REPO, 'skills', 'guyin-setup');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'guyin-tests-'));

let passed = 0;
let failed = 0;
const failures = [];

function check(name, cond, detail) {
  if (cond) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    failures.push(`${name}${detail ? `：${detail}` : ''}`);
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function runNode(script, args, opts = {}) {
  const r = spawnSync('node', [script, ...args], { encoding: 'utf8', ...opts });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

// ============================================================
console.log('== 技能包完整性（manifest verify） ==');
{
  const r = runNode(path.join(SETUP, 'scripts', 'guyin-check-package.js'),
    ['verify', '--root', path.join(REPO, 'skills')]);
  check('manifest verify exit 0', r.status === 0, (r.stdout + r.stderr).slice(0, 300));
}

// ============================================================
console.log('== guyin-setup 模板结构 ==');
{
  const LONG = path.join(SETUP, 'templates', 'long');
  const must = [
    'AGENTS.md', 'README.md', '.opencode/commands/guyin.md',
    '大纲/README.md', '大纲/魂谱对表.md', '大纲/执行层一页纸.md', '大纲/批次公约.md',
    '设定/题材定位.md', '正文/README.md', '灵感池/README.md',
    '追踪/上下文.md', '追踪/伏笔.md', '追踪/读者信号.md', '追踪/角色状态/README.md',
    '作者性/指纹.md', '作者性/魂档案.md',
  ];
  for (const rel of must) {
    check(`模板存在 ${rel}`, fs.existsSync(path.join(LONG, rel)));
  }
  const banned = ['.claude/settings.json', '.claude/hooks/guyin-hook.js'];
  for (const rel of banned) {
    check(`模板不含 ${rel}`, !fs.existsSync(path.join(LONG, rel)));
  }
  const banned2 = ['追踪/_tracking-state.json', '追踪/待审台账.md', '追踪/豁免台账.md', '追踪/契约对账矩阵.md'];
  for (const rel of banned2) {
    check(`模板不含 ${rel}`, !fs.existsSync(path.join(LONG, rel)));
  }
  // 反向检查：模板树内不得出现受管 agent 文件
  const walk = (dir, out) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(abs, out);
      else out.push(path.relative(LONG, abs).split(path.sep).join('/'));
    }
  };
  const all = [];
  walk(LONG, all);
  const agentLeak = all.filter((rel) => /(^|\/)agents\/guyin-(beat-writer|checker)\./.test(rel));
  check('模板树无受管 agent 泄漏', agentLeak.length === 0, agentLeak.join(', '));
}

// ============================================================
console.log('== 部署 smoke（temp 目录） ==');
{
  const DEPLOY = path.join(SETUP, 'scripts', 'guyin-deploy.js');
  const dest = path.join(TMP, 'book');
  const r1 = runNode(DEPLOY, ['install', '--dest', dest, '--kind', 'long', '--title', '测试书']);
  check('install exit 0', r1.status === 0, r1.stderr.slice(0, 300));
  let out1 = null;
  try { out1 = JSON.parse(r1.stdout); } catch (e) { /* ignore */ }
  check('install 返回 ok', !!(out1 && out1.ok));

  check('AGENTS.md 已落位', fs.existsSync(path.join(dest, 'AGENTS.md')));
  const agents = fs.existsSync(path.join(dest, 'AGENTS.md'))
    ? fs.readFileSync(path.join(dest, 'AGENTS.md'), 'utf8') : '';
  check('AGENTS.md 书名占位符已替换', agents.includes('测试书') && !agents.includes('{书名}'));
  check('正文/README.md 已落位', fs.existsSync(path.join(dest, '正文', 'README.md')));
  check('追踪/角色状态/ 已落位', fs.existsSync(path.join(dest, '追踪', '角色状态', 'README.md')));
  check('部署标记 .guyin-deployed', fs.existsSync(path.join(dest, '.guyin-deployed')));
  check('未部署 hook', !fs.existsSync(path.join(dest, '.claude', 'hooks', 'guyin-hook.js')));
  check('未部署 settings.json', !fs.existsSync(path.join(dest, '.claude', 'settings.json')));

  // create-if-absent：用户文件不被覆盖
  const userCtx = path.join(dest, '追踪', '上下文.md');
  fs.writeFileSync(userCtx, '# 用户自己的内容\n', 'utf8');
  const r2 = runNode(DEPLOY, ['install', '--dest', dest, '--kind', 'long', '--title', '测试书']);
  check('重跑 install exit 0', r2.status === 0, r2.stderr.slice(0, 300));
  const after = fs.readFileSync(userCtx, 'utf8');
  check('重跑不覆盖用户内容', after === '# 用户自己的内容\n');

  // 部署件 replace：opencode command 可刷新
  const cmdFile = path.join(dest, '.opencode', 'commands', 'guyin.md');
  check('opencode command 已落位', fs.existsSync(cmdFile));
}

// ============================================================
console.log('== 热路径脚本语法（node --check） ==');
{
  const hot = [
    'skills/guyin-setup/scripts/guyin-deploy.js',
    'skills/guyin-setup/scripts/guyin-check-package.js',
    'skills/guyin-write/scripts/guyin-check-pitch.js',
    'skills/guyin-write/scripts/guyin-normalize-punctuation.js',
    'scripts/check-doc-budget.js',
    'scripts/check-skill-contracts.js',
  ];
  for (const rel of hot) {
    const r = spawnSync(process.execPath, ['--check', path.join(REPO, rel)], { encoding: 'utf8' });
    check(`语法 ok ${rel}`, r.status === 0, (r.stderr || '').slice(0, 200));
  }
}

// ============================================================
console.log('');
if (failed) {
  console.log(`FAILED ${failed}/${passed + failed}`);
  console.log(failures.map((f) => `  - ${f}`).join('\n'));
  process.exit(1);
} else {
  console.log(`OK ${passed}/${passed + failed}（纯工程断言）`);
  process.exit(0);
}
