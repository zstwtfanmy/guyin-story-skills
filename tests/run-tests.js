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
const FIXTURES = path.join(REPO, 'tests', 'fixtures');
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
console.log('== guyin-check-ai-patterns L1-L3（三腔 advisory，黄金样本回归） ==');
{
  // 黄金样本（05 §3 L1-L3）：坏样本三腔必报。
  // aphorism 特例：ch36 修复版「表是死的，人是活的。」（第 45 行）是功能性策略句，
  // 规则校准注释已记录为允许命中——断言锁「仅 1 处」，不锁全静默。
  let r = run('guyin-check-ai-patterns.js', ['--json', path.join(FIXTURES, 'ch61-正文_三腔坏样本.md')]);
  let report = parseJson(r.stdout);
  check('ch61 三腔坏样本必报 explain-tic（科普腔）', r.status === 1 && report
    && report.findings.some((f) => f.type === 'explain-tic' && f.severity === 'advisory'),
    `status=${r.status} types=${JSON.stringify(report && report.findings.map((f) => f.type))}`);
  check('ch61 三腔坏样本必报 mid-trailer（段中预告腔）', r.status === 1 && report
    && report.findings.some((f) => f.type === 'mid-trailer' && f.severity === 'advisory'),
    `types=${JSON.stringify(report && report.findings.map((f) => f.type))}`);
  check('ch61 三腔坏样本必报 aphorism-tic（金句腔）', r.status === 1 && report
    && report.findings.some((f) => f.type === 'aphorism-tic' && f.severity === 'advisory'),
    `types=${JSON.stringify(report && report.findings.map((f) => f.type))}`);

  r = run('guyin-check-ai-patterns.js', ['--json', path.join(FIXTURES, 'ch36-正文_修复版.md')]);
  report = parseJson(r.stdout);
  const aph = report ? report.findings.filter((f) => f.type === 'aphorism-tic') : [];
  check('ch36 修复版 explain/mid 静默（零误报）', report
    && !report.findings.some((f) => f.type === 'explain-tic' || f.type === 'mid-trailer'),
    `types=${JSON.stringify(report && report.findings.map((f) => f.type))}`);
  check('ch36 修复版 aphorism 仅 1 处功能性命中（「表是死的，人是活的。」）',
    aph.length === 1,
    `aphorism=${JSON.stringify(aph.map((f) => f.excerpt))}`);
}

// ============================================================
console.log('== guyin-check-integrity（F1 落盘前格式门，黄金样本回归） ==');
{
  // 黄金样本（tests/fixtures/README.md）：跑坏样本必报 blocking、跑正常版必静默。
  let r = run('guyin-check-integrity.js', ['--json', path.join(FIXTURES, 'ch39-正文_塌缩重构.md')]);
  let report = parseJson(r.stdout);
  check('ch39 塌缩样本必报 avg-line-collapse', r.status === 1 && report
    && report.findings.some((f) => f.type === 'avg-line-collapse' && f.severity === 'blocking'),
    `status=${r.status} types=${JSON.stringify(report && report.findings.map((f) => f.type))}`);
  check('ch39 塌缩样本代词叠复「他他」报 doubled-char', r.status === 1 && report
    && report.findings.some((f) => f.type === 'doubled-char'),
    `types=${JSON.stringify(report && report.findings.map((f) => f.type))}`);

  r = run('guyin-check-integrity.js', ['--json', path.join(FIXTURES, 'ch59-正文_错字风暴重构.md')]);
  report = parseJson(r.stdout);
  check('ch59 错字风暴样本必报 char-storm', r.status === 1 && report
    && report.findings.some((f) => f.type === 'char-storm' && f.severity === 'blocking'
      && (f.message || '').includes('个')),
    `status=${r.status} types=${JSON.stringify(report && report.findings.map((f) => f.type))}`);

  // 正常样本零误报：ch36 两版（初稿是叙事 S1 不是格式事故，F1 必须静默）。
  for (const name of ['ch36-正文_全盘否定初稿.md', 'ch36-正文_修复版.md']) {
    r = run('guyin-check-integrity.js', ['--json', path.join(FIXTURES, name)]);
    report = parseJson(r.stdout);
    check(`正常样本 ${name} 静默`, r.status === 0 && report && report.findings.length === 0,
      `status=${r.status} findings=${JSON.stringify(report && report.findings.map((f) => f.type))}`);
  }

  // 引号失衡与正常引号（内联构造）。
  const mismatch = fixture('it/第001章_引.md', `# 第001章 引\n${'他沿着长街慢慢走，看两侧的铺子。'.repeat(3)}\n「这批银，账上写着往南。\n${'她把熬好的粥端上桌，先递给奶奶那碗。'.repeat(40)}\n`);
  r = run('guyin-check-integrity.js', ['--json', mismatch]);
  report = parseJson(r.stdout);
  check('引号失衡报 quote-mismatch', r.status === 1 && report
    && report.findings.some((f) => f.type === 'quote-mismatch' && f.severity === 'blocking'),
    `status=${r.status} types=${JSON.stringify(report && report.findings.map((f) => f.type))}`);

  // 零误报样本必须用句池轮换的多样正文——单一模板机械复读本身就是风暴形态
  // （SCENE 单句「的」密度 6.25%，复读后必压线；正常中文「的」常态带 ~4.6%）。
  const POOL = [
    '母亲把晒好的被子抱进屋里，掸了掸上头的灰。',
    '他在门口帮着收竹竿，竿梢扫过檐角的蛛网。',
    '父亲蹲在鸡圈边上补网，铁丝在指头绕了三圈。',
    '她熬好一锅粥端上桌，先给奶奶盛了满满一碗。',
    '书包挂上门后的钉子，灯绳拉两下才亮。',
    '灶膛里的火压成暗红，水壶底结了一层白垢。',
    '巷口的馄饨摊收了，竹椅摞在墙根下淋雨。',
    '当票折成小方块，塞进枕头套内侧的针脚里。',
    '账房先生拨完算盘，把数目誊在黄麻纸上。',
    '夜风从门缝钻进来，吹得供桌上的烛火偏了偏。',
  ];
  const balanced = fixture('it/第002章_平.md',
    `# 第002章 平\n${Array.from({ length: 30 }, (_, i) =>
      `${POOL[i % POOL.length]}${POOL[(i + 3) % POOL.length]}「第${i + 1}笔：今日账目，两讫。」`).join('\n')}\n`);
  r = run('guyin-check-integrity.js', ['--json', balanced]);
  report = parseJson(r.stdout);
  check('引号配对正常静默（正常章零误报）', r.status === 0 && report && report.findings.length === 0,
    `status=${r.status} findings=${JSON.stringify(report && report.findings.map((f) => f.type))}`);
}

// ============================================================
console.log('== guyin-check-outline-verdict（G1 细纲三档声明仲裁，黄金样本回归） ==');
{
  // 黄金样本：冲突细纲必报、修复版定性必静默。
  let r = run('guyin-check-outline-verdict.js', ['--json', path.join(FIXTURES, 'ch36-细纲_档位冲突.md')]);
  let report = parseJson(r.stdout);
  check('ch36 冲突细纲必报档位冲突', r.status === 1 && report
    && report.findings.some((f) => f.type === 'verdict-tier-conflict' && f.severity === 'blocking'),
    `status=${r.status} types=${JSON.stringify(report && report.findings.map((f) => f.type))}`);
  check('ch36 冲突细纲必报缺声明（机械判档 2）', r.status === 1 && report
    && report.findings.some((f) => f.type === 'verdict-declaration-missing'),
    `types=${JSON.stringify(report && report.findings.map((f) => f.type))}`);

  r = run('guyin-check-outline-verdict.js', ['--json', path.join(FIXTURES, 'ch36-细纲_修复版定性.md')]);
  report = parseJson(r.stdout);
  check('ch36 修复版定性静默（判档 1）', r.status === 0 && report && report.findings.length === 0,
    `status=${r.status} findings=${JSON.stringify(report && report.findings.map((f) => f.type))}`);

  // 内联行为断言。
  const noDecl = fixture('ov/细纲_第008章_缺声明.md',
    '# 细纲（第 8 章）\n\n## 第 8 章：对峙\n- 核心事件：他对质旧账（ch5），说破「这局不是天意，是人算」\n');
  r = run('guyin-check-outline-verdict.js', ['--json', noDecl]);
  report = parseJson(r.stdout);
  check('翻转句+既往引用缺声明报 blocking', r.status === 1 && report
    && report.findings.some((f) => f.type === 'verdict-declaration-missing' && f.severity === 'blocking'),
    `status=${r.status}`);

  const normal = fixture('ov/细纲_第009章_正常.md',
    '# 细纲（第 9 章）\n\n## 第 9 章：赶路\n- 核心事件：两人北上问船\n- 字数目标：2500 字\n');
  r = run('guyin-check-outline-verdict.js', ['--json', normal]);
  report = parseJson(r.stdout);
  check('无引用无翻转细纲静默（无声明也不报）', r.status === 0 && report && report.findings.length === 0,
    `status=${r.status}`);

  const tier1 = fixture('ov/细纲_第005章_档1.md',
    '# 细纲（第 5 章）\n\n## 第 5 章：回声\n- 核心事件：他翻出旧案（ch2），认下「那晚不是他失约，是有人换了信」\n- 资产影响档位：1 部分动用——重估 ch2 失约：失约是真的，换信是局\n');
  r = run('guyin-check-outline-verdict.js', ['--json', tier1]);
  report = parseJson(r.stdout);
  check('声明档 1 与机械判档一致静默', r.status === 0 && report && report.findings.length === 0,
    `status=${r.status} findings=${JSON.stringify(report && report.findings.map((f) => f.type))}`);

  const suspect = fixture('ov/细纲_第006章_疑低.md',
    '# 细纲（第 6 章）\n\n## 第 6 章：全貌\n- 核心事件：复盘旧局（ch3），发现从头到尾都是安排\n- 资产影响档位：0\n');
  r = run('guyin-check-outline-verdict.js', ['--json', suspect]);
  report = parseJson(r.stdout);
  check('声明低于机械判档报 advisory', r.status === 1 && report
    && report.findings.some((f) => f.type === 'verdict-tier-suspect' && f.severity === 'advisory'),
    `status=${r.status} types=${JSON.stringify(report && report.findings.map((f) => f.type))}`);
  r = run('guyin-check-outline-verdict.js', ['--fail-on=blocking', suspect]);
  check('advisory 不触发 --fail-on=blocking', r.status === 0, `status=${r.status}`);

  const tier2 = fixture('ov/细纲_第007章_档2.md',
    '# 细纲（第 7 章）\n\n## 第 7 章：翻案\n- 核心事件：旧案翻案（ch4）\n- 资产影响档位：2\n');
  r = run('guyin-check-outline-verdict.js', ['--json', tier2]);
  report = parseJson(r.stdout);
  check('档 2 缺补偿声明报 advisory', r.status === 1 && report
    && report.findings.some((f) => f.type === 'verdict-tier2-uncompensated'),
    `status=${r.status} types=${JSON.stringify(report && report.findings.map((f) => f.type))}`);

  // G3 契约对照（05 §2 G3/M1）：ch36 事故场景——「送出来的」否定定性（机械判档 2）对
  // 「误信干净账」叠加契约（关键词取自真实矩阵登记，细纲第 44 行含「干净账」）。advisory 只提醒不拦。
  const matrix = fixture('g3/追踪/契约对账矩阵.md', [
    '# 契约对账矩阵',
    '',
    '## 机械对照区（脚本消费，列序固定：契约ID|卷号|契约类型|定性关键词|方向|内容摘要|状态）',
    '',
    '| 契约ID | 卷号 | 契约类型 | 定性关键词（顿号分隔） | 方向 | 内容摘要 | 状态 |',
    '|---|---|---|---|---|---|---|',
    '| C002 | 2 | 危机 | 干净账、误信 | 叠加 | 卷2 智性危机：误信干净账——识破后叠加成长 | 已登记 |',
  ].join('\n') + '\n');

  r = run('guyin-check-outline-verdict.js', ['--json', `--contracts=${matrix}`, path.join(FIXTURES, 'ch36-细纲_档位冲突.md')]);
  report = parseJson(r.stdout);
  check('G3 契约越界：叠加契约 × 否定定性报 advisory', r.status === 1 && report
    && report.findings.some((f) => f.type === 'contract-violation' && f.severity === 'advisory'),
    `status=${r.status} types=${JSON.stringify(report && report.findings.map((f) => f.type))}`);

  r = run('guyin-check-outline-verdict.js', ['--json', `--contracts=${matrix}`, path.join(FIXTURES, 'ch36-细纲_修复版定性.md')]);
  report = parseJson(r.stdout);
  check('G3 正向细纲（档 1 重估）对叠加契约零误报', r.status === 0 && report
    && !report.findings.some((f) => f.type.startsWith('contract-')),
    `status=${r.status} types=${JSON.stringify(report && report.findings.map((f) => f.type))}`);

  const matrixNeg = fixture('g3/追踪/矩阵_否定契约.md', [
    '# 契约对账矩阵',
    '',
    '| 契约ID | 卷号 | 契约类型 | 定性关键词（顿号分隔） | 方向 | 内容摘要 | 状态 |',
    '|---|---|---|---|---|---|---|',
    '| C003 | 2 | 反转 | 送出来的 | 否定 | 拆神局合法推翻（已登记的没收+补偿计划） | 已登记 |',
  ].join('\n') + '\n');
  r = run('guyin-check-outline-verdict.js', ['--json', `--contracts=${matrixNeg}`, path.join(FIXTURES, 'ch36-细纲_档位冲突.md')]);
  report = parseJson(r.stdout);
  check('G3 命中否定契约方向一致放行（无 contract findings）', report
    && !report.findings.some((f) => f.type.startsWith('contract-')),
    `types=${JSON.stringify(report && report.findings.map((f) => f.type))}`);

  const unreg = fixture('g3/大纲/细纲_第010章_未登记.md',
    '# 细纲（第 10 章）\n\n## 第 10 章：识破\n- 核心事件：他复盘旧计（ch3），认定「那晚不是巧合，是布局」\n- 资产影响档位：1 部分动用——重估旧计：局是真的，对象认错了\n');
  r = run('guyin-check-outline-verdict.js', ['--json', `--contracts=${matrix}`, unreg]);
  report = parseJson(r.stdout);
  check('G3 未登记契约：否定定性零命中提醒补录 advisory', r.status === 1 && report
    && report.findings.some((f) => f.type === 'contract-unregistered' && f.severity === 'advisory'),
    `status=${r.status} types=${JSON.stringify(report && report.findings.map((f) => f.type))}`);

  const autoOutline = fixture('g3auto/书/大纲/细纲_第036章_试.md',
    fs.readFileSync(path.join(FIXTURES, 'ch36-细纲_档位冲突.md'), 'utf8'));
  fixture('g3auto/书/追踪/契约对账矩阵.md', fs.readFileSync(matrix, 'utf8'));
  r = run('guyin-check-outline-verdict.js', ['--json', autoOutline]);
  report = parseJson(r.stdout);
  check('G3 矩阵自动发现（大纲/ 同级 追踪/）', r.status === 1 && report
    && report.findings.some((f) => f.type === 'contract-violation'),
    `status=${r.status} types=${JSON.stringify(report && report.findings.map((f) => f.type))}`);
}

// ============================================================
console.log('== guyin-check-narrative-asset（G2 事件定性共现检测，黄金样本回归） ==');
{
  // 项目布局：书/{正文,大纲,追踪}/；V027 拆神为 ch27 兑付资产（05 §2 G2 示例原样）。
  const V027 = {
    id: 'V027', chapter: 27, event: '拆神', status: 'active',
    verdict: '神像夹层里藏着流水账，他当众拆穿了换银的局。',
    keywords: ['拆神', '夹层', '流水账', '换银'],
    updated_chapter: 27,
  };
  fixture('g2/书/追踪/_tracking-state.json', JSON.stringify({ schema_version: 5, verdicts: { V027 } }));
  fixture('g2-null/书/追踪/_tracking-state.json',
    JSON.stringify({ schema_version: 5, verdicts: { V027: { ...V027, status: 'nullified' } } }));

  // 黄金样本：初稿（全盘否定）必报、修复版（档 1 重估表述）必静默。
  const draft = fixture('g2/书/正文/第036章_初稿.md',
    fs.readFileSync(path.join(FIXTURES, 'ch36-正文_全盘否定初稿.md'), 'utf8'));
  let r = run('guyin-check-narrative-asset.js', ['--json', draft]);
  let report = parseJson(r.stdout);
  check('G2 ch36 初稿对 V027 共现必报（「一场戏/人家排的」×拆神）', r.status === 1 && report
    && report.findings.some((f) => f.type === 'narrative-asset-violation' && f.severity === 'advisory'
      && (f.message || '').includes('V027')),
    `status=${r.status} types=${JSON.stringify(report && report.findings.map((f) => f.type))}`);

  const fixed = fixture('g2/书/正文/第036章_修复版.md',
    fs.readFileSync(path.join(FIXTURES, 'ch36-正文_修复版.md'), 'utf8'));
  r = run('guyin-check-narrative-asset.js', ['--json', fixed]);
  report = parseJson(r.stdout);
  check('G2 ch36 修复版静默（「从头到尾」不进否定词表，档 1 重估同形不误报）',
    r.status === 0 && report && report.findings.length === 0,
    `status=${r.status} findings=${JSON.stringify(report && report.findings.map((f) => f.type))}`);

  // 兑付当章（第 27 章正文写拆神当章）不算既往资产，不报。
  const sameChapter = fixture('g2/书/正文/第027章_兑付当章.md',
    '他当众拆了神，忽然想起老人说这是人家排的一场戏，心里一演。\n');
  r = run('guyin-check-narrative-asset.js', ['--json', sameChapter]);
  report = parseJson(r.stdout);
  check('G2 兑付当章建立资产不报', r.status === 0 && report && report.findings.length === 0,
    `status=${r.status} findings=${JSON.stringify(report && report.findings.map((f) => f.type))}`);

  // nullified 已没收：后续否定叙述是合法状态，不报。
  const afterNull = fixture('g2-null/书/正文/第036章_没收后.md',
    fs.readFileSync(path.join(FIXTURES, 'ch36-正文_全盘否定初稿.md'), 'utf8'));
  r = run('guyin-check-narrative-asset.js', ['--json', afterNull]);
  report = parseJson(r.stdout);
  check('G2 nullified 资产不再报', r.status === 0 && report && report.findings.length === 0,
    `status=${r.status}`);

  // 档位声明一致（档 ≥1）：作者已在细纲仲裁动用资产，静默。
  const declared = fixture('g2/书/大纲/细纲_第036章_档1声明.md',
    '# 细纲（第 36 章）\n\n## 第 36 章：复盘\n- 核心事件：他复盘拆神那局（ch27），认下「这局不是破出来的，是送出来的」\n- 资产影响档位：1 部分动用——重估拆神：赢是真的，被利用的是专注度\n');
  r = run('guyin-check-narrative-asset.js', ['--json', declared]);
  report = parseJson(r.stdout);
  check('G2 档位声明（档 1）静默', r.status === 0 && report && report.findings.length === 0,
    `status=${r.status}`);

  // 双层共现防误伤：否定模式行无 keywords、keywords 行无否定模式，单层均不报。
  const singleLayer = fixture('g2/书/正文/第005章_单层.md', [
    '“你们看见了，不是我要闹，是账对不上。”他说。',
    '这场做戏他早看穿了，只是没说破。',
    '拆神那天的流水账还在他怀里，纸都磨软了。',
  ].join('\n') + '\n');
  r = run('guyin-check-narrative-asset.js', ['--json', singleLayer]);
  report = parseJson(r.stdout);
  check('G2 双层共现：单层命中（否定模式或关键词各自单独出现）不报',
    r.status === 0 && report && report.findings.length === 0,
    `status=${r.status} findings=${JSON.stringify(report && report.findings.map((f) => f.type))}`);

  // 无追踪目录：无登记实体即无可对照资产，静默跳过。
  const orphan = fixture('g2-nostate/正文/第036章_孤本.md',
    '他想起拆神那局，才明白那是人家排的一场戏。\n');
  r = run('guyin-check-narrative-asset.js', ['--json', orphan]);
  report = parseJson(r.stdout);
  check('G2 无 state 静默（fail-open）', r.status === 0 && report && report.findings.length === 0,
    `status=${r.status}`);

  r = run('guyin-check-narrative-asset.js', ['--fail-on=blocking', draft]);
  check('G2 advisory 不触发 --fail-on=blocking', r.status === 0, `status=${r.status}`);

  // G2 接入 outline-verdict 事件名引用：细纲无章号引用但提及既往 verdict 事件名。
  fixture('g2ov/书/追踪/_tracking-state.json', JSON.stringify({
    schema_version: 5,
    verdicts: {
      V001: {
        id: 'V001', chapter: 3, event: '拆神', status: 'active',
        verdict: '神像夹层里藏着流水账，他当众拆穿了换银的局。',
        keywords: ['拆神', '流水账'], updated_chapter: 3,
      },
    },
  }));
  const evRef = fixture('g2ov/书/大纲/细纲_第009章_事件引用.md',
    '# 细纲（第 9 章）\n\n## 第 9 章：余波\n- 核心事件：他翻看流水账，说破「拆神不是天意，是人算」\n');
  r = run('guyin-check-outline-verdict.js', ['--json', evRef]);
  report = parseJson(r.stdout);
  check('G2 事件名引用自动发现：翻转句×拆神无声明报 blocking', r.status === 1 && report
    && report.findings.some((f) => f.type === 'verdict-declaration-missing' && f.severity === 'blocking'),
    `status=${r.status} types=${JSON.stringify(report && report.findings.map((f) => f.type))}`);

  const evDeclared = fixture('g2ov/书/大纲/细纲_第010章_事件声明.md',
    '# 细纲（第 10 章）\n\n## 第 10 章：回声\n- 核心事件：他翻看流水账，说破「拆神不是天意，是人算」\n- 资产影响档位：1 部分动用——重估拆神：局是真破的，递话的另有其人\n');
  r = run('guyin-check-outline-verdict.js', ['--json', evDeclared]);
  report = parseJson(r.stdout);
  check('G2 事件名引用已声明档 1 静默', r.status === 0 && report && report.findings.length === 0,
    `status=${r.status} findings=${JSON.stringify(report && report.findings.map((f) => f.type))}`);

  r = run('guyin-check-outline-verdict.js',
    ['--json', `--state=${path.join(TMP, 'g2ov', '书', '追踪', '_tracking-state.json')}`, evRef]);
  report = parseJson(r.stdout);
  check('G2 --state 显式指定事件名引用生效', r.status === 1 && report
    && report.findings.some((f) => f.type === 'verdict-declaration-missing'),
    `status=${r.status}`);
}

// ============================================================
console.log('== guyin-check-consistency（T1/T2 物证·能力·地理章检，黄金样本回归） ==');
{
  // 项目布局：书/{正文,追踪}/。黄金样本取 05 §5 三个原型：
  // ch2 方向冲突（临清在通州以南 × 顺水往南往通州）、销毁物证仍使用、ch32 型能力空降。
  fixture('tt/书/追踪/_tracking-state.json', JSON.stringify({
    schema_version: 6,
    evidence: {
      W001: {
        id: 'W001', chapter: 3, name: '会票',
        anchor: '小厮把票捧到案前：会票就是商号开的借据式票据。',
        status: 'destroyed', holder: '', keywords: ['会票'], updated_chapter: 5,
      },
    },
    geo: {
      G001: {
        id: 'G001', chapter: 2, name: '临清', aliases: ['临清州'],
        anchor: '临清在通州以南，运河上一半的银子打这里过。',
        ref: '通州', direction: '南', keywords: ['临清'], updated_chapter: 2,
      },
    },
    characters: {
      燕衡: { knowledge: ['验银'] },
    },
  }));

  // T2 方向冲突：台账断言临清在通州以南，正文却从临清一带顺水往南往通州（同向离参照地更远）。
  let r = run('guyin-check-consistency.js', ['--json', fixture('tt/书/正文/第002章_南下.md',
    '船出临清，水声催人。顺水往南，往通州去，两日可到。')]);
  let report = parseJson(r.stdout);
  check('T2 方向冲突必报 direction-conflict（ch2「顺水往南往通州」型）', r.status === 1 && report
    && report.findings.some((f) => f.type === 'direction-conflict' && f.severity === 'advisory'),
    `status=${r.status} types=${JSON.stringify(report && report.findings.map((f) => f.type))}`);

  // T1 物证状态矛盾：W001 第 5 章销毁，第 6 章仍掏出来用。
  r = run('guyin-check-consistency.js', ['--json', fixture('tt/书/正文/第006章_旧票.md',
    '他把那张会票掏出来，对着灯又看了一遍。')]);
  report = parseJson(r.stdout);
  check('T1 销毁物证仍使用必报 evidence-status-conflict', r.status === 1 && report
    && report.findings.some((f) => f.type === 'evidence-status-conflict'),
    `status=${r.status} types=${JSON.stringify(report && report.findings.map((f) => f.type))}`);

  // T1 能力空降：燕衡快照只登记验银，正文却让他懂漕运（ch32 小窦型）。
  r = run('guyin-check-consistency.js', ['--json', fixture('tt/书/正文/第006章_空降.md',
    '燕衡懂得漕运，一眼看出船的吃水不对。')]);
  report = parseJson(r.stdout);
  check('T1 能力空降必报 capability-unregistered', r.status === 1 && report
    && report.findings.some((f) => f.type === 'capability-unregistered'),
    `status=${r.status} types=${JSON.stringify(report && report.findings.map((f) => f.type))}`);

  // T2 新地名提示：到达句地名不在台账（含别名、子串互含）集。
  r = run('guyin-check-consistency.js', ['--json', fixture('tt/书/正文/第007章_新地.md',
    '船入济宁州，码头上的粮垛堆得像山。')]);
  report = parseJson(r.stdout);
  check('T2 新地名提示必报 place-unregistered', r.status === 1 && report
    && report.findings.some((f) => f.type === 'place-unregistered'),
    `status=${r.status} types=${JSON.stringify(report && report.findings.map((f) => f.type))}`);

  // 零误报：已登记地名的到达句静默，无物证/能力句干扰。
  r = run('guyin-check-consistency.js', ['--json', fixture('tt/书/正文/第008章_平.md',
    '船到临清州码头，他把缆绳抛上岸。')]);
  report = parseJson(r.stdout);
  check('T2 已登记地名到达句零误报', r.status === 0 && report && report.findings.length === 0,
    `status=${r.status} findings=${JSON.stringify(report && report.findings.map((f) => f.type))}`);

  // fail-open：非隐笔项目（无追踪 state）静默。
  const orphan = fixture('tt-nostate/正文/第036章_孤.md', '他把那张会票掏出来，又往南走了一程。');
  r = run('guyin-check-consistency.js', ['--json', orphan]);
  report = parseJson(r.stdout);
  check('T1/T2 无 state 静默（fail-open）', r.status === 0 && report && report.findings.length === 0,
    `status=${r.status}`);
}

// ============================================================
console.log('== guyin-tracking-commit.py G2 事件定性实体（行为断言） ==');
{
  const py = ['python3', 'python', 'py'].find((bin) => {
    try {
      return spawnSync(bin, ['-c', ''], { encoding: 'utf8' }).status === 0;
    } catch (e) {
      return false;
    }
  });
  if (!py) {
    skip('init 登记 verdicts', '未找到可用 python 解释器');
    skip('v4 存量 backfill 升级 v6', '未找到可用 python 解释器');
    skip('commit verdict_changes 合并', '未找到可用 python 解释器');
    skip('未来章 verdict 拒绝', '未找到可用 python 解释器');
  } else {
    const SCRIPT = path.join(S, 'guyin-tracking-commit.py');
    const runPy = (args, project) => spawnSync(py, [SCRIPT, ...args, '--project', project], { encoding: 'utf8' });

    // init 带 verdicts：state v6（写盘统一归一，G2 后 T1/T2 已升版）+ 事件定性资产.md 视图。
    const book1 = path.join(TMP, 'g2py', '甲');
    fixture('g2py/甲/init.json', JSON.stringify({
      schema_version: 1, book_title: '白银案录', last_chapter: 1,
      context: {
        position: { volume: '卷一', volume_start_chapter: 1, story_time: '景和三年春', scene: '县衙' },
        long_term_constraints: [], active_character_names: ['燕衡'], continuity_risks: [],
        recent_chapters: [{ chapter: 1, summary: '验银' }], next_chapter_commitments: [],
      },
      character_snapshots: {
        燕衡: { identity: '主角', location: '县衙', goal: '查银案', state: '冷静',
          abilities_resources: [], relationships: [], knowledge: [], open_threads: [] },
      },
      foreshadow: [], timeline_events: [],
      verdicts: [{
        id: 'V001', chapter: 1, event: '拆神', status: 'active',
        verdict: '神像夹层里藏着流水账，他当众拆穿了换银的局。',
        keywords: ['拆神', '夹层', '流水账', '换银'],
      }],
    }));
    let r = runPy(['init', '--input', path.join(TMP, 'g2py', '甲', 'init.json')], book1);
    let state = r.status === 0
      ? JSON.parse(fs.readFileSync(path.join(book1, '追踪', '_tracking-state.json'), 'utf8')) : null;
    const view = r.status === 0
      ? fs.readFileSync(path.join(book1, '追踪', '事件定性资产.md'), 'utf8') : '';
    check('init 登记 verdicts：state v6 + 资产视图', r.status === 0 && state
      && state.schema_version === 6 && state.verdicts.V001
      && view.includes('V001') && view.includes('拆神'),
      `status=${r.status} err=${r.stderr.trim().slice(0, 160)}`);
    r = runPy(['check'], book1);
    check('init 后 check 一致', r.status === 0, `status=${r.status} err=${r.stderr.trim().slice(0, 160)}`);

    // v4 存量（无 verdicts 键）→ backfill → v6：无需手工迁移。
    const book2 = path.join(TMP, 'g2py', '乙');
    const baseContext = {
      position: { volume: '卷一', volume_start_chapter: 1, story_time: '景和三年春', scene: '县衙' },
      long_term_constraints: [], active_character_names: ['燕衡'], continuity_risks: [],
      recent_chapters: [{ chapter: 1, summary: '验银' }], next_chapter_commitments: [],
    };
    const baseSnapshot = {
      燕衡: { identity: '主角', location: '县衙', goal: '查银案', state: '冷静',
        abilities_resources: [], relationships: [], knowledge: [], open_threads: [] },
    };
    fixture('g2py/乙/追踪/_tracking-state.json', JSON.stringify({
      schema_version: 4, book_title: '白银案录', last_committed_chapter: 1,
      imported_through_chapter: 1, state_revision: 1,
      context: baseContext, characters: baseSnapshot, foreshadow: {}, timeline: {},
    }));
    fixture('g2py/乙/backfill.json', JSON.stringify({
      schema_version: 1,
      verdicts: [{
        id: 'V027', chapter: 27, event: '拆神', status: 'active',
        verdict: '神像夹层里藏着流水账，他当众拆穿了换银的局。',
        keywords: ['拆神', '夹层', '流水账', '换银'],
      }],
    }));

    // 未来章校验：chapter 27 > last 1 → 拒绝。
    r = runPy(['backfill', '--input', path.join(TMP, 'g2py', '乙', 'backfill.json')], book2);
    check('backfill 未来章 verdict 拒绝（chapter > last_committed）', r.status === 2,
      `status=${r.status} err=${r.stderr.trim().slice(0, 120)}`);

    fixture('g2py/乙/追踪/_tracking-state.json', JSON.stringify({
      schema_version: 4, book_title: '白银案录', last_committed_chapter: 27,
      imported_through_chapter: 27, state_revision: 1,
      context: baseContext, characters: baseSnapshot, foreshadow: {}, timeline: {},
    }));
    r = runPy(['backfill', '--input', path.join(TMP, 'g2py', '乙', 'backfill.json')], book2);
    state = r.status === 0
      ? JSON.parse(fs.readFileSync(path.join(book2, '追踪', '_tracking-state.json'), 'utf8')) : null;
    check('backfill v4 存量自动升级 v6 并登记 verdicts', r.status === 0 && state
      && state.schema_version === 6 && state.verdicts.V027
      && state.verdicts.V027.updated_chapter === 27,
      `status=${r.status} err=${r.stderr.trim().slice(0, 160)}`);
    r = runPy(['check'], book2);
    check('backfill 后 check 一致', r.status === 0, `status=${r.status} err=${r.stderr.trim().slice(0, 160)}`);

    // commit verdict_changes：V027 重估（repriced）+ 新登记 V002，逐章记录渲染事件定性段。
    fixture('g2py/乙/commit.json', JSON.stringify({
      schema_version: 1, mode: 'append', chapter: 28, chapter_title: '反打',
      expected_state_revision: 2,
      delta: {
        result: '燕衡认下拆神那局有一半是送给他的，决意反打。',
        character_changes: [{ name: '燕衡', change: '从信干净账转向验喂他的人' }],
        verdict_changes: [
          {
            id: 'V027', chapter: 27, event: '拆神', status: 'repriced',
            verdict: '拆神那局有一半是送给他的：赢是真的，被利用的是专注度。',
            keywords: ['拆神', '夹层', '流水账', '换银'],
          },
          {
            id: 'V028', chapter: 28, event: '认被喂', status: 'active',
            verdict: '这局不是破出来的，是送出来的。',
            keywords: ['送出来的', '戏是人家排的'],
          },
        ],
      },
      context: {
        position: { volume: '卷一', volume_start_chapter: 1, story_time: '景和三年夏', scene: '银库' },
        long_term_constraints: [], active_character_names: ['燕衡'], continuity_risks: [],
      },
      character_snapshots: {
        燕衡: { identity: '主角', location: '银库', goal: '反打喂他的人', state: '冷静带狠劲',
          abilities_resources: [], relationships: [], knowledge: [], open_threads: [] },
      },
    }));
    r = runPy(['commit', '--input', path.join(TMP, 'g2py', '乙', 'commit.json')], book2);
    state = r.status === 0
      ? JSON.parse(fs.readFileSync(path.join(book2, '追踪', '_tracking-state.json'), 'utf8')) : null;
    const delta = r.status === 0
      ? fs.readFileSync(path.join(book2, '追踪', '逐章记录', '第028章.md'), 'utf8') : '';
    check('commit verdict_changes：重估+新登记，逐章记录含事件定性段', r.status === 0 && state
      && state.verdicts.V027.status === 'repriced' && state.verdicts.V028
      && delta.includes('## 事件定性') && delta.includes('V027｜repriced'),
      `status=${r.status} err=${r.stderr.trim().slice(0, 160)}`);
    r = runPy(['check'], book2);
    check('commit 后 check 一致', r.status === 0, `status=${r.status} err=${r.stderr.trim().slice(0, 160)}`);
  }
}

// ============================================================
console.log('== guyin-tracking-commit.py T1/T2 实体（evidence/geo，行为断言） ==');
{
  const py = ['python3', 'python', 'py'].find((bin) => {
    try {
      return spawnSync(bin, ['-c', ''], { encoding: 'utf8' }).status === 0;
    } catch (e) {
      return false;
    }
  });
  if (!py) {
    skip('init 登记 evidence/geo：state v6 + 双台账视图', '未找到可用 python 解释器');
    skip('init 后 check 一致（v6）', '未找到可用 python 解释器');
    skip('backfill 未来章 evidence 拒绝', '未找到可用 python 解释器');
    skip('backfill v5 存量自动升级 v6 并登记 evidence/geo', '未找到可用 python 解释器');
    skip('commit evidence_changes/geo_changes 渲染双变化段', '未找到可用 python 解释器');
  } else {
    const SCRIPT = path.join(S, 'guyin-tracking-commit.py');
    const runPy = (args, project) => spawnSync(py, [SCRIPT, ...args, '--project', project], { encoding: 'utf8' });

    // init 带 evidence/geo：state v6 + 物证台账/地理台账双视图。
    const book1 = path.join(TMP, 'ttpy', '甲');
    fixture('ttpy/甲/init.json', JSON.stringify({
      schema_version: 1, book_title: '白银案录', last_chapter: 2,
      context: {
        position: { volume: '卷一', volume_start_chapter: 1, story_time: '景和三年春', scene: '运河' },
        long_term_constraints: [], active_character_names: ['燕衡'], continuity_risks: [],
        recent_chapters: [{ chapter: 2, summary: '南下' }], next_chapter_commitments: [],
      },
      character_snapshots: {
        燕衡: { identity: '主角', location: '船上', goal: '查银案', state: '冷静',
          abilities_resources: [], relationships: [], knowledge: [], open_threads: [] },
      },
      foreshadow: [], timeline_events: [],
      evidence: [{
        id: 'W001', chapter: 2, name: '会票',
        anchor: '小厮把票捧到案前：会票就是商号开的借据式票据。',
        status: 'held', holder: '燕衡', keywords: ['会票', '票据'],
      }],
      geo: [{
        id: 'G001', chapter: 2, name: '临清', aliases: ['临清州'],
        anchor: '临清在通州以南，运河上一半的银子打这里过。',
        ref: '通州', direction: '南', keywords: ['临清'],
      }],
    }));
    let r = runPy(['init', '--input', path.join(TMP, 'ttpy', '甲', 'init.json')], book1);
    let state = r.status === 0
      ? JSON.parse(fs.readFileSync(path.join(book1, '追踪', '_tracking-state.json'), 'utf8')) : null;
    const evView = r.status === 0
      ? fs.readFileSync(path.join(book1, '追踪', '物证台账.md'), 'utf8') : '';
    const geoView = r.status === 0
      ? fs.readFileSync(path.join(book1, '追踪', '地理台账.md'), 'utf8') : '';
    check('init 登记 evidence/geo：state v6 + 双台账视图', r.status === 0 && state
      && state.schema_version === 6 && state.evidence.W001 && state.geo.G001
      && state.geo.G001.direction === '南' && state.evidence.W001.updated_chapter === 2
      && evView.includes('W001') && evView.includes('在案')
      && geoView.includes('G001') && geoView.includes('通州以南'),
      `status=${r.status} err=${r.stderr.trim().slice(0, 160)}`);
    r = runPy(['check'], book1);
    check('init 后 check 一致（v6）', r.status === 0, `status=${r.status} err=${r.stderr.trim().slice(0, 160)}`);

    // v5 存量（无 evidence/geo 键）→ backfill 自动升级 v6；未来章 evidence 先拒绝。
    const book2 = path.join(TMP, 'ttpy', '乙');
    const baseContext = {
      position: { volume: '卷一', volume_start_chapter: 1, story_time: '景和三年春', scene: '运河' },
      long_term_constraints: [], active_character_names: ['燕衡'], continuity_risks: [],
      recent_chapters: [{ chapter: 1, summary: '验银' }], next_chapter_commitments: [],
    };
    const baseSnapshot = {
      燕衡: { identity: '主角', location: '县衙', goal: '查银案', state: '冷静',
        abilities_resources: [], relationships: [], knowledge: [], open_threads: [] },
    };
    fixture('ttpy/乙/追踪/_tracking-state.json', JSON.stringify({
      schema_version: 5, book_title: '白银案录', last_committed_chapter: 1,
      imported_through_chapter: 1, state_revision: 1,
      context: baseContext, characters: baseSnapshot, foreshadow: {}, timeline: {},
      verdicts: {},
    }));
    fixture('ttpy/乙/backfill.json', JSON.stringify({
      schema_version: 1,
      evidence: [{
        id: 'W001', chapter: 2, name: '会票',
        anchor: '小厮把票捧到案前：会票就是商号开的借据式票据。',
        status: 'held', holder: '燕衡', keywords: ['会票'],
      }],
      geo: [{
        id: 'G001', chapter: 2, name: '临清',
        anchor: '临清在通州以南，运河上一半的银子打这里过。',
        ref: '通州', direction: '南', keywords: ['临清'],
      }],
    }));
    r = runPy(['backfill', '--input', path.join(TMP, 'ttpy', '乙', 'backfill.json')], book2);
    check('backfill 未来章 evidence 拒绝（chapter > last_committed）', r.status === 2,
      `status=${r.status} err=${r.stderr.trim().slice(0, 120)}`);

    fixture('ttpy/乙/追踪/_tracking-state.json', JSON.stringify({
      schema_version: 5, book_title: '白银案录', last_committed_chapter: 2,
      imported_through_chapter: 2, state_revision: 1,
      context: baseContext, characters: baseSnapshot, foreshadow: {}, timeline: {},
      verdicts: {},
    }));
    r = runPy(['backfill', '--input', path.join(TMP, 'ttpy', '乙', 'backfill.json')], book2);
    state = r.status === 0
      ? JSON.parse(fs.readFileSync(path.join(book2, '追踪', '_tracking-state.json'), 'utf8')) : null;
    check('backfill v5 存量自动升级 v6 并登记 evidence/geo', r.status === 0 && state
      && state.schema_version === 6 && state.evidence.W001 && state.geo.G001
      && state.state_revision === 2,
      `status=${r.status} err=${r.stderr.trim().slice(0, 160)}`);
    r = runPy(['check'], book2);
    check('backfill 后 check 一致（v6）', r.status === 0, `status=${r.status} err=${r.stderr.trim().slice(0, 160)}`);

    // commit evidence_changes/geo_changes：状态流转 + 新登记，逐章记录渲染双变化段。
    fixture('ttpy/乙/commit.json', JSON.stringify({
      schema_version: 1, mode: 'append', chapter: 3, chapter_title: '验票',
      expected_state_revision: 2,
      delta: {
        result: '燕衡验出会票是仿票，决意追查票源。',
        character_changes: [{ name: '燕衡', change: '从收票转向查票源' }],
        evidence_changes: [
          {
            id: 'W001', chapter: 2, name: '会票',
            anchor: '小厮把票捧到案前：会票就是商号开的借据式票据。',
            status: 'transferred', holder: '县衙库房', keywords: ['会票'],
          },
          {
            id: 'W002', chapter: 3, name: '名录',
            anchor: '他把名录摊开，一行一行对着灯看。',
            status: 'held', holder: '燕衡', keywords: ['名录'],
          },
        ],
        geo_changes: [{
          id: 'G002', chapter: 3, name: '济宁', aliases: ['济宁州'],
          anchor: '船入济宁州，码头上的粮垛堆得像山。',
          ref: '临清', direction: '南', keywords: ['济宁'],
        }],
      },
      context: {
        position: { volume: '卷一', volume_start_chapter: 1, story_time: '景和三年夏', scene: '济宁码头' },
        long_term_constraints: [], active_character_names: ['燕衡'], continuity_risks: [],
      },
      character_snapshots: {
        燕衡: { identity: '主角', location: '济宁码头', goal: '查票源', state: '冷静带狠劲',
          abilities_resources: [], relationships: [], knowledge: [], open_threads: [] },
      },
    }));
    r = runPy(['commit', '--input', path.join(TMP, 'ttpy', '乙', 'commit.json')], book2);
    state = r.status === 0
      ? JSON.parse(fs.readFileSync(path.join(book2, '追踪', '_tracking-state.json'), 'utf8')) : null;
    const delta = r.status === 0
      ? fs.readFileSync(path.join(book2, '追踪', '逐章记录', '第003章.md'), 'utf8') : '';
    check('commit evidence_changes/geo_changes：流转+新登记，逐章记录含双变化段', r.status === 0 && state
      && state.evidence.W001.status === 'transferred' && state.evidence.W002
      && state.geo.G002 && state.geo.G002.ref === '临清'
      && delta.includes('## 物证变化') && delta.includes('W001｜transferred')
      && delta.includes('## 地理变化') && delta.includes('G002｜济宁｜济宁在临清以南'),
      `status=${r.status} err=${r.stderr.trim().slice(0, 160)}`);
    r = runPy(['check'], book2);
    check('commit 后 check 一致（v6）', r.status === 0, `status=${r.status} err=${r.stderr.trim().slice(0, 160)}`);
  }
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

  // 书C（G5 同步性）：state 已提交至第 2 章；第 1 章正文早于 state（正常），第 2 章被外部改过
  //（mtime 晚于 state = 账本脱节），第 3 章已落盘未提交（落盘与提交之间中断）。
  const bookC = path.join(TMP, 'hook', '书C');
  fixture('hook/书C/正文/第001章_旧.md', `# 第001章 旧${'\n'}${longChapter(75)}`);
  fixture('hook/书C/正文/第002章_改.md', `# 第002章 改${'\n'}${longChapter(75)}`);
  fixture('hook/书C/正文/第003章_新.md', `# 第003章 新${'\n'}${longChapter(75)}`);
  fixture('hook/书C/追踪/_tracking-state.json', JSON.stringify({ schema_version: 1, last_committed_chapter: 2, state_revision: 2 }));
  const future = new Date(Date.now() + 10000);
  fs.utimesSync(path.join(bookC, '正文', '第002章_改.md'), future, future);

  r = runHook(['session'], '', bookC);
  check('session 追踪脱节提醒（已提交章晚于 state）', r.status === 0
    && r.stdout.includes('追踪脱节') && r.stdout.includes('第 2 章') && r.stdout.includes('重提交'),
    `status=${r.status} out=${r.stdout.slice(0, 200)}`);
  check('session 落盘未提交提醒', r.status === 0
    && r.stdout.includes('第 3 章') && r.stdout.includes('未提交'),
    `out=${r.stdout.slice(0, 200)}`);

  r = runHook(['post-write'], payload(path.join(bookC, '正文', '第002章_改.md')));
  check('post-write 已提交章改动提醒重提交', r.status === 0
    && r.stdout.includes('已提交章') && r.stdout.includes('重提交'),
    `status=${r.status} out=${r.stdout.slice(0, 160)}`);

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
    'long/大纲/README.md',
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
