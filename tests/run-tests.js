#!/usr/bin/env node
'use strict';

// tests/run-tests.js — 运行时脚本回归测试（零依赖，node 直跑，Windows 友好）
//
// 适配自上游 test-ai-patterns.sh 的 fixture+断言思路，收窄为隐笔 5+1 个运行时脚本与 guyin-setup 模板 hook 核的最小回归：
//   wordcount／degeneration／ai-patterns／outline-copy／normalize-punctuation 做行为断言，
//   tracking-commit.py 做语法 smoke（无 python 环境则 SKIP），guyin-hook.js 做 guard/兑底/注入三面断言，
//   另覆盖 guyin-setup 模板完整性（防「模板未提交致 CI 挂」复发）与 merge-claude-settings 合并语义。
// 上游的 bash 壳、mktemp、内联 node 断言全部收进本文件——一个文件跑完，CI 与本地同口径。

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const S = path.join(REPO, 'skills', 'guyin-write', 'scripts');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'guyin-tests-'));

let passed = 0;
let failed = 0;
let skipped = 0;
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

function skip(name, why) {
  skipped += 1;
  console.log(`  SKIP  ${name}（${why}）`);
}

function run(script, args, opts = {}) {
  const r = spawnSync('node', [path.join(S, script), ...args], { encoding: 'utf8', ...opts });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function fixture(rel, content) {
  const abs = path.join(TMP, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
  return abs;
}

function parseJson(stdout) {
  try {
    return JSON.parse(stdout);
  } catch (e) {
    return null;
  }
}

// 场景正文生成器（去空白约 34 字/句）
const SCENE = '院子里的灯还亮着，母亲把晒好的被子抱进屋里，他在门口帮着把竹竿收回来。';
const longChapter = (n) => `${SCENE.repeat(n)}\n`;

// ============================================================
console.log('== guyin-check-wordcount ==');
{
  const short = fixture('wc/第001章_短.md', '# 第001章 短\n他走了。\n');
  const normal = fixture('wc/第002章_正常.md', `# 第002章 正常\n${longChapter(75)}`);
  const overlong = fixture('wc/第003章_超.md', `# 第003章 超\n${longChapter(220)}`);

  let r = run('guyin-check-wordcount.js', ['--json', short]);
  let report = parseJson(r.stdout);
  check('短章 blocking 报警', r.status === 1 && report && report.findings.length === 1
    && report.findings[0].type === 'chapter-too-short' && report.findings[0].severity === 'blocking',
    `status=${r.status} findings=${JSON.stringify(report && report.findings.map((f) => f.type))}`);

  r = run('guyin-check-wordcount.js', [normal]);
  check('正常章通过', r.status === 0, `status=${r.status} out=${r.stdout.trim()}`);

  r = run('guyin-check-wordcount.js', ['--json', '--min=10', '--max=2000', overlong]);
  report = parseJson(r.stdout);
  check('超长章 advisory 报警', r.status === 1 && report
    && report.findings.some((f) => f.type === 'chapter-too-long' && f.severity === 'advisory'),
    `status=${r.status}`);

  r = run('guyin-check-wordcount.js', ['--fail-on=blocking', '--min=10', '--max=2000', overlong]);
  check('advisory 不触发 --fail-on=blocking', r.status === 0, `status=${r.status}`);

  r = run('guyin-check-wordcount.js', ['--json', path.join(TMP, 'wc')]);
  report = parseJson(r.stdout);
  const shorts = report ? report.findings.filter((f) => f.type === 'chapter-too-short') : [];
  check('目录模式只扫 第*.md', r.status === 1 && shorts.length === 1 && path.basename(shorts[0].file) === '第001章_短.md',
    `status=${r.status} shorts=${JSON.stringify(shorts.map((f) => path.basename(f.file)))}`);

  const other = fixture('wc/notes.md', '太短。');
  r = run('guyin-check-wordcount.js', ['--json', path.join(TMP, 'wc')]);
  report = parseJson(r.stdout);
  check('目录里非 第*.md 文件被忽略', report && !report.findings.some((f) => path.basename(f.file) === 'notes.md'),
    JSON.stringify(report && report.findings.map((f) => path.basename(f.file))));
}

// ============================================================
console.log('== guyin-check-degeneration ==');
{
  const line = '他沿着长廊往里走，走过一道又一道紧闭的木门，终于在最里面停了下来。';
  const rep = fixture('dg/第001章_转.md', `${line}\n${line}\n${line}\n`);
  let r = run('guyin-check-degeneration.js', ['--json', rep]);
  let report = parseJson(r.stdout);
  check('复读打转报警', r.status === 1 && report && report.findings.length >= 1, `status=${r.status}`);

  const clean = fixture('dg/第002章_净.md',
    '父亲蹲在鸡圈边上补网，手指被铁丝划了一道，他也没停。\n'
    + '母亲把熬好的粥端上桌，吹了吹，先递给奶奶那碗。\n'
    + '他把书包挂上门后的钉子，灯绳拉了两下才亮。\n');
  r = run('guyin-check-degeneration.js', ['--json', clean]);
  report = parseJson(r.stdout);
  check('干净正文通过', r.status === 0 && report && report.findings.length === 0,
    `status=${r.status} findings=${JSON.stringify(report && report.findings.map((f) => f.type))}`);

  const meta = fixture('dg/第003章_漏.md', '本章的目标情绪是愤怒，字数目标一千五。\n');
  r = run('guyin-check-degeneration.js', ['--json', meta]);
  report = parseJson(r.stdout);
  check('工程词泄漏报警', r.status === 1 && report && report.findings.length >= 1, `status=${r.status}`);
}

// ============================================================
console.log('== guyin-check-ai-patterns ==');
{
  const fx = fixture('ai/第001章_对比.md', [
    '他不是冷漠，而是绝望。',
    '她不是害怕，是累了。',
    '“你们看见了啊，不是我要闹，是物业非法限制人身自由。”',
  ].join('\n'));
  const r = run('guyin-check-ai-patterns.js', ['--json', fx]);
  const report = parseJson(r.stdout);
  const ni = report ? report.findings.filter((f) => f.type === 'not-is-comparison') : [];
  check('不是A而是B 命中 2 处', r.status === 1 && ni.length === 2,
    `status=${r.status} not-is=${ni.length} findings=${JSON.stringify(report && report.findings.map((f) => f.type))}`);
  check('引号内台词豁免', !ni.some((f) => (f.excerpt || '').includes('物业')),
    JSON.stringify(ni.map((f) => f.excerpt)));

  const clean = fixture('ai/第002章_净.md',
    '父亲把退货的椅子修到比原样还结实，没收钱。\n他说这木头还硬，就是榫眼松了。\n');
  const r2 = run('guyin-check-ai-patterns.js', [clean]);
  check('干净正文通过', r2.status === 0, `status=${r2.status} out=${r2.stdout.trim()}`);
}

// ============================================================
console.log('== guyin-check-outline-copy ==');
{
  const anchor = '他把祖传的青玉佩收进贴身口袋，转身推开老宅那扇斑驳的木门。';
  const outline = fixture('oc/大纲/细纲_第001章_测试.md', `1. 开场：${anchor}\n2. 冲突：弟弟拦门要钱。\n`);
  const copyProse = fixture('oc/正文/第001章_测试.md', `${longChapter(40)}${anchor}\n${longChapter(10)}`);
  const cleanProse = fixture('oc/正文/第002章_测试.md',
    '玉佩贴着胸口发凉。他抬手，门轴响了很久，灰从门梁上落下来。\n' + longChapter(20));

  let r = run('guyin-check-outline-copy.js', ['--outline', outline, copyProse]);
  check('细纲照搬报警', r.status === 1, `status=${r.status} out=${r.stdout.trim().slice(0, 200)}`);

  r = run('guyin-check-outline-copy.js', ['--outline', outline, cleanProse]);
  check('无重合通过', r.status === 0, `status=${r.status} out=${r.stdout.trim().slice(0, 200)}`);
}

// ============================================================
console.log('== guyin-normalize-punctuation ==');
{
  const target = fixture('np/第001章_标点.md', '他等等...再进来吧。\n她停住--没说话。\n');
  const r = run('guyin-normalize-punctuation.js', [target]);
  const after = fs.readFileSync(target, 'utf8');
  check('转换退出 0', r.status === 0, `status=${r.status} err=${r.stderr.trim()}`);
  // 本框架哲学：句中停顿不用省略号——脚本把 ... 规范为中文停顿标点（逗/句），-- 同理清障。
  // 断言只锁「ASCII 序列被确定性消除」，不锁目标字形（字形随 lint 规则演进）。
  check('ASCII 省略号被清除', !after.includes('...'), after.trim());
  check('双连字符被清除', !after.includes('--'), after.trim());
}

// ============================================================
console.log('== guyin-tracking-commit.py (smoke) ==');
{
  const py = ['python3', 'python', 'py'].find((bin) => {
    try {
      return spawnSync(bin, ['-c', ''], { encoding: 'utf8' }).status === 0;
    } catch (e) {
      return false;
    }
  });
  if (!py) {
    skip('python 语法编译', '未找到可用 python 解释器');
  } else {
    const script = path.join(S, 'guyin-tracking-commit.py');
    const r = spawnSync(py, ['-c', `compile(open(${JSON.stringify(script)}, encoding="utf-8").read(), ${JSON.stringify(script)}, "exec")`], { encoding: 'utf8' });
    check('python 语法编译', r.status === 0, r.stderr.trim().slice(0, 300));
  }
}

// ============================================================
console.log('== guyin-setup 模板 hook（guyin-hook.js） ==');
{
  const HOOK = path.join(REPO, 'skills', 'guyin-setup', 'templates', 'long', '.claude', 'hooks', 'guyin-hook.js');
  const runHook = (args, input, cwd) => {
    const r = spawnSync('node', [HOOK, ...args], { encoding: 'utf8', input, cwd: cwd || process.cwd() });
    return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
  };
  const payload = (file) => JSON.stringify({ tool_name: 'Write', tool_input: { file_path: file } });

  // 书A：第 1/2 章细纲齐 + state 已提交至第 1 章 + 第 1 章正文已存在
  const bookA = path.join(TMP, 'hook', '书A');
  fixture('hook/书A/大纲/细纲_第001章_试.md', '1. 开场。');
  fixture('hook/书A/大纲/细纲_第002章_试.md', '1. 承接。');
  fixture('hook/书A/追踪/_tracking-state.json', JSON.stringify({ schema_version: 1, last_committed_chapter: 1, state_revision: 1 }));
  fixture('hook/书A/正文/第001章_试.md', `# 第001章 试${'\n'}${longChapter(75)}`);
  fixture('hook/书A/追踪/上下文.md', `# 上下文${'\n'}${'\n'}## 当前位置${'\n'}- 第 1 章已交付${'\n'}`);

  // 书B：只有第 2 章细纲，state 停在第 0 章（上一章未提交）
  const bookB = path.join(TMP, 'hook', '书B');
  fixture('hook/书B/大纲/细纲_第002章_试.md', '1. 承接。');
  fixture('hook/书B/追踪/_tracking-state.json', JSON.stringify({ schema_version: 1, last_committed_chapter: 0, state_revision: 0 }));

  let r = runHook(['guard'], payload(path.join(bookA, '正文', '第003章_新.md')));
  check('guard 首建缺细纲拦截', r.status === 2 && r.stderr.includes('细纲'), `status=${r.status} err=${r.stderr.trim().slice(0, 80)}`);

  r = runHook(['guard'], payload(path.join(bookB, '正文', '第002章_试.md')));
  check('guard 上一章未提交拦截', r.status === 2 && r.stderr.includes('追踪'), `status=${r.status} err=${r.stderr.trim().slice(0, 80)}`);

  r = runHook(['guard'], payload(path.join(bookA, '正文', '第002章_试.md')));
  check('guard 细纲与 state 全齐放行', r.status === 0, `status=${r.status} err=${r.stderr.trim().slice(0, 80)}`);

  r = runHook(['guard'], payload(path.join(bookA, '正文', '第001章_试.md')));
  check('guard 续写已存在章放行', r.status === 0, `status=${r.status} err=${r.stderr.trim().slice(0, 80)}`);

  r = runHook(['guard'], payload(path.join(bookA, '大纲', '细纲_第004章_新.md')));
  check('guard 非正文目标放行', r.status === 0, `status=${r.status}`);

  r = runHook(['guard'], 'not-json');
  check('guard 坏负载 fail-open', r.status === 0, `status=${r.status}`);

  const notBook = path.join(TMP, 'hook', 'notbook', '正文');
  fs.mkdirSync(notBook, { recursive: true });
  r = runHook(['guard'], payload(path.join(notBook, '第005章_误.md')));
  check('guard 非隐笔项目防误伤', r.status === 0, `status=${r.status}`);

  const tiny = fixture('hook/书A/正文/第004章_极短.md', `# 第004章 短${'\n'}太短。${'\n'}`);
  r = runHook(['post-write'], payload(tiny));
  check('post-write 极短落盘提醒', r.status === 0 && r.stdout.includes('落盘'), `status=${r.status} out=${r.stdout.trim().slice(0, 80)}`);

  const midChap = fixture('hook/书A/正文/第005章_欠.md', `# 第005章 欠${'\n'}${longChapter(40)}`);
  r = runHook(['post-write'], payload(midChap));
  check('post-write 章字数欠账提醒', r.status === 0 && r.stdout.includes('字数'), `status=${r.status} out=${r.stdout.trim().slice(0, 80)}`);

  const okChap = fixture('hook/书A/正文/第006章_全.md', `# 第006章 全${'\n'}${longChapter(75)}`);
  r = runHook(['post-write'], payload(okChap));
  check('post-write 正常章静默', r.status === 0 && r.stdout.trim() === '', `status=${r.status} out=${r.stdout.trim().slice(0, 80)}`);

  r = runHook(['post-write'], payload(path.join(bookA, '大纲', '细纲_第001章_试.md')));
  check('post-write 非正文静默', r.status === 0 && r.stdout.trim() === '', `status=${r.status}`);

  r = runHook(['session'], '', bookA);
  check('session 注入当前位置', r.status === 0 && r.stdout.includes('第 1 章已交付'), `status=${r.status} out=${r.stdout.slice(0, 120)}`);

  const emptyDir = path.join(TMP, 'hook', 'empty');
  fs.mkdirSync(emptyDir, { recursive: true });
  r = runHook(['session'], '', emptyDir);
  check('session 空项目静默', r.status === 0 && r.stdout.trim() === '', `status=${r.status}`);
}

// ============================================================
console.log('== guyin-setup 模板完整性（Phase 0 清单落成断言） ==');
{
  const T = path.join(REPO, 'skills', 'guyin-setup', 'templates');
  const required = [
    'long/AGENTS.md',
    'long/README.md',
    'long/.claude/settings.json',
    'long/.claude/hooks/guyin-hook.js',
    'long/.claude/agents/guyin-beat-writer.md',
    'long/.codex/agents/guyin-beat-writer.toml',
    'long/.opencode/agents/guyin-beat-writer.md',
    'long/.opencode/commands/guyin.md',
    'long/作者性/气卡.md',
    'long/作者性/指纹.md',
    'long/作者性/偏执点.md',
    'long/作者性/魂档案.md',
    'long/作者性/粒度配置.md',
    'long/作者性/参考-气质谱系.md',
    'long/作者性/口述定稿单.md',
    'long/大纲/魂谱对表.md',
    'long/追踪/_tracking-state.json',
    'short/大纲/情节节点.md',
    'short/大纲/情绪曲线.md',
    'short/大纲/反转表.md',
  ];
  for (const rel of required) {
    check(`模板存在 ${rel}`, fs.existsSync(path.join(T, rel)));
  }
}

// ============================================================
console.log('== merge-claude-settings.js（hooks 节确定性合并） ==');
{
  const MERGE = path.join(REPO, 'skills', 'guyin-setup', 'scripts', 'merge-claude-settings.js');
  const TPL = path.join(REPO, 'skills', 'guyin-setup', 'templates', 'long', '.claude', 'settings.json');
  const runMerge = (target) => {
    const r = spawnSync('node', [MERGE, '--template', TPL, '--target', target], { encoding: 'utf8' });
    return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
  };
  const readTarget = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
  const managedCount = (j) => {
    let n = 0;
    for (const blocks of Object.values(j.hooks || {})) {
      if (!Array.isArray(blocks)) continue;
      for (const b of blocks) {
        for (const h of (b && b.hooks) || []) {
          if (h && typeof h.command === 'string' && h.command.includes('guyin-hook.js')) n += 1;
        }
      }
    }
    return n;
  };

  // 案例 1：target 不存在 → 等价复制，三条管理注册齐
  const t1 = path.join(TMP, 'merge/a/.claude/settings.json');
  let r = runMerge(t1);
  const j1 = fs.existsSync(t1) ? readTarget(t1) : null;
  check('无 target 等价复制', r.status === 0 && j1 && managedCount(j1) === 3,
    `status=${r.status} managed=${j1 ? managedCount(j1) : 'n/a'}`);

  // 案例 2：用户 hooks 与旧版管理注册共存 → 用户保留、旧注册刷新
  const t2 = path.join(TMP, 'merge/b/.claude/settings.json');
  fs.mkdirSync(path.dirname(t2), { recursive: true });
  fs.writeFileSync(t2, JSON.stringify({
    permissions: { allow: ['Bash(git:*)'] },
    hooks: {
      PreToolUse: [
        { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo user-hook' }] },
        { matcher: 'Write|Edit', hooks: [{ type: 'command', command: 'node .claude/hooks/guyin-hook.js guard-OLD' }] },
      ],
    },
  }, null, 2), 'utf8');
  r = runMerge(t2);
  const j2 = readTarget(t2);
  const userBlock = (j2.hooks.PreToolUse || []).find((b) => b.matcher === 'Bash');
  check('用户 hooks 保留', r.status === 0 && userBlock
    && userBlock.hooks.some((h) => h.command === 'echo user-hook'), `status=${r.status}`);
  check('旧管理注册被刷新为模板三条', r.status === 0 && managedCount(j2) === 3
    && !JSON.stringify(j2).includes('guard-OLD'), `managed=${managedCount(j2)}`);
  check('用户顶层字段保留', j2.permissions && j2.permissions.allow[0] === 'Bash(git:*)');

  // 案例 3：重复执行幂等（字节一致）
  const before = fs.readFileSync(t2, 'utf8');
  r = runMerge(t2);
  check('重复执行幂等', r.status === 0 && fs.readFileSync(t2, 'utf8') === before,
    `status=${r.status}`);
}

// ============================================================
try {
  fs.rmSync(TMP, { recursive: true, force: true });
} catch (e) {
  /* Windows 上偶发占用，留给系统临时目录自清理 */
}

console.log('');
console.log(`Summary: ${passed} pass, ${failed} fail, ${skipped} skip`);
if (failed > 0) {
  console.log('');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log('Result: 运行时脚本回归测试通过');
