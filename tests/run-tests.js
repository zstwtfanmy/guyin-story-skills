#!/usr/bin/env node
'use strict';

// tests/run-tests.js — 运行时脚本回归测试（零依赖，node 直跑，Windows 友好）
//
// 适配自上游 test-ai-patterns.sh 的 fixture+断言思路，覆盖隐笔全部运行时检查脚本与 guyin-setup 模板 hook 核的回归：
//   wordcount／degeneration／ai-patterns／outline-copy／normalize-punctuation／repetition（指纹/意象/复读雷达）／
//   outline-slots（槽位/时序/气卡坐标）／outline-deliver（承诺交付）等做行为断言，
//   tracking-commit.py 做语法 smoke + P2/S1 行为断言（无 python 环境则 SKIP），guyin-hook.js 做 guard/兑底/注入三面断言，
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
  const normal = fixture('wc/第002章_正常.md', `# 第002章 正常\n${longChapter(95)}`);
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
console.log('== guyin-check-beat（P1 beat 级确定性预检，自检卡下沉） ==');
{
  // 工程词检测：beat 正文含「细纲」「伏笔」等 → blocking
  const metaLeak = fixture('beat/第001章_漏.md',
    '他翻开细纲，想起上一章的伏笔，觉得这事不简单。\n');
  let r = run('guyin-check-beat.js', ['--json', '--min=10', metaLeak]);
  let report = parseJson(r.stdout);
  check('beat 工程词泄漏报 meta-leak-beat', r.status === 1 && report
    && report.findings.some((f) => f.type === 'meta-leak-beat'),
    `status=${r.status} types=${JSON.stringify(report && report.findings.map((f) => f.type))}`);

  // 禁止项检测：--ban 列表词出现 → blocking
  const banned = fixture('beat/第002章_禁.md',
    '他把凑数字的东西收起来，随便看了看就走了。\n');
  r = run('guyin-check-beat.js', ['--json', '--min=10', '--ban=凑数,随便', banned]);
  report = parseJson(r.stdout);
  check('beat 禁止项报 ban-violation', r.status === 1 && report
    && report.findings.some((f) => f.type === 'ban-violation'),
    `status=${r.status} types=${JSON.stringify(report && report.findings.map((f) => f.type))}`);

  // 字数不足 → blocking
  const tiny = fixture('beat/第003章_短.md', '他走了。\n');
  r = run('guyin-check-beat.js', ['--json', '--min=500', tiny]);
  report = parseJson(r.stdout);
  check('beat 字数不足报 beat-too-short', r.status === 1 && report
    && report.findings.some((f) => f.type === 'beat-too-short' && f.severity === 'blocking'),
    `status=${r.status} types=${JSON.stringify(report && report.findings.map((f) => f.type))}`);

  // 跳写检测：含「此处省略」→ blocking
  const skip = fixture('beat/第004章_跳.md',
    '他走进屋子。（此处省略三百字）然后天亮了。\n');
  r = run('guyin-check-beat.js', ['--json', '--min=10', skip]);
  report = parseJson(r.stdout);
  check('beat 跳写报 skip-write', r.status === 1 && report
    && report.findings.some((f) => f.type === 'skip-write' && f.severity === 'blocking'),
    `status=${r.status} types=${JSON.stringify(report && report.findings.map((f) => f.type))}`);

  // 连续对话：4+ 句对话无动作 → advisory
  const dialogue = fixture('beat/第005章_话.md',
    '「你来干什么？」\n「找你算账。」\n「凭什么？」\n「就凭这个。」\n「你疯了。」\n');
  r = run('guyin-check-beat.js', ['--json', '--min=10', dialogue]);
  report = parseJson(r.stdout);
  check('beat 连续对话报 dialogue-run（advisory）', r.status === 1 && report
    && report.findings.some((f) => f.type === 'dialogue-run' && f.severity === 'advisory'),
    `status=${r.status} types=${JSON.stringify(report && report.findings.map((f) => f.type))}`);

  // 心理独白超限 → advisory
  const mono = fixture('beat/第006章_独.md',
    '他心想这事不对。他觉得背后有人。他暗想这一定是圈套。他琢磨着怎么脱身。\n');
  r = run('guyin-check-beat.js', ['--json', '--min=10', '--mono-limit=2', mono]);
  report = parseJson(r.stdout);
  check('beat 心理独白超限报 mono-count（advisory）', r.status === 1 && report
    && report.findings.some((f) => f.type === 'mono-count' && f.severity === 'advisory'),
    `status=${r.status} types=${JSON.stringify(report && report.findings.map((f) => f.type))}`);

  // 干净 beat 静默
  const clean = fixture('beat/第007章_净.md',
    '他把竹竿靠在墙根，拍了拍手上的灰。\n母亲从灶房探出头：「饭好了。」\n他应了一声，进屋洗手。\n');
  r = run('guyin-check-beat.js', ['--json', '--min=10', clean]);
  report = parseJson(r.stdout);
  check('beat 干净正文静默', r.status === 0 && report && report.findings.length === 0,
    `status=${r.status} findings=${JSON.stringify(report && report.findings.map((f) => f.type))}`);

  // --fail-on=blocking：advisory 不触发
  r = run('guyin-check-beat.js', ['--fail-on=blocking', '--min=10', dialogue]);
  check('beat advisory 不触发 --fail-on=blocking', r.status === 0, `status=${r.status}`);

  // summary 验证：脚本处理 Q1-Q6，模型只剩 Q7/Q8
  r = run('guyin-check-beat.js', ['--json', '--min=10', clean]);
  report = parseJson(r.stdout);
  check('beat summary 含 modelRemaining=[Q7,Q8]', report
    && JSON.stringify(report.summary.modelRemaining) === JSON.stringify(['Q7', 'Q8']),
    `summary=${JSON.stringify(report && report.summary)}`);
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

    // init 带 verdicts：state v7（写盘统一归一，G2 后 T1/T2/P4 已升版）+ 事件定性资产.md 视图。
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
    check('init 登记 verdicts：state v7 + 资产视图', r.status === 0 && state
      && state.schema_version === 7 && state.verdicts.V001
      && view.includes('V001') && view.includes('拆神'),
      `status=${r.status} err=${r.stderr.trim().slice(0, 160)}`);
    r = runPy(['check'], book1);
    check('init 后 check 一致', r.status === 0, `status=${r.status} err=${r.stderr.trim().slice(0, 160)}`);

    // v4 存量（无 verdicts 键）→ backfill → v7：无需手工迁移。
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
    check('backfill v4 存量自动升级 v7 并登记 verdicts', r.status === 0 && state
      && state.schema_version === 7 && state.verdicts.V027
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
    skip('init 登记 evidence/geo：state v7 + 双台账视图', '未找到可用 python 解释器');
    skip('init 后 check 一致（v7）', '未找到可用 python 解释器');
    skip('backfill 未来章 evidence 拒绝', '未找到可用 python 解释器');
    skip('backfill v5 存量自动升级 v7 并登记 evidence/geo', '未找到可用 python 解释器');
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
    check('init 登记 evidence/geo：state v7 + 双台账视图', r.status === 0 && state
      && state.schema_version === 7 && state.evidence.W001 && state.geo.G001
      && state.geo.G001.direction === '南' && state.evidence.W001.updated_chapter === 2
      && evView.includes('W001') && evView.includes('在案')
      && geoView.includes('G001') && geoView.includes('通州以南'),
      `status=${r.status} err=${r.stderr.trim().slice(0, 160)}`);
    r = runPy(['check'], book1);
    check('init 后 check 一致（v7）', r.status === 0, `status=${r.status} err=${r.stderr.trim().slice(0, 160)}`);

    // v5 存量（无 evidence/geo 键）→ backfill 自动升级 v7；未来章 evidence 先拒绝。
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
    check('backfill v5 存量自动升级 v7 并登记 evidence/geo', r.status === 0 && state
      && state.schema_version === 7 && state.evidence.W001 && state.geo.G001
      && state.state_revision === 2,
      `status=${r.status} err=${r.stderr.trim().slice(0, 160)}`);
    r = runPy(['check'], book2);
    check('backfill 后 check 一致（v7）', r.status === 0, `status=${r.status} err=${r.stderr.trim().slice(0, 160)}`);

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
    check('commit 后 check 一致（v7）', r.status === 0, `status=${r.status} err=${r.stderr.trim().slice(0, 160)}`);
  }
}

// ============================================================
console.log('== guyin-tracking-commit.py P4 场景台账（scenes，行为断言） ==');
{
  const py = ['python3', 'python', 'py'].find((bin) => {
    try {
      return spawnSync(bin, ['-c', ''], { encoding: 'utf8' }).status === 0;
    } catch (e) {
      return false;
    }
  });
  if (!py) {
    skip('init 登记 scenes：state v7 + 场景台账视图', '未找到可用 python 解释器');
    skip('commit scene_changes：变迁链 + 逐章记录场景变化段', '未找到可用 python 解释器');
  } else {
    const SCRIPT = path.join(S, 'guyin-tracking-commit.py');
    const runPy = (args, project) => spawnSync(py, [SCRIPT, ...args, '--project', project], { encoding: 'utf8' });

    // init 带 scenes：state v7 + 场景台账视图（锚点原句 + 状态链）。
    const book = path.join(TMP, 'p4py', '甲');
    fixture('p4py/甲/init.json', JSON.stringify({
      schema_version: 1, book_title: '白银案录', last_chapter: 1,
      context: {
        position: { volume: '卷一', volume_start_chapter: 1, story_time: '景和三年春', scene: '西厢院' },
        long_term_constraints: [], active_character_names: ['燕衡'], continuity_risks: [],
        recent_chapters: [{ chapter: 1, summary: '验银' }], next_chapter_commitments: [],
      },
      character_snapshots: {
        燕衡: { identity: '主角', location: '西厢院', goal: '查银案', state: '冷静',
          abilities_resources: [], relationships: [], knowledge: [], open_threads: [] },
      },
      foreshadow: [], timeline_events: [],
      scenes: [{
        id: 'S001', chapter: 1, name: '西厢院',
        anchor: '院里有棵歪脖枣树，树底下压着半扇磨盘。',
        status: 'active', current: '', keywords: ['歪脖枣树', '磨盘'],
      }],
    }));
    let r = runPy(['init', '--input', path.join(TMP, 'p4py', '甲', 'init.json')], book);
    let state = r.status === 0
      ? JSON.parse(fs.readFileSync(path.join(book, '追踪', '_tracking-state.json'), 'utf8')) : null;
    const sceneView = r.status === 0
      ? fs.readFileSync(path.join(book, '追踪', '场景台账.md'), 'utf8') : '';
    check('init 登记 scenes：state v7 + 场景台账视图', r.status === 0 && state
      && state.schema_version === 7 && state.scenes.S001
      && state.scenes.S001.updated_chapter === 1
      && sceneView.includes('S001') && sceneView.includes('歪脖枣树') && sceneView.includes('在场'),
      `status=${r.status} err=${r.stderr.trim().slice(0, 160)}`);
    r = runPy(['check'], book);
    check('P4 init 后 check 一致', r.status === 0, `status=${r.status} err=${r.stderr.trim().slice(0, 160)}`);

    // commit scene_changes：S001 状态变迁（active→changed），逐章记录渲染场景变化段。
    // init 写盘 state_revision=0，首次 commit 期望 0（乐观锁），成功后 +1。
    fixture('p4py/甲/commit.json', JSON.stringify({
      schema_version: 1, mode: 'append', chapter: 2, chapter_title: '西厢走水',
      expected_state_revision: 0,
      delta: {
        result: '西厢走水，燕衡从火场里抢出半扇磨盘。',
        character_changes: [{ name: '燕衡', change: '从验银转向查火源' }],
        scene_changes: [{
          id: 'S001', chapter: 1, name: '西厢院',
          anchor: '院里有棵歪脖枣树，树底下压着半扇磨盘。',
          status: 'changed',
          current: '那场火之后，西厢塌了，只剩半堵焦墙，枣树还立在原地。',
          keywords: ['歪脖枣树', '磨盘'],
        }],
      },
      context: {
        position: { volume: '卷一', volume_start_chapter: 1, story_time: '景和三年夏', scene: '西厢院火场' },
        long_term_constraints: [], active_character_names: ['燕衡'], continuity_risks: [],
      },
      character_snapshots: {
        燕衡: { identity: '主角', location: '西厢院火场', goal: '查火源', state: '冷静带狠劲',
          abilities_resources: [], relationships: [], knowledge: [], open_threads: [] },
      },
    }));
    r = runPy(['commit', '--input', path.join(TMP, 'p4py', '甲', 'commit.json')], book);
    state = r.status === 0
      ? JSON.parse(fs.readFileSync(path.join(book, '追踪', '_tracking-state.json'), 'utf8')) : null;
    const delta = r.status === 0
      ? fs.readFileSync(path.join(book, '追踪', '逐章记录', '第002章.md'), 'utf8') : '';
    const sceneView2 = r.status === 0
      ? fs.readFileSync(path.join(book, '追踪', '场景台账.md'), 'utf8') : '';
    check('commit scene_changes：变迁链 + 逐章记录场景变化段', r.status === 0 && state
      && state.scenes.S001.status === 'changed'
      && state.scenes.S001.updated_chapter === 2
      && state.scenes.S001.anchor.includes('歪脖枣树')
      && state.scenes.S001.current.includes('焦墙')
      && delta.includes('## 场景变化') && delta.includes('S001｜西厢院｜changed')
      && sceneView2.includes('已变迁') && sceneView2.includes('焦墙'),
      `status=${r.status} err=${r.stderr.trim().slice(0, 160)}`);
    r = runPy(['check'], book);
    check('P4 commit 后 check 一致', r.status === 0, `status=${r.status} err=${r.stderr.trim().slice(0, 160)}`);
  }
}

// ============================================================
console.log('== guyin-tracking-commit.py P2 执行偏差回填提醒（stderr） ==');
{
  // commit 章号对应的细纲缺「执行偏差」区 → stderr 提醒（不阻断）；含该区 → 静默。
  // stdout 是提交产物单行 JSON 通道，提醒只走 stderr（v1.1 口径）。
  const py = ['python3', 'python', 'py'].find((bin) => {
    try {
      return spawnSync(bin, ['-c', ''], { encoding: 'utf8' }).status === 0;
    } catch (e) {
      return false;
    }
  });
  if (!py) {
    skip('P2 细纲缺执行偏差区 → stderr 提醒且不阻断', '未找到可用 python 解释器');
    skip('P2 细纲含执行偏差区 → stderr 静默', '未找到可用 python 解释器');
  } else {
    const SCRIPT = path.join(S, 'guyin-tracking-commit.py');
    const runPy = (args, project) => spawnSync(py, [SCRIPT, ...args, '--project', project], { encoding: 'utf8' });
    const initPayload = {
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
    };
    const commitPayload = {
      schema_version: 1, mode: 'append', chapter: 2, chapter_title: '验票',
      expected_state_revision: 0, // init 起始修订为 0，首次 commit 期待 0
      delta: {
        result: '燕衡验出会票是仿票，决意追查票源。',
        character_changes: [{ name: '燕衡', change: '从收票转向查票源' }],
      },
      context: {
        position: { volume: '卷一', volume_start_chapter: 1, story_time: '景和三年春', scene: '县衙' },
        long_term_constraints: [], active_character_names: ['燕衡'], continuity_risks: [],
      },
      character_snapshots: {
        燕衡: { identity: '主角', location: '县衙', goal: '查票源', state: '冷静',
          abilities_resources: [], relationships: [], knowledge: [], open_threads: [] },
      },
    };

    // 甲：细纲无执行偏差区 → commit 成功（status 0 不阻断）+ stderr 提醒。
    const book1 = path.join(TMP, 'p2py', '甲');
    fixture('p2py/甲/init.json', JSON.stringify(initPayload));
    fixture('p2py/甲/大纲/细纲_第002章_试.md', '- 字数目标：3000\n- 章尾钩子：期待·预告式——明日开审\n');
    fixture('p2py/甲/commit.json', JSON.stringify(commitPayload));
    let r = runPy(['init', '--input', path.join(TMP, 'p2py', '甲', 'init.json')], book1);
    check('P2 前置：init 成功', r.status === 0, `status=${r.status} err=${r.stderr.trim().slice(0, 160)}`);
    r = runPy(['commit', '--input', path.join(TMP, 'p2py', '甲', 'commit.json')], book1);
    check('P2 细纲缺执行偏差区 → stderr 提醒且不阻断', r.status === 0 && r.stderr.includes('执行偏差'),
      `status=${r.status} err=${r.stderr.trim().slice(0, 200)}`);

    // 乙：细纲含执行偏差区 → stderr 静默。
    const book2 = path.join(TMP, 'p2py', '乙');
    fixture('p2py/乙/init.json', JSON.stringify(initPayload));
    fixture('p2py/乙/大纲/细纲_第002章_试.md', '- 字数目标：3000\n#### 执行偏差（检测驱动回填）\n- 变体：无\n- 未落实：无\n');
    fixture('p2py/乙/commit.json', JSON.stringify(commitPayload));
    r = runPy(['init', '--input', path.join(TMP, 'p2py', '乙', 'init.json')], book2);
    check('P2 前置：乙 init 成功', r.status === 0, `status=${r.status} err=${r.stderr.trim().slice(0, 160)}`);
    r = runPy(['commit', '--input', path.join(TMP, 'p2py', '乙', 'commit.json')], book2);
    check('P2 细纲含执行偏差区 → stderr 静默', r.status === 0 && !r.stderr.includes('执行偏差'),
      `status=${r.status} err=${r.stderr.trim().slice(0, 200)}`);

    // 丙（R1，docs/08）：未落实值非「无」但不含顺延章号 → stderr 提醒（承诺无声消失防线）。
    const book3 = path.join(TMP, 'p2py', '丙');
    fixture('p2py/丙/init.json', JSON.stringify(initPayload));
    fixture('p2py/丙/大纲/细纲_第002章_试.md', '- 字数目标：3000\n#### 执行偏差（检测驱动回填）\n- 变体：无\n- 未落实：火耗锚定戏没写\n');
    fixture('p2py/丙/commit.json', JSON.stringify(commitPayload));
    r = runPy(['init', '--input', path.join(TMP, 'p2py', '丙', 'init.json')], book3);
    check('R1 前置：丙 init 成功', r.status === 0, `status=${r.status} err=${r.stderr.trim().slice(0, 160)}`);
    r = runPy(['commit', '--input', path.join(TMP, 'p2py', '丙', 'commit.json')], book3);
    check('R1 未落实缺顺延章号 → stderr 提醒且不阻断', r.status === 0 && r.stderr.includes('顺延章号'),
      `status=${r.status} err=${r.stderr.trim().slice(0, 200)}`);
  }
}

// ============================================================
console.log('== guyin-tracking-commit.py S1 时滞预检（check 子命令） ==');
{
  // 正文已落盘最大章号 > last_committed_chapter → check 退 2 报欠账（docs/07 §二 S1：
  // 61-63 事故直接防线——写 61-63 时状态停在 8/26；既供 J3 批收尾「时滞＝0」判据，
  // 也供编排层预检。正文目录缺失静默由既有「P4 commit 后 check 一致」断言覆盖）。
  const py = ['python3', 'python', 'py'].find((bin) => {
    try {
      return spawnSync(bin, ['-c', ''], { encoding: 'utf8' }).status === 0;
    } catch (e) {
      return false;
    }
  });
  if (!py) {
    skip('S1 正文已落盘未提交 → check 退 2 报时滞', '未找到可用 python 解释器');
  } else {
    const SCRIPT = path.join(S, 'guyin-tracking-commit.py');
    const runPy = (args, project) => spawnSync(py, [SCRIPT, ...args, '--project', project], { encoding: 'utf8' });
    const book = path.join(TMP, 's1py');
    const initPayload = {
      schema_version: 1, book_title: '验时滞', last_chapter: 1,
      context: {
        position: { volume: '卷一', volume_start_chapter: 1, story_time: '景和三年春', scene: '县衙' },
        long_term_constraints: [], active_character_names: ['燕衡'], continuity_risks: [],
        recent_chapters: [{ chapter: 1, summary: '验银' }], next_chapter_commitments: [],
      },
      character_snapshots: {
        燕衡: { identity: '主角', location: '县衙', goal: '查银案', state: '冷静',
          abilities_resources: [], relationships: [], knowledge: [], open_threads: [] },
      },
    };
    fixture('s1py/init.json', JSON.stringify(initPayload));
    fixture('s1py/大纲/细纲_第003章_试.md', '- 字数目标：3000\n');
    let r = runPy(['init', '--input', path.join(TMP, 's1py', 'init.json')], book);
    check('S1 前置：init 成功（last_committed=1）', r.status === 0, `status=${r.status} err=${r.stderr.trim().slice(0, 160)}`);
    fixture('s1py/正文/第003章_试.md', '第三章正文占位。\n');
    r = runPy(['check'], book);
    check('S1 正文第3章落盘未提交 → check 退 2 报时滞', r.status === 2
      && r.stderr.includes('已落盘未提交') && r.stderr.includes('追踪记至第 1 章'),
      `status=${r.status} err=${r.stderr.trim().slice(0, 200)}`);
  }
}

// ============================================================
console.log('== guyin-check-hook-rotation (P4 钩子轮换/蓄力成对) ==');
{
  const mkOutline = (name, hookLine, mark) =>
    fixture(`hr/大纲/${name}`,
      `# 细纲\n\n- 章尾钩子：${hookLine}\n${mark ? `- 节奏标记：${mark}\n` : ''}`);
  // ch1-3 连续悬念钩 → hook-run；ch4 无标注断开计数；ch5 爆发前无蓄力 → burst-without-charge；ch7 蓄力 + ch8 爆发成对 → 静默
  mkOutline('细纲_第001章.md', '悬念·封口式——他把账册塞进怀里', null);
  mkOutline('细纲_第002章.md', '悬念·断章式——门外来人', null);
  mkOutline('细纲_第003章.md', '悬念·留白式——灯灭了', null);
  mkOutline('细纲_第004章.md', 'S级·决意式——那就让他以为，我还在信', null);
  mkOutline('细纲_第005章.md', '危机·绝境式——银子对不上', '爆发');
  mkOutline('细纲_第007章.md', '反转·打脸式——来人是自己人', '蓄力');
  mkOutline('细纲_第008章.md', '情绪·决意式——他要还回去', '爆发');
  const dir = path.join(TMP, 'hr', '大纲');
  let r = run('guyin-check-hook-rotation.js', ['--json', dir]);
  let report = parseJson(r.stdout);
  check('钩子坍缩：连续 3 章悬念钩报 hook-run', r.status === 1 && report
    && report.findings.some((f) => f.type === 'hook-run' && f.message.includes('悬念')),
    `status=${r.status} out=${r.stdout.trim().slice(0, 200)}`);
  check('爆发无蓄力报 burst-without-charge（第5章）', report
    && report.findings.some((f) => f.type === 'burst-without-charge' && f.message.includes('第5章')),
    `findings=${JSON.stringify(report && report.findings.map((f) => f.type))}`);
  check('蓄力+爆发成对静默（第8章不报）', report
    && !report.findings.some((f) => f.type === 'burst-without-charge' && f.message.includes('第8章')),
    `findings=${JSON.stringify(report && report.findings.map((f) => f.type))}`);
  check('summary 统计已标注/未标注章', report && report.summary
    && report.summary.chapters_scanned === 7 && report.summary.annotated === 6
    && report.summary.unannotated === 1 && report.summary.burst_marked === 2
    && report.summary.charge_marked === 1,
    `summary=${JSON.stringify(report && report.summary)}`);

  // 类型轮换正常（危机→反转→期待）→ 全静默。
  const dir2 = path.join(TMP, 'hr2', '大纲');
  fixture('hr2/大纲/细纲_第001章.md', '- 章尾钩子：危机·绝境式——银子对不上\n');
  fixture('hr2/大纲/细纲_第002章.md', '- 章尾钩子：反转·打脸式——来人是自己人\n');
  fixture('hr2/大纲/细纲_第003章.md', '- 章尾钩子：期待·预告式——明日开审\n');
  r = run('guyin-check-hook-rotation.js', ['--json', dir2]);
  report = parseJson(r.stdout);
  check('类型轮换正常零报警', r.status === 0 && report && report.findings.length === 0,
    `status=${r.status} out=${r.stdout.trim().slice(0, 200)}`);
}

// ============================================================
console.log('== guyin-check-repetition (P6 段落指纹库) ==');
{
  // 台词段不入库（只比叙述段）；雨段/雪段换词复读；照抄段近乎相同。
  const rain = '雨下了一夜，青石板路上积着浅浅的水洼，倒映出两侧歪斜的屋檐。他撑着一把旧油纸伞，沿着巷子慢慢往里走，鞋底踩过水洼，溅起的泥点打在裤脚上，他也不在意。';
  const snow = '雪下了一夜，青石板路上积着浅浅的雪洼，倒映出两侧歪斜的屋檐。他撑着一把旧油纸伞，沿着巷子慢慢往里走，鞋底踩过雪洼，溅起的雪点打在裤脚上，他也不在意。';
  const fresh = '天色将暮，远处的山峦像一头伏卧的巨兽，脊背在暮色里起伏，轮廓被最后一线天光描出金边。';
  const nearCopy = '雨下了一整夜，青石板路上积着浅浅的水洼，倒映出两侧歪斜的屋檐。他撑着一把旧油纸伞，沿着巷子慢慢往里走，鞋底踩过水洼，溅起的泥点打在裤脚上，他也不在意。';
  const proj = path.join(TMP, 'rep');
  const ch1 = fixture('rep/正文/第001章.md', `第一章\n\n${rain}\n\n「客官里边请，慢走带伞。」店小二躬身掀开帘子，又补了一句客套话，转身去了后厨。\n`);
  fixture('rep/正文/第002章.md', `第二章\n\n${snow}\n\n${fresh}\n`);
  fixture('rep/正文/第003章.md', `第三章\n\n${nearCopy}\n`);

  // 首章 --commit：库建立，叙述段 1 条（台词段不入库）。
  let r = run('guyin-check-repetition.js', ['--json', '--project', proj, '--commit', ch1]);
  let report = parseJson(r.stdout);
  const libPath = path.join(proj, '追踪', '段落指纹库.json');
  let lib = fs.existsSync(libPath) ? JSON.parse(fs.readFileSync(libPath, 'utf8')) : null;
  check('首章 commit：库建立且台词段不入库', r.status === 0 && report && report.summary.committed === 1
    && lib && lib.entries.length === 1 && lib.entries[0].chapter === 1,
    `status=${r.status} out=${r.stdout.trim().slice(0, 200)}`);

  // 第002章：雪段（换词复读）报 pattern，全新段静默。
  r = run('guyin-check-repetition.js', ['--json', '--project', proj, path.join(proj, '正文', '第002章.md')]);
  report = parseJson(r.stdout);
  const pattern = report && report.findings.find((f) => f.type === 'para-repeat-pattern');
  check('换词复读报 para-repeat-pattern（雪段 vs 雨段）', r.status === 1 && pattern
    && pattern.match.chapter === 1 && pattern.match.similarity >= 0.72 && pattern.match.similarity < 0.9,
    `status=${r.status} findings=${JSON.stringify(report && report.findings.map((f) => f.type))}`);
  check('全新段落零误报（山峦段不报）', report
    && !report.findings.some((f) => f.excerpt.startsWith('天色将暮')),
    `findings=${JSON.stringify(report && report.findings.map((f) => f.excerpt.slice(0, 8)))}`);

  // 第003章：近乎照抄报 near，带改写卡处置提示。
  r = run('guyin-check-repetition.js', ['--json', '--project', proj, path.join(proj, '正文', '第003章.md')]);
  report = parseJson(r.stdout);
  const near = report && report.findings.find((f) => f.type === 'para-repeat-near');
  check('近乎照抄报 para-repeat-near（改写卡路径）', r.status === 1 && near
    && near.match.similarity >= 0.9 && near.message.includes('改写卡'),
    `status=${r.status} findings=${JSON.stringify(report && report.findings.map((f) => f.type))}`);

  // 幂等：重 commit 第001章，同章先清后插，库仍 1 条。
  r = run('guyin-check-repetition.js', ['--json', '--project', proj, '--commit', ch1]);
  lib = fs.existsSync(libPath) ? JSON.parse(fs.readFileSync(libPath, 'utf8')) : null;
  check('重 commit 幂等（同章先清后插）', r.status === 0 && lib && lib.entries.length === 1,
    `status=${r.status} entries=${lib && lib.entries.length}`);
}

// ============================================================
console.log('== guyin-check-repetition P6-2 意象台账 ==');
{
  // 三章各含一句自然域比喻（喻体侧：海潮/雷霜）；同批 commit 验证 batchImagery 窗口统计。
  const proj = path.join(TMP, 'imgp');
  fixture('imgp/追踪/_tracking-state.json', JSON.stringify({
    schema_version: 7, characters: { 燕衡: { identity: '主角' }, 周砚: { identity: '账房' } },
  }));
  fixture('imgp/正文/第001章.md', `第一章\n\n云像海潮一样涌过来，一层压着一层，把半边天都盖住了。燕衡站在城头看了很久，直到暮色把最后一道光收走，他才转身下楼。\n`);
  fixture('imgp/正文/第002章.md', `第二章\n\n闷响从远处传来，像滚过山谷的雷，一声接一声压得人心里发慌。燕衡按住剑柄没动，盯着城下那条黑黢黢的路看了半晌。\n`);
  const ch3 = fixture('imgp/正文/第003章.md', `第三章\n\n月光如霜，铺了满院，青砖地上泛着一层冷白。燕衡推门进去，看见周砚伏在案上睡着了，笔还捏在手里。\n`);

  // 同批 commit 三章：第3章窗口（1-3 章）自然域 3 次 → imagery-domain-run（本批已处理章计入窗口）。
  let r = run('guyin-check-repetition.js', ['--json', '--project', proj, '--commit',
    path.join(proj, '正文', '第001章.md'), path.join(proj, '正文', '第002章.md'), ch3]);
  let report = parseJson(r.stdout);
  check('同域比喻密度报 imagery-domain-run（第3章窗口自然×3）', r.status === 1 && report
    && report.findings.some((f) => f.type === 'imagery-domain-run' && f.message.includes('自然')),
    `status=${r.status} findings=${JSON.stringify(report && report.findings.map((f) => f.type))}`);
  const lib = JSON.parse(fs.readFileSync(path.join(proj, '追踪', '段落指纹库.json'), 'utf8'));
  check('比喻句入库且角色就近归属（周砚）', Array.isArray(lib.imagery) && lib.imagery.length >= 3
    && lib.imagery.some((m) => m.domain === '自然' && m.character === '周砚' && m.chapter === 3),
    `imagery=${JSON.stringify(lib.imagery)}`);
  const view = fs.readFileSync(path.join(proj, '追踪', '意象台账.md'), 'utf8');
  check('意象台账视图含域统计与明细', view.includes('自然') && view.includes('周砚') && view.includes('月光如霜'),
    `view=${view.slice(0, 200)}`);
}

// ============================================================
console.log('== guyin-check-repetition N1 复读雷达 ==');
{
  // 跨章必报：ch1「缺角的讫印」×2 --commit（入库门槛 total≥2）→ ch6 ×1，窗口 [1,5]
  // winLib=2+count=1=3 ≥ ECHO_CROSS_RUN → phrase-echo-cross。
  // 实体过滤：「燕衡的算盘」同频分布但含角色名 → 全程静默（过滤失效会以同形态误报 cross）。
  const proj = path.join(TMP, 'echo1');
  fixture('echo1/追踪/_tracking-state.json', JSON.stringify({
    schema_version: 7, characters: { 燕衡: { identity: '主角' }, 周砚: { identity: '账房' } },
  }));
  const ch1 = fixture('echo1/正文/第001章.md',
    `第一章\n\n账房的灯下，他把那枚缺角的讫印按在纸上，印泥未干。周砚说燕衡的算盘打得比账房还精，他不接话——燕衡的算盘从来只算别人。他又拿起缺角的讫印补了一记，对着光看了很久，把票据折好收进袖袋，吹灯出门去了。\n`);
  let r = run('guyin-check-repetition.js', ['--json', '--project', proj, '--commit', ch1]);
  let report = parseJson(r.stdout);
  check('N1 ch1 ×2 同章复读报 phrase-echo-inline（SP1 docs/11 §一：ECHO_INLINE_RUN=2，旧 ×2 静默口径已废止）', r.status === 1 && report
    && report.findings.some((f) => f.type === 'phrase-echo-inline' && f.excerpt === '缺角的讫印'),
    `status=${r.status} findings=${JSON.stringify(report && report.findings.map((f) => f.type))}`);

  const ch6 = fixture('echo1/正文/第006章.md',
    `第六章\n\n他把缺角的讫印又按了一回，燕衡的算盘还悬在梁上，谁也没去动它。窗外更声三遍，他把票据压回原处，吹了灯。\n`);
  r = run('guyin-check-repetition.js', ['--json', '--project', proj, '--commit', ch6]);
  report = parseJson(r.stdout);
  const cross = report && report.findings.find((f) => f.type === 'phrase-echo-cross');
  check('N1 跨章窗口必报 phrase-echo-cross（库2+本章1=3）', r.status === 1 && cross
    && cross.excerpt === '缺角的讫印',
    `status=${r.status} findings=${JSON.stringify(report && report.findings.map((f) => `${f.type}:${f.excerpt}`))}`);
  check('N1 角色短语静默（燕衡的算盘 实体过滤）', report
    && !report.findings.some((f) => f.excerpt === '燕衡的算盘'),
    `findings=${JSON.stringify(report && report.findings.map((f) => f.excerpt))}`);

  const echoLib = JSON.parse(fs.readFileSync(path.join(proj, '追踪', '段落指纹库.json'), 'utf8'));
  const stored = (echoLib.phrases || []).find((p) => p.phrase === '缺角的讫印');
  check('N1 phrases 沉淀（ch1+ch6 合并 total=3、last=6）', stored
    && stored.total === 3 && stored.last === 6,
    `phrases=${JSON.stringify(echoLib.phrases)}`);
  const echoView = fs.readFileSync(path.join(proj, '追踪', '意象台账.md'), 'utf8');
  check('N2 台账扩域：意象台账视图含复读短语节', echoView.includes('复读短语') && echoView.includes('缺角的讫印'),
    `view=${echoView.slice(0, 300)}`);

  // E6 章尾同图重复（docs/07 §二 N1）：新短语本章 ×2、末次落章尾 20% → phrase-echo-ending。
  // 库内无此短语（winLib=0，count=2 < 3）不走 cross 分支；4/5 字子串同条件命中，
  // 断言 excerpt 为 6 字最长形——顺带锁防噪②子串归并。
  const endingPhrase = '更声敲过三遍';
  const ch7 = fixture('echo1/正文/第007章.md',
    `第七章\n\n他先看的是案角的旧印匣，${endingPhrase}，周砚还没歇，笔尖在纸上沙沙地走。他把窗推开一条缝，风灌进来吹得烛火直晃，影子在墙上叠成一层又一层。他把票据按次序折好压进袖袋，又拨亮灯芯。临出门他回头看了一眼，${endingPhrase}。\n`);
  r = run('guyin-check-repetition.js', ['--json', '--project', proj, '--commit', ch7]);
  report = parseJson(r.stdout);
  check('N1 章尾复读报 phrase-echo-ending（本章×2 且末次落章尾 20%，子串归并报最长形）', r.status === 1 && report
    && report.findings.some((f) => f.type === 'phrase-echo-ending' && f.excerpt === endingPhrase),
    `status=${r.status} findings=${JSON.stringify(report && report.findings.map((f) => `${f.type}:${f.excerpt}`))}`);
  const endingLib = JSON.parse(fs.readFileSync(path.join(proj, '追踪', '段落指纹库.json'), 'utf8'));
  const endingStored = (endingLib.phrases || []).find((p) => p.phrase === endingPhrase);
  check('N1 ending 短语同步沉淀 phrases（total=2、last=7）', endingStored
    && endingStored.total === 2 && endingStored.last === 7,
    `phrases=${JSON.stringify(endingLib.phrases)}`);
}

// ============================================================
console.log('== guyin-check-repetition B3 比喻域固化 ==');
{
  // 五章自然域主导（每章一句喻体侧自然词的比喻）→ 第 5 章驻留 run=5 > 4 报 advisory；
  // 断链项目（2 自然+1 身体+2 自然）第 5 章 run=2 不报；--domain-stale=2 收紧后必报。
  const natural = [
    '云像海潮一样涌过来，一层压着一层，把半边天都盖住了。他站在城头看了很久，直到暮色把最后一道光收走，才转身下楼去了。',
    '雾如薄纱漫过山脊，把远处的灯火一盏盏收进去。他沿着城墙走了半圈，鞋底沾了露水也没觉出凉意来。',
    '月光似霜，铺了满院，青砖地上泛着一层冷白。他推门进去，看见案上的灯还亮着，笔搁在砚边没人收拾。',
    '风像刀子刮过河面，吹得渡口的旗子哗哗作响。他把领口拢了又拢，盯着那条黑沉沉的水路看了半晌。',
    '雪片如同柳絮，落进江里就没了踪影。他数着更声等到天亮，眉毛上凝了一层细霜也没拂去。',
  ];
  const proj = path.join(TMP, 'b3stale');
  natural.forEach((p, i) => fixture(`b3stale/正文/第00${i + 1}章.md`, `第${'一二三四五'[i]}章\n\n${p}\n`));
  let r = run('guyin-check-repetition.js', ['--json', '--project', proj, '--commit',
    ...natural.map((_, i) => path.join(proj, '正文', `第00${i + 1}章.md`))]);
  let report = parseJson(r.stdout);
  check('B3 主导域连续 5 章固化报 metaphor-domain-stale（自然域 run=5>4）', r.status === 1 && report
    && report.findings.some((f) => f.type === 'metaphor-domain-stale'
      && f.excerpt.includes('自然') && f.excerpt.includes('连续5章')),
    `status=${r.status} findings=${JSON.stringify(report && report.findings.map((f) => `${f.type}:${f.excerpt}`))}`);

  const broken = path.join(TMP, 'b3break');
  natural.slice(0, 2).forEach((p, i) => fixture(`b3break/正文/第00${i + 1}章.md`, `第${'一二'[i]}章\n\n${p}\n`));
  fixture('b3break/正文/第003章.md', `第三章\n\n老账房瘦得像只失了水的鱼，脊背弯成一张弓，算盘珠子拨得飞快。他把茶碗推过去，对方只顾摇头，连眼皮都没抬一下。\n`);
  natural.slice(3).forEach((p, i) => fixture(`b3break/正文/第00${i + 4}章.md`, `第${'四五'[i]}章\n\n${p}\n`));
  r = run('guyin-check-repetition.js', ['--json', '--project', broken, '--commit',
    ...[1, 2, 3, 4, 5].map((n) => path.join(broken, '正文', `第00${n}章.md`))]);
  report = parseJson(r.stdout);
  check('B3 断链不报（第3章切身体域，第5章 run=2）', report
    && !report.findings.some((f) => f.type === 'metaphor-domain-stale'),
    `findings=${JSON.stringify(report && report.findings.map((f) => `${f.type}:${f.excerpt}`))}`);

  // 收紧阈值：同库重检第 5 章（库已含 1-5 章意象），run=5 > 2 必报。
  r = run('guyin-check-repetition.js', ['--json', '--project', proj, '--domain-stale=2',
    path.join(proj, '正文', '第005章.md')]);
  report = parseJson(r.stdout);
  check('B3 --domain-stale=2 收紧后 run=5 必报', r.status === 1 && report
    && report.findings.some((f) => f.type === 'metaphor-domain-stale' && f.message.includes('--domain-stale')),
    `status=${r.status} findings=${JSON.stringify(report && report.findings.map((f) => f.type))}`);
}

// ============================================================
console.log('== guyin-check-repetition U3 同族去重 ==');
{
  // 一个 8 字 tic ×2：8-4 字子串全部复现 ≥2——去重后只存最长形；独立短语照常入库。
  const proj = path.join(TMP, 'u3dedup');
  const tic = '他把算盘压在碗底';
  const tic2 = '灯芯爆了个火花';
  fixture('u3dedup/正文/第001章.md', `第一章\n\n${tic}，才肯多说的样子。周砚皱着眉把茶盏搁下，半天没言语。${tic}，又把话头岔了开去。\n`);
  fixture('u3dedup/正文/第002章.md', `第二章\n\n${tic2}，他都没抬头。周砚把册子翻过一页，笔尖顿了顿。${tic2}，照旧没言语。\n`);
  let r = run('guyin-check-repetition.js', ['--json', '--project', proj, '--commit',
    path.join(proj, '正文', '第001章.md'), path.join(proj, '正文', '第002章.md')]);
  let report = parseJson(r.stdout);
  const lib = JSON.parse(fs.readFileSync(path.join(proj, '追踪', '段落指纹库.json'), 'utf8'));
  const family = (lib.phrases || []).filter((p) => p.phrase.includes('算盘') || p.phrase.includes('碗底'));
  check('U3 同族只存最长形（8字 tic 的 4-7 字子串不另立行，SP1 同章复读不影响去重逻辑）', report
    && family.length === 1 && family[0].phrase === tic && family[0].total === 2 && family[0].last === 1,
    `status=${r.status} family=${JSON.stringify(family)}`);
  const kept = (lib.phrases || []).find((p) => p.phrase === tic2);
  check('U3 独立短语照常入库（去重不误伤异族）', kept && kept.total === 2 && kept.last === 2,
    `phrases=${JSON.stringify(lib.phrases)}`);
}

// ============================================================
console.log('== guyin-check-pending U1 待审台账终态门 ==');
{
  // 表格契约：| 章号 | 来源 | 报警/发现 | 终态 | 去向/备注 |——待审/空＝开放，五终态＝闭。
  const ledger = fixture('pend/追踪/待审台账.md', [
    '# 待审台账（检测必有终态）',
    '',
    '| 章号 | 来源 | 报警/发现 | 终态 | 去向/备注 |',
    '|---|---|---|---|---|',
    '| 61 | repetition N2 | {{例：钱压在碗底下×2}} | {{待审/修复/豁免}} | {{例：改写卡L2}} |',
    '| 61 | repetition N2 | 钱压在碗底下×2 | 待审 | |',
    '| 61 | wordcount | 字数欠账 1200/2000 | 修复 | 改写卡 L2 |',
    '| 62 | review | 章尾评点句 |  | |',
    '| 63 | consistency | 实体冲突：账页数 | 顺延 | 伏笔.md@ch65 |',
    '',
  ].join('\n'));
  let r = run('guyin-check-pending.js', ['--json', ledger]);
  let report = parseJson(r.stdout);
  check('U1 未终态行（待审/空）exit 1，占位行跳过', r.status === 1 && report
    && report.total === 4 && report.open.length === 2
    && report.open.every((o) => o.chapter === 61 || o.chapter === 62),
    `status=${r.status} out=${r.stdout.trim().slice(0, 200)}`);

  r = run('guyin-check-pending.js', ['--json', '--through', '61', ledger]);
  report = parseJson(r.stdout);
  check('U1 --through 61 只查 ≤61 章（62/63 行出界，1 行开放）', r.status === 1 && report
    && report.open.length === 1 && report.total === 2,
    `status=${r.status} out=${r.stdout.trim().slice(0, 200)}`);

  const closed = fixture('pend/追踪/待审台账_全终态.md', [
    '| 章号 | 来源 | 报警/发现 | 终态 | 去向/备注 |',
    '|---|---|---|---|---|',
    '| 61 | repetition N2 | 钱压在碗底下×2 | 豁免 | 豁免台账#3 |',
    '| 62 | review | 章尾评点句 | 修复 | 大修 L1 |',
    '',
  ].join('\n'));
  r = run('guyin-check-pending.js', ['--json', closed]);
  report = parseJson(r.stdout);
  check('U1 全终态 exit 0', r.status === 0 && report && report.open.length === 0 && report.total === 2,
    `status=${r.status} out=${r.stdout.trim().slice(0, 200)}`);

  // Fw-07：升级作者非自终态——备注无「已裁决：」仍 open；有作者回填才闭（半/全角冒号均认）。
  const fw07 = fixture('pend/追踪/待审台账_fw07.md', [
    '| 章号 | 来源 | 报警/发现 | 终态 | 去向/备注 |',
    '|---|---|---|---|---|',
    '| 3 | ai-patterns | 碎化率 62% | 升级作者 | 请作者裁决后转豁免/关闭 |',
    '| 3 | consistency | 台词归属误判 | 升级作者 | 已裁决:转豁免（误报），登豁免台账#2 |',
    '| 4 | repetition | 钱×2 | 升级作者 | 已裁决：关闭，非问题 |',
    '',
  ].join('\n'));
  r = run('guyin-check-pending.js', ['--json', fw07]);
  report = parseJson(r.stdout);
  check('Fw-07 升级作者无裁决回填=open，有「已裁决:」=闭（1 行 open / 共 3 行）',
    r.status === 1 && report && report.open.length === 1 && report.total === 3
      && report.open[0].chapter === 3 && /碎化率/.test(report.open[0].finding),
    `status=${r.status} out=${r.stdout.trim().slice(0, 200)}`);

  r = run('guyin-check-pending.js', ['--json', '--through', '2', fw07]);
  report = parseJson(r.stdout);
  check('Fw-07 --through 2 升级行均 >2 出界，exit 0',
    r.status === 0 && report && report.open.length === 0 && report.total === 0,
    `status=${r.status} out=${r.stdout.trim().slice(0, 200)}`);

  r = run('guyin-check-pending.js', ['--json', path.join(TMP, 'pend-none', '追踪', '待审台账.md')]);
  report = parseJson(r.stdout);
  check('U1 台账缺失 fail-open exit 0', r.status === 0 && report && report.missing === true,
    `status=${r.status} out=${r.stdout.trim().slice(0, 120)}`);
}

// ============================================================
console.log('== guyin-check-outline-deliver S3+S4 承诺交付 ==');
{
  // 大纲契约：术语锚点双术语 + 章尾钩子实体；四个变体验证全合规静默与三条 advisory。
  const outline = '# 第061章 细纲\n- 术语锚点：勘合（老周在账房说出）、火耗——师爷写账时提到\n'
    + '- 章尾钩子：期待·预告式——实体：撕掉的账页；承接：第062章对账；期待度：中\n';
  const anchored = '「老周把册子推过来，指着那方印：勘合，就是两关互相对批的凭据，少了哪一关都不作数。」\n\n'
    + '师爷拨了两下算盘。「火耗是熔铸时折掉的分量，一两银子到手只剩九成七，账上要另立一栏。」\n\n'
    + '他把那半张撕掉的账页压回匣底，吹熄了灯。\n';
  const mkDolv = (name, prose) => {
    fixture(`dolv/${name}/大纲/细纲_第061章_试.md`, outline);
    return fixture(`dolv/${name}/正文/第061章.md`, prose);
  };
  const dolvA = mkDolv('a', anchored);
  const dolvB = mkDolv('b', anchored.replace(
    '师爷拨了两下算盘。「火耗是熔铸时折掉的分量，一两银子到手只剩九成七，账上要另立一栏。」',
    '师爷拨了两下算盘，只说账上要另立一栏，别的没提。'));
  const dolvC = mkDolv('c', `账房梁上还挂着勘合的旧木牌，字迹磨得快没了。\n\n${anchored}`);
  const dolvD = mkDolv('d', anchored.replace('他把那半张撕掉的账页压回匣底，吹熄了灯。',
    '他把匣子推回架子最深处，转身吹熄了灯。'));

  let r = run('guyin-check-outline-deliver.js', ['--json', dolvA]);
  let report = parseJson(r.stdout);
  check('S3+S4 全履约静默（双术语对白锚定+钩子压尾）', r.status === 0 && report && report.findings.length === 0,
    `status=${r.status} out=${r.stdout.trim().slice(0, 200)}`);

  r = run('guyin-check-outline-deliver.js', ['--json', dolvB]);
  report = parseJson(r.stdout);
  check('S3 锚定戏漏写报 outline-term-missing（火耗）', r.status === 1 && report
    && report.findings.some((f) => f.type === 'outline-term-missing' && f.excerpt === '火耗')
    && !report.findings.some((f) => f.excerpt === '勘合'),
    `status=${r.status} findings=${JSON.stringify(report && report.findings.map((f) => f.type))}`);

  r = run('guyin-check-outline-deliver.js', ['--json', dolvC]);
  report = parseJson(r.stdout);
  check('S3 首现叙述层报 outline-term-unanchored（勘合）', r.status === 1 && report
    && report.findings.some((f) => f.type === 'outline-term-unanchored' && f.excerpt === '勘合'),
    `status=${r.status} findings=${JSON.stringify(report && report.findings.map((f) => f.type))}`);

  r = run('guyin-check-outline-deliver.js', ['--json', dolvD]);
  report = parseJson(r.stdout);
  check('S4 钩子被顶出报 outline-hook-offtail（撕掉的账页）', r.status === 1 && report
    && report.findings.some((f) => f.type === 'outline-hook-offtail' && f.excerpt === '撕掉的账页'),
    `status=${r.status} findings=${JSON.stringify(report && report.findings.map((f) => f.type))}`);
}

// ============================================================
console.log('== guyin-check-outline-deliver R1+K2（docs/08：锚句落地/钩子引语/跨章签名句） ==');
{
  // R1：锚句未落地 / 钩子引语幽灵化；K2：跨章签名句提前释放与已声明复用静默。
  const mkProj = (name, outlines, proses) => {
    for (const [num, text] of Object.entries(outlines)) {
      fixture(`r1k2/${name}/大纲/细纲_第${num}章_试.md`, text);
    }
    const files = [];
    for (const [num, text] of Object.entries(proses)) {
      files.push(fixture(`r1k2/${name}/正文/第${num}章.md`, text));
    }
    return path.join(TMP, `r1k2/${name}/正文`);
  };
  const ol = (anchor, hookExtra) => `# 细纲\n- 术语锚点：无\n- 复沓锚句：${anchor}\n- 章尾钩子：期待·预告式——实体：信；${hookExtra}\n`;

  // 全履约：锚句一字不差 + 钩子引语真实存在 → 静默
  const dirOk = mkProj('ok',
    { '061': ol('「立此为凭，账没算完」', '承接：第62章对质') },
    { '061': '他把笔搁下。「立此为凭，账没算完。」\n\n说完把那封信压在匣底，吹熄了灯。\n' });
  let r = run('guyin-check-outline-deliver.js', ['--json', dirOk]);
  let report = parseJson(r.stdout);
  check('R1 锚句落地+引语一致静默', r.status === 0 && report && report.findings.length === 0,
    `status=${r.status} findings=${JSON.stringify(report && report.findings.map((f) => f.type))}`);

  // R1 双报：锚句未落地 + 钩子引语幽灵化
  const dirBad = mkProj('bad',
    { '062': ol('「立此为凭，账没算完」', '承接：第63章；引小窦原话「那引不是我发的」') },
    { '062': '他推说账目还要再核，把册子合上。\n\n小窦在廊下站了半晌，只说上个月也有人来对过号。\n' });
  r = run('guyin-check-outline-deliver.js', ['--json', dirBad]);
  report = parseJson(r.stdout);
  check('R1 锚句未落地报 outline-anchor-missing', r.status === 1 && report
    && report.findings.some((f) => f.type === 'outline-anchor-missing'),
    `status=${r.status} findings=${JSON.stringify(report && report.findings.map((f) => f.type))}`);
  check('R1 幽灵引语报 outline-hook-quote-mismatch', report
    && report.findings.some((f) => f.type === 'outline-hook-quote-mismatch' && f.excerpt === '那引不是我发的'),
    `findings=${JSON.stringify(report && report.findings.map((f) => f.type))}`);

  // K2：ch61 提前说出 ch62 签名句 → 报 preempted；双方声明同一锚句（复沓仪式）→ 静默
  const dirLeak = mkProj('leak',
    {
      '061': ol('「留着一并算」', '承接：第62章'),
      '062': ol('「三炉烧不出两炉的引子」', '承接：第63章'),
    },
    {
      '061': '老周眯眼道：「三炉烧不出两炉的引子，这话我可没说过。」\n\n他把算盘收进布袋走了。\n',
      '062': '三炉烧不出两炉的引子——这句话在坊间传了半年。\n\n火头把炉门关了。\n',
    });
  r = run('guyin-check-outline-deliver.js', ['--json', dirLeak]);
  report = parseJson(r.stdout);
  const pre = report ? report.findings.filter((f) => f.type === 'outline-signature-preempted') : [];
  check('K2 跨章签名句提前释放报 outline-signature-preempted（61 说 62 的句）', r.status === 1 && pre.length === 1
    && pre[0].excerpt === '三炉烧不出两炉的引子',
    `status=${r.status} pre=${JSON.stringify(pre.map((f) => f.excerpt))}`);

  const dirEcho = mkProj('echo',
    {
      '061': `# 细纲\n- 术语锚点：无\n- 复沓锚句：「立此为凭，账没算完」\n- 章尾钩子：期待·预告式——实体：灯花；承接：第62章\n`,
      '062': `# 细纲\n- 术语锚点：无\n- 复沓锚句：「立此为凭，账没算完」\n- 章尾钩子：期待·预告式——实体：灯花；承接：第63章\n`,
    },
    {
      '061': '他落笔：「立此为凭，账没算完。」\n\n搁笔，灯花跳了一下。\n',
      '062': '周砚看着那行字：「立此为凭，账没算完。」\n\n灯花爆了一下。\n',
    });
  r = run('guyin-check-outline-deliver.js', ['--json', dirEcho]);
  report = parseJson(r.stdout);
  check('K2 已声明复用（复沓仪式）静默', r.status === 0 && report && report.findings.length === 0,
    `status=${r.status} findings=${JSON.stringify(report && report.findings.map((f) => f.type))}`);
}

// ============================================================
console.log('== guyin-check-strip（K3 成稿剥离门禁） ==');
{
  // blocking：多标题脚手架 + 大纲尾巴；advisory：工序词泄漏；白名单：案卷静默。
  const clean = fixture('strip/第001章_净.md',
    '# 第001章 试\n\n他把案卷从架上取下，翻开卷宗第三页。\n\n「火耗是折掉的分量。」师爷说。\n');
  let r = run('guyin-check-strip.js', ['--json', clean]);
  let report = parseJson(r.stdout);
  check('K3 干净正文通过（案卷/卷宗白名单）', r.status === 0 && report && report.findings.length === 0,
    `status=${r.status} findings=${JSON.stringify(report && report.findings.map((f) => f.type))}`);

  const scaffold = fixture('strip/第002章_脚手架.md',
    '# 第002章 试\n\n他把笔搁下。\n\n## 声线锚\n\n老周说话带算盘声。\n\n## 封档\n\n物证三件。\n\n灯熄了。\n');
  r = run('guyin-check-strip.js', ['--json', scaffold]);
  report = parseJson(r.stdout);
  check('K3 多标题报 strip-extra-heading（blocking）', r.status === 1 && report
    && report.findings.filter((f) => f.type === 'strip-extra-heading' && f.severity === 'blocking').length === 2,
    `status=${r.status} findings=${JSON.stringify(report && report.findings.map((f) => f.type))}`);
  r = run('guyin-check-strip.js', ['--fail-on=blocking', scaffold]);
  check('K3 blocking 触发 --fail-on=blocking', r.status === 1, `status=${r.status}`);

  const carryover = fixture('strip/第003章_尾巴.md',
    '# 第003章 试\n\n他把信压回匣底，吹熄了灯。\n\n承接：第004章盐贩到齐，官船明早出发。\n');
  r = run('guyin-check-strip.js', ['--json', carryover]);
  report = parseJson(r.stdout);
  check('K3 大纲尾巴报 strip-carryover（blocking）', r.status === 1 && report
    && report.findings.some((f) => f.type === 'strip-carryover' && f.severity === 'blocking'),
    `status=${r.status} findings=${JSON.stringify(report && report.findings.map((f) => f.type))}`);

  const leakWords = fixture('strip/第004章_泄漏.md',
    '# 第004章 试\n\n「推理≤3步，已经到第三步了。」他低声道，「这细纲里写着，情节点四要落在伏笔上。」\n\n全貌留卷三卷四。\n');
  r = run('guyin-check-strip.js', ['--json', leakWords]);
  report = parseJson(r.stdout);
  check('K3 工序词泄漏报 strip-framework-word（advisory）', r.status === 1 && report
    && report.findings.some((f) => f.type === 'strip-framework-word' && f.severity === 'advisory'),
    `status=${r.status} findings=${JSON.stringify(report && report.findings.map((f) => f.type))}`);
  check('K3 卷N 自引用命中（卷三形态）', report
    && report.findings.some((f) => f.type === 'strip-framework-word' && (f.excerpt || '').includes('卷三卷四')),
    JSON.stringify(report && report.findings.filter((f) => f.type === 'strip-framework-word').map((f) => f.excerpt)));
  r = run('guyin-check-strip.js', ['--fail-on=blocking', leakWords]);
  check('K3 advisory 不触发 --fail-on=blocking', r.status === 0, `status=${r.status}`);

  const dir = path.join(TMP, 'strip');
  r = run('guyin-check-strip.js', ['--json', dir]);
  report = parseJson(r.stdout);
  check('K3 目录模式扫描全部 第*.md', r.status === 1 && report
    && report.findings.length >= 4
    && new Set(report.findings.map((f) => f.file)).size === 3,
    `status=${r.status} files=${JSON.stringify([...new Set(report.findings.map((f) => f.file))])}`);
}

// ============================================================
console.log('== guyin-check-flesh P6-3 人物显影器 ==');
{
  // 林彻卡标「果决」，正文反特质行为 ×3（犹豫×2+退缩×1）零正特质 → 断裂；
  // 周砚卡无特质词 → 静默。对话呼吸回归锚：「我再想想」(5) + 「查」(1)。
  // 老赵（P6-4）：连续 3 章每章 2 句纯递话 → tool-character；主角色零误报。
  const proj = path.join(TMP, 'fleshp');
  fixture('fleshp/设定/角色/林彻.md', '# 林彻\n\n- 身份：刑警队长，行事果决\n- 目标：查清白银案\n- 说话习惯：短句，不废话\n');
  fixture('fleshp/设定/角色/周砚.md', '# 周砚\n\n- 身份：退休法医\n- 目标：安度晚年\n- 说话习惯：慢条斯理\n');
  fixture('fleshp/设定/角色/老赵.md', '# 老赵\n\n- 身份：线人\n- 说话习惯：报信快\n');
  const ch1 = fixture('fleshp/正文/第001章.md', '雨夜。林彻犹豫了一下，没接周砚递来的伞。\n\n周砚说：「你来晚了。」\n\n林彻犹豫着没接话。灯影里他迟疑半晌，才抬手敲了敲门。\n\n老赵说：「头儿，人找到了。」\n老赵又说：「在城西巷子。」\n');
  const ch2 = fixture('fleshp/正文/第002章.md', '档案室积灰。林彻翻着卷宗，指尖停在一张照片上。\n\n「这是九八年那桩。」周砚说。\n\n林彻没说话，退缩半步，靠在柜子上。「我再想想。」\n\n老赵来报：「档案借出过。」\n老赵补了一句：「借的是内勤。」\n');
  const ch3 = fixture('fleshp/正文/第003章.md', '雨停了。林彻说「查」，转身出门。\n\n周砚站在门口，看他的背影消失在楼道尽头。\n\n老赵拦住他：「别回队里。」\n老赵只说了四个字：「有人等着。」\n');
  const chapters = [ch1, ch2, ch3];

  let r = run('guyin-check-flesh.js', ['--json', '--project', proj, '林彻', ...chapters]);
  let report = parseJson(r.stdout);
  check('卡标果决+反特质×3零正特质报 flesh-trait-break', r.status === 0 && report
    && report.findings.some((f) => f.type === 'flesh-trait-break' && f.message.includes('果决'))
    && report.axes.some((a) => a.trait === '果决' && a.in_card && a.pro === 0 && a.anti === 3),
    `status=${r.status} findings=${JSON.stringify(report && report.findings.map((f) => f.type))}`);

  r = run('guyin-check-flesh.js', ['--json', '--project', proj, '周砚', ...chapters]);
  report = parseJson(r.stdout);
  check('无特质卡角色零报警（无卡轴不判，终判归作者）', r.status === 0 && report
    && report.findings.length === 0 && report.summary.breaks === 0,
    `status=${r.status} findings=${JSON.stringify(report && report.findings)}`);

  r = run('guyin-check-flesh.js', ['--json', '--project', proj, '林彻', ...chapters]);
  report = parseJson(r.stdout);
  check('对话呼吸：引号感知切分+归属继承（「引文」XX说不误归）', report && report.breath
    && report.breath.turns === 2 && report.breath.max_len === 5 && report.breath.min_len === 1,
    `breath=${JSON.stringify(report && report.breath)}`);

  r = run('guyin-check-flesh.js', ['--json', '--project', proj, '--all', ...chapters]);
  report = parseJson(r.stdout);
  const sorted = report && report.roles.every((row, k) => k === 0 || report.roles[k - 1].sentences >= row.sentences);
  check('--all 戏份概览按句数降序且断裂随报', r.status === 0 && report
    && report.roles.length === 3 && sorted
    && report.findings.some((f) => f.type === 'flesh-trait-break'),
    `roles=${JSON.stringify(report && report.roles)} findings=${JSON.stringify(report && report.findings.map((f) => f.type))}`);

  check('P6-4 工具人检测：连续 3 章纯递话报 tool-character（老赵）', report
    && report.findings.some((f) => f.type === 'tool-character' && f.message.includes('老赵') && f.message.includes('递话'))
    && report.roles.some((row) => row.name === '老赵' && row.dialogue === 6),
    `findings=${JSON.stringify(report && report.findings.map((f) => f.type))} roles=${JSON.stringify(report && report.roles)}`);
  check('P6-4 主角色零误报（林彻/周砚无 tool-character）', report
    && !report.findings.some((f) => f.type === 'tool-character' && (f.message.includes('林彻') || f.message.includes('周砚'))),
    `findings=${JSON.stringify(report && report.findings)}`);
}

// ============================================================
console.log('== P5 impact-map + reader-signal ==');
{
  // P5-1 影响面：白银线→悬空债+定性资产+补丁面；周砚→角色名一级扩散命中其事件。
  // P5-2/3：第3/5章掉崖（-37%/-31%），第4-5章无推进×2 弃书点含信号佐证。
  const proj = path.join(TMP, 'p5p');
  fixture('p5p/追踪/_tracking-state.json', JSON.stringify({
    schema_version: 7, book_title: '白银案录', last_committed_chapter: 5, imported_through_chapter: 0, state_revision: 3,
    context: {},
    characters: { 林彻: { identity: '刑警队长', state: '追查白银案', goal: '破案' }, 周砚: { identity: '退休法医', state: '协助查案', goal: '安度晚年' } },
    foreshadow: {
      F001: { id: 'F001', summary: '白银首饰的真伪存疑', planted_chapter: 1, planned_resolution_chapter: null, status: '已埋', importance: '高', updated_chapter: 1 },
      F002: { id: 'F002', summary: '周砚的旧档案', planted_chapter: 2, planned_resolution_chapter: null, status: '已回收', importance: '中', updated_chapter: 3 },
    },
    timeline: { E001: { id: 'E001', story_time: '1998年冬', objective_fact: '白银作坊起火', reader_knowledge: '知道起火不知道人为', reveal_status: '部分揭示', reveal_chapter: 2, characters: ['周砚'] } },
    verdicts: { V001: { id: 'V001', chapter: 3, event: '白银案重启调查', verdict: '林彻确认旧案有遗漏', status: 'active', keywords: ['白银案'], updated_chapter: 3 } },
    evidence: { W001: { id: 'W001', chapter: 1, name: '白银镯', anchor: '他从灰里捡起一只白银镯。', status: 'held', holder: '林彻', keywords: ['白银'], updated_chapter: 1 } },
    geo: {}, scenes: {},
    chapter_summaries: {
      1: '林彻到城西巷勘察作坊废墟。', 2: '周砚交出旧档案，揭示起火另有隐情。',
      3: '林彻重启白银案，确认旧案有遗漏。', 4: '林彻整理卷宗，回忆旧案细节。', 5: '林彻在办公室过夜，等周砚的消息。',
    },
  }));
  fixture('p5p/大纲/细纲_第003章.md', '# 第003章\n\n- 章尾钩子：危机·门后黑影 — 有人等着他\n');
  fixture('p5p/追踪/读者信号.md', '# 读者信号\n\n| 章 | 追读 | 评论关键词 |\n|----|------|-----------|\n| 1 | 1000 | 开头快 |\n| 2 | 950 | 节奏稳 |\n| 3 | 600 | 水了 |\n| 4 | 580 | 注水 |\n| 5 | 400 | 弃了 |\n');

  let r = run('guyin-impact-map.js', ['--json', '--project', proj, '白银']);
  let report = parseJson(r.stdout);
  check('P5-1 白银线影响面：悬空债+定性资产+风险双报', r.status === 0 && report
    && report.summary.dangling === 1 && report.summary.verdicts === 1
    && report.result.warnings.some((w) => w.type === 'impact-dangling-foreshadow')
    && report.result.warnings.some((w) => w.type === 'impact-verdict-asset'),
    `summary=${JSON.stringify(report && report.summary)} warn=${JSON.stringify(report && report.result.warnings.map((w) => w.type))}`);

  r = run('guyin-impact-map.js', ['--json', '--project', proj, '周砚']);
  report = parseJson(r.stdout);
  check('P5-1 角色名一级扩散：周砚命中其关联事件', r.status === 0 && report
    && report.summary.characters === 1 && report.summary.events === 1
    && report.result.events.some((e) => e.id === 'E001'),
    `summary=${JSON.stringify(report && report.summary)}`);

  r = run('guyin-check-reader-signal.js', ['--json', '--project', proj]);
  report = parseJson(r.stdout);
  const cliff3 = report && report.findings.find((f) => f.type === 'reader-cliff' && f.excerpt.includes('第3章'));
  check('P5-2 掉崖检测+±2章归因表（钩子/推进列）', r.status === 0 && report
    && report.summary.cliffs === 2 && cliff3 && cliff3.table.length >= 4
    && cliff3.table.some((row) => row.chapter === 3 && row.hook === '危机' && row.progress === '有推进'),
    `summary=${JSON.stringify(report && report.summary)} cliff3=${JSON.stringify(cliff3 && cliff3.table)}`);

  check('P5-3 弃书点：连续 2 章无推进含信号佐证', report
    && report.findings.some((f) => f.type === 'drop-point' && f.excerpt.includes('第4-5章') && f.excerpt.includes('信号佐证')),
    `findings=${JSON.stringify(report && report.findings.map((f) => f.type + '|' + f.excerpt))}`);
}

// ============================================================
console.log('== P7 guyin-check-pitch 开书文案三判据 ==');
{
  const proj = path.join(TMP, 'p7p');
  fixture('p7p/大纲/细纲_第001章.md', '# 第001章\n\n- 章尾钩子：危机·门后黑影 — 有人在他家门口等他动手\n');
  fixture('p7p/大纲/细纲_第002章.md', '# 第002章\n\n- 章尾钩子：期待·师父的剑 — 师父说过剑冢里藏着天下第一的剑\n');
  fixture('p7p/大纲/细纲_第003章.md', '# 第003章\n\n- 章尾钩子：悬念·半张画像 — 画像上只有母亲的脸另一半被烧掉\n');
  const blurb = fixture('p7p/简介.md', '刑警林彻重启白银旧案，有人不想让他查。师父留下的剑冢，藏着天下第一的剑。\n');
  fixture('p7p/正文/第001章_白银.md', '# 第001章\n');
  fixture('p7p/正文/第002章_往事.md', '# 第002章\n');
  const ch3 = fixture('p7p/正文/第003章_真相大白与旧案重启.md', '# 第003章\n\n- 章尾钩子：反转·画像的另一面 — 母亲手上有同样的画像\n');

  let r = run('guyin-check-pitch.js', ['--json', 'name', '开局无敌剑神', '白银案录', '我在洪荒当赘婿']);
  let report = parseJson(r.stdout);
  check('P7-2 书名十年测试：热词名过滤与干净名区分', r.status === 0 && report
    && report.summary.tested === 3 && report.summary.hype === 2
    && report.names.some((n) => n.name === '白银案录' && n.verdict === '过十年')
    && report.findings.filter((f) => f.type === 'hype-title').length === 2,
    `names=${JSON.stringify(report && report.names)}`);

  r = run('guyin-check-pitch.js', ['--json', 'blurb', '--blurb', blurb, path.join(proj, '大纲')]);
  report = parseJson(r.stdout);
  check('P7-2 简介钩子覆盖：期待钩命中、漏覆盖两报（危机可隐/悬念应映射）', r.status === 0 && report
    && report.summary.hooks_checked === 3
    && report.hooks.some((h) => h.chapter === 2 && h.covered)
    && report.findings.filter((f) => f.type === 'blurb-missing-promise').length === 2,
    `hooks=${JSON.stringify(report && report.hooks)}`);

  r = run('guyin-check-pitch.js', ['--json', 'titles', path.join(proj, '正文')]);
  report = parseJson(r.stdout);
  check('P7-2 章节标题三报：抽象词/超长/钩子错位', r.status === 0 && report
    && report.findings.some((f) => f.type === 'title-abstract' && f.excerpt === '往事')
    && report.findings.some((f) => f.type === 'title-too-long')
    && report.findings.some((f) => f.type === 'title-hook-mismatch' && f.excerpt.includes('反转')),
    `findings=${JSON.stringify(report && report.findings.map((f) => f.type + '|' + f.excerpt))}`);
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

  // P2 伴生修复（docs/07 §二 P2）：细纲「执行偏差（写后回填）」区比对前整段剥除——
  // 变体行引用正文原句 ≥16 字不得判誊抄（每个回填偏差区的章都在章检出假警报的封堵）；
  // 对照组同一句写在细纲正文区仍报——证明静默来自剥除授权而非句子本身不触发。
  const devSent = '他把那半张撕掉的账页压回匣底，吹熄了灯。';
  const devOutline = fixture('oc/大纲/细纲_第003章_偏差.md',
    `1. 开场：弟弟拦门要钱，母亲把灶上的粥端下来。\n2. 冲突：官差上门查验田契，弟弟顶了两句。\n\n#### 执行偏差（写后回填）\n- 变体：${devSent}（正文原句，接受）\n`);
  const devProse = fixture('oc/正文/第003章_偏差.md', `${longChapter(30)}${devSent}\n`);
  r = run('guyin-check-outline-copy.js', ['--outline', devOutline, devProse]);
  check('P2 执行偏差区变体引用不判誊抄（剥除后比对）', r.status === 0,
    `status=${r.status} out=${r.stdout.trim().slice(0, 200)}`);
  const noExemptOutline = fixture('oc/大纲/细纲_第004章_无豁免.md', `1. 开场：${devSent}\n`);
  const noExemptProse = fixture('oc/正文/第004章_无豁免.md', `${longChapter(30)}${devSent}\n`);
  r = run('guyin-check-outline-copy.js', ['--outline', noExemptOutline, noExemptProse]);
  check('P2 对照：同句写在细纲正文区仍报誊抄（豁免只认偏差区）', r.status === 1,
    `status=${r.status} out=${r.stdout.trim().slice(0, 200)}`);
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
console.log('== guyin-tracking-commit.py P2 章节金字塔（chapter_summaries + 派生视图） ==');
{
  const py = ['python3', 'python', 'py'].find((bin) => {
    try {
      return spawnSync(bin, ['-c', ''], { encoding: 'utf8' }).status === 0;
    } catch (e) {
      return false;
    }
  });
  if (!py) {
    skip('P2 init 带 chapter_summaries 入库', '未找到可用 python 解释器');
    skip('P2 金字塔派生视图含摘要', '未找到可用 python 解释器');
    skip('P2 commit 入库 chapter_summaries', '未找到可用 python 解释器');
    skip('P2 金字塔视图含两章摘要', '未找到可用 python 解释器');
    skip('P2 check 金字塔视图一致', '未找到可用 python 解释器');
  } else {
    const SCRIPT = path.join(S, 'guyin-tracking-commit.py');
    const runPy = (args, project) => spawnSync(py, [SCRIPT, ...args, '--project', project], { encoding: 'utf8' });

    // init 带 chapter_summaries：验证持久层入库 + 金字塔派生视图生成。
    const book = path.join(TMP, 'p2py', '书');
    fixture('p2py/书/init.json', JSON.stringify({
      schema_version: 1, book_title: '金字塔测试', last_chapter: 1,
      context: {
        position: { volume: '卷一', volume_start_chapter: 1, story_time: '景和三年春', scene: '县衙' },
        long_term_constraints: [], active_character_names: ['燕衡'], continuity_risks: [],
        recent_chapters: [{ chapter: 1, summary: '验银' }], next_chapter_commitments: [],
      },
      character_snapshots: {
        燕衡: { identity: '主角', location: '县衙', goal: '查银', state: '冷静',
          abilities_resources: [], relationships: [], knowledge: [], open_threads: [] },
      },
      foreshadow: [], timeline_events: [], verdicts: [], evidence: [], geo: [],
      chapter_summaries: { '1': '燕衡验银，当众拆穿换银的局' },
    }));
    let r = runPy(['init', '--input', path.join(TMP, 'p2py', '书', 'init.json')], book);
    let state = r.status === 0
      ? JSON.parse(fs.readFileSync(path.join(book, '追踪', '_tracking-state.json'), 'utf8')) : null;
    check('P2 init 带 chapter_summaries：持久层入库', r.status === 0 && state
      && state.chapter_summaries && state.chapter_summaries['1'] === '燕衡验银，当众拆穿换银的局',
      `status=${r.status} err=${r.stderr.trim().slice(0, 160)}`);

    let pyramid = r.status === 0
      ? fs.readFileSync(path.join(book, '追踪', '章节金字塔.md'), 'utf8') : '';
    check('P2 章节金字塔.md 含章摘要表', r.status === 0 && pyramid.includes('章摘要（全量）')
      && pyramid.includes('燕衡验银'),
      `status=${r.status}`);

    // commit 第 2 章：delta.result 自动入库 chapter_summaries[2]。
    fixture('p2py/书/commit.json', JSON.stringify({
      schema_version: 1, mode: 'append', chapter: 2, chapter_title: '追查',
      expected_state_revision: 0,
      delta: {
        result: '燕衡追查银两去向，发现线索指向济宁。',
        character_changes: [{ name: '燕衡', change: '从验银转向追查' }],
      },
      context: {
        position: { volume: '卷一', volume_start_chapter: 1, story_time: '景和三年夏', scene: '码头' },
        long_term_constraints: [], active_character_names: ['燕衡'], continuity_risks: [],
      },
      character_snapshots: {
        燕衡: { identity: '主角', location: '码头', goal: '追查', state: '冷静带狠',
          abilities_resources: [], relationships: [], knowledge: [], open_threads: [] },
      },
    }));
    r = runPy(['commit', '--input', path.join(TMP, 'p2py', '书', 'commit.json')], book);
    state = r.status === 0
      ? JSON.parse(fs.readFileSync(path.join(book, '追踪', '_tracking-state.json'), 'utf8')) : null;
    check('P2 commit 入库 chapter_summaries[2]', r.status === 0 && state
      && state.chapter_summaries && state.chapter_summaries['1'] && state.chapter_summaries['2'] === '燕衡追查银两去向，发现线索指向济宁。',
      `status=${r.status} err=${r.stderr.trim().slice(0, 160)}`);

    pyramid = r.status === 0
      ? fs.readFileSync(path.join(book, '追踪', '章节金字塔.md'), 'utf8') : '';
    check('P2 金字塔视图含两章摘要', r.status === 0 && pyramid.includes('燕衡验银')
      && pyramid.includes('燕衡追查'),
      `status=${r.status}`);

    // check 一致（金字塔视图与 state 同步）
    r = runPy(['check'], book);
    check('P2 check 金字塔视图一致', r.status === 0, `status=${r.status} err=${r.stderr.trim().slice(0, 160)}`);
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

  // U4 覆盖门：动刀已存在章须先快照——无快照拦截（v1/v3 稿裸奔覆盖的确定性封堵）。
  r = runHook(['guard'], payload(path.join(bookA, '正文', '第001章_试.md')));
  check('guard 覆盖已存在章无快照拦截（U4）', r.status === 2 && r.stderr.includes('快照'), `status=${r.status} err=${r.stderr.trim().slice(0, 80)}`);
  fixture('hook/书A/正文/_archive/第001章_v1_20260902.md', `# 第001章 试 v1${'\n'}${longChapter(75)}`);
  r = runHook(['guard'], payload(path.join(bookA, '正文', '第001章_试.md')));
  check('guard 覆盖已存在章有快照放行（U4）', r.status === 0, `status=${r.status} err=${r.stderr.trim().slice(0, 80)}`);

  // Fw-07 hook 侧（U1/D2 两份实现同步验证）：书D state 到第2章、ch3 细纲齐，
  // 待审台账 ch1 行「升级作者」无裁决回填 → guard 写 ch3 拦截；回填「已裁决：」后放行。
  const bookD = path.join(TMP, 'hook', '书D');
  fixture('hook/书D/大纲/细纲_第003章_试.md', '1. 第三开场。');
  fixture('hook/书D/追踪/_tracking-state.json', JSON.stringify({ schema_version: 1, last_committed_chapter: 2, state_revision: 2 }));
  const dLedger = path.join(bookD, '追踪', '待审台账.md');
  fixture('hook/书D/追踪/待审台账.md', [
    '| 章号 | 来源 | 报警/发现 | 终态 | 去向/备注 |',
    '|---|---|---|---|---|',
    '| 1 | ai-patterns | 碎化率 62% | 升级作者 | 请作者裁决后转豁免/关闭 |',
    '',
  ].join('\n'));
  r = runHook(['guard'], payload(path.join(bookD, '正文', '第003章_试.md')));
  check('Fw-07 guard 升级作者无裁决回填拦截（hook 侧）',
    r.status === 2 && r.stderr.includes('待审台账') && r.stderr.includes('已裁决'),
    `status=${r.status} err=${r.stderr.trim().slice(0, 120)}`);
  fs.writeFileSync(dLedger, [
    '| 章号 | 来源 | 报警/发现 | 终态 | 去向/备注 |',
    '|---|---|---|---|---|',
    '| 1 | ai-patterns | 碎化率 62% | 升级作者 | 已裁决：转豁免（ch1-3 密档），登豁免台账#1 |',
    '',
  ].join('\n'));
  r = runHook(['guard'], payload(path.join(bookD, '正文', '第003章_试.md')));
  check('Fw-07 guard 作者裁决回填后放行（hook 侧）',
    r.status === 0, `status=${r.status} err=${r.stderr.trim().slice(0, 120)}`);

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

  const okChap = fixture('hook/书A/正文/第006章_全.md', `# 第006章 全${'\n'}${longChapter(95)}`);
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
console.log('== 06 整改黄金样本回归（H2/O2/O3/I1/I2） ==');
{
  // H2 作者性泄漏（docs/06 §1.4）：整句与 4 字子句必报 blocking，化用放行（防的是抄，
  // 不防化用），无作者性项目静默（E6 唯一合法静默），占位符气卡报词源为空（检测空转）。
  fixture('h2leak/作者性/气卡.md', [
    '# 气卡',
    '',
    '| 字段 | 本书取值 |',
    '| --- | --- |',
    '| 气句 | 稳住，别慌。天塌不下来。（口述定稿） |',
    '',
  ].join('\n'));
  const leakFull = fixture('h2leak/正文/第001章_整句.md', '他稳住，别慌。天塌不下来。\n');
  const leakClause = fixture('h2leak/正文/第002章_子句.md', '他稳住，别慌，接着把账对完。\n');
  const paraphrase = fixture('h2leak/正文/第003章_化用.md', '账没乱，慌什么。天塌下来，当被盖。\n');
  let r = run('guyin-check-authority-leak.js', ['--json', leakFull, leakClause, paraphrase]);
  let report = parseJson(r.stdout);
  check('H2 整句泄漏必报 blocking', r.status === 1 && report
    && report.findings.some((f) => f.type === 'authority-leak' && f.severity === 'blocking'
      && f.file === leakFull),
    `status=${r.status} types=${JSON.stringify(report && report.findings.map((f) => f.type))}`);
  check('H2 四字子句泄漏必报 blocking（E1：稳住，别慌）', report
    && report.findings.some((f) => f.type === 'authority-leak' && f.severity === 'blocking'
      && f.file === leakClause),
    `types=${JSON.stringify(report && report.findings.map((f) => f.type))}`);
  check('H2 化用句静默（同一精神、不同措辞合法）', report
    && !report.findings.some((f) => f.file === paraphrase),
    `types=${JSON.stringify(report && report.findings.map((f) => f.type))}`);

  const noAuthority = fixture('h2plain/正文/第001章_净.md', '他稳住，别慌。天塌不下来。\n');
  r = run('guyin-check-authority-leak.js', ['--json', noAuthority]);
  report = parseJson(r.stdout);
  check('H2 无作者性项目静默（E6）', r.status === 0 && report && report.findings.length === 0,
    `status=${r.status} types=${JSON.stringify(report && report.findings.map((f) => f.type))}`);

  fixture('h2ph/作者性/气卡.md', [
    '# 气卡',
    '',
    '| 字段 | 本书取值 |',
    '| --- | --- |',
    '| 气句 | {{写你的气句}} |',
    '',
  ].join('\n'));
  const phText = fixture('h2ph/正文/第001章_占位.md', '他把账对完，收了笔。\n');
  r = run('guyin-check-authority-leak.js', ['--json', phText]);
  report = parseJson(r.stdout);
  check('H2 占位符气卡报词源为空 advisory', r.status === 1 && report
    && report.findings.some((f) => f.type === 'authority-source-empty' && f.severity === 'advisory'),
    `status=${r.status} types=${JSON.stringify(report && report.findings.map((f) => f.type))}`);

  // O2 细纲槽位完整性（docs/06 §二）：beat 版残缺细纲五类 blocking 全报；全字段细纲静默。
  const beatOutline = fixture('o2slots/大纲/细纲_第064章_beat版.md', [
    '# 细纲_第064章 试炼',
    '',
    '## beat',
    '',
    '- beat1：开场，林彻进账房',
    '- beat2：对手戏，与周砚对账',
    '- beat3：收尾',
    '',
  ].join('\n'));
  r = run('guyin-check-outline-slots.js', ['--json', beatOutline]);
  report = parseJson(r.stdout);
  for (const slot of ['hook', 'wordcount', 'multiline', 'anchor', 'holdback']) {
    check(`O2 beat 版残缺细纲必报 outline-missing-${slot}`, r.status === 1 && report
      && report.findings.some((f) => f.type === `outline-missing-${slot}` && f.severity === 'blocking'),
      `types=${JSON.stringify(report && report.findings.map((f) => f.type))}`);
  }

  const fullOutlineLines = [
    '# 细纲_第065章 齐全',
    '',
    '- 字数目标：3000',
    '- 场景与对手戏下限：≥2 场 / ≥1 对手戏',
    '- 情绪落点：①平心静气@点1（对总账）②起疑@点2（私账出入）③下决心@点3（缺页）',
    '- 主线：推进对账线，账本缺口浮出',
    '- 感情线：无显性，但关系变化为周砚开始交底',
    '- 复沓锚句：无',
    '- 禁止提前释放：无',
    '- 涉及场景：账房、当铺后巷',
    '- 术语锚点：无',
    '- 契约风险：低',
    '',
    '## 情节安排',
    '',
    '1. 开场：林彻核对总账',
    '2. 对手戏：周砚交出私账',
    '3. 收尾：发现缺页',
    '- 时序自检：出场顺序＝时间顺序；插叙无；beat 时间轴走查：通过',
    '',
    '章尾钩子：悬念型——挂在账本缺的那一页上；实体：账本缺页；承接：第66章对质。',
    '',
  ];
  const fullOutline = fixture('o2slots/大纲/细纲_第065章_全字段.md', fullOutlineLines.join('\n'));
  r = run('guyin-check-outline-slots.js', [fullOutline]);
  check('O2 全字段细纲静默（含 P1 时序自检行）', r.status === 0, `status=${r.status} out=${r.stdout.trim()}`);

  // P1 时序自检行（docs/07 §二）：全字段缺该行 → advisory outline-missing-timecheck
  //（源头治 E1 时序倒错，advisory 起步不拦落盘）。
  const noTimecheck = fixture('o2slots/大纲/细纲_第066章_缺时序.md',
    fullOutlineLines.filter((l) => !l.includes('时序自检')).join('\n'));
  r = run('guyin-check-outline-slots.js', ['--json', noTimecheck]);
  report = parseJson(r.stdout);
  check('P1 缺时序自检行报 advisory', r.status === 1 && report
    && report.findings.some((f) => f.type === 'outline-missing-timecheck' && f.severity === 'advisory'),
    `status=${r.status} types=${JSON.stringify(report && report.findings.map((f) => f.type))}`);

  // Q1 情绪落点（docs/08）：行缺失/计数不足 → advisory；豁免声明 → 静默。
  const noEmotion = fixture('o2slots/大纲/细纲_第067章_缺落点.md',
    fullOutlineLines.filter((l) => !l.includes('情绪落点')).join('\n'));
  r = run('guyin-check-outline-slots.js', ['--json', noEmotion]);
  report = parseJson(r.stdout);
  check('Q1 缺情绪落点行报 advisory', r.status === 1 && report
    && report.findings.some((f) => f.type === 'outline-missing-emotion-beats' && f.severity === 'advisory'),
    `status=${r.status} types=${JSON.stringify(report && report.findings.map((f) => f.type))}`);
  const fewEmotion = fixture('o2slots/大纲/细纲_第068章_两落点.md',
    fullOutlineLines.filter((l) => !l.includes('情绪落点'))
      .concat(['- 情绪落点：①平心静气@点1（对总账）②起疑@点2（私账出入）']).join('\n'));
  r = run('guyin-check-outline-slots.js', ['--json', fewEmotion]);
  report = parseJson(r.stdout);
  check('Q1 落点计数 2 报 advisory（下限 3）', r.status === 1 && report
    && report.findings.some((f) => f.type === 'outline-missing-emotion-beats'),
    `status=${r.status} types=${JSON.stringify(report && report.findings.map((f) => f.type))}`);
  const exemptEmotion = fixture('o2slots/大纲/细纲_第069章_豁免.md',
    fullOutlineLines.filter((l) => !l.includes('情绪落点'))
      .concat(['- 情绪落点：①平心静气@点1（对总账）②起疑@点2（私账出入）；低压章豁免']).join('\n'));
  r = run('guyin-check-outline-slots.js', ['--json', exemptEmotion]);
  report = parseJson(r.stdout);
  check('Q1 低压章豁免声明计数 2 静默', r.status === 0
    && report && !report.findings.some((f) => f.type === 'outline-missing-emotion-beats'),
    `status=${r.status} types=${JSON.stringify(report && report.findings.map((f) => f.type))}`);

  // S2 气卡坐标覆盖预检（docs/07 §二 S2；Y2 路径/口径修正，docs/09 §三）：章号不落
  // 「当前」坐标行区间 → advisory；落在区间内/气卡缺失/无当前行 → 静默（fail-open）。
  fixture('s2qy/作者性/气卡.md', '# 气卡\n\n当前阶段：第61-63章（卷三·山雨欲来）——以天合天。\n');
  const qyOutside = fixture('s2qy/大纲/细纲_第065章_试.md', fullOutlineLines.join('\n'));
  r = run('guyin-check-outline-slots.js', ['--json', qyOutside]);
  report = parseJson(r.stdout);
  check('S2 章号不在气卡坐标区间报 qiyun-coord-uncovered（65∉61-63）', r.status === 1 && report
    && report.findings.some((f) => f.type === 'qiyun-coord-uncovered' && f.severity === 'advisory'
      && f.message.includes('61-63')),
    `status=${r.status} types=${JSON.stringify(report && report.findings.map((f) => f.type))}`);
  const qyInside = fixture('s2qy/大纲/细纲_第062章_试.md', fullOutlineLines.join('\n'));
  r = run('guyin-check-outline-slots.js', ['--json', qyInside]);
  report = parseJson(r.stdout);
  check('S2 章号落在区间内静默（62∈61-63）', r.status === 0 && report && report.findings.length === 0,
    `status=${r.status} types=${JSON.stringify(report && report.findings.map((f) => f.type))}`);
  const qyNoCard = fixture('s2qy2/大纲/细纲_第065章_试.md', fullOutlineLines.join('\n'));
  r = run('guyin-check-outline-slots.js', ['--json', qyNoCard]);
  report = parseJson(r.stdout);
  check('S2 气卡缺失静默（fail-open 无假警报）', r.status === 0 && report && report.findings.length === 0,
    `status=${r.status} types=${JSON.stringify(report && report.findings.map((f) => f.type))}`);

  // Y2 双路径（白银案录形态）：坐标写在 设定/气韵卡.md，旧 parser 只找 作者性/气卡.md
  // → 永远 fail-open。卷级规划表（卷3（61-130））不算覆盖——当前行停在 ch28-32 时
  // ch61 细纲落盘必报（假绿灯封堵）；当前行刷新到本批区间后静默。
  fixture('y2qy/设定/气韵卡.md', [
    '# 气韵卡', '',
    '| 卷 | 气 |', '|---|---|', '| 卷3（61-130） | 盐路风尘气 |', '',
    '## 五、当前坐标（写作时必对）', '',
    '- **当前阶段**：卷2 中段（ch28-32 小窦事件·静水深流段）——大拆神余韵之后的小心肠', '',
  ].join('\n'));
  const yq61 = fixture('y2qy/大纲/细纲_第061章_试.md', fullOutlineLines.join('\n'));
  r = run('guyin-check-outline-slots.js', ['--json', yq61]);
  report = parseJson(r.stdout);
  check('Y2 设定/气韵卡.md 坐标停旧段必报（61∉28-32，卷3 规划行不算覆盖）', r.status === 1 && report
    && report.findings.some((f) => f.type === 'qiyun-coord-uncovered' && f.message.includes('28-32')
      && !f.message.includes('61-130')),
    `status=${r.status} types=${JSON.stringify(report && report.findings.map((f) => f.type))}`);
  fixture('y2qy/设定/气韵卡.md', [
    '# 气韵卡', '',
    '| 卷 | 气 |', '|---|---|', '| 卷3（61-130） | 盐路风尘气 |', '',
    '## 五、当前坐标（写作时必对）', '',
    '- **当前阶段**：卷3 开局（ch61-75 盐路风尘气）——好奇起步、卷首拉留存优先', '',
  ].join('\n'));
  r = run('guyin-check-outline-slots.js', ['--json', yq61]);
  report = parseJson(r.stdout);
  check('Y2 当前行刷新到本批区间后静默（61∈61-75）', r.status === 0 && report && report.findings.length === 0,
    `status=${r.status} types=${JSON.stringify(report && report.findings.map((f) => f.type))}`);
  fixture('y2qy2/作者性/气卡.md', '# 气卡\n\n- 当前阶段：卷{{X}} {{段名}}（ch{{A}}-{{B}} {{一句话基调}}）\n');
  const yq65 = fixture('y2qy2/大纲/细纲_第065章_试.md', fullOutlineLines.join('\n'));
  r = run('guyin-check-outline-slots.js', ['--json', yq65]);
  report = parseJson(r.stdout);
  check('Y2 模板坐标节未实例化（无数字区间）静默', r.status === 0 && report && report.findings.length === 0,
    `status=${r.status} types=${JSON.stringify(report && report.findings.map((f) => f.type))}`);

  // O3 字数验收个性化（docs/06 §二）：细纲「字数目标」驱动（×90%），无细纲缺省 3000。
  // 2014 字对缺省 3000 必报（ch63 事故形态）；同 2905 字对目标 3000 静默、对目标 3500
  // 必报——同字数不同判定，锁「目标驱动」而非「宽带硬编码」。
  const body2014 = `${longChapter(57)}他把账本从头翻到尾页，一页也没跳过去。\n`;
  const body2905 = longChapter(83);
  const o3a = fixture('o3wc/a/正文/第001章_短.md', `# 第001章 短\n${body2014}`);
  fixture('o3wc/b/大纲/细纲_第001章_试.md', '- 字数目标：3000\n');
  const o3b = fixture('o3wc/b/正文/第001章_达标.md', `# 第001章 达标\n${body2905}`);
  fixture('o3wc/c/大纲/细纲_第001章_试.md', '- 字数目标：3500\n');
  const o3c = fixture('o3wc/c/正文/第001章_欠.md', `# 第001章 欠\n${body2905}`);
  const o3d = fixture('o3wc/d/正文/第001章_近.md', `# 第001章 近\n${body2905}`);

  r = run('guyin-check-wordcount.js', ['--json', o3a]);
  report = parseJson(r.stdout);
  check('O3 2014 字对缺省 3000 必报 blocking', r.status === 1 && report
    && report.findings.some((f) => f.type === 'chapter-too-short' && f.severity === 'blocking'
      && f.count === 2014 && f.limit === 3000),
    `status=${r.status} findings=${JSON.stringify(report && report.findings.map((f) => `${f.count}/${f.limit}`))}`);

  r = run('guyin-check-wordcount.js', [o3b]);
  check('O3 同 2905 字对目标 3000 静默（×90% 达标线 2700）', r.status === 0,
    `status=${r.status} out=${r.stdout.trim().slice(0, 120)}`);

  r = run('guyin-check-wordcount.js', ['--json', o3c]);
  report = parseJson(r.stdout);
  check('O3 同 2905 字对目标 3500 必报（目标驱动）', r.status === 1 && report
    && report.findings.some((f) => f.type === 'chapter-too-short' && f.limit === 3150),
    `status=${r.status} findings=${JSON.stringify(report && report.findings.map((f) => `${f.count}/${f.limit}`))}`);

  r = run('guyin-check-wordcount.js', ['--json', o3d]);
  report = parseJson(r.stdout);
  check('O3 无细纲 2905 字对缺省 3000 必报', r.status === 1 && report
    && report.findings.some((f) => f.type === 'chapter-too-short' && f.limit === 3000),
    `status=${r.status} findings=${JSON.stringify(report && report.findings.map((f) => `${f.count}/${f.limit}`))}`);

  // J1 字数区间双口径（docs/07 §二）：区间 X-Y 取下限 X 不打折——「3000-3300」对 2900
  // 必报、对 3000 静默；旧 bug 把区间截为 3000 再九折＝2700 达标线，2712-2754 假达标。
  fixture('j1wc/a/大纲/细纲_第001章_试.md', '- 字数目标：3000-3300\n');
  const j1a = fixture('j1wc/a/正文/第001章_欠.md', `# 第001章 欠\n${longChapter(83)}`);
  r = run('guyin-check-wordcount.js', ['--json', j1a]);
  report = parseJson(r.stdout);
  check('J1 区间 3000-3300 对 2900 必报（下限 3000 不再打折）', r.status === 1 && report
    && report.findings.some((f) => f.type === 'chapter-too-short' && f.limit === 3000
      && f.message.includes('区间下限 3000')),
    `status=${r.status} findings=${JSON.stringify(report && report.findings.map((f) => `${f.count}/${f.limit}`))}`);

  fixture('j1wc/b/大纲/细纲_第001章_试.md', '- 字数目标：3000-3300\n');
  const j1b = fixture('j1wc/b/正文/第001章_达.md', `# 第001章 达\n${longChapter(87)}`);
  r = run('guyin-check-wordcount.js', ['--json', j1b]);
  check('J1 区间 3000-3300 对 3000 静默（旧 bug 九折 2700 线下假达标）', r.status === 0,
    `status=${r.status} out=${r.stdout.trim().slice(0, 120)}`);

  // J2 批内方差（docs/07 §二）：--batch 取章号最大 3 章实绩，max−min < 400 → advisory
  // chapter-length-uniform（E8 平整感信号）；--uniform-gap=N 覆盖缺省后静默。
  fixture('j2batch/大纲/细纲_第001章_试.md', '- 字数目标：3000\n');
  fixture('j2batch/大纲/细纲_第002章_试.md', '- 字数目标：3000\n');
  fixture('j2batch/大纲/细纲_第003章_试.md', '- 字数目标：3000\n');
  fixture('j2batch/正文/第001章.md', `# 第001章\n${longChapter(86)}`);
  fixture('j2batch/正文/第002章.md', `# 第002章\n${longChapter(85)}`);
  fixture('j2batch/正文/第003章.md', `# 第003章\n${longChapter(85)}`);
  r = run('guyin-check-wordcount.js', ['--json', '--batch', path.join(TMP, 'j2batch', '正文')]);
  report = parseJson(r.stdout);
  check('J2 均质批报 chapter-length-uniform advisory', r.status === 1 && report
    && report.findings.some((f) => f.type === 'chapter-length-uniform' && f.severity === 'advisory'),
    `status=${r.status} types=${JSON.stringify(report && report.findings.map((f) => f.type))}`);
  r = run('guyin-check-wordcount.js', ['--json', '--batch', '--uniform-gap=10', path.join(TMP, 'j2batch', '正文')]);
  check('J2 --uniform-gap=10 覆盖后静默（本书刻意均质豁免通道）', r.status === 0,
    `status=${r.status} out=${r.stdout.trim().slice(0, 120)}`);

  // I1 指纹库欠账（docs/06 §三）：库至第 1 章、受检至第 2 章 → blocking；--commit 补齐后静默。
  const projI1 = path.join(TMP, 'i1rep');
  const seg1 = '他把三本账并排摊开在案上，一页一页对过去，烛火在纸面上晃。翻到第三十七页，指尖停住了——那里缺了半页，撕口很新，不像虫蛀。他抬头看了周砚一眼，没有立刻问。\n';
  const seg2 = '周砚把私账从袖子里推过桌面，纸角底下压着一张当票，墨迹旧了两年。他把声音压得很低，说这是当年被人逼着签的死契，如今拿回来，账就能对上了。\n';
  const i1ch1 = fixture('i1rep/正文/第001章.md', `第一章\n\n${seg1}\n`);
  const i1ch2 = fixture('i1rep/正文/第002章.md', `第二章\n\n${seg2}\n`);

  r = run('guyin-check-repetition.js', ['--json', '--project', projI1, '--commit', i1ch1]);
  check('I1 前置：首章 commit 建库', r.status === 0, `status=${r.status} out=${r.stdout.trim().slice(0, 120)}`);

  r = run('guyin-check-repetition.js', ['--json', '--project', projI1, i1ch2]);
  report = parseJson(r.stdout);
  check('I1 指纹库欠账必报 blocking（库至第 1 章、受检至第 2 章）', r.status === 1 && report
    && report.findings.some((f) => f.type === 'fingerprint-arrears' && f.severity === 'blocking'
      && f.message.includes('指纹库欠账')),
    `status=${r.status} types=${JSON.stringify(report && report.findings.map((f) => f.type))}`);

  r = run('guyin-check-repetition.js', ['--json', '--project', projI1, '--commit', i1ch2]);
  const libI1 = JSON.parse(fs.readFileSync(path.join(projI1, '追踪', '段落指纹库.json'), 'utf8'));
  check('I1 --commit 补齐（库登记至第 2 章）', r.status === 0
    && libI1.entries.length === 2 && libI1.entries.every((e) => e.chapter <= 2),
    `status=${r.status} entries=${JSON.stringify(libI1.entries.map((e) => e.chapter))}`);

  r = run('guyin-check-repetition.js', ['--json', '--project', projI1, i1ch2]);
  report = parseJson(r.stdout);
  check('I1 补齐后欠账静默', r.status === 0 && report
    && !report.findings.some((f) => f.type === 'fingerprint-arrears'),
    `status=${r.status} types=${JSON.stringify(report && report.findings.map((f) => f.type))}`);

  // I2 短语黑名单（docs/06 §四）：登记短语每章超限报 advisory；无黑名单项目静默。
  check('I2 模板 短语黑名单.md 随模板分发',
    fs.existsSync(path.join(REPO, 'skills', 'guyin-setup', 'templates', 'long', '追踪', '短语黑名单.md')));
  fixture('i2quota/追踪/短语黑名单.md', [
    '# 短语黑名单',
    '',
    '| 短语 | 限额 |',
    '| --- | --- |',
    '| 记下 | 每章 ≤2 |',
    '',
  ].join('\n'));
  const quotaChap = fixture('i2quota/正文/第001章.md',
    '他记下了第一笔，又记下了第二笔，最后记下了第三笔，笔尖在纸上划出三道墨痕。\n');
  r = run('guyin-check-ai-patterns.js', ['--json', quotaChap]);
  report = parseJson(r.stdout);
  check('I2 黑名单每章超限必报 phrase-quota advisory', r.status === 1 && report
    && report.findings.some((f) => f.type === 'phrase-quota' && f.severity === 'advisory'
      && f.message.includes('记下')),
    `status=${r.status} types=${JSON.stringify(report && report.findings.map((f) => f.type))}`);

  const plainChap = fixture('i2plain/正文/第001章.md',
    '他记下了第一笔，又记下了第二笔，最后记下了第三笔，笔尖在纸上划出三道墨痕。\n');
  r = run('guyin-check-ai-patterns.js', [plainChap]);
  check('I2 无黑名单项目静默', r.status === 0, `status=${r.status} out=${r.stdout.trim().slice(0, 120)}`);
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
    'long/.claude/agents/guyin-checker.md',
    'long/.codex/agents/guyin-beat-writer.toml',
    'long/.codex/agents/guyin-checker.toml',
    'long/.opencode/agents/guyin-beat-writer.md',
    'long/.opencode/agents/guyin-checker.md',
    'long/.opencode/commands/guyin.md',
    'long/作者性/气卡.md',
    'long/作者性/指纹.md',
    'long/作者性/偏执点.md',
    'long/作者性/魂档案.md',
    'long/作者性/粒度配置.md',
    'long/作者性/参考-气质谱系.md',
    'long/作者性/口述定稿单.md',
    'long/作者性/语言纪律.md',
    'long/作者性/纪律冲突台账.md',
    'long/大纲/README.md',
    'long/大纲/魂谱对表.md',
    'long/大纲/执行层一页纸.md',
    'long/追踪/_tracking-state.json',
    'short/大纲/情节节点.md',
    'short/大纲/情绪曲线.md',
    'short/大纲/反转表.md',
  ];
  for (const rel of required) {
    check(`模板存在 ${rel}`, fs.existsSync(path.join(T, rel)));
  }

  // Fw-03：部署件默认不得预置假 model（非注释行无 model 配置），且必须明示等同 solo 的去向——
  // 占位 model 会让用户误以为编排/执行已分层，是 solo 路径失效的源头。
  const agentEndpoints = [
    ['long/.claude/agents/guyin-beat-writer.md', /^model\s*:/m],
    ['long/.claude/agents/guyin-checker.md', /^model\s*:/m],
    ['long/.opencode/agents/guyin-beat-writer.md', /^model\s*:/m],
    ['long/.opencode/agents/guyin-checker.md', /^model\s*:/m],
    ['long/.codex/agents/guyin-beat-writer.toml', /^model\s*=/m],
    ['long/.codex/agents/guyin-checker.toml', /^model\s*=/m],
  ];
  for (const [rel, activeModelRe] of agentEndpoints) {
    const content = fs.readFileSync(path.join(T, rel), 'utf8');
    const active = content.split(/\r?\n/)
      .filter((l) => !/^\s*#/.test(l))
      .some((l) => activeModelRe.test(l));
    check(`Fw-03 ${rel} 默认无生效 model 行（占位即假分层）`, !active, `命中生效 model 行`);
    check(`Fw-03 ${rel} 明示 solo 去向`, /solo/.test(content), `文件缺 solo 说明`);
  }
}

// ============================================================
console.log('== Y4 灵感台账状态位（模板契约，docs/09 §三） ==');
{
  const ledgerTpl = fs.readFileSync(
    path.join(REPO, 'skills', 'guyin-setup', 'templates', 'long', '追踪', '灵感台账.md'),
    'utf8',
  );
  for (const state of ['候选', '转正', '保护', '弃用']) {
    check(`Y4 状态位含「${state}」`, ledgerTpl.includes(`{{候选 / 转正 / 保护 / 弃用}}`) || ledgerTpl.includes(state));
  }
  check('Y4 弃用须理由＋替代物（终态登记）', ledgerTpl.includes('理由＋替代物'));
  check('Y4 保护资产过堂纪律（过堂不落卡＝静默弃用）', ledgerTpl.includes('过堂') && ledgerTpl.includes('静默弃用'));
  check('Y4 弃用同步偏差区（U2 联动）', ledgerTpl.includes('偏差区'));
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
console.log('== SP2 直引号字符集迁移（docs/11 §一 SP2，三文件六处） ==');
{
  // SP2-deliver（outline-deliver inQuoteAt）：术语锚点「勘合」正文首现落在直引号对白内 →
  // outline-term-unanchored 零报（迁移前必报——只认「」/""，直引号判非对白）。
  const proj = path.join(TMP, 'sp2-deliver');
  fixture('sp2-deliver/大纲/细纲_第001章.md', [
    '# 细纲 第001章',
    '',
    '- 术语锚点：勘合（小窦问、燕衡答）',
    '- 章尾钩子：实体：票据',
  ].join('\n'));
  const ch = fixture('sp2-deliver/正文/第001章.md',
    '第一章\n\n燕衡把票据摊在案上，指节压住边角，等对面那人开口。\n'
      + '"跟铺子里骑缝的存根一个理，这就是勘合的法子。"对面那人终于答了。\n');
  let r = run('guyin-check-outline-deliver.js', ['--json', ch]);
  let rep = parseJson(r.stdout);
  check('SP2-deliver 直引号对白内术语首现判对白（outline-term-unanchored 零报）',
    r.status === 0 && rep
      && !rep.findings.some((f) => f.type === 'outline-term-unanchored' && (f.excerpt || '').includes('勘合')),
    `status=${r.status} findings=${JSON.stringify(rep && rep.findings.map((f) => `${f.type}:${f.excerpt}`))}`);

  // SP2-narrative（repetition isNarrative）：直引号对白占段落 60% 字符 → isNarrative 判 false
  // → 对白段不进叙述扫描，对白内「袖里的账」不产 tic 候选（迁移前对白算叙述，会被当 tic 报）。
  // 实测口径：构造长段，对白占比 >50%，跑 repetition --commit 不报任何复读（无叙述候选）。
  fixture('sp2-narrative/追踪/_tracking-state.json', JSON.stringify({
    schema_version: 7, characters: { 燕衡: { identity: '主角' } },
  }));
  const chNarr = fixture('sp2-narrative/正文/第001章.md',
    '第一章\n\n'
      + '"他说的全记在袖里的账上，半个字也不差，你只管去查。"对面那人答得干脆，把袖里的账又数了一遍才歇。\n');
  r = run('guyin-check-repetition.js', ['--json', '--project', path.join(TMP, 'sp2-narrative'),
    '--commit', chNarr]);
  rep = parseJson(r.stdout);
  check('SP2-narrative 直引号对白段不进叙述扫描（isNarrative 判 false）',
    rep && !rep.findings.some((f) => f.type.startsWith('phrase-echo-') && (f.excerpt || '').includes('袖里的账')),
    `status=${r.status} findings=${JSON.stringify(rep && rep.findings.map((f) => `${f.type}:${f.excerpt}`))}`);

  // SP2-split（repetition ECHO_SPLIT）：两直引号对白相邻 → n-gram 不产出跨边界短语。
  // 「"钱给你"。"货给我。"」按 ECHO_SPLIT 切段后「钱给你」「货给我」分属两段，
  // 不应产出「给你货给」类跨引号串（迁移前会成词，作为 4-gram 候选入库）。
  fixture('sp2-split/追踪/_tracking-state.json', JSON.stringify({
    schema_version: 7, characters: { 燕衡: { identity: '主角' } },
  }));
  const chSplit = fixture('sp2-split/正文/第001章.md',
    '第一章\n\n"钱给你"。"货给我。"\n'
      + '又添了几笔说明才收住，把账页重新码齐推到案沿下头，等对面那人先开口再说，他才肯把底牌亮出来。\n');
  r = run('guyin-check-repetition.js', ['--json', '--project', path.join(TMP, 'sp2-split'),
    '--commit', chSplit]);
  rep = parseJson(r.stdout);
  const lib = JSON.parse(fs.readFileSync(path.join(TMP, 'sp2-split', '追踪', '段落指纹库.json'), 'utf8'));
  check('SP2-split 直引号相邻对白不跨边界成词（无「给你货给」类串入库）',
    rep && !lib.phrases.some((p) => p.phrase.includes('给你货给') || p.phrase.includes('你货')),
    `status=${r.status} phrases=${JSON.stringify((lib.phrases || []).map((p) => p.phrase))}`);

  // SP2-beat（beat PSYCH_VERBS 负向断言 + stripQuoted）：叙述行「他心想这买卖做得」+ 对白
  // `"我觉得还行"` → 心理计数只算叙述层 +1（「心想」），对白内「觉得」不计（stripQuoted 剥除后归零）。
  const chBeat = fixture('sp2-beat/第001章_beat.md',
    '他心想这买卖做得，端起茶碗抿了一口。\n'
      + '"我觉得还行，你别老不信。"对面那人摆手，又催了一遍。\n');
  r = run('guyin-check-beat.js', ['--json', '--mono-limit=0', '--min=10', '--max=2000', chBeat]);
  rep = parseJson(r.stdout);
  const mono = rep && rep.findings.find((f) => f.type === 'mono-count');
  check('SP2-beat 心理计数：叙述行 +1（心想），对白内「觉得」不计（stripQuoted 剥除）',
    mono && mono.count === 1,
    `status=${r.status} findings=${JSON.stringify(rep && rep.findings.map((f) => `${f.type}:${f.count}`))}`);
}

// ============================================================
console.log('== SP1 同章短语复读门（docs/11 §一 SP1，repetition 第三分支+白名单） ==');
{
  // SP1-正例：单章同短语 ×2 中段（隔一拍） → phrase-echo-inline，报最长形。
  // A1' 实证形态：ch62「踏平的灰地」L79/L83 同拍重复。
  fixture('sp1/追踪/_tracking-state.json', JSON.stringify({
    schema_version: 7, characters: { 燕衡: { identity: '主角' } },
  }));
  const filler = '院里起了风，吹得檐下的灯晃来晃去。他把账册翻了一遍又一遍，没找出新的字迹来。月光铺在阶上像层霜，他也没觉出冷来。';
  const tail = '风从棚区那头刮过来，他把衣领拢了拢，在阶上又站了一会儿才回屋去。';
  const chPos = fixture('sp1/正文/第001章.md',
    `第一章\n\n他看着他踏平的灰地，没追问。${filler}他看着他踏平的灰地，没追问。${tail}\n`);
  let r = run('guyin-check-repetition.js', ['--json', '--project', path.join(TMP, 'sp1'),
    '--commit', chPos]);
  let rep = parseJson(r.stdout);
  check('SP1-正例 同章中段同拍重复 ×2 报 phrase-echo-inline',
    r.status === 1 && rep
      && rep.findings.some((f) => f.type === 'phrase-echo-inline'
        && (f.excerpt || '').includes('踏平的灰地')),
    `status=${r.status} findings=${JSON.stringify(rep && rep.findings.map((f) => `${f.type}:${f.excerpt}`))}`);

  // SP1-章尾归 ending：同短语 ×2 但末次出现在文本 85% 位置之后 → 报 phrase-echo-ending，
  // 不报 inline（else-if 链互斥验证）。
  const endingPhrase = '更声敲过三遍';
  const head = '他把账册摊开又合上，'.repeat(8);
  const chEnd = fixture('sp1/正文/第002章.md',
    `第二章\n\n${head}${endingPhrase}，周砚还没歇，笔尖在纸上沙沙地走。${'他又添了几笔说明，'.repeat(2)}${endingPhrase}。\n`);
  r = run('guyin-check-repetition.js', ['--json', '--project', path.join(TMP, 'sp1'),
    '--commit', chEnd]);
  rep = parseJson(r.stdout);
  check('SP1-章尾归 ending（同短语×2 末次落章尾 → 报 ending 不报 inline，互斥）',
    rep && rep.findings.some((f) => f.type === 'phrase-echo-ending' && f.excerpt === endingPhrase)
      && !rep.findings.some((f) => f.type === 'phrase-echo-inline' && f.excerpt === endingPhrase),
    `status=${r.status} findings=${JSON.stringify(rep && rep.findings.map((f) => `${f.type}:${f.excerpt}`))}`);

  // SP1-cross 优先：同短语本章 2 次 + 库内近 5 章 1 次（合计 3）→ 报 phrase-echo-cross，
  // 不报 inline（够 cross 不报 inline，零双报）。
  const crossPhrase = '旧讫印压在案上';
  const ch3Filler = '院里起了风，吹得檐下的灯晃来晃去。他把账册翻了一遍又一遍，没找出新的字迹来。月光铺在阶上像层霜，他也没觉出冷来。';
  const ch4Filler = '窗外的更鼓敲了一轮，他把茶碗搁下，没续那盏灯。纸上写的字已干透了，他折好塞进袖袋里。';
  fixture('sp1/正文/第003章.md',
    `第三章\n\n${crossPhrase}，他没动。${ch3Filler}${crossPhrase}，他终于开口。\n`);
  // 先 commit ch3，再 commit ch4 同短语 ×1 → ch4 总数 = 1(本章)+2(库内 ch3)=3 ≥ 3 → 报 cross。
  r = run('guyin-check-repetition.js', ['--json', '--project', path.join(TMP, 'sp1'),
    '--commit', path.join(TMP, 'sp1', '正文', '第003章.md')]);
  // SP2 fix：crossPhrase 必须落在 ≥40 字叙述段内（isNarrative 门槛），单行短句会被过滤致 count=0。
  const ch4 = fixture('sp1/正文/第004章.md',
    `第四章\n\n${crossPhrase}，他抬眼看了对面那人一眼。${ch4Filler}\n`);
  r = run('guyin-check-repetition.js', ['--json', '--project', path.join(TMP, 'sp1'),
    '--commit', ch4]);
  rep = parseJson(r.stdout);
  check('SP1-cross 优先（够 cross 不报 inline，零双报）',
    rep && rep.findings.some((f) => f.type === 'phrase-echo-cross' && f.excerpt === crossPhrase)
      && !rep.findings.some((f) => f.type === 'phrase-echo-inline' && f.excerpt === crossPhrase),
    `status=${r.status} findings=${JSON.stringify(rep && rep.findings.map((f) => `${f.type}:${f.excerpt}`))}`);

  // SP1-白名单：复沓锚句.md 登记「算盘」，正文「袖里那把算盘」×2 → 零报（白名单跳过）。
  fixture('sp1-wl/追踪/_tracking-state.json', JSON.stringify({
    schema_version: 7, characters: { 燕衡: { identity: '主角' } },
  }));
  fixture('sp1-wl/追踪/复沓锚句.md', [
    '# 复沓锚句',
    '',
    '| 实体 |',
    '| --- |',
    '| 算盘 |',
    '',
  ].join('\n'));
  const chWl = fixture('sp1-wl/正文/第001章.md',
    `第一章\n\n袖里那把算盘被他攥得发烫，没拿出来。${filler}袖里那把算盘还是没拿出来，他终于开了口。\n`);
  r = run('guyin-check-repetition.js', ['--json', '--project', path.join(TMP, 'sp1-wl'),
    '--commit', chWl]);
  rep = parseJson(r.stdout);
  check('SP1-白名单 复沓锚句.md 登记「算盘」豁免（同短语×2 零报）',
    rep && !rep.findings.some((f) => (f.excerpt || '').includes('算盘')),
    `status=${r.status} findings=${JSON.stringify(rep && rep.findings.map((f) => `${f.type}:${f.excerpt}`))}`);
}

// ============================================================
console.log('== SP3 口吃标点模式（docs/11 §一 SP3，ai-patterns 新函数） ==');
{
  // SP3-正例：直引号对白内「这：这」 → 报 stutter-punct，excerpt=「这：这」。
  const chPos = fixture('sp3/正文/第001章.md',
    '第一章\n\n"客官，这：这是正经路数来的。"对面那人赔着笑，又把茶碗推过去。\n');
  let r = run('guyin-check-ai-patterns.js', ['--json', chPos]);
  let rep = parseJson(r.stdout);
  check('SP3-正例 同字夹冒号报 stutter-punct',
    r.status === 1 && rep
      && rep.findings.some((f) => f.type === 'stutter-punct' && f.severity === 'advisory'
        && (f.excerpt || '') === '这：这'),
    `status=${r.status} findings=${JSON.stringify(rep && rep.findings.map((f) => `${f.type}:${f.excerpt}`))}`);

  // SP3-反例：冒号后接「这」但前字非同字（「念头：这事没完」前字是「头」） → 零报。
  const chNeg = fixture('sp3/正文/第002章.md',
    '第二章\n\n他心里只有一个念头：这事没完，得接着查下去。\n');
  r = run('guyin-check-ai-patterns.js', ['--json', chNeg]);
  rep = parseJson(r.stdout);
  check('SP3-反例 冒号后接「这」但前字非同字（零报）',
    rep && !rep.findings.some((f) => f.type === 'stutter-punct'),
    `status=${r.status} findings=${JSON.stringify(rep && rep.findings.map((f) => `${f.type}:${f.excerpt}`))}`);
}

// ============================================================
console.log('== PV2 视角纪律（docs/11 §二 PV2，ai-patterns 状态机扫描） ==');
{
  // PV2-显式：公约 POV=燕衡；叙述「书办心里叫苦」「书办暗自盘算」两处显式人名 →
  // 报 pov-drift N=2，句位两处（subject=书办）。
  fixture('pv2-exp/大纲/批次公约.md', [
    '# 批次公约（第 1-3 章）',
    '',
    '- 批次区间：第 1-3 章',
    '- 引号规格：对白 " "，嵌套 \' \'',
    '- 视角规格：POV=燕衡（第三有限）；对手/配角内心禁直写',
    '',
  ].join('\n'));
  fixture('pv2-exp/追踪/_tracking-state.json', JSON.stringify({
    schema_version: 7, characters: { 燕衡: { identity: '主角' }, 书办: { identity: '对手' } },
  }));
  const chExp = fixture('pv2-exp/正文/第001章.md',
    '第一章\n\n燕衡把票据摊在案上，没说话。书办心里叫苦，脸上却堆着笑，把茶碗又推过去。'
      + '燕衡抬眼看了他一眼，还是没接话。书办暗自盘算，今天怕是过不去这关了。\n');
  let r = run('guyin-check-ai-patterns.js', ['--json', chExp]);
  let rep = parseJson(r.stdout);
  const pv = rep && rep.findings.find((f) => f.type === 'pov-drift');
  check('PV2-显式 公约 POV=燕衡；书办内心×2 报 pov-drift N=2',
    r.status === 1 && pv && pv.severity === 'advisory' && (pv.message || '').includes('2 处')
      && (pv.message || '').includes('POV=燕衡') && (pv.message || '').includes('书办'),
    `status=${r.status} findings=${JSON.stringify(rep && rep.findings.map((f) => `${f.type}:${f.message.slice(0, 50)}`))}`);

  // PV2-回指：「书办搓了搓手。他忽然拿不准眼前这位，到底是哪路人。……他备好了一肚子的话」
  // → 一跳回指书办 + 心理动词两处（拿不准、备好了）→ N=2 命中。
  fixture('pv2-pro/大纲/批次公约.md', [
    '# 批次公约',
    '',
    '- 视角规格：POV=燕衡（第三有限）',
    '',
  ].join('\n'));
  fixture('pv2-pro/追踪/_tracking-state.json', JSON.stringify({
    schema_version: 7, characters: { 燕衡: { identity: '主角' }, 书办: { identity: '对手' } },
  }));
  const chPro = fixture('pv2-pro/正文/第001章.md',
    '第一章\n\n书办搓了搓手，把茶碗往那头推了推。'
      + '他忽然拿不准眼前这位，到底是哪路人，话到嘴边又咽了回去。'
      + '他备好了一肚子的话，这下连一个字都说不出来。\n');
  r = run('guyin-check-ai-patterns.js', ['--json', chPro]);
  rep = parseJson(r.stdout);
  const pvPro = rep && rep.findings.find((f) => f.type === 'pov-drift');
  check('PV2-回指 一跳代词回指 + 心理动词×2 报 pov-drift（subject=书办）',
    pvPro && (pvPro.message || '').includes('2 处') && (pvPro.message || '').includes('书办'),
    `status=${r.status} findings=${JSON.stringify(rep && rep.findings.map((f) => `${f.type}:${(f.message || '').slice(0, 50)}`))}`);

  // PV2-单处静默：仅「书办心里叫苦」一处 → 零报（1 处静默）。
  fixture('pv2-solo/大纲/批次公约.md', [
    '# 批次公约',
    '',
    '- 视角规格：POV=燕衡（第三有限）',
    '',
  ].join('\n'));
  fixture('pv2-solo/追踪/_tracking-state.json', JSON.stringify({
    schema_version: 7, characters: { 燕衡: { identity: '主角' }, 书办: { identity: '对手' } },
  }));
  const chSolo = fixture('pv2-solo/正文/第001章.md',
    '第一章\n\n燕衡把票据摊在案上。书办心里叫苦，脸上却堆着笑，把茶碗推过去。\n');
  r = run('guyin-check-ai-patterns.js', ['--json', chSolo]);
  rep = parseJson(r.stdout);
  check('PV2-单处静默（书办心理×1 不报，给喜剧拍留空间）',
    rep && !rep.findings.some((f) => f.type === 'pov-drift'),
    `status=${r.status} findings=${JSON.stringify(rep && rep.findings.map((f) => `${f.type}:${f.excerpt}`))}`);

  // PV2-静默态：公约无视角规格行（POV=全知）→ fail-open 零报。
  fixture('pv2-open/大纲/批次公约.md', [
    '# 批次公约',
    '',
    '- 批次区间：第 1-3 章',
    '- 引号规格：对白 " "',
    '',
  ].join('\n'));
  fixture('pv2-open/追踪/_tracking-state.json', JSON.stringify({
    schema_version: 7, characters: { 燕衡: { identity: '主角' }, 书办: { identity: '对手' } },
  }));
  const chOpen = fixture('pv2-open/正文/第001章.md',
    '第一章\n\n燕衡把票据摊在案上。书办心里叫苦，脸上却堆着笑。书办暗自盘算怎么应付。\n');
  r = run('guyin-check-ai-patterns.js', ['--json', chOpen]);
  rep = parseJson(r.stdout);
  check('PV2-静默态 无视角规格行 fail-open（不扫，零报）',
    rep && !rep.findings.some((f) => f.type === 'pov-drift'),
    `status=${r.status} findings=${JSON.stringify(rep && rep.findings.map((f) => `${f.type}`))}`);
}

// ============================================================
console.log('== Fw-05 beat 心理动词拆分（合法认知半句不计数/情绪告知计数） ==');
{
  // 知道/明白/清楚/疑惑/纳闷：合法认知半句，不再计 mono-count（追影事故纠偏）。
  const cognition = fixture('fw05beat/cog.md',
    '他知道这病几年后会要父亲的命。他明白瞒不住了。他清楚时日无多。他疑惑地看向门口，心里纳闷来人是谁。\n');
  let r = run('guyin-check-beat.js', ['--json', '--min=10', '--mono-limit=0', cognition]);
  let report = parseJson(r.stdout);
  check('Fw-05 知道/明白/清楚/疑惑/纳闷不计数（mono-limit=0 仍零报）',
    report && !report.findings.some((f) => f.type === 'mono-count'),
    `findings=${JSON.stringify(report && report.findings.map((f) => f.type))}`);

  // 内心独白标记（心想）+ 情绪告知词（愤怒/恐惧）引号外计数；对白内「觉得」不计。
  const emotion = fixture('fw05beat/emo.md',
    '他心想不妙。她愤怒地拍桌，心头一阵恐惧。她抬眼说：“我觉得不成。”\n');
  r = run('guyin-check-beat.js', ['--json', '--min=10', '--mono-limit=2', emotion]);
  report = parseJson(r.stdout);
  const mono = report && report.findings.find((f) => f.type === 'mono-count');
  check('Fw-05 心想/愤怒/恐惧计 3（对白内觉得不计），超 limit=2 报 mono-count',
    !!mono && mono.count === 3, `mono=${JSON.stringify(mono)}`);
}

// ============================================================
console.log('== Fw-01 开篇留存门 guyin-check-opening-retention ==');
{
  const goodOutline = [
    '# 细纲_第001章',
    '- 当下目标：收摊前挣到面钱，给父亲抓药',
    '- 能力实证：一眼报准客人病灶，满座失声',
    '- 情绪温度：①情绪@点2 热——围观排队',
    '- 即兑钩子：实体：订金信封；兑现：第4章 验真',
  ].join('\n');
  const good = fixture('fw01/大纲/细纲_第001章.md', `${goodOutline}\n`);
  let r = run('guyin-check-opening-retention.js', ['--json', good]);
  check('Fw-01 ch001 四字段齐＋兑付第4章≤5 通过', r.status === 0, `status=${r.status} out=${r.stdout.trim()}`);

  // 目标值「无」判缺失＋其余三行缺失 = 4 条 blocking。
  const bad = fixture('fw01bad/大纲/细纲_第002章.md', '# 细纲\n- 当下目标：无\n');
  r = run('guyin-check-opening-retention.js', ['--json', bad]);
  let report = parseJson(r.stdout);
  const miss = report ? report.findings.filter((f) => f.type === 'opening-retention-missing' && f.severity === 'blocking') : [];
  check('Fw-01 值「无」＋字段缺失共 4 条 blocking', r.status === 1 && miss.length === 4,
    `status=${r.status} n=${miss.length}`);

  // 兑付章号 >5 → blocking。
  const far = fixture('fw01far/大纲/细纲_第003章.md',
    goodOutline.replace('细纲_第001章', '细纲_第003章').replace('兑现：第4章 验真', '兑现：第8章 验真') + '\n');
  r = run('guyin-check-opening-retention.js', ['--json', far]);
  report = parseJson(r.stdout);
  check('Fw-01 兑付第8章 >5 blocking',
    r.status === 1 && report && report.findings.some((f) => f.message.includes('第 8 章')),
    `status=${r.status}`);

  // {{占位}} 值判缺失。
  const ph = fixture('fw01ph/大纲/细纲_第001章.md',
    goodOutline.replace('收摊前挣到面钱，给父亲抓药', '{{主角目标待填}}') + '\n');
  r = run('guyin-check-opening-retention.js', ['--json', '--fail-on=blocking', ph]);
  check('Fw-01 {{占位}} 值 fail-on=blocking exit 1', r.status === 1, `status=${r.status}`);

  // 非黄金三章静默。
  const ch4 = fixture('fw01ch4/大纲/细纲_第004章.md', '# 细纲\n完全没有留存字段的普通细纲\n');
  r = run('guyin-check-opening-retention.js', ['--json', ch4]);
  report = parseJson(r.stdout);
  check('Fw-01 ch004+ 静默 exit 0 零 findings',
    r.status === 0 && report && report.findings.length === 0, `status=${r.status}`);

  // 无兑付章号 → blocking。
  const nopay = fixture('fw01nopay/大纲/细纲_第002章.md',
    goodOutline.replace('；兑现：第4章 验真', '；长周期回收') + '\n');
  r = run('guyin-check-opening-retention.js', ['--json', nopay]);
  report = parseJson(r.stdout);
  check('Fw-01 即兑钩子无兑付章号 blocking',
    r.status === 1 && report && report.findings.some((f) => f.message.includes('缺近期兑现章号')),
    `status=${r.status}`);
}

// ============================================================
console.log('== Fw-02 prose-fragment-ratio（碎化率，密/疏双轨配套） ==');
{
  const SHORT = '他放下碗走了。'; // 7 字短叙述段
  const LONG = SCENE; // 34 字长叙述段

  // 40 短 + 20 长 = 66.7% → blocking。
  const heavy = fixture('fw02heavy/正文/第001章_碎.md',
    `${[...Array(40)].map(() => SHORT).join('\n')}\n${[...Array(20)].map(() => LONG).join('\n')}\n`);
  let r = run('guyin-check-ai-patterns.js', ['--json', '--fail-on=blocking', heavy]);
  let report = parseJson(r.stdout);
  let f = report && report.findings.find((x) => x.type === 'prose-fragment-ratio');
  check('Fw-02 碎化 67% blocking（--fail-on=blocking exit 1）',
    r.status === 1 && f && f.severity === 'blocking' && f.ratio > 0.4,
    `status=${r.status} f=${JSON.stringify(f && f.severity)}`);

  // 10 短 + 28 长 = 26.3% → advisory。
  const mild = fixture('fw02mild/正文/第001章_轻.md',
    `${[...Array(10)].map(() => SHORT).join('\n')}\n${[...Array(28)].map(() => LONG).join('\n')}\n`);
  r = run('guyin-check-ai-patterns.js', ['--json', mild]);
  report = parseJson(r.stdout);
  f = report && report.findings.find((x) => x.type === 'prose-fragment-ratio');
  check('Fw-02 碎化 26% advisory（>25% 且 ≤40%）',
    f && f.severity === 'advisory' && f.ratio > 0.25 && f.ratio <= 0.4,
    `f=${JSON.stringify(f && [f.severity, f.ratio])}`);
  r = run('guyin-check-ai-patterns.js', ['--fail-on=blocking', mild]);
  check('Fw-02 advisory 不触发 --fail-on=blocking', r.status === 0, `status=${r.status}`);

  // 样本不足（10 段）静默。
  const tiny = fixture('fw02tiny/正文/第001章_少.md',
    `${[...Array(10)].map(() => SHORT).join('\n')}\n`);
  r = run('guyin-check-ai-patterns.js', ['--json', tiny]);
  report = parseJson(r.stdout);
  check('Fw-02 样本不足（<30 段/<800 字）静默',
    report && !report.findings.some((x) => x.type === 'prose-fragment-ratio'),
    `types=${JSON.stringify(report && report.findings.map((x) => x.type))}`);

  // 细纲「碎化豁免」→ blocking 降 advisory。
  fixture('fw02heavy/大纲/细纲_第001章.md', '# 细纲\n碎化豁免：本章过场，一句一段刻意为之。\n');
  r = run('guyin-check-ai-patterns.js', ['--json', '--fail-on=blocking', heavy]);
  report = parseJson(r.stdout);
  f = report && report.findings.find((x) => x.type === 'prose-fragment-ratio');
  check('Fw-02 细纲碎化豁免后降 advisory（--fail-on=blocking exit 0）',
    r.status === 0 && f && f.severity === 'advisory', `status=${r.status} f=${JSON.stringify(f && f.severity)}`);
}

// ============================================================
console.log('== Fw-06 真人试读门 guyin-check-trial-gate ==');
{
  const HEADER = [
    '## 试读记录',
    '',
    '| 日期 | 试读人 | 章范围 | 想不想看下一章 | 记住了谁 | 想划下来的句子 | 能力实证 | 当下目标 | 情绪热度 | 我猜对了 |',
    '|---|---|---|---|---|---|---|---|---|---|',
  ];
  const trialProject = (name, tableLines) => {
    const dir = path.join(TMP, 'fw06', name);
    fixture('fw06/' + name + '/追踪/读者信号.md',
      `# 读者信号\n\n| 章 | 追读 | 评论关键词 |\n|----|------|-----------|\n\n${[...HEADER, ...tableLines].join('\n')}\n`);
    return dir;
  };
  const tg = (dir, n, failOn) => run('guyin-check-trial-gate.js',
    ['--project', dir, '--chapter', String(n), '--json', ...(failOn ? [`--fail-on=${failOn}`] : [])]);

  // ch1-3 写作期静默（含无文件场景）。
  let r = tg(path.join(TMP, 'fw06', 'none'), 3);
  let report = parseJson(r.stdout);
  check('Fw-06 ch3 静默（写作期不需要试读）',
    r.status === 0 && report && report.findings.length === 0, `status=${r.status}`);

  // 读者信号.md 缺失 → fail-open（老项目）。
  r = tg(path.join(TMP, 'fw06', 'none'), 4);
  report = parseJson(r.stdout);
  check('Fw-06 读者信号缺失 fail-open exit 0',
    r.status === 0 && report && report.missing === true, `status=${r.status} out=${r.stdout.slice(0, 120)}`);

  // 文件在但无试读节 → blocking（模板已部署不填）。
  const noSec = path.join(TMP, 'fw06', 'nosec');
  fixture('fw06/nosec/追踪/读者信号.md', '# 读者信号\n\n| 章 | 追读 |\n|----|------|\n');
  r = tg(noSec, 4);
  report = parseJson(r.stdout);
  check('Fw-06 无试读记录节 → blocking trial-gate-missing',
    r.status === 1 && report.findings.length === 1
      && report.findings[0].type === 'trial-gate-missing' && report.findings[0].severity === 'blocking',
    `status=${r.status} f=${JSON.stringify(report.findings)}`);

  // 节内只有表头+占位行 → blocking。
  const empty = trialProject('empty', ['| {{日期}} | {{谁}} | {{1-3}} | | | | | | | |']);
  r = tg(empty, 4);
  report = parseJson(r.stdout);
  check('Fw-06 试读节仅占位行 → blocking',
    r.status === 1 && report.findings.some((f) => f.type === 'trial-gate-missing'),
    `status=${r.status} f=${JSON.stringify(report.findings)}`);

  // 一条真人试读 1-3 → ch4 放行。
  const good = trialProject('good', [
    '| 9-14 | 表妹（没看过设定） | 1-3 | 想，问订金是谁放的 | 沈亦舟，闻碗就辨出地沟油 | 「面要热，账要清」 | 是 | 是 | 是 | 是：猜主角会拿订金做局 |',
  ]);
  r = tg(good, 4);
  report = parseJson(r.stdout);
  check('Fw-06 覆盖 ch1-3 的真人试读 → ch4 放行 exit 0',
    r.status === 0 && report.findings.length === 0, `status=${r.status} f=${JSON.stringify(report.findings)}`);

  // 只覆盖 1-2 → blocking 且文案点出缺 ch3。
  const partial = trialProject('partial', [
    '| 9-14 | 表妹 | 1-2 | 想 | 沈亦舟 | 无 | 是 | 是 | 否 | 否 |',
  ]);
  r = tg(partial, 4);
  report = parseJson(r.stdout);
  check('Fw-06 只覆盖 ch1-2 → blocking 且指出缺 ch3',
    r.status === 1 && report.findings[0].type === 'trial-gate-missing'
      && /ch\s*3/.test(report.findings[0].message),
    `status=${r.status} msg=${report.findings[0] && report.findings[0].message}`);

  // 两行拼合并集覆盖 1-3 → 放行。
  const merged = trialProject('merged', [
    '| 9-13 | 同事A | 1,2 | 想 | 母亲 | 无 | 否 | 是 | 否 | 否 |',
    '| 9-14 | 表妹 | 3 | 想 | 沈亦舟 | 面要热账要清 | 是 | 是 | 是 | 是 |',
  ]);
  r = tg(merged, 4);
  report = parseJson(r.stdout);
  check('Fw-06 多行并集覆盖 ch1-3 → 放行',
    r.status === 0 && report.findings.length === 0, `status=${r.status} f=${JSON.stringify(report.findings)}`);

  // 试读人列空的行不计入覆盖 → blocking。
  const noReader = trialProject('noreader', [
    '| 9-14 |  | 1-3 | 想 | 沈亦舟 | 无 | 是 | 是 | 是 | 是 |',
  ]);
  r = tg(noReader, 4);
  report = parseJson(r.stdout);
  check('Fw-06 试读人空＝无法证明真人 → blocking',
    r.status === 1 && report.findings.some((f) => f.type === 'trial-gate-missing'),
    `status=${r.status} f=${JSON.stringify(report.findings)}`);

  // 周期 advisory：覆盖止于 ch3，开写 ch7 → advisory，--fail-on=blocking 不拦截，--fail-on=all exit 1。
  r = tg(good, 7);
  report = parseJson(r.stdout);
  check('Fw-06 ch7 试读止于 ch3 → advisory trial-gate-stale（blocking 门放行）',
    r.status === 0 && report.findings.length === 1 && report.findings[0].type === 'trial-gate-stale',
    `status=${r.status} f=${JSON.stringify(report.findings)}`);
  r = tg(good, 7, 'all');
  check('Fw-06 advisory 在 --fail-on=all 下 exit 1', r.status === 1, `status=${r.status}`);

  // 覆盖到 ch4，ch7 阈值 N-3=4 → 不提醒。
  const fresh = trialProject('fresh', [
    '| 9-20 | 表妹 | 1至4 | 想 | 沈亦舟 | 面要热账要清 | 是 | 是 | 是 | 是 |',
  ]);
  r = tg(fresh, 7);
  report = parseJson(r.stdout);
  check('Fw-06 覆盖至 ch4 → ch7 无 stale 提醒',
    r.status === 0 && report.findings.length === 0, `status=${r.status} f=${JSON.stringify(report.findings)}`);
}

// ============================================================
console.log('== Fw-04 笔法文件治理 guyin-check-rule-conflict ==');
{
  const rc = (dir, failOn) => run('guyin-check-rule-conflict.js',
    ['--project', dir, '--json', ...(failOn ? [`--fail-on=${failOn}`] : [])]);
  const RULE_STUB = '# 语言纪律\n\n## 与卷纲调性一致性声明\n项目自创笔法存在。\n';
  const header = [
    '| 编号 | 冲突双方（文件:节） | 冲突实质 | 仲裁结论 | 优先级 | 仲裁日期 |',
    '|---|---|---|---|---|---|',
  ];

  // 无自创笔法文件 → 治理不激活，静默。
  const plain = path.join(TMP, 'fw04plain');
  fixture('fw04plain/追踪/_tracking-state.json', '{}');
  let r = rc(plain, 'all');
  let report = parseJson(r.stdout);
  check('Fw-04 无笔法文件静默（fail-open）',
    r.status === 0 && report && report.governanceActive === false && report.findings.length === 0,
    `status=${r.status} out=${r.stdout.slice(0, 120)}`);

  // 有笔法文件无台账 → ledger-missing advisory；默认 blocking 门 exit 0，all exit 1。
  fixture('fw04miss/作者性/语言纪律.md', RULE_STUB);
  const miss = path.join(TMP, 'fw04miss');
  r = rc(miss);
  report = parseJson(r.stdout);
  check('Fw-04 笔法在/台账缺 → advisory ledger-missing（默认门放行）',
    r.status === 0 && report.governanceActive === true
      && report.findings.length === 1 && report.findings[0].type === 'rule-conflict-ledger-missing',
    `status=${r.status} f=${JSON.stringify(report.findings)}`);
  r = rc(miss, 'all');
  check('Fw-04 ledger-missing 在 --fail-on=all 下 exit 1', r.status === 1, `status=${r.status}`);

  // 模板原样（仅占位行）→ 零 finding。
  fixture('fw04tpl/作者性/语言纪律.md', RULE_STUB);
  const tplLedger = fs.readFileSync(
    path.join(REPO, 'skills', 'guyin-setup', 'templates', 'long', '作者性', '纪律冲突台账.md'), 'utf8');
  fixture('fw04tpl/作者性/纪律冲突台账.md', tplLedger);
  r = rc(path.join(TMP, 'fw04tpl'), 'all');
  report = parseJson(r.stdout);
  check('Fw-04 模板占位台账零未仲裁行',
    r.status === 0 && report.findings.length === 0, `status=${r.status} f=${JSON.stringify(report.findings)}`);

  // 追影《框架问题清单》C-01…C-08 整表落入演练（只读对照，不在追影落盘）。
  const zyList = path.join('d:', 'readbook-workspace', '追影', '框架问题清单_交外部处理.md');
  const zyText = fs.readFileSync(zyList, 'utf8');
  const cRows = [
    ['C-01', '卷纲_第1卷「老灵魂＋嬉皮笑脸」 ↔ 执行层一页纸 禁令#5「主角不搞笑」', '卷级调性与执行级禁令直接对立'],
    ['C-02', '语言纪律 §4 对话签名（≤15字/不问/不解释） ↔ §4.5 对话鼓励无信息量俗套', '两条都指向删信息，叠加清空对话'],
    ['C-03', '开篇钩子设计：读完必有四个问题 ↔ 细纲001：唯一解密位=无＋三章禁释六项', '只给问题不给料'],
    ['C-04', '隐杀式爽点 H4 望诊慢镜（脑内列三证候） ↔ 语言纪律 §一 三不写（不写心理/判断）', '望诊核心爽点必须写内心，与硬禁令冲突'],
    ['C-05', '开篇钩子设计：破折号本段特批 ↔ 去AI味轮：清除全部分隔符', '作者特批被自动化流程推翻，定稿被重写'],
    ['C-06', '语言纪律 §八 主语+动词不修饰 ↔ H4 分镜慢写（一动作拆4-6层）', '一个要压缩一个要展开'],
    ['C-07', '爽点体系 §三 每卷四类爽点配额 ↔ 卷纲26章四线并装', '配额挤压，一章要装多类'],
    ['C-08', '执行层一页纸「忘了评分/伏笔表」 ↔ 章检链/状态门/tracking 全强制', '写作期减负与落盘期强制压在同一环节'],
  ];
  check('Fw-04 追影清单含 C-01…C-08 八条（只读红测样本）',
    cRows.every(([id]) => zyText.includes(id)), '追影清单缺条');

  const buildLedger = (withVerdict) => [
    '# 纪律冲突台账', '', ...header,
    ...cRows.map(([id, parties, essence], i) => `| ${id} | ${parties} | ${essence} | ${withVerdict ? ['以卷纲为准，改写一页纸', '按场拆分：日常保留/信息场解禁', '保留问题且必须给人物交代', '望诊列为硬禁令明确例外', '作者特批＞自动化流程', '按章型分配：高压慢镜/日常经济', '卷一只需三类（豁免旧人回访）', '写作期守3条/落盘期全查'][i] : ''} | P10 | ${withVerdict ? '2026-09-14' : ''} |`),
    '',
  ].join('\n');

  fixture('fw04zy/大纲/执行层一页纸.md', '# 执行层一页纸\n项目自创笔法存在。\n');
  const zyLedger = path.join(TMP, 'fw04zy', '作者性', '纪律冲突台账.md');
  fixture('fw04zy/作者性/纪律冲突台账.md', buildLedger(false));
  r = rc(path.join(TMP, 'fw04zy'), 'all');
  report = parseJson(r.stdout);
  check('Fw-04 C-01…C-08 整表落入且未仲裁 → 8 条 unadjudicated advisory',
    r.status === 1 && report.findings.length === 8
      && report.findings.every((f) => f.type === 'rule-conflict-unadjudicated')
      && report.findings.some((f) => /C-01/.test(f.message)),
    `status=${r.status} n=${report.findings.length}`);

  fs.writeFileSync(zyLedger, buildLedger(true));
  r = rc(path.join(TMP, 'fw04zy'), 'all');
  report = parseJson(r.stdout);
  check('Fw-04 八条全部仲裁回填后 exit 0',
    r.status === 0 && report.findings.length === 0, `status=${r.status} f=${JSON.stringify(report.findings)}`);
}

// ============================================================
console.log('== Fw-09 批次 C：C1 页眉约定 / C2 伏笔编号门 / C3 切口门 / C4 术语准入 ==');
{
  // C1：过期评估页眉约定进 check-doc-budget.js 头注释（慎建文件，约定随守卫分发）。
  const budgetSrc = fs.readFileSync(path.join(REPO, 'scripts', 'check-doc-budget.js'), 'utf8');
  check('Fw-09 C1 过期评估页眉规范有固定文案与落点（check-doc-budget 头注释）',
    /结论已被 vXX/.test(budgetSrc) && /第一行/.test(budgetSrc) && /仅存档/.test(budgetSrc),
    '缺页眉约定');

  // C3：切口门接线三处（写指定章预检 ch004 起、建批硬前置、卷末附加）。
  const writeSkill = fs.readFileSync(
    path.join(REPO, 'skills', 'guyin-write', 'SKILL.md'), 'utf8');
  check('Fw-09 C3 写指定章预检含切口门（ch004 起二选一）',
    /切口门（\*\*ch004 起\*\*：魂档案「私人切口」/.test(writeSkill)
      && /立即补或显式延期至某卷末/.test(writeSkill),
    '预检缺切口门');
  check('Fw-09 C3 建批硬前置含私人切口定稿/显式延期',
    /私人切口已定稿或持显式延期（Fw-09 C3）/.test(writeSkill), '建批前置缺');
  check('Fw-09 C3 卷末附加含未定稿/延期到期主动询问',
    /私人切口未定稿或延期到期者\*\*主动询问\*\*，二选一落字/.test(writeSkill), '卷末附加缺');

  // C4：细纲协议术语准入三件套。
  const outlineProtocol = fs.readFileSync(
    path.join(REPO, 'skills', 'guyin-write', 'references', '细纲协议.md'), 'utf8');
  check('Fw-09 C4 细纲协议含术语准入节（定义+反例+正文可指认特征）',
    /术语准入（Fw-09 C4/.test(outlineProtocol)
      && /定义/.test(outlineProtocol) && /反例/.test(outlineProtocol)
      && /正文可指认特征/.test(outlineProtocol),
    '缺三件套');
  check('Fw-09 C4 术语准入点名黑话样例（密/疏、外选、气压、回甘强度）',
    ['密/疏', '外选', '气压', '回甘强度'].every((w) => outlineProtocol.includes(w)),
    '黑话样例不全');

  // C2：伏笔编号门。
  const fc = (dir, failOn) => run('guyin-check-foreshadow-id.js',
    ['--project', dir, '--json', ...(failOn ? [`--fail-on=${failOn}`] : [])]);
  const ledgerHeader = [
    '| ID | 内容 | 埋设章 | 计划回收章 | 状态 | 重要度 | 揭示方式 | 最近变更章 |',
    '|---|---|---:|---:|---|---|---|---:|',
  ];
  const ledgerRow = (id, content) =>
    `| ${id} | ${content} | 第1章 | 第10章 | 已埋 | 中 | 一句带过 | 第1章 |`;

  // 无台账 → fail-open 静默。
  fixture('fw09none/追踪/_tracking-state.json', '{}');
  let r = fc(path.join(TMP, 'fw09none'), 'all');
  let report = parseJson(r.stdout);
  check('Fw-09 C2 无伏笔台账静默（fail-open）',
    r.status === 0 && report && report.findings.length === 0,
    `status=${r.status} out=${r.stdout.slice(0, 120)}`);

  // 模板态（仅 {{占位}} 行）→ 零 finding。
  const tplForeshadow = fs.readFileSync(
    path.join(REPO, 'skills', 'guyin-setup', 'templates', 'long', '追踪', '伏笔.md'), 'utf8');
  fixture('fw09tpl/追踪/伏笔.md', tplForeshadow);
  r = fc(path.join(TMP, 'fw09tpl'), 'all');
  report = parseJson(r.stdout);
  check('Fw-09 C2 模板占位台账零 finding',
    r.status === 0 && report.findings.length === 0, `status=${r.status} f=${JSON.stringify(report.findings)}`);

  // 重号 + 空号：默认 advisory 放行，--fail-on=all exit 1。
  fixture('fw09bad/追踪/伏笔.md', [
    '# 伏笔当前状态', '', ...ledgerHeader,
    ledgerRow('F001', '第一件事'),
    ledgerRow('F001', '重号的另一件事'),
    '|  | 空号行 | 第1章 | 第10章 | 已埋 | 中 | 一句带过 | 第1章 |',
    ledgerRow('F003', '第三件事'),
    '',
  ].join('\n'));
  const bad = path.join(TMP, 'fw09bad');
  r = fc(bad);
  report = parseJson(r.stdout);
  check('Fw-09 C2 重号+空号 → 两条 advisory（默认门放行 exit 0）',
    r.status === 0
      && report.findings.filter((f) => f.type === 'foreshadow-duplicate-id').length === 1
      && report.findings.filter((f) => f.type === 'foreshadow-empty-id').length === 1,
    `status=${r.status} f=${JSON.stringify(report.findings)}`);
  r = fc(bad, 'all');
  check('Fw-09 C2 重号+空号在 --fail-on=all 下 exit 1', r.status === 1, `status=${r.status}`);

  // 引用未登记：细纲引用 F009（台账只登记 F001/F003）。
  fixture('fw09bad/大纲/细纲_第002章.md', '## 细纲（第 2 章）\n承接 F009 的回收预期，本章不动。\n');
  fixture('fw09bad/正文/第002章_试.md', SCENE + '\n他想起编号 F009 还挂着。\n');
  r = fc(bad, 'all');
  report = parseJson(r.stdout);
  const unreg = report.findings.filter((f) => f.type === 'foreshadow-ref-unregistered');
  check('Fw-09 C2 正文与大纲引用未登记 F009 → 各一条 ref-unregistered',
    r.status === 1 && unreg.length === 2
      && unreg.every((f) => /F009/.test(f.message)),
    `n=${unreg.length} f=${JSON.stringify(unreg)}`);

  // 规划文件（非细纲）中的「待埋」未来编号是登记源不是引用方——不扫。
  fixture('fw09bad/大纲/伏笔规划台账.md', '| **F99** | ch180 | 规划中的未来伏笔 | 待埋 |\n');
  r = fc(bad, 'all');
  report = parseJson(r.stdout);
  check('Fw-09 C2 大纲规划台账中的未来编号 F99 不误报（只扫细纲_*.md）',
    report.findings.every((f) => !/F099|F99/.test(f.message)),
    `f=${JSON.stringify(report.findings)}`);

  // 登记 F009 后引用 finding 清零（重号/空号仍在）。
  const fixedLedger = [
    '# 伏笔当前状态', '', ...ledgerHeader,
    ledgerRow('F001', '第一件事'),
    ledgerRow('F003', '第三件事'),
    ledgerRow('F009', '补上的登记'),
    '',
  ].join('\n');
  fs.writeFileSync(path.join(bad, '追踪', '伏笔.md'), fixedLedger);
  r = fc(bad, 'all');
  report = parseJson(r.stdout);
  check('Fw-09 C2 补登记后无悬空引用（registered 含 F001/F003/F009）',
    report.findings.every((f) => f.type !== 'foreshadow-ref-unregistered')
      && ['F001', 'F003', 'F009'].every((id) => report.registered.includes(id)),
    `f=${JSON.stringify(report.findings)} reg=${report.registered}`);

  // 追影只读对照：台账 12 个 F 号，正文/大纲零悬空引用。
  const zyRoot = path.join('d:', 'readbook-workspace', '追影');
  if (fs.existsSync(zyRoot)) {
    r = fc(zyRoot);
    report = parseJson(r.stdout);
    check('Fw-09 C2 追影只读对照：12 编号无重号/空号/悬空引用',
      r.status === 0 && report.findings.length === 0 && report.registered.length === 12,
      `status=${r.status} n=${report.registered && report.registered.length} f=${JSON.stringify(report.findings).slice(0, 160)}`);
  }
}

// ============================================================
console.log('== Fw-05 silence-density-tic（沉默短语密度） ==');
{
  // 约 1150 字叙述 + 4 处沉默短语 ≈ 3.5/千字 → advisory。
  const base = [...Array(34)].map(() => SCENE);
  const hot = fixture('fw05sil/hot/正文/第002章_默.md',
    `${base.slice(0, 12).join('\n')}\n她没答。\n${base.slice(12, 24).join('\n')}\n他没说话，她也没吭声，两个人都不说话。\n${base.slice(24).join('\n')}\n`);
  let r = run('guyin-check-ai-patterns.js', ['--json', hot]);
  let report = parseJson(r.stdout);
  check('Fw-05 沉默短语 4 处/千余字报 silence-density-tic（advisory）',
    report && report.findings.some((f) => f.type === 'silence-density-tic' && f.severity === 'advisory'),
    `types=${JSON.stringify(report && report.findings.map((f) => f.type))}`);

  // 假词不误伤：「没答案」「没接住」不是沉默短语。
  const fake = fixture('fw05sil/fake/正文/第002章_假.md',
    `${base.slice(0, 20).join('\n')}\n他没答案，球也没接住。\n${base.slice(20).join('\n')}\n`);
  r = run('guyin-check-ai-patterns.js', ['--json', fake]);
  report = parseJson(r.stdout);
  check('Fw-05 没答案/没接住不计沉默短语（零报）',
    report && !report.findings.some((f) => f.type === 'silence-density-tic'),
    `types=${JSON.stringify(report && report.findings.map((f) => f.type))}`);
}

// ============================================================
console.log('== Fw-05 dialogue-zero-information（ch1-3 对话零信息启发式） ==');
{
  fixture('fw05dz/大纲/批次公约.md', '# 批次公约\n- 叙述契约：第三人称限知。POV＝阿衡。\n');
  const passiveLines = ['阿衡低着头。', '“嗯。”', '“不知道。”', '“哦。”', '“行。”', '“没。”', '“算了。”', '“不用。”', '“好。”', '掌柜又问了他几句，他始终不肯抬头。'];
  const passive = fixture('fw05dz/正文/第002章_被动.md', `${passiveLines.join('\n')}\n`);
  let r = run('guyin-check-ai-patterns.js', ['--json', passive]);
  let report = parseJson(r.stdout);
  check('Fw-05 主角零发问＋对白中位≤5字 → dialogue-zero-information',
    report && report.findings.some((f) => f.type === 'dialogue-zero-information'),
    `types=${JSON.stringify(report && report.findings.map((f) => f.type))}`);

  const activeLines = [
    '阿衡问：“掌柜的，这药铺今天几时关门？”',
    '“那这位先生是谁，为何坐在柜台后头翻账本？”阿衡又问。',
    '阿衡凑过去：“你手里这包药，是不是给前街周家老太太抓的？”',
    '“我再问一句——这方子谁开的，出了人命算谁的？”阿衡盯着他。',
    '店家捋着胡子答话，说了一通今年药材行情的涨跌来由。',
    '阿衡听完点头，又把那包药拿起来对着窗光细看了半天。',
    '“这药里少了一味黄芪，你当我真认不出来吗？”他把纸包拍回柜上。',
    '店外雨声淅沥，街上行人撑着伞匆匆走过湿亮的青石板路。',
  ];
  const active = fixture('fw05dz/正文/第001章_主动.md', `${activeLines.join('\n')}\n`);
  r = run('guyin-check-ai-patterns.js', ['--json', active]);
  report = parseJson(r.stdout);
  check('Fw-05 主角主动发问＋长对白 → 不报',
    report && !report.findings.some((f) => f.type === 'dialogue-zero-information'),
    `types=${JSON.stringify(report && report.findings.map((f) => f.type))}`);

  // ch004 即使同形态也静默（仅黄金三章）。
  const ch4 = fixture('fw05dz/正文/第004章_后文.md', `${passiveLines.join('\n')}\n`);
  r = run('guyin-check-ai-patterns.js', ['--json', ch4]);
  report = parseJson(r.stdout);
  check('Fw-05 ch004+ 静默（黄金三章契约不外推）',
    report && !report.findings.some((f) => f.type === 'dialogue-zero-information'),
    `types=${JSON.stringify(report && report.findings.map((f) => f.type))}`);

  // 无批次公约 → fail-open。
  const noPactDir = 'fw05dzopen';
  const noPact = fixture(`${noPactDir}/正文/第003章_无公约.md`, `${passiveLines.join('\n')}\n`);
  r = run('guyin-check-ai-patterns.js', ['--json', noPact]);
  report = parseJson(r.stdout);
  check('Fw-05 无批次公约 POV fail-open 静默',
    report && !report.findings.some((f) => f.type === 'dialogue-zero-information'),
    `types=${JSON.stringify(report && report.findings.map((f) => f.type))}`);
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
