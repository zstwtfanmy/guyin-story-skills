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

  r = run('guyin-check-wordcount.js', ['--json', '--max=2000', overlong]);
  report = parseJson(r.stdout);
  check('超长章 advisory 报警（editorial，默认门 exit 0）', r.status === 0 && report
    && report.findings.some((f) => f.type === 'chapter-too-long' && f.severity === 'advisory'),
    `status=${r.status}`);

  r = run('guyin-check-wordcount.js', ['--fail-on=all', '--max=2000', overlong]);
  check('超长章 editorial 触发 --fail-on=all exit 1（审计门）', r.status === 1, `status=${r.status}`);

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
  check('不是A而是B 命中 2 处（editorial，默认门 exit 0）', r.status === 0 && ni.length === 2,
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
  check('ch61 三腔坏样本必报 explain-tic（科普腔，editorial 默认门 exit 0）', r.status === 0 && report
    && report.findings.some((f) => f.type === 'explain-tic' && f.severity === 'advisory'),
    `status=${r.status} types=${JSON.stringify(report && report.findings.map((f) => f.type))}`);
  check('ch61 三腔坏样本必报 mid-trailer（段中预告腔，editorial 默认门 exit 0）', r.status === 0 && report
    && report.findings.some((f) => f.type === 'mid-trailer' && f.severity === 'advisory'),
    `types=${JSON.stringify(report && report.findings.map((f) => f.type))}`);
  check('ch61 三腔坏样本必报 aphorism-tic（金句腔，editorial 默认门 exit 0）', r.status === 0 && report
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
  r = run('guyin-check-outline-verdict.js', [suspect]);
  check('verdict-tier-suspect → verify（默认门 exit 1）', r.status === 1, `status=${r.status}`);

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

  r = run('guyin-check-narrative-asset.js', [draft]);
  check('G2 narrative-asset → verify（默认门 exit 1）', r.status === 1, `status=${r.status}`);

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
console.log('== guyin-check-beat（P1 连续场景/整章确定性预检，语义审读归 4a） ==');
{
  // 工程词检测：beat 正文含「细纲」「伏笔」等 → blocking
  const metaLeak = fixture('beat/第001章_漏.md',
    '他翻开细纲，想起上一章的伏笔，觉得这事不简单。\n');
  let r = run('guyin-check-beat.js', ['--json', metaLeak]);
  let report = parseJson(r.stdout);
  check('beat 工程词泄漏报 meta-leak-beat', r.status === 1 && report
    && report.findings.some((f) => f.type === 'meta-leak-beat'),
    `status=${r.status} types=${JSON.stringify(report && report.findings.map((f) => f.type))}`);

  // 禁止项检测：--ban 列表词出现 → blocking
  const banned = fixture('beat/第002章_禁.md',
    '他把凑数字的东西收起来，随便看了看就走了。\n');
  r = run('guyin-check-beat.js', ['--json', '--ban=凑数,随便', banned]);
  report = parseJson(r.stdout);
  check('beat 禁止项报 ban-violation', r.status === 1 && report
    && report.findings.some((f) => f.type === 'ban-violation'),
    `status=${r.status} types=${JSON.stringify(report && report.findings.map((f) => f.type))}`);

  // 四组化（任务书 §2.2）：字数桶已删——beat 只是节奏标签，--min 传入即按未知参数退 2。
  const tiny = fixture('beat/第003章_短.md', '他走了。\n');
  r = run('guyin-check-beat.js', ['--json', '--min=500', tiny]);
  check('beat --min 已废除，传入按未知参数退 2（无字数桶）', r.status === 2, `status=${r.status}`);

  // 跳写检测：含「此处省略」→ blocking
  const skip = fixture('beat/第004章_跳.md',
    '他走进屋子。（此处省略三百字）然后天亮了。\n');
  r = run('guyin-check-beat.js', ['--json', skip]);
  report = parseJson(r.stdout);
  check('beat 跳写报 skip-write', r.status === 1 && report
    && report.findings.some((f) => f.type === 'skip-write' && f.severity === 'blocking'),
    `status=${r.status} types=${JSON.stringify(report && report.findings.map((f) => f.type))}`);

  // 连续对话：4+ 句对话无动作 → advisory（v3-A1 默认 fail-on=blocking，advisory 不触发 exit 1）
  const dialogue = fixture('beat/第005章_话.md',
    '「你来干什么？」\n「找你算账。」\n「凭什么？」\n「就凭这个。」\n「你疯了。」\n');
  r = run('guyin-check-beat.js', ['--json', dialogue]);
  report = parseJson(r.stdout);
  check('beat 连续对话报 dialogue-run（advisory，默认 exit 0）', r.status === 0 && report
    && report.findings.some((f) => f.type === 'dialogue-run' && f.severity === 'advisory'),
    `status=${r.status} types=${JSON.stringify(report && report.findings.map((f) => f.type))}`);

  // 心理独白超限 → advisory（同上，advisory 不再因 exit 1 被放大为失败）
  const mono = fixture('beat/第006章_独.md',
    '他心想这事不对。他觉得背后有人。他暗想这一定是圈套。他琢磨着怎么脱身。\n');
  r = run('guyin-check-beat.js', ['--json', '--mono-limit=2', mono]);
  report = parseJson(r.stdout);
  check('beat 心理独白超限报 mono-count（advisory，默认 exit 0）', r.status === 0 && report
    && report.findings.some((f) => f.type === 'mono-count' && f.severity === 'advisory'),
    `status=${r.status} types=${JSON.stringify(report && report.findings.map((f) => f.type))}`);

  // 干净 beat 静默
  const clean = fixture('beat/第007章_净.md',
    '他把竹竿靠在墙根，拍了拍手上的灰。\n母亲从灶房探出头：「饭好了。」\n他应了一声，进屋洗手。\n');
  r = run('guyin-check-beat.js', ['--json', clean]);
  report = parseJson(r.stdout);
  check('beat 干净正文静默', r.status === 0 && report && report.findings.length === 0,
    `status=${r.status} findings=${JSON.stringify(report && report.findings.map((f) => f.type))}`);

  // editorial 不触发默认门（block）：dialogue-run 观测不拦
  r = run('guyin-check-beat.js', [dialogue]);
  check('beat editorial 不触发默认门（block）', r.status === 0, `status=${r.status}`);

  // v3-A1（任务书 §4 A1 / §2.7）：时间压缩词是概述笔法观测（advisory）——合法时间过渡
  // 不再判 blocking 跳写；是否跳过「必须展示」的事件交完整章审读（SKILL.md 4a）语义判断。
  const transition = fixture('beat/第008章_过渡.md',
    '不多时，雨停了。车夫收起油布，继续赶路。\n');
  r = run('guyin-check-beat.js', ['--json', transition]);
  report = parseJson(r.stdout);
  check('beat 时间压缩词报 advisory skip-write（默认 exit 0）', r.status === 0 && report
    && report.findings.some((f) => f.type === 'skip-write' && f.severity === 'advisory'),
    `status=${r.status} types=${JSON.stringify(report && report.findings.map((f) => f.type))}`);
  r = run('guyin-check-beat.js', ['--fail-on=all', transition]);
  check('beat 时间压缩词 --fail-on=all exit 1（观测全拦须显式）', r.status === 1, `status=${r.status}`);

  // v3-A1（任务书 §2.7）：同行含动作的对白行断开连排——连续带引号行不再误称「无动作」。
  const actionDialogue = fixture('beat/第009章_动作对白.md',
    '“走吧。”他提起箱子。\n“等等。”她拉住门把。\n“带上这个。”老人递出雨伞。\n“谢谢。”他接过伞，退到屋檐下。\n');
  r = run('guyin-check-beat.js', ['--json', actionDialogue]);
  report = parseJson(r.stdout);
  check('beat 同行动作对白不报 dialogue-run', r.status === 0 && report
    && !report.findings.some((f) => f.type === 'dialogue-run'),
    `status=${r.status} types=${JSON.stringify(report && report.findings.map((f) => f.type))}`);

  // summary 验证：语义审读归完整章审读（4a），编号题体系已废除（任务书 §2.3）
  r = run('guyin-check-beat.js', ['--json', clean]);
  report = parseJson(r.stdout);
  check('beat summary 指向完整章审读且无编号题残留', report
    && report.summary.semanticReview === 'full-chapter-read (SKILL.md 4a)'
    && !('modelRemaining' in report.summary),
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
console.log('== D1 状态契约（任务书 §2.5：模板 v7 往返 / 长度契约 / 运行记录分离） ==');
{
  const py = ['python3', 'python', 'py'].find((bin) => {
    try {
      return spawnSync(bin, ['-c', ''], { encoding: 'utf8' }).status === 0;
    } catch (e) {
      return false;
    }
  });
  // 模板契约（不依赖 python）：模板 state 必须是脚本现行 v7 形状（旧 schema 1/open_threads 模板是
  // 「不得按旧模板向 context.open_threads 写入」的事故源）；hook 必须接受 4-7 全谱。
  const tplState = JSON.parse(fs.readFileSync(
    path.join(REPO, 'skills', 'guyin-setup', 'templates', 'long', '追踪', '_tracking-state.json'), 'utf8'));
  check('D1 模板 state 为 v7 现行字段形状（无 open_threads/summary 旧键）',
    tplState.schema_version === 7 && !('open_threads' in tplState.context) && !('summary' in tplState.context)
      && ['foreshadow', 'timeline', 'verdicts', 'evidence', 'geo', 'scenes', 'chapter_summaries']
        .every((k) => k in tplState),
    `schema=${tplState.schema_version} keys=${Object.keys(tplState).join(',')}`);
  const hookSrc = fs.readFileSync(
    path.join(REPO, 'skills', 'guyin-setup', 'templates', 'long', '.claude', 'hooks', 'guyin-hook.js'), 'utf8');
  check('D1 hook 接受 state schema 4-7（v7 项目不再被 stateProblem 误拦）',
    /\[4,\s*5,\s*6,\s*7\]/.test(hookSrc), 'hook stateProblem 未含 4-7 全谱');
  const tplCtx = fs.readFileSync(
    path.join(REPO, 'skills', 'guyin-setup', 'templates', 'long', '追踪', '上下文.md'), 'utf8');
  check('D1 模板 上下文.md 为七区段派生形状（无 open_threads 悬置线头旧节）',
    tplCtx.includes('## 近三章速记') && !tplCtx.includes('open_threads'),
    `head=${tplCtx.split('\n').slice(0, 6).join('/')}`);

  if (!py) {
    skip('D1 模板部署→check→commit 往返', '未找到可用 python 解释器');
    skip('D1 模板部署→修订重提交不覆盖运行记录', '未找到可用 python 解释器');
    skip('D1 delta.result ≈300字/900字节 三处同额', '未找到可用 python 解释器');
    skip('D1 超限 result 拒绝', '未找到可用 python 解释器');
  } else {
    const SCRIPT = path.join(S, 'guyin-tracking-commit.py');
    const runPy = (args, project) => spawnSync(py, [SCRIPT, ...args, '--project', project], { encoding: 'utf8' });
    const TPL_TRACKING = path.join(REPO, 'skills', 'guyin-setup', 'templates', 'long', '追踪');

    // 往返一：模板原样部署 → check 通过 → 首章 append commit 通过 → check 通过。
    const book = path.join(TMP, 'd1tpl');
    fs.mkdirSync(path.join(book, '追踪', '角色状态'), { recursive: true });
    for (const entry of fs.readdirSync(TPL_TRACKING, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        fs.mkdirSync(path.join(book, '追踪', entry.name), { recursive: true });
        for (const f of fs.readdirSync(path.join(TPL_TRACKING, entry.name))) {
          fs.copyFileSync(path.join(TPL_TRACKING, entry.name, f), path.join(book, '追踪', entry.name, f));
        }
      } else {
        fs.copyFileSync(path.join(TPL_TRACKING, entry.name), path.join(book, '追踪', entry.name));
      }
    }
    let r = runPy(['check'], book);
    check('D1 模板部署后 check 通过（v7 空态与派生视图逐字一致）', r.status === 0,
      `status=${r.status} err=${r.stderr.trim().slice(0, 200)}`);

    const pos = { volume: '第一卷', volume_start_chapter: 1, story_time: '开篇当日', scene: '渡口票房' };
    const mkTx = (mode, chapter, expected, result) => JSON.stringify({
      schema_version: 1, mode, chapter, chapter_title: '开篇', expected_state_revision: expected,
      delta: {
        result,
        character_changes: [], foreshadow_changes: [], timeline_events: [], verdict_changes: [],
        evidence_changes: [], geo_changes: [], scene_changes: [], constraints: [],
        next_chapter_commitments: [], retired_context_items: [], retired_characters: [],
      },
      context: {
        position: pos, long_term_constraints: [], active_character_names: [], continuity_risks: [],
      },
      character_snapshots: {},
    });
    fixture('d1tpl/tx1.json', mkTx('append', 1, 0, '主角抵渡口，船票被人买走。'));
    r = runPy(['commit', '--input', path.join(TMP, 'd1tpl', 'tx1.json')], book);
    check('D1 模板空态上首章 commit 通过（无 init 依赖）', r.status === 0,
      `status=${r.status} err=${r.stderr.trim().slice(0, 200)}`);
    r = runPy(['check'], book);
    check('D1 首章 commit 后 check 通过', r.status === 0,
      `status=${r.status} err=${r.stderr.trim().slice(0, 200)}`);

    // 运行记录分离：编排层写运行记录 → revision 重提交 → 运行记录原样、逐章记录重写。
    fixture('d1tpl/追踪/运行记录/第001章.md', '模式=solo｜审读：初读通过，L1 无');
    fixture('d1tpl/tx1rev.json', mkTx('revision', 1, 1, '修订版：主角抵渡口，船票被沈家管家买走。'));
    r = runPy(['commit', '--input', path.join(TMP, 'd1tpl', 'tx1rev.json')], book);
    const runRecord = fs.readFileSync(path.join(book, '追踪', '运行记录', '第001章.md'), 'utf8');
    const chapterRecord = fs.readFileSync(path.join(book, '追踪', '逐章记录', '第001章.md'), 'utf8');
    check('D1 修订重提交不覆盖运行记录、只重写逐章记录', r.status === 0
      && runRecord === '模式=solo｜审读：初读通过，L1 无' && chapterRecord.includes('沈家管家'),
      `status=${r.status} run=${runRecord} delta=${chapterRecord.slice(0, 80)}`);
    r = runPy(['check'], book);
    check('D1 修订后 check 通过', r.status === 0, `status=${r.status} err=${r.stderr.trim().slice(0, 200)}`);

    // 长度契约：≈300字 result 通过（900 字节额），>900 字节拒绝；chapter_summaries 同文本入库。
    const book2 = path.join(TMP, 'd1len');
    fixture('d1len/init.json', JSON.stringify({
      schema_version: 1, book_title: '长度契约', last_chapter: 0,
      context: {
        position: { volume: '卷一', volume_start_chapter: 1, story_time: '开篇前', scene: '未定' },
        long_term_constraints: [], active_character_names: [], continuity_risks: [],
        recent_chapters: [], next_chapter_commitments: [],
      },
    }));
    r = runPy(['init', '--input', path.join(TMP, 'd1len', 'init.json')], book2);
    check('D1 长度契约前置：init 成功', r.status === 0, `status=${r.status} err=${r.stderr.trim().slice(0, 160)}`);
    // 296 个汉字 ≈ 888 字节（≤900）；305 个 ≈ 915 字节（>900）。
    const longOk = '锚'.repeat(296);
    const longBad = '锚'.repeat(305);
    fixture('d1len/tx2.json', mkTx('append', 1, 0, longOk));
    r = runPy(['commit', '--input', path.join(TMP, 'd1len', 'tx2.json')], book2);
    let st = r.status === 0
      ? JSON.parse(fs.readFileSync(path.join(book2, '追踪', '_tracking-state.json'), 'utf8')) : null;
    check('D1 ≈300字（888字节）result 通过且三处同额入库', r.status === 0 && st
      && st.chapter_summaries['1'] === longOk
      && st.context.recent_chapters.some((i) => i.chapter === 1 && i.summary === longOk),
      `status=${r.status} err=${r.stderr.trim().slice(0, 160)}`);
    fixture('d1len/tx3.json', mkTx('append', 2, 1, longBad));
    r = runPy(['commit', '--input', path.join(TMP, 'd1len', 'tx3.json')], book2);
    check('D1 超限 result（915字节 > 900）在任何写入前拒绝', r.status === 2
      && r.stderr.includes('exceeds 900'),
      `status=${r.status} err=${r.stderr.trim().slice(0, 160)}`);
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
  check('钩子坍缩：连续 3 章悬念钩报 hook-run（editorial，默认门 exit 0）', r.status === 0 && report
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
  check('同域比喻密度报 imagery-domain-run（第3章窗口自然×3，editorial 默认门 exit 0）', r.status === 0 && report
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
  check('N1 ch1 ×2 同章复读报 phrase-echo-inline（SP1 docs/11 §一：ECHO_INLINE_RUN=2，旧 ×2 静默口径已废止；editorial 默认门 exit 0）', r.status === 0 && report
    && report.findings.some((f) => f.type === 'phrase-echo-inline' && f.excerpt === '缺角的讫印'),
    `status=${r.status} findings=${JSON.stringify(report && report.findings.map((f) => f.type))}`);

  const ch6 = fixture('echo1/正文/第006章.md',
    `第六章\n\n他把缺角的讫印又按了一回，燕衡的算盘还悬在梁上，谁也没去动它。窗外更声三遍，他把票据压回原处，吹了灯。\n`);
  r = run('guyin-check-repetition.js', ['--json', '--project', proj, '--commit', ch6]);
  report = parseJson(r.stdout);
  const cross = report && report.findings.find((f) => f.type === 'phrase-echo-cross');
  check('N1 跨章窗口必报 phrase-echo-cross（库2+本章1=3，editorial 默认门 exit 0）', r.status === 0 && cross
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
  check('N1 章尾复读报 phrase-echo-ending（本章×2 且末次落章尾 20%，子串归并报最长形；editorial 默认门 exit 0）', r.status === 0 && report
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
  check('B3 主导域连续 5 章固化报 metaphor-domain-stale（自然域 run=5>4，editorial 默认门 exit 0）', r.status === 0 && report
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
  check('B3 --domain-stale=2 收紧后 run=5 必报（editorial 默认门 exit 0）', r.status === 0 && report
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
console.log('== guyin-check-pending U1 待审台账阻断门（D3 八列契约） ==');
{
  const crypto = require('crypto');
  // 表格契约（D3 任务书 §2.4）：八列按表头名定位——
  // | 章号 | 来源 | 报警/发现 | 处置类别 | 正文版本 | 终态 | 决定依据 | 去向/备注 |
  const HDR = '| 章号 | 来源 | 报警/发现 | 处置类别 | 正文版本 | 终态 | 决定依据 | 去向/备注 |';
  const SEP = '|---|---|---|---|---|---|---|---|';

  // 基础：待审/空 open；占位行跳过；五终态＋证据闭合。
  const ledger = fixture('pend/追踪/待审台账.md', [
    '# 待审台账（hard/verify 必有终态）',
    '',
    HDR, SEP,
    '| 61 | repetition N2 | {{例：钱压在碗底下×2}} | {{hard}} | {{}} | {{待审}} | {{}} | {{例}} |',
    '| 61 | repetition N2 | 钱压在碗底下×2 | hard | | 待审 | | |',
    '| 61 | wordcount | 字数欠账 1200/2000 | hard | a1b2c3d4e5f6 | 修复 | 复检通过，字数达标 | 改写卡 L2 |',
    '| 62 | review | 章尾评点句 | verify | b1b2c3d4e5f6 |  |  |  |',
    '| 63 | consistency | 实体冲突：账页数 | verify | c1b2c3d4e5f6 | 顺延 | 伏笔.md 登记，去向第65章 | |',
    '',
  ].join('\n'));
  let r = run('guyin-check-pending.js', ['--json', ledger]);
  let report = parseJson(r.stdout);
  check('D3 待审/空行 open，占位行跳过，修复/顺延证据齐全闭合（2 open / 共 4 行）',
    r.status === 1 && report && report.total === 4 && report.open.length === 2
      && report.open.every((o) => o.chapter === 61 || o.chapter === 62),
    `status=${r.status} out=${r.stdout.trim().slice(0, 300)}`);

  r = run('guyin-check-pending.js', ['--json', '--through', '61', ledger]);
  report = parseJson(r.stdout);
  check('D3 --through 61 只查 ≤61 章（62/63 行出界，1 行开放）', r.status === 1 && report
    && report.open.length === 1 && report.total === 2,
    `status=${r.status} out=${r.stdout.trim().slice(0, 200)}`);

  // 严格完整匹配（E16 修复）：未修复/修复中/部分豁免均不闭单。
  const strict = fixture('pend/追踪/待审台账_strict.md', [
    HDR, SEP,
    '| 7 | beat | ban-violation | hard | aaaaaaaaaaaa | 未修复 | | |',
    '| 7 | beat | skip-write | hard | aaaaaaaaaaaa | 修复中 | | |',
    '| 7 | ai-patterns | ratio | verify | aaaaaaaaaaaa | 部分豁免 | | |',
    '',
  ].join('\n'));
  r = run('guyin-check-pending.js', ['--json', strict]);
  report = parseJson(r.stdout);
  check('D3 终态严格完整匹配：未修复/修复中/部分豁免均 open（unknown-state，E16）',
    r.status === 1 && report && report.open.length === 3
      && report.open.every((o) => o.reason === 'unknown-state'),
    `status=${r.status} out=${r.stdout.trim().slice(0, 200)}`);

  // Fw-07/D3：升级作者=等待态——「已裁决：」字样只是线索，不转结。
  const fw07 = fixture('pend/追踪/待审台账_fw07.md', [
    HDR, SEP,
    '| 3 | ai-patterns | 碎化率 62% | verify | aaaaaaaaaaaa | 升级作者 | 请作者裁决后转豁免/关闭 | |',
    '| 3 | consistency | 台词归属误判 | verify | aaaaaaaaaaaa | 升级作者 | 已裁决:转豁免，登豁免台账#2 | |',
    '| 4 | repetition | 钱×2 | hard | aaaaaaaaaaaa | 升级作者 | 已裁决：关闭，非问题 | |',
    '',
  ].join('\n'));
  r = run('guyin-check-pending.js', ['--json', fw07]);
  report = parseJson(r.stdout);
  check('Fw-07/D3 升级作者=等待态：「已裁决：」不转结，3 行全 open（awaiting-author）',
    r.status === 1 && report && report.open.length === 3
      && report.open.every((o) => o.reason === 'awaiting-author'),
    `status=${r.status} out=${r.stdout.trim().slice(0, 200)}`);

  // 转结=终态列改五选一＋证据（用户真实决定落账）。
  const fw07Closed = fixture('pend/追踪/待审台账_fw07转结.md', [
    HDR, SEP,
    '| 3 | ai-patterns | 碎化率 62% | verify | aaaaaaaaaaaa | 豁免 | 豁免台账#2，用户裁决保留 | |',
    '| 4 | repetition | 钱×2 | hard | bbbbbbbbbbbb | 修复 | 复检通过，L23 已删 | 替代 v-aaaaaaaaaaaa 行 |',
    '',
  ].join('\n'));
  r = run('guyin-check-pending.js', ['--json', fw07Closed]);
  report = parseJson(r.stdout);
  check('Fw-07/D3 用户决定转结五终态＋证据后闭合 exit 0',
    r.status === 0 && report && report.open.length === 0 && report.total === 2,
    `status=${r.status} out=${r.stdout.trim().slice(0, 200)}`);

  // 证据规则（决定依据列）：各终态缺证据均 open。
  const evid = fixture('pend/追踪/待审台账_证据.md', [
    HDR, SEP,
    '| 5 | beat | ban-violation | hard | | 修复 | 复检通过 | 缺新版本关联 |',
    '| 5 | beat | skip-write | hard | aaaaaaaaaaaa | 修复 | 改写卡 L2 已执行 | 缺复检 |',
    '| 5 | review | 章尾评点 | verify | aaaaaaaaaaaa | 豁免 | 五测试通过 | 缺台账关联 |',
    '| 5 | consistency | 冲突 | verify | aaaaaaaaaaaa | 契约修订 | 改了细纲 | 缺偏差登记 |',
    '| 5 | consistency | 冲突 | verify | aaaaaaaaaaaa | 顺延 | 伏笔 | 缺去向章号 |',
    '| 6 | ai-patterns | ratio | verify | aaaaaaaaaaaa | 不适用 | 第6章 L12 | 缺理由 |',
    '',
  ].join('\n'));
  r = run('guyin-check-pending.js', ['--json', evid]);
  report = parseJson(r.stdout);
  check('D3 证据规则：修复缺版本/缺复检、豁免缺台账、契约修订缺偏差、顺延缺章号、不适用缺理由均 open',
    r.status === 1 && report && report.open.length === 6
      && report.open.every((o) => o.reason === 'missing-evidence' || o.reason === 'no-version'),
    `status=${r.status} out=${r.stdout.trim().slice(0, 300)}`);

  // 处置类别：editorial 不入台账；空=缺分类——均工具错误 exit 2。
  const badHandling = fixture('pend/追踪/待审台账_类别editorial.md', [
    HDR, SEP,
    '| 8 | ai-patterns | prose-fragment-ratio | editorial | aaaaaaaaaaaa | 待审 | | |',
    '',
  ].join('\n'));
  r = run('guyin-check-pending.js', ['--json', badHandling]);
  check('D3 editorial 行入台账=数据异常 exit 2（editorial 留审读记录）',
    r.status === 2 && r.stderr.includes('hard/verify'),
    `status=${r.status} err=${r.stderr.trim().slice(0, 160)}`);

  const emptyHandling = fixture('pend/追踪/待审台账_类别空.md', [
    HDR, SEP,
    '| 8 | beat | ban-violation | | aaaaaaaaaaaa | 待审 | | |',
    '',
  ].join('\n'));
  r = run('guyin-check-pending.js', ['--json', emptyHandling]);
  check('D3 处置类别缺分类 exit 2（不能默认降为建议）',
    r.status === 2 && r.stderr.includes('处置类别'),
    `status=${r.status} err=${r.stderr.trim().slice(0, 160)}`);

  // 版本机制（--project）：匹配在册、不匹配 superseded、空=保守在册、章文件缺失=保守在册。
  const prose = '张三把册子推过来，指着那方印。';
  const curHash = crypto.createHash('sha256').update(Buffer.from(prose, 'utf8')).digest('hex').slice(0, 12);
  fixture('pend-proj/正文/第002章_试.md', prose);
  const ver = fixture('pend-proj/追踪/待审台账.md', [
    HDR, SEP,
    `| 2 | beat | a | hard | ${curHash} | 待审 | | 版本匹配当前 |`,
    '| 2 | beat | b | hard | 000000000000 | 修复 | 复检通过 | 旧版本行 |',
    `| 2 | beat | c | verify | ${curHash} | 豁免 | 豁免台账#1 | |`,
    '| 2 | beat | d | verify | | 修复 | 复检通过 | 空版本按当前在册 |',
    '| 3 | beat | e | hard | aaaaaaaaaaaa | 待审 | | 章文件缺失保守在册 |',
    '',
  ].join('\n'));
  r = run('guyin-check-pending.js', ['--json', '--project', path.join(TMP, 'pend-proj'), ver]);
  report = parseJson(r.stdout);
  check('D3 --project 版本比对：匹配在册、不匹配 superseded 不阻塞、空/章缺失保守在册（3 open/1 superseded/共 4 在册）',
    r.status === 1 && report && report.open.length === 3 && report.superseded.length === 1
      && report.total === 4 && report.open[0].finding === 'a' && report.open[1].finding === 'd'
      && report.open[1].reason === 'no-version' && report.open[2].finding === 'e'
      && report.open[2].reason === 'pending' && report.open[2].current === null,
    `status=${r.status} out=${r.stdout.trim().slice(0, 400)}`);

  const badHash = fixture('pend/追踪/待审台账_版本.md', [
    HDR, SEP,
    '| 2 | beat | x | hard | abc | 待审 | | |',
    '',
  ].join('\n'));
  r = run('guyin-check-pending.js', ['--json', badHash]);
  check('D3 正文版本非法格式 exit 2（须 hash12，--hash 生成）',
    r.status === 2 && r.stderr.includes('hash12'),
    `status=${r.status} err=${r.stderr.trim().slice(0, 160)}`);

  // 损坏行/缺列：列数错、章号非数字、旧五列格式 → exit 2，不静默跳过。
  const broken = fixture('pend/追踪/待审台账_损坏.md', [
    HDR, SEP,
    '| 9 | beat | x | hard | aaaaaaaaaaaa | 待审 | |',
    '',
  ].join('\n'));
  r = run('guyin-check-pending.js', ['--json', broken]);
  check('D3 损坏行（列数≠8）exit 2 不静默跳过',
    r.status === 2 && r.stderr.includes('损坏'),
    `status=${r.status} err=${r.stderr.trim().slice(0, 160)}`);

  const oldFive = fixture('pend/追踪/待审台账_旧五列.md', [
    '| 章号 | 来源 | 报警/发现 | 终态 | 去向/备注 |',
    '|---|---|---|---|---|',
    '| 61 | repetition N2 | 钱×2 | 待审 | |',
    '',
  ].join('\n'));
  r = run('guyin-check-pending.js', ['--json', oldFive]);
  check('D3 旧五列台账缺列 exit 2（引导按模板迁移）',
    r.status === 2 && r.stderr.includes('缺列'),
    `status=${r.status} err=${r.stderr.trim().slice(0, 160)}`);

  const badCh = fixture('pend/追踪/待审台账_章号.md', [
    HDR, SEP,
    '| 卷一 | beat | x | hard | aaaaaaaaaaaa | 待审 | | |',
    '',
  ].join('\n'));
  r = run('guyin-check-pending.js', ['--json', badCh]);
  check('D3 章号非纯数字 exit 2',
    r.status === 2 && r.stderr.includes('章号'),
    `status=${r.status} err=${r.stderr.trim().slice(0, 160)}`);

  // 台账缺失：父目录不存在=非写作项目不误拦（exit 0）；父目录在而台账缺=停靠（exit 2）。
  r = run('guyin-check-pending.js', ['--json', path.join(TMP, 'pend-none', '追踪', '待审台账.md')]);
  report = parseJson(r.stdout);
  check('D3 台账缺失且父目录不存在 exit 0（非写作项目不误拦）',
    r.status === 0 && report && report.missing === true,
    `status=${r.status} out=${r.stdout.trim().slice(0, 120)}`);

  fixture('pend-dir/追踪/占位.md', '占位');
  r = run('guyin-check-pending.js', ['--json', path.join(TMP, 'pend-dir', '追踪', '待审台账.md')]);
  check('D3 已部署项目缺台账 exit 2（报告停靠，不 fail-open）',
    r.status === 2 && r.stderr.includes('缺台账'),
    `status=${r.status} err=${r.stderr.trim().slice(0, 160)}`);
}

// ============================================================
console.log('== D2 发布契约（任务书 §2.6：隔离工作区 / publish 状态机 / 项目锁 / 受保护恢复） ==');
{
  const crypto = require('crypto');
  const py = ['python3', 'python', 'py'].find((bin) => {
    try {
      return spawnSync(bin, ['-c', ''], { encoding: 'utf8' }).status === 0;
    } catch (e) {
      return false;
    }
  });
  const PYSCRIPT = path.join(S, 'guyin-tracking-commit.py');
  const REPJS = path.join(S, 'guyin-check-repetition.js');
  const HOOK = path.join(REPO, 'skills', 'guyin-setup', 'templates', 'long', '.claude', 'hooks', 'guyin-hook.js');
  const h12 = (s) => crypto.createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex').slice(0, 12);
  const h12file = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex').slice(0, 12);
  const cleanEnv = { ...process.env };
  delete cleanEnv.GUYIN_PUBLISH_PAUSE_AFTER;
  const pauseEnv = (stage) => ({ ...cleanEnv, GUYIN_PUBLISH_PAUSE_AFTER: stage });

  // 叙述段（≥40 字、引号占比低，指纹库才收）；两章之间用词岔开避免自带复读。
  const P1 = '河风裹着鱼腥气扑进票房窗口，老周把六张勘合按在案上，指节因用力而泛白，烛火被穿堂风压得只剩一点豆光。';
  const P2 = '后院堆着成捆的硝石，账房先生拿竹尺量麻袋口沿，报出的数字落在水渍里，谁也懒得再核对第二遍。';
  const P1R = '河风裹着卤咸味扑进票房窗口，老周把六张勘合压在案上，指节因用力而泛青，灯焰被穿堂风压得只剩一点豆光。';
  const P2R = '后院码着成包的茶砖，账房先生拿铜尺量麻袋口沿，报出的数目落进尘灰里，谁也懒得再复核第二遍。';
  const candCh1 = (a, b) => `# 第001章 开篇\n\n${a}\n\n${b}\n`;
  const LEDGER = [
    '| 章号 | 来源 | 报警/发现 | 处置类别 | 正文版本 | 终态 | 决定依据 | 去向/备注 |',
    '|---|---|---|---|---|---|---|---|',
    '',
  ].join('\n');

  const mkTx = (mode, chapter, expected, result) => JSON.stringify({
    schema_version: 1, mode, chapter, chapter_title: '开篇', expected_state_revision: expected,
    delta: {
      result,
      character_changes: [], foreshadow_changes: [], timeline_events: [], verdict_changes: [],
      evidence_changes: [], geo_changes: [], scene_changes: [], constraints: [],
      next_chapter_commitments: [], retired_context_items: [], retired_characters: [],
    },
    context: {
      position: { volume: '第一卷', volume_start_chapter: 1, story_time: '开篇当日', scene: '渡口票房' },
      long_term_constraints: [], active_character_names: [], continuity_risks: [],
    },
    character_snapshots: {},
  });

  const initBook = (name) => {
    const book = path.join(TMP, name);
    fs.mkdirSync(path.join(book, '追踪', '角色状态'), { recursive: true });
    fs.mkdirSync(path.join(book, '正文'), { recursive: true });
    fs.writeFileSync(path.join(book, '追踪', '待审台账.md'), LEDGER, 'utf8');
    const initDoc = {
      schema_version: 1, book_title: 'D2书', last_chapter: 0,
      context: {
        position: { volume: '卷一', volume_start_chapter: 1, story_time: '开篇前', scene: '未定' },
        long_term_constraints: [], active_character_names: [], continuity_risks: [],
        recent_chapters: [], next_chapter_commitments: [],
      },
    };
    const initPath = path.join(TMP, name, 'init.json');
    fs.writeFileSync(initPath, JSON.stringify(initDoc), 'utf8');
    const r = spawnSync(py || 'python', [PYSCRIPT, 'init', '--input', initPath, '--project', book],
      { encoding: 'utf8', env: cleanEnv });
    if (r.status !== 0) throw new Error(`initBook ${name} failed: ${r.stderr || r.stdout}`);
    return book;
  };

  // 组装一次发布的全部隔离输入（工作区 .guyin/work/{runId}/），返回 manifest 路径与候选 hash。
  const stagePublish = (book, runId, candidate, opts = {}) => {
    const wsRel = `.guyin/work/${runId}`;
    const ws = path.join(book, wsRel);
    fs.mkdirSync(ws, { recursive: true });
    const candPath = path.join(ws, 'candidate.md');
    fs.writeFileSync(candPath, candidate, 'utf8');
    const chash = h12file(candPath);
    fs.writeFileSync(path.join(ws, 'review.md'), `# 审读记录\n候选 hash12=${chash}\n模式：solo 全章通读。\n`, 'utf8');
    fs.writeFileSync(path.join(ws, 'checks.md'), `# 检查证据\n候选 hash12=${chash}\n五测试全绿。\n`, 'utf8');
    const mode = opts.mode || 'append';
    const expected = opts.expected !== undefined ? opts.expected : 0;
    const result = opts.result || '老周在票房核勘合，烛火被风压矮，他把六张凭据逐张按平。';
    const txPath = path.join(ws, 'tx.json');
    fs.writeFileSync(txPath, mkTx(mode, 1, expected, result), 'utf8');
    const proseFiles = opts.proseFiles !== undefined
      ? opts.proseFiles
      : fs.readdirSync(path.join(book, '正文')).filter((n) => !n.startsWith('.'));
    const manifest = {
      schema_version: 1, run_id: runId,
      target: { chapter: 1, title: '开篇', mode },
      candidate: `${wsRel}/candidate.md`,
      destination: opts.destination || '正文/第001章_开篇.md',
      transaction: `${wsRel}/tx.json`,
      baseline: [
        { path: '追踪/_tracking-state.json', hash12: opts.stateHash || h12file(path.join(book, '追踪', '_tracking-state.json')) },
        { dir: '正文', files: proseFiles },
      ],
      expected_state_revision: expected,
      review: {
        mode: 'solo 全章通读',
        conclusion: opts.conclusion !== undefined ? opts.conclusion : '初读通过，L1/L2 无阻断',
        evidence: [`${wsRel}/review.md`],
      },
      check_evidence: [`${wsRel}/checks.md`],
    };
    const manifestPath = path.join(ws, 'manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify(manifest), 'utf8');
    return { manifestPath, chash, txPath };
  };

  const readPub = (book) => JSON.parse(fs.readFileSync(path.join(book, '追踪', '_publication.json'), 'utf8'));
  const readState = (book) => JSON.parse(fs.readFileSync(path.join(book, '追踪', '_tracking-state.json'), 'utf8'));
  const libChapters = (book) => {
    try {
      const doc = JSON.parse(fs.readFileSync(path.join(book, '追踪', '段落指纹库.json'), 'utf8'));
      return [...new Set((doc.entries || []).map((e) => e.chapter))].sort((a, b) => a - b);
    } catch (e) { return null; }
  };
  const runPy = (args, book, env) =>
    spawnSync(py || 'python', [PYSCRIPT, ...args, '--project', book], { encoding: 'utf8', env: env || cleanEnv });
  const runNode = (args, env) => spawnSync('node', [REPJS, ...args], { encoding: 'utf8', env: env || cleanEnv });
  const runHook = (file, book) => {
    const r = spawnSync('node', [HOOK, 'guard'], {
      encoding: 'utf8', cwd: book || process.cwd(),
      input: JSON.stringify({ tool_name: 'Write', tool_input: { file_path: file } }),
    });
    return { status: r.status, stderr: r.stderr || '', stdout: r.stdout || '' };
  };
  const patchManifest = (p, fn) => {
    const doc = JSON.parse(fs.readFileSync(p, 'utf8'));
    fn(doc);
    fs.writeFileSync(p, JSON.stringify(doc), 'utf8');
  };

  if (!py) {
    skip('D2 全部行为用例', '未找到可用 python 解释器');
  } else {
    // ---------- happy：append 第 1 章一次走完全程 ----------
    let book = initBook('d2happy');
    const staged = stagePublish(book, 'run-1', candCh1(P1, P2));
    let r = runPy(['publish', '--input', staged.manifestPath], book);
    check('D2 happy publish exit 0（prepared→prose→tracking→fingerprint→complete）',
      r.status === 0, `status=${r.status} err=${(r.stderr || r.stdout).trim().slice(0, 300)}`);
    const dest = path.join(book, '正文', '第001章_开篇.md');
    let st = readState(book);
    let pub = readPub(book);
    check('D2 happy：正文=候选、state 至第1章 rev1、journal=complete、锁已释放',
      fs.existsSync(dest) && fs.readFileSync(dest, 'utf8') === candCh1(P1, P2)
      && st.last_committed_chapter === 1 && st.state_revision === 1
      && pub.stage === 'complete' && pub.run_id === 'run-1'
      && !fs.existsSync(path.join(book, '追踪', '.track-lock')),
      `st=${st.last_committed_chapter}/${st.state_revision} pub=${pub.stage}`);
    check('D2 happy：指纹库收录第1章、意象台账已渲染',
      JSON.stringify(libChapters(book)) === '[1]'
      && fs.existsSync(path.join(book, '追踪', '意象台账.md')),
      `chapters=${JSON.stringify(libChapters(book))}`);

    // ---------- happy 第二条：revision（存档+state rev2+指纹重固化） ----------
    const stagedRev = stagePublish(book, 'run-2', candCh1(P1R, P2R),
      { mode: 'revision', expected: 1, result: '修订：老周压平勘合，灯焰被风压矮，数目落进尘灰。' });
    r = runPy(['publish', '--input', stagedRev.manifestPath], book);
    check('D2 revision publish exit 0', r.status === 0,
      `status=${r.status} err=${(r.stderr || r.stdout).trim().slice(0, 300)}`);
    const archiveFiles = fs.existsSync(path.join(book, '正文', '_archive'))
      ? fs.readdirSync(path.join(book, '正文', '_archive')).filter((n) => n.includes('发布前存档')) : [];
    st = readState(book);
    check('D2 revision：发布前存档 1 份、state rev2、正文为候选新版',
      archiveFiles.length === 1 && st.state_revision === 2
      && fs.readFileSync(dest, 'utf8') === candCh1(P1R, P2R)
      && h12file(path.join(book, '正文', '_archive', archiveFiles[0])) === staged.chash,
      `archive=${archiveFiles.length} rev=${st.state_revision}`);
    check('D2 同 run_id complete 重入幂等（不重复存档）',
      runPy(['publish', '--input', stagedRev.manifestPath], book).status === 0
      && fs.readdirSync(path.join(book, '正文', '_archive')).filter((n) => n.includes('发布前存档')).length === 1,
      '');

    // ---------- 中断矩阵：四个阶段 PAUSE exit3 → recover 续跑至 complete ----------
    const pauseCases = [
      ['d2pause-prepared', 'prepared', (b) => !fs.existsSync(path.join(b, '正文', '第001章_开篇.md'))],
      ['d2pause-prose', 'prose_written', (b) => fs.existsSync(path.join(b, '正文', '第001章_开篇.md'))],
      ['d2pause-tracking', 'tracking_committed', () => true],
      ['d2pause-fp', 'fingerprint_committed', () => true],
    ];
    for (const [name, stage, midCheck] of pauseCases) {
      const b = initBook(name);
      const sg = stagePublish(b, `run-${stage}`, candCh1(P1, P2));
      let rr = runPy(['publish', '--input', sg.manifestPath], b, pauseEnv(stage));
      let okPause = rr.status === 3 && readPub(b).stage === stage && midCheck(b);
      // recover 续跑
      rr = runPy(['recover'], b);
      const s2 = readState(b);
      const p2 = readPub(b);
      check(`D2 PAUSE=${stage}：exit3 且现场正确，recover 续跑 complete`,
        okPause && rr.status === 0 && p2.stage === 'complete'
        && s2.last_committed_chapter === 1 && s2.state_revision === 1
        && JSON.stringify(libChapters(b)) === '[1]'
        && fs.readFileSync(path.join(b, '正文', '第001章_开篇.md'), 'utf8') === candCh1(P1, P2)
        && !fs.existsSync(path.join(b, '追踪', '.track-lock')),
        `pause=${rr.status === 0 ? 'ok' : rr.status} after=${p2.stage} st=${s2.state_revision} lib=${JSON.stringify(libChapters(b))} err=${(rr.stderr || '').slice(0, 160)}`);
    }
    // tracking_committed 后崩溃：恢复不得重复 append（last 仍为 1，不长出第 2 章）。
    {
      const b = path.join(TMP, 'd2pause-tracking');
      const stt = readState(b);
      check('D2 tracking_committed 恢复不重复 append（无第2章、rev 仍为1、journal 记录在案）',
        stt.last_committed_chapter === 1 && stt.state_revision === 1
        && readPub(b).steps.tracking_committed && fs.readdirSync(path.join(b, '正文')).length === 1,
        `last=${stt.last_committed_chapter} rev=${stt.state_revision}`);
    }
    // 指纹库损坏 + 中断在 tracking_committed：recover 走 node 受保护恢复（--under-lock）。
    {
      const b = initBook('d2pause-damaged');
      const sg = stagePublish(b, 'run-damaged', candCh1(P1, P2));
      let rr = runPy(['publish', '--input', sg.manifestPath], b, pauseEnv('tracking_committed'));
      const pausedOk = rr.status === 3 && readPub(b).stage === 'tracking_committed';
      fs.writeFileSync(path.join(b, '追踪', '段落指纹库.json'), '{损坏', 'utf8');
      rr = runPy(['recover'], b);
      const quarantined = fs.readdirSync(path.join(b, '追踪'))
        .some((n) => /^段落指纹库\.corrupt-\d+\.json$/.test(n));
      check('D2 损坏库：tracking 中断后 recover 经 --under-lock 受保护恢复并 complete',
        pausedOk && rr.status === 0 && readPub(b).stage === 'complete'
        && quarantined && JSON.stringify(libChapters(b)) === '[1]'
        && !fs.existsSync(path.join(b, '追踪', '.track-lock')),
        `paused=${pausedOk} status=${rr.status} q=${quarantined} err=${(rr.stderr || rr.stdout || '').trim().slice(0, 240)}`);
    }

    // ---------- recover 幂等：无发布文件 no-op exit0 ----------
    {
      const b = initBook('d2noop');
      const rr = runPy(['recover'], b);
      check('D2 recover 无在途发布：no-op exit 0',
        rr.status === 0 && rr.stdout.includes('no_open_publication'),
        `status=${rr.status} out=${rr.stdout.trim()}`);
    }

    // ---------- 发布门消费：非 complete 拦 check 与低层 commit ----------
    {
      const b = initBook('d2idle');
      fs.writeFileSync(path.join(b, '追踪', '_publication.json'),
        JSON.stringify({ schema_version: 1, run_id: 'stuck', stage: 'prepared' }), 'utf8');
      let rr = runPy(['check'], b);
      const checkBlocked = rr.status === 2 && rr.stderr.includes('未完成发布');
      const sg = stagePublish(b, 'ignored', candCh1(P1, P2));
      rr = runPy(['commit', '--input', sg.txPath], b);
      check('D2 发布门：在途发布拦截 check 与低层 commit（不能绕过）',
        checkBlocked && rr.status === 2 && rr.stderr.includes('未完成发布'),
        `check=${checkBlocked} commit=${rr.status} err=${rr.stderr.slice(0, 120)}`);
    }

    // ---------- 拒绝矩阵（prepared 全量前置，任一律失败正文零改动） ----------
    const rejectCase = (name, mutate, expectMsg) => {
      const b = initBook(name);
      const sg = stagePublish(b, 'run-x', candCh1(P1, P2));
      mutate(b, sg);
      const rr = runPy(['publish', '--input', sg.manifestPath], b);
      const clean = !fs.existsSync(path.join(b, '正文', '第001章_开篇.md'))
        && readState(b).state_revision === 0
        && !fs.existsSync(path.join(b, '追踪', '_publication.json'))
        && !fs.existsSync(path.join(b, '追踪', '.track-lock'));
      check(`D2 拒绝：${expectMsg}`,
        rr.status === 2 && rr.stderr.includes(expectMsg) && clean,
        `status=${rr.status} clean=${clean} err=${rr.stderr.trim().slice(0, 160)}`);
    };
    rejectCase('d2rej-baseline', (b, sg) => patchManifest(sg.manifestPath, (d) => {
      d.baseline[0].hash12 = '000000000000';
    }), '基线变化');
    rejectCase('d2rej-candidate', (b, sg) => {
      fs.appendFileSync(path.join(b, '.guyin', 'work', 'run-x', 'candidate.md'), '\n候选已被偷改。\n', 'utf8');
    }, '未绑定候选哈希');
    rejectCase('d2rej-review', (b, sg) => patchManifest(sg.manifestPath, (d) => {
      d.review.conclusion = '';
    }), 'conclusion');
    rejectCase('d2rej-pending', (b) => {
      fs.writeFileSync(path.join(b, '追踪', '待审台账.md'),
        `${LEDGER}| 1 | beat | x | hard | | 待审 | | |\n`, 'utf8');
    }, '未决阻断');
    rejectCase('d2rej-revision', (b, sg) => patchManifest(sg.manifestPath, (d) => {
      d.target.mode = 'revision';
    }), 'revision 目标不存在');
    rejectCase('d2rej-outside', (b, sg) => {
      const rogue = path.join(b, '正文', '_野稿.md');
      fs.writeFileSync(rogue, candCh1(P1, P2), 'utf8');
      patchManifest(sg.manifestPath, (d) => { d.candidate = '正文/_野稿.md'; });
    }, '隔离工作区');
    {
      const b = initBook('d2rej-append');
      fs.writeFileSync(path.join(b, '正文', '第001章_开篇.md'), '旧文。\n', 'utf8');
      const sg = stagePublish(b, 'run-x', candCh1(P1, P2),
        { proseFiles: ['第001章_开篇.md'] });
      const rr = runPy(['publish', '--input', sg.manifestPath], b);
      check('D2 拒绝：append 目标已存在（修订须走 revision）',
        rr.status === 2 && rr.stderr.includes('append 目标已存在')
        && fs.readFileSync(path.join(b, '正文', '第001章_开篇.md'), 'utf8') === '旧文。\n',
        `status=${rr.status} err=${rr.stderr.trim().slice(0, 140)}`);
    }
    rejectCase('d2rej-rev', (b, sg) => patchManifest(sg.manifestPath, (d) => {
      d.expected_state_revision = 5;
    }), 'expected_state_revision');

    // ---------- 废弃候选零污染 ----------
    {
      const b = path.join(TMP, 'd2happy');
      const before = readState(b);
      const ws2 = path.join(b, '.guyin', 'work', 'abandoned');
      fs.mkdirSync(ws2, { recursive: true });
      fs.writeFileSync(path.join(ws2, 'candidate.md'), '废弃候选，永不发布。\n', 'utf8');
      const rr = runPy(['check'], b);
      const after = readState(b);
      check('D2 废弃候选留在隔离工作区：check 通过、正式状态与正文零变化',
        rr.status === 0 && before.state_revision === after.state_revision
        && before.last_committed_chapter === after.last_committed_chapter
        && fs.readdirSync(path.join(b, '正文')).filter((n) => /^第0*\d+章/.test(n)).length === 1
        && JSON.stringify(libChapters(b)) === '[1]',
        `status=${rr.status}`);
    }

    // ---------- 项目锁：活 pid 互斥（py 与 node 同协议）、死 pid 清陈旧、under-lock 校验 ----------
    {
      const b = initBook('d2lock-live');
      const lockDir = path.join(b, '追踪', '.track-lock');
      fs.mkdirSync(lockDir, { recursive: true });
      fs.writeFileSync(path.join(lockDir, 'owner.json'),
        JSON.stringify({ pid: process.pid, host: 'test', label: 'test-live', started_at: 'x' }), 'utf8');
      const sg = stagePublish(b, 'run-x', candCh1(P1, P2));
      let rr = runPy(['commit', '--input', sg.txPath], b);
      const pyBlocked = rr.status === 2 && rr.stderr.includes('项目被占用');
      fs.writeFileSync(path.join(b, '正文', '第001章_开篇.md'), candCh1(P1, P2), 'utf8');
      rr = runNode(['--commit', '--project', b, path.join(b, '正文', '第001章_开篇.md')]);
      const nodeBlocked = rr.status === 2 && rr.stderr.includes('项目被占用');
      check('D2 活 pid 锁：python commit 与 node --commit 双双互斥',
        pyBlocked && nodeBlocked && fs.existsSync(lockDir),
        `py=${pyBlocked} node=${nodeBlocked} nerr=${rr.stderr.trim().slice(0, 120)}`);
      const bNoLock = initBook('d2lock-underlock');
      fs.writeFileSync(path.join(bNoLock, '正文', '第001章_开篇.md'), candCh1(P1, P2), 'utf8');
      rr = runNode(['--commit', '--under-lock', '--project', bNoLock,
        path.join(bNoLock, '正文', '第001章_开篇.md')]);
      check('D2 --under-lock 无锁时拒绝（发布器内部接口不空转）',
        rr.status === 2 && rr.stderr.includes('under-lock'),
        `status=${rr.status} err=${rr.stderr.trim().slice(0, 120)}`);
    }
    {
      const b = initBook('d2lock-stale');
      const lockDir = path.join(b, '追踪', '.track-lock');
      fs.mkdirSync(lockDir, { recursive: true });
      fs.writeFileSync(path.join(lockDir, 'owner.json'),
        JSON.stringify({ pid: 999999, host: 'test', label: 'dead', started_at: 'x' }), 'utf8');
      const sg = stagePublish(b, 'run-x', candCh1(P1, P2));
      const rr = runPy(['commit', '--input', sg.txPath], b);
      check('D2 死 pid 陈旧锁：自动挪走后 commit 成功，锁目录清空',
        rr.status === 0 && !fs.existsSync(lockDir) && readState(b).state_revision === 1,
        `status=${rr.status} err=${rr.stderr.trim().slice(0, 120)}`);
    }

    // ---------- 指纹库受保护恢复（node CLI 直测） ----------
    {
      const b = initBook('d2fp');
      const sg = stagePublish(b, 'run-1', candCh1(P1, P2));
      let rr = runPy(['publish', '--input', sg.manifestPath], b);
      const happy = rr.status === 0;
      fs.writeFileSync(path.join(b, '追踪', '段落指纹库.json'), '{损坏', 'utf8');
      // 普通扫描遇损坏库：报错指向显式恢复，不放行。
      rr = runNode(['--json', '--project', b, path.join(b, '正文', '第001章_开篇.md')]);
      const plainBlocked = rr.status === 2 && rr.stderr.includes('--recover-library');
      // 受保护恢复：隔离 + 全量重放 + 复检通过。
      rr = runNode(['--json', '--recover-library', '--project', b, path.join(b, '正文')]);
      let report = parseJson(rr.stdout);
      const quarantineExists = report && report.quarantine
        && fs.existsSync(path.join(b, '追踪', path.basename(report.quarantine)));
      const recovered = rr.status === 0 && report && report.recovered === true
        && report.verification && report.verification.status === 0
        && quarantineExists && JSON.stringify(libChapters(b)) === '[1]';
      // 库健康再跑：no-op。
      const rr2 = runNode(['--json', '--recover-library', '--project', b, path.join(b, '正文')]);
      const healthy = rr2.status === 0 && (rr2.stdout || '').includes('healthy');
      check('D2 损坏库：普通扫描拒绝并指路；--recover-library 隔离+重放+复检成功；健康库 no-op',
        happy && plainBlocked && recovered && healthy,
        `happy=${happy} plain=${plainBlocked} recovered=${recovered} healthy=${healthy} out=${rr.stdout.trim().slice(0, 200)} err=${rr.stderr.trim().slice(0, 160)}`);
    }
    {
      // 复检有阻断时绝不冒充通过：ch2 与 ch1 仅差一个字（bigram Jaccard ≈0.93 近抄）。
      const b = initBook('d2fpfail');
      fs.writeFileSync(path.join(b, '正文', '第001章_开篇.md'), `${P1}\n\n${P2}\n`, 'utf8');
      const near = P1.replace('案', '柜');
      fs.writeFileSync(path.join(b, '正文', '第002章_再开.md'), `${near}\n\n${P2R}\n`, 'utf8');
      fs.writeFileSync(path.join(b, '追踪', '段落指纹库.json'), '{损坏', 'utf8');
      const rr = runNode(['--json', '--recover-library', '--project', b, path.join(b, '正文')]);
      const report = parseJson(rr.stdout);
      const quarantineExists = report && report.quarantine
        && fs.existsSync(path.join(b, '追踪', path.basename(report.quarantine)));
      check('D2 恢复复检存在近抄阻断时 exit1/recovered=false（不把检测失败冒充恢复成功）',
        rr.status === 1 && report && report.recovered === false && quarantineExists,
        `status=${rr.status} out=${rr.stdout.trim().slice(0, 220)} err=${rr.stderr.trim().slice(0, 160)}`);
    }

    // ---------- hook 发布门 ----------
    {
      const b = initBook('d2hook');
      fs.mkdirSync(path.join(b, '大纲'), { recursive: true });
      fs.writeFileSync(path.join(b, '大纲', '细纲_第002章.md'), '1. 承接。', 'utf8');
      fs.writeFileSync(path.join(b, '追踪', '_tracking-state.json'),
        JSON.stringify({ schema_version: 7, last_committed_chapter: 1, state_revision: 1 }), 'utf8');
      const target = path.join(b, '正文', '第002章_新.md');
      let hh = runHook(target, b);
      const noPub = hh.status === 0;
      fs.writeFileSync(path.join(b, '追踪', '_publication.json'),
        JSON.stringify({ schema_version: 1, run_id: 'r', stage: 'tracking_committed' }), 'utf8');
      hh = runHook(target, b);
      const blocked = hh.status === 2 && hh.stderr.includes('发布进行到一半');
      fs.writeFileSync(path.join(b, '追踪', '_publication.json'), '{损坏', 'utf8');
      hh = runHook(target, b);
      const broken = hh.status === 2 && hh.stderr.includes('损坏');
      fs.writeFileSync(path.join(b, '追踪', '_publication.json'),
        JSON.stringify({ schema_version: 1, run_id: 'r', stage: 'complete' }), 'utf8');
      hh = runHook(target, b);
      const done = hh.status === 0;
      check('D2 hook 发布门：无文件放行 / 在途拦 / 损坏拦 / complete 放行（首建与覆盖同函数）',
        noPub && blocked && broken && done,
        `none=${noPub} block=${blocked} broken=${broken} done=${done} err=${hh.stderr.trim().slice(0, 100)}`);
    }
  }
}

// ============================================================
console.log('== guyin-check-outline-deliver S3 承诺交付 ==');
{
  // 大纲契约：术语锚点双术语；三个变体验证全合规静默与两条 advisory（四组化：钩子规则已废）。
  const outline = '# 第061章 细纲\n- 术语锚点：勘合（老周在账房说出）、火耗——师爷写账时提到\n';
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

  let r = run('guyin-check-outline-deliver.js', ['--json', dolvA]);
  let report = parseJson(r.stdout);
  check('S3 全履约静默（双术语对白锚定）', r.status === 0 && report && report.findings.length === 0,
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
}

// ============================================================
console.log('== guyin-check-outline-deliver R1+K2（docs/08：锚句落地/跨章签名句，四组化） ==');
{
  // R1：锚句未落地；K2：跨章签名句提前释放与已声明复用静默（签名句仅复沓锚句——任务书 §2.1）。
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
  const ol = (anchor) => `# 细纲\n- 术语锚点：无\n- 复沓锚句：${anchor}\n`;

  // 全履约：锚句一字不差落地 → 静默
  const dirOk = mkProj('ok',
    { '061': ol('「立此为凭，账没算完」') },
    { '061': '他把笔搁下。「立此为凭，账没算完。」\n\n说完把那封信压在匣底，吹熄了灯。\n' });
  let r = run('guyin-check-outline-deliver.js', ['--json', dirOk]);
  let report = parseJson(r.stdout);
  check('R1 锚句落地静默', r.status === 0 && report && report.findings.length === 0,
    `status=${r.status} findings=${JSON.stringify(report && report.findings.map((f) => f.type))}`);

  // R1：锚句未落地（四组化：钩子引语规则已废，签名句聚合收窄为仅复沓锚句）
  const dirBad = mkProj('bad',
    { '062': ol('「立此为凭，账没算完」') },
    { '062': '他推说账目还要再核，把册子合上。\n\n小窦在廊下站了半晌，只说上个月也有人来对过号。\n' });
  r = run('guyin-check-outline-deliver.js', ['--json', dirBad]);
  report = parseJson(r.stdout);
  check('R1 锚句未落地报 outline-anchor-missing', r.status === 1 && report
    && report.findings.some((f) => f.type === 'outline-anchor-missing'),
    `status=${r.status} findings=${JSON.stringify(report && report.findings.map((f) => f.type))}`);

  // K2：ch61 提前说出 ch62 签名句 → 报 preempted；双方声明同一锚句（复沓仪式）→ 静默
  const dirLeak = mkProj('leak',
    {
      '061': ol('「留着一并算」'),
      '062': ol('「三炉烧不出两炉的引子」'),
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
      '061': ol('「立此为凭，账没算完」'),
      '062': ol('「立此为凭，账没算完」'),
    },
    {
      '061': '他落笔：「立此为凭，账没算完。」\n\n搁笔，灯花跳了一下。\n',
      '062': '周砚看着那行字：「立此为凭，账没算完。」\n\n灯花爆了一下。\n',
    });
  r = run('guyin-check-outline-deliver.js', ['--json', dirEcho]);
  report = parseJson(r.stdout);
  check('K2 已声明复用（复沓仪式）静默', r.status === 0 && report && report.findings.length === 0,
    `status=${r.status} findings=${JSON.stringify(report && report.findings.map((f) => f.type))}`);

  // 四组化反向锁（任务书 §2.1）：细纲残留旧「章尾钩子」行时零报——钩子规则已废，
  // 删掉的栏目不得仍由脚本强制（存量细纲不追溯）。
  const dirGhost = mkProj('ghost',
    { '063': '# 细纲\n- 术语锚点：无\n- 复沓锚句：无\n- 章尾钩子：悬念型——实体：账本缺页；承接：第64章对质\n' },
    { '063': '他把册子合上，起身吹熄了灯。\n' });
  r = run('guyin-check-outline-deliver.js', ['--json', dirGhost]);
  report = parseJson(r.stdout);
  check('四组化残留章尾钩子行零报（钩子规则已废，存量不追溯）',
    r.status === 0 && report && report.findings.length === 0,
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
  r = run('guyin-check-strip.js', ['--fail-on=block', scaffold]);
  check('K3 blocking 触发 --fail-on=block', r.status === 1, `status=${r.status}`);

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
  r = run('guyin-check-strip.js', [leakWords]);
  check('K3 工序词 strip-framework-word → verify（默认门 exit 1）', r.status === 1, `status=${r.status}`);

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
  check('卡标果决+反特质×3零正特质报 flesh-trait-break（verify，默认门 exit 1）', r.status === 1 && report
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
  check('--all 戏份概览按句数降序且断裂随报（verify，默认门 exit 1）', r.status === 1 && report
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
  // P5-2：第3/5章掉崖（-37%/-31%）。E1：第4-5章无推进不再产弃书点（drop-point 废除）。
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

  // E1：取消「连续两章不推主线即弃书」自动归因——第4-5章无推进只出现在掉崖表上下文列，
  // 不再机械生成 drop-point；无读者实测数据不得替读者下弃书结论。
  check('E1/P5-3 连续无推进不再自动归因弃书点（drop-point 已废除）', report
    && report.summary.drop_points === undefined
    && !report.findings.some((f) => f.type === 'drop-point'),
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
  check('P7-2 简介钩子覆盖：期待钩命中、漏覆盖两报（危机可隐/悬念应映射；verify 默认门 exit 1）', r.status === 1 && report
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
  const crypto = require('crypto');
  const runHook = (args, input, cwd) => {
    const r = spawnSync('node', [HOOK, ...args], { encoding: 'utf8', input, cwd: cwd || process.cwd() });
    return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
  };
  const payload = (file) => JSON.stringify({ tool_name: 'Write', tool_input: { file_path: file } });

  // 书A：第 1/2 章细纲齐 + state 已提交至第 1 章 + 第 1 章正文已存在
  const bookA = path.join(TMP, 'hook', '书A');
  fixture('hook/书A/大纲/细纲_第001章_试.md', '1. 开场。');
  fixture('hook/书A/大纲/细纲_第002章_试.md', '1. 承接。');
  fixture('hook/书A/追踪/_tracking-state.json', JSON.stringify({ schema_version: 7, last_committed_chapter: 1, state_revision: 1 }));
  fixture('hook/书A/正文/第001章_试.md', `# 第001章 试${'\n'}${longChapter(75)}`);
  fixture('hook/书A/追踪/上下文.md', `# 上下文${'\n'}${'\n'}## 当前位置${'\n'}- 第 1 章已交付${'\n'}`);

  // 书B：只有第 2 章细纲，state 停在第 0 章（上一章未提交）
  const bookB = path.join(TMP, 'hook', '书B');
  fixture('hook/书B/大纲/细纲_第002章_试.md', '1. 承接。');
  fixture('hook/书B/追踪/_tracking-state.json', JSON.stringify({ schema_version: 7, last_committed_chapter: 0, state_revision: 0 }));

  // D3：书项目内台账缺失=拦截（不再 fail-open）——书A/书B 补合法空表走既有用例原语义。
  const emptyLedger = [
    '| 章号 | 来源 | 报警/发现 | 处置类别 | 正文版本 | 终态 | 决定依据 | 去向/备注 |',
    '|---|---|---|---|---|---|---|---|',
    '',
  ].join('\n');
  fixture('hook/书A/追踪/待审台账.md', emptyLedger);
  fixture('hook/书B/追踪/待审台账.md', emptyLedger);

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

  // Fw-07/D3 hook 侧（U1/D2 两份实现同步验证）：书D state 到第2章、ch3 细纲齐，
  // 待审台账 ch1 行「升级作者」——「已裁决：」只是线索仍拦截；用户转结（终态改五选一＋证据）后放行。
  const bookD = path.join(TMP, 'hook', '书D');
  fixture('hook/书D/大纲/细纲_第003章_试.md', '1. 第三开场。');
  fixture('hook/书D/追踪/_tracking-state.json', JSON.stringify({ schema_version: 7, last_committed_chapter: 2, state_revision: 2 }));
  const HDR8 = '| 章号 | 来源 | 报警/发现 | 处置类别 | 正文版本 | 终态 | 决定依据 | 去向/备注 |';
  const SEP8 = '|---|---|---|---|---|---|---|---|';
  const dLedger = path.join(bookD, '追踪', '待审台账.md');
  fixture('hook/书D/追踪/待审台账.md', [
    HDR8, SEP8,
    '| 1 | ai-patterns | 碎化率 62% | verify | aaaaaaaaaaaa | 升级作者 | 已裁决：转豁免，登豁免台账#1 | |',
    '',
  ].join('\n'));
  r = runHook(['guard'], payload(path.join(bookD, '正文', '第003章_试.md')));
  check('Fw-07/D3 guard 升级作者=等待态，「已裁决：」不转结仍拦截（hook 侧）',
    r.status === 2 && r.stderr.includes('等待态'),
    `status=${r.status} err=${r.stderr.trim().slice(0, 120)}`);
  fs.writeFileSync(dLedger, [
    HDR8, SEP8,
    '| 1 | ai-patterns | 碎化率 62% | verify | aaaaaaaaaaaa | 豁免 | 豁免台账#1，用户裁决保留 | |',
    '',
  ].join('\n'));
  r = runHook(['guard'], payload(path.join(bookD, '正文', '第003章_试.md')));
  check('Fw-07/D3 guard 用户转结五终态＋证据后放行（hook 侧）',
    r.status === 0, `status=${r.status} err=${r.stderr.trim().slice(0, 120)}`);

  // v3-A1/D3 hook 侧（U1/D2 同步验证）：「不适用」缺证据按未决拦截；决定依据补位置＋理由后放行。
  const bookE = path.join(TMP, 'hook', '书E');
  fixture('hook/书E/大纲/细纲_第003章_试.md', '1. 第三开场。');
  fixture('hook/书E/追踪/_tracking-state.json', JSON.stringify({ schema_version: 7, last_committed_chapter: 2, state_revision: 2 }));
  const eLedger = path.join(bookE, '追踪', '待审台账.md');
  fixture('hook/书E/追踪/待审台账.md', [
    HDR8, SEP8,
    '| 1 | beat | 时间压缩词 | verify | aaaaaaaaaaaa | 不适用 | 误报，不是问题 | |',
    '',
  ].join('\n'));
  r = runHook(['guard'], payload(path.join(bookE, '正文', '第003章_试.md')));
  check('v3-A1/D3 guard 不适用缺证据拦截（hook 侧与 check-pending 一致）',
    r.status === 2 && r.stderr.includes('不适用'),
    `status=${r.status} err=${r.stderr.trim().slice(0, 120)}`);
  fs.writeFileSync(eLedger, [
    HDR8, SEP8,
    '| 1 | beat | 时间压缩词 | verify | aaaaaaaaaaaa | 不适用 | 第1章 L7：雨夜赶路的省笔过渡，有功能 | |',
    '',
  ].join('\n'));
  r = runHook(['guard'], payload(path.join(bookE, '正文', '第003章_试.md')));
  check('v3-A1/D3 guard 不适用证据齐全放行（hook 侧）',
    r.status === 0, `status=${r.status} err=${r.stderr.trim().slice(0, 120)}`);

  // D3 hook 侧版本比对：行版本匹配当前盘上正文 → 拦；版本不匹配（历史行）→ 放行。
  const bookF = path.join(TMP, 'hook', '书F');
  fixture('hook/书F/大纲/细纲_第003章_试.md', '1. 第三开场。');
  fixture('hook/书F/追踪/_tracking-state.json', JSON.stringify({ schema_version: 7, last_committed_chapter: 2, state_revision: 2 }));
  const fProse = '张三把册子推过来，指着那方印。';
  const fHash = crypto.createHash('sha256').update(Buffer.from(fProse, 'utf8')).digest('hex').slice(0, 12);
  fixture('hook/书F/正文/第001章_试.md', fProse);
  const fLedger = path.join(bookF, '追踪', '待审台账.md');
  fixture('hook/书F/追踪/待审台账.md', [
    HDR8, SEP8,
    `| 1 | beat | a | hard | ${fHash} | 待审 | | 版本匹配当前 |`,
    '',
  ].join('\n'));
  r = runHook(['guard'], payload(path.join(bookF, '正文', '第003章_试.md')));
  check('D3 guard 版本匹配当前正文的未决行拦截（hook 侧）',
    r.status === 2 && r.stderr.includes('未决'),
    `status=${r.status} err=${r.stderr.trim().slice(0, 120)}`);
  fs.writeFileSync(fLedger, [
    HDR8, SEP8,
    '| 1 | beat | a | hard | 000000000000 | 待审 | | 历史版本行只记录不阻塞 |',
    '',
  ].join('\n'));
  r = runHook(['guard'], payload(path.join(bookF, '正文', '第003章_试.md')));
  check('D3 guard 历史版本行（≠当前正文哈希）不阻塞（hook 侧）',
    r.status === 0, `status=${r.status} err=${r.stderr.trim().slice(0, 120)}`);

  // D3 hook 侧损坏拦截：旧五列台账（缺列）→ guard 拦并报异常，不静默放行。
  const bookG = path.join(TMP, 'hook', '书G');
  fixture('hook/书G/大纲/细纲_第003章_试.md', '1. 第三开场。');
  fixture('hook/书G/追踪/_tracking-state.json', JSON.stringify({ schema_version: 7, last_committed_chapter: 2, state_revision: 2 }));
  fixture('hook/书G/追踪/待审台账.md', [
    '| 章号 | 来源 | 报警/发现 | 终态 | 去向/备注 |',
    '|---|---|---|---|---|',
    '| 1 | beat | x | 待审 | |',
    '',
  ].join('\n'));
  r = runHook(['guard'], payload(path.join(bookG, '正文', '第003章_试.md')));
  check('D3 guard 台账缺列（旧五列）拦截并报异常（hook 侧）',
    r.status === 2 && r.stderr.includes('缺列'),
    `status=${r.status} err=${r.stderr.trim().slice(0, 120)}`);

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
  fixture('hook/书C/追踪/_tracking-state.json', JSON.stringify({ schema_version: 7, last_committed_chapter: 2, state_revision: 2 }));
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
  // v3-A3：落盘门顺带校验 设定/题材定位.md（依赖文件）——夹具项目补一份实质内容版，
  // 「全字段静默」语义含依赖齐全（A3 测试块另测缺件/占位/未定各形态）。
  fixture('o2slots/设定/题材定位.md', [
    '# 题材定位', '',
    '## 读者契约', '',
    '- 主要阅读回报：查案解谜＋师徒并肩，一案一结', '',
    '## 终局底牌与升级台阶', '',
    '- 终局底牌：头号宿敌=账房师叔·第3卷', '',
    '- 升级台阶：讼师品级共5档 × 每档约40万字', '',
  ].join('\n'));
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
  const beatHardTypes = ['outline-missing-group-1', 'outline-missing-group-2', 'outline-missing-group-3',
    'outline-missing-group-4', 'outline-missing-wordcount', 'outline-missing-anchor', 'outline-missing-holdback'];
  for (const t of beatHardTypes) {
    check(`O2 beat 版残缺细纲必报 ${t}（四组化 hard）`, r.status === 1 && report
      && report.findings.some((f) => f.type === t && f.severity === 'blocking'),
      `types=${JSON.stringify(report && report.findings.map((f) => f.type))}`);
  }

  const fullOutlineLines = [
    '# 细纲_第065章 齐全',
    '',
    '#### 一、本章要交付什么',
    '',
    '- 核心事件：林彻核对总账，账本缺口浮出',
    '- 读者承诺：查案解谜＋师徒并肩，一案一结（当下目标：对出缺页真相/入口体验：账房对账的智性紧张/近期回报：第66章对质）',
    '- 字数目标：3000',
    '- 术语锚点：无',
    '',
    '#### 二、人为何这样行动',
    '',
    '- 林彻：查账是本职，缺页触及师门旧事，必须查',
    '- 周砚：交底是试探，留了后手',
    '',
    '#### 三、场景如何承接',
    '',
    '- 场景序列：账房（开场：总账核对）→ 当铺后巷（对手戏：周砚交私账）→ 账房（收尾：发现缺页）',
    '- 章尾落点：林彻捏着缺页的手停在灯下',
    '',
    '#### 四、哪些不能擅改',
    '',
    '- 禁止提前释放：无',
    '- 复沓锚句：无',
    '',
  ];
  const fullOutline = fixture('o2slots/大纲/细纲_第065章_全字段.md', fullOutlineLines.join('\n'));
  r = run('guyin-check-outline-slots.js', ['--json', fullOutline]);
  report = parseJson(r.stdout);
  check('O2 四组细纲静默（四组齐备+保留行齐备，已废除槽位零发射）',
    r.status === 0 && report && report.findings.length === 0,
    `status=${r.status} findings=${JSON.stringify(report && report.findings.map((f) => f.type))}`);

  // 四组化单项（任务书 §2.1）：缺哪组报哪组——只缺组三 → 仅 group-3 一条组报；
  // 缺字数目标行单独报 wordcount。时序自检/情绪落点/场景下限等槽位已废除（存量不追溯）。
  const noGroup3 = fixture('o2slots/大纲/细纲_第066章_缺组三.md',
    fullOutlineLines.filter((l) => !l.includes('场景如何承接')).join('\n'));
  r = run('guyin-check-outline-slots.js', ['--json', noGroup3]);
  report = parseJson(r.stdout);
  check('O2 只缺组三必报 outline-missing-group-3（缺哪组报哪组）', r.status === 1 && report
    && report.findings.some((f) => f.type === 'outline-missing-group-3')
    && report.findings.filter((f) => f.type.startsWith('outline-missing-group-')).length === 1,
    `types=${JSON.stringify(report && report.findings.map((f) => f.type))}`);

  const noWordcount = fixture('o2slots/大纲/细纲_第067章_缺字数.md',
    fullOutlineLines.filter((l) => !l.includes('字数目标')).join('\n'));
  r = run('guyin-check-outline-slots.js', ['--json', noWordcount]);
  report = parseJson(r.stdout);
  check('O2 缺字数目标行报 outline-missing-wordcount', r.status === 1 && report
    && report.findings.some((f) => f.type === 'outline-missing-wordcount'),
    `types=${JSON.stringify(report && report.findings.map((f) => f.type))}`);

  // S2 气卡坐标覆盖预检（docs/07 §二 S2；Y2 路径/口径修正，docs/09 §三）：章号不落
  // 「当前」坐标行区间 → advisory；落在区间内/气卡缺失/无当前行 → 静默（fail-open）。
  fixture('s2qy/设定/题材定位.md', [
    '# 题材定位', '',
    '## 读者契约', '',
    '- 主要阅读回报：查案解谜＋师徒并肩，一案一结', '',
    '## 终局底牌与升级台阶', '',
    '- 终局底牌：头号宿敌=账房师叔·第3卷', '',
  ].join('\n'));
  fixture('s2qy/作者性/气卡.md', '# 气卡\n\n当前阶段：第61-63章（卷三·山雨欲来）——以天合天。\n');
  const qyOutside = fixture('s2qy/大纲/细纲_第065章_试.md', fullOutlineLines.join('\n'));
  r = run('guyin-check-outline-slots.js', ['--json', qyOutside]);
  report = parseJson(r.stdout);
  check('S2 章号不在气卡坐标区间报 qiyun-coord-uncovered（65∉61-63，editorial 默认门 exit 0）', r.status === 0 && report
    && report.findings.some((f) => f.type === 'qiyun-coord-uncovered' && f.severity === 'advisory'
      && f.message.includes('61-63')),
    `status=${r.status} types=${JSON.stringify(report && report.findings.map((f) => f.type))}`);
  const qyInside = fixture('s2qy/大纲/细纲_第062章_试.md', fullOutlineLines.join('\n'));
  r = run('guyin-check-outline-slots.js', ['--json', qyInside]);
  report = parseJson(r.stdout);
  check('S2 章号落在区间内静默（62∈61-63）', r.status === 0 && report && report.findings.length === 0,
    `status=${r.status} types=${JSON.stringify(report && report.findings.map((f) => f.type))}`);
  fixture('s2qy2/设定/题材定位.md', [
    '# 题材定位', '',
    '## 读者契约', '',
    '- 主要阅读回报：查案解谜＋师徒并肩，一案一结', '',
    '## 终局底牌与升级台阶', '',
    '- 终局底牌：头号宿敌=账房师叔·第3卷', '',
  ].join('\n'));
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
  fixture('y2qy/设定/题材定位.md', [
    '# 题材定位', '',
    '## 读者契约', '',
    '- 主要阅读回报：查案解谜＋师徒并肩，一案一结', '',
    '## 终局底牌与升级台阶', '',
    '- 终局底牌：头号宿敌=账房师叔·第3卷', '',
  ].join('\n'));
  const yq61 = fixture('y2qy/大纲/细纲_第061章_试.md', fullOutlineLines.join('\n'));
  r = run('guyin-check-outline-slots.js', ['--json', yq61]);
  report = parseJson(r.stdout);
  check('Y2 设定/气韵卡.md 坐标停旧段必报（61∉28-32，卷3 规划行不算覆盖；editorial 默认门 exit 0）', r.status === 0 && report
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
  fixture('y2qy2/设定/题材定位.md', [
    '# 题材定位', '',
    '## 读者契约', '',
    '- 主要阅读回报：查案解谜＋师徒并肩，一案一结', '',
    '## 终局底牌与升级台阶', '',
    '- 终局底牌：头号宿敌=账房师叔·第3卷', '',
  ].join('\n'));
  const yq65 = fixture('y2qy2/大纲/细纲_第065章_试.md', fullOutlineLines.join('\n'));
  r = run('guyin-check-outline-slots.js', ['--json', yq65]);
  report = parseJson(r.stdout);
  check('Y2 模板坐标节未实例化（无数字区间）静默', r.status === 0 && report && report.findings.length === 0,
    `status=${r.status} types=${JSON.stringify(report && report.findings.map((f) => f.type))}`);

  // v3-A3 书级题材/读者契约依赖检查（任务书 §4 A3）：细纲落盘门顺带校验
  // 设定/题材定位.md——缺文件/必要节缺/占位未实例化 → advisory；非升级型「不适用＋
  // 替代阶段说明」是合法显式决定放行。只查结构不打分（不是 genre-fit 评分器）。
  const genreMissing = fixture('a3genre/大纲/细纲_第070章_缺题材定位.md', fullOutlineLines.join('\n'));
  r = run('guyin-check-outline-slots.js', ['--json', genreMissing]);
  report = parseJson(r.stdout);
  check('A3 题材定位文件缺失 → advisory outline-genre-contract-missing',
    r.status === 1 && report
      && report.findings.some((f) => f.type === 'outline-genre-contract-missing' && f.severity === 'advisory'),
    `status=${r.status} types=${JSON.stringify(report && report.findings.map((f) => f.type))}`);

  fixture('a3ph/设定/题材定位.md', [
    '# 题材定位', '',
    '## 读者契约', '',
    '- 主要阅读回报：{{读者来追什么：爽感/情绪/关系/事业/解谜…——具体到回报形态}}', '',
    '## 终局底牌与升级台阶', '',
    '- 终局底牌：头号宿敌={{}}·第{{X}}卷；金手指上限={{}}·第{{X}}卷', '',
  ].join('\n'));
  const genrePlaceholder = fixture('a3ph/大纲/细纲_第071章_占位.md', fullOutlineLines.join('\n'));
  r = run('guyin-check-outline-slots.js', ['--json', genrePlaceholder]);
  report = parseJson(r.stdout);
  check('A3 读者契约节 {{...}} 占位未实例化 → advisory（模板原样不算可用内容）',
    r.status === 1 && report
      && report.findings.some((f) => f.type === 'outline-genre-contract-missing' && f.message.includes('读者契约')),
    `status=${r.status} types=${JSON.stringify(report && report.findings.map((f) => f.type))}`);

  fixture('a3na/设定/题材定位.md', [
    '# 题材定位', '',
    '## 读者契约', '',
    '- 主要阅读回报：世情冷暖＋小人物翻案，一桩一报', '',
    '## 终局底牌与升级台阶', '',
    '- 非升级型说明：不适用——本书无升级体系，替代的阶段变化为关系四阶段（结怨/试探/托付/共生），每阶段揭示一层真相', '',
  ].join('\n'));
  const genreNA = fixture('a3na/大纲/细纲_第072章_非升级型.md', fullOutlineLines.join('\n'));
  r = run('guyin-check-outline-slots.js', ['--json', genreNA]);
  report = parseJson(r.stdout);
  check('A3 非升级型「不适用＋替代阶段说明」→ 放行（合法显式决定）',
    r.status === 0 && report && !report.findings.some((f) => f.type === 'outline-genre-contract-missing'),
    `status=${r.status} types=${JSON.stringify(report && report.findings.map((f) => f.type))}`);

  // setup 模板骨架完整性（Phase 0 清单登记项）：必要节随模板分发，防模板缺失/被误删。
  const genreTplPath = path.join(REPO, 'skills', 'guyin-setup', 'templates', 'long', '设定', '题材定位.md');
  const genreTplOk = fs.existsSync(genreTplPath);
  const genreTpl = genreTplOk ? fs.readFileSync(genreTplPath, 'utf8') : '';
  check('A3 setup 模板含 题材定位.md 骨架（Phase 0 清单登记）',
    genreTplOk && /## 读者契约/.test(genreTpl) && /## 终局底牌与升级台阶/.test(genreTpl)
      && /## 允许的叙事手法\/边界/.test(genreTpl) && /对标登记/.test(genreTpl) && genreTpl.includes('{{'),
    `exists=${genreTplOk}`);

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
  check('J2 均质批报 chapter-length-uniform advisory（editorial，默认门 exit 0）', r.status === 0 && report
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
  check('I2 黑名单每章超限必报 phrase-quota advisory（editorial，默认门 exit 0）', r.status === 0 && report
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

  // v3-C2：solo 说明与 write 可选卡协议同步——陈旧「三硬动作（先组卡后填卡…）」与现行
  // 「允许直写、卡可选」（Fw-08 反转后）冲突（任务书 §2.6）；五处同步后以断言锁住防回潮。
  const soloSyncFiles = [
    'skills/guyin-setup/SKILL.md',
    'skills/guyin-write/agents/guyin-beat-writer.md',
    'long/.claude/agents/guyin-beat-writer.md',
    'long/.opencode/agents/guyin-beat-writer.md',
    'long/.codex/agents/guyin-beat-writer.toml',
  ];
  for (const rel of soloSyncFiles) {
    const full = rel.startsWith('long/') ? path.join(T, rel) : path.join(REPO, rel);
    const content = fs.readFileSync(full, 'utf8');
    check(`v3-C2 ${rel} 无陈旧 solo 三硬动作措辞`, !/三硬动作|先组卡后填卡|笔法嚼碎/.test(content), `含陈旧措辞`);
    check(`v3-C2 ${rel} solo 三条与 write 协议同步`, /solo 三条/.test(content), `缺「solo 三条」现行措辞`);
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
  r = run('guyin-check-beat.js', ['--json', '--mono-limit=0', chBeat]);
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
  check('SP1-正例 同章中段同拍重复 ×2 报 phrase-echo-inline（editorial，默认门 exit 0）',
    r.status === 0 && rep
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
  check('SP3-正例 同字夹冒号报 stutter-punct（editorial，默认门 exit 0）',
    r.status === 0 && rep
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
  let r = run('guyin-check-beat.js', ['--json', '--mono-limit=0', cognition]);
  let report = parseJson(r.stdout);
  check('Fw-05 知道/明白/清楚/疑惑/纳闷不计数（mono-limit=0 仍零报）',
    report && !report.findings.some((f) => f.type === 'mono-count'),
    `findings=${JSON.stringify(report && report.findings.map((f) => f.type))}`);

  // 内心独白标记（心想）+ 情绪告知词（愤怒/恐惧）引号外计数；对白内「觉得」不计。
  const emotion = fixture('fw05beat/emo.md',
    '他心想不妙。她愤怒地拍桌，心头一阵恐惧。她抬眼说：“我觉得不成。”\n');
  r = run('guyin-check-beat.js', ['--json', '--mono-limit=2', emotion]);
  report = parseJson(r.stdout);
  const mono = report && report.findings.find((f) => f.type === 'mono-count');
  check('Fw-05 心想/愤怒/恐惧计 3（对白内觉得不计），超 limit=2 报 mono-count',
    !!mono && mono.count === 3, `mono=${JSON.stringify(mono)}`);
}

// ============================================================
console.log('== Fw-01 开篇留存门 guyin-check-opening-retention（四组化：组一读者承诺行） ==');
{
  const mkGolden = (file, promise) => fixture(file, [
    '# 细纲_第001章', '',
    '#### 一、本章要交付什么', '',
    '- 核心事件：摆摊一天，收摊前挣到面钱',
    promise,
    '- 字数目标：3000', '',
    '#### 二、人为何这样行动', '',
    '- 父亲的药钱等不得，今天必须开张', '',
    '#### 三、场景如何承接', '',
    '- 场景序列：摆摊（开场）→ 收摊（收尾）', '',
    '#### 四、哪些不能擅改', '',
    '- 禁止提前释放：无', '- 复沓锚句：无', '',
  ].join('\n'));
  const PROMISE = '- 读者承诺：当下目标：收摊前挣到面钱，给父亲抓药/入口体验：市井算命摊的烟火与锋利/近期回报：第4章验真';

  const good = mkGolden('fw01/大纲/细纲_第001章.md', PROMISE);
  let r = run('guyin-check-opening-retention.js', ['--json', good]);
  check('Fw-01 ch001 组一读者承诺行（含入口声明）通过', r.status === 0, `status=${r.status} out=${r.stdout.trim()}`);

  // 组一缺「读者承诺」行 → hard blocking。
  const noline = mkGolden('fw01nl/大纲/细纲_第001章.md', '- 交付清单：面钱三十七文，药一贴');
  r = run('guyin-check-opening-retention.js', ['--json', noline]);
  let report = parseJson(r.stdout);
  check('Fw-01 缺读者承诺行报 outline-opening-promise-missing', r.status === 1 && report
    && report.findings.some((f) => f.type === 'outline-opening-promise-missing' && f.severity === 'blocking'),
    `status=${r.status} types=${JSON.stringify(report && report.findings.map((f) => f.type))}`);

  // 值「无」→ hard。
  const none = mkGolden('fw01none/大纲/细纲_第002章.md', '- 读者承诺：无');
  r = run('guyin-check-opening-retention.js', ['--json', none]);
  report = parseJson(r.stdout);
  check('Fw-01 读者承诺值「无」判未填（blocking）', r.status === 1 && report
    && report.findings.some((f) => f.type === 'outline-opening-promise-missing'),
    `status=${r.status}`);

  // {{占位}} 值判缺失。
  const ph = mkGolden('fw01ph/大纲/细纲_第001章.md', '- 读者承诺：{{开篇承诺待填}}');
  r = run('guyin-check-opening-retention.js', ['--json', '--fail-on=block', ph]);
  check('Fw-01 {{占位}} 值 fail-on=block exit 1', r.status === 1, `status=${r.status}`);

  // 旧格式兼容（四组化，任务书 §2.1）：四留存字段任一行在场 → 跳过新检查（存量不追溯），
  // JSON 记 legacy_four_fields: true。
  const legacy = fixture('fw01legacy/大纲/细纲_第002章.md', [
    '# 细纲_第002章', '',
    '- 当下目标：收摊前挣到面钱，给父亲抓药',
    '- 能力实证：一眼报准客人病灶，满座失声',
  ].join('\n'));
  r = run('guyin-check-opening-retention.js', ['--json', legacy]);
  report = parseJson(r.stdout);
  check('Fw-01 旧格式四留存字段在场静默＋legacy_four_fields 标记', r.status === 0 && report
    && report.findings.length === 0 && report.legacy_four_fields === true,
    `status=${r.status} payload=${JSON.stringify(report && { n: report.findings.length, legacy: report.legacy_four_fields })}`);

  // 非黄金三章静默。
  const ch4 = fixture('fw01ch4/大纲/细纲_第004章.md', '# 细纲\n完全没有读者承诺行的普通细纲\n');
  r = run('guyin-check-opening-retention.js', ['--json', ch4]);
  report = parseJson(r.stdout);
  check('Fw-01 ch004+ 静默 exit 0 零 findings',
    r.status === 0 && report && report.findings.length === 0, `status=${r.status}`);
}

// ============================================================
console.log('== Fw-02 prose-fragment-ratio（碎化率，密/疏双轨配套） ==');
{
  const SHORT = '他放下碗走了。'; // 7 字短叙述段
  const LONG = SCENE; // 34 字长叙述段

  // 40 短 + 20 长 = 66.7% → v3-A1 起恒 advisory（任务书 §4 A1：取消通用短段比例直接
  // blocking——碎化率是文体启发式观测，不构成「必然错误」），editorial 默认门放行。
  const heavy = fixture('fw02heavy/正文/第001章_碎.md',
    `${[...Array(40)].map(() => SHORT).join('\n')}\n${[...Array(20)].map(() => LONG).join('\n')}\n`);
  let r = run('guyin-check-ai-patterns.js', ['--json', heavy]);
  let report = parseJson(r.stdout);
  let f = report && report.findings.find((x) => x.type === 'prose-fragment-ratio');
  check('Fw-02 碎化 67% 恒 advisory（editorial，默认门 exit 0，v3-A1）',
    r.status === 0 && f && f.severity === 'advisory' && f.ratio > 0.4,
    `status=${r.status} f=${JSON.stringify(f && f.severity)}`);
  r = run('guyin-check-ai-patterns.js', ['--fail-on=all', heavy]);
  check('Fw-02 碎化 67% --fail-on=all exit 1（观测全拦须显式）',
    r.status === 1, `status=${r.status}`);

  // 10 短 + 28 长 = 26.3% → advisory。
  const mild = fixture('fw02mild/正文/第001章_轻.md',
    `${[...Array(10)].map(() => SHORT).join('\n')}\n${[...Array(28)].map(() => LONG).join('\n')}\n`);
  r = run('guyin-check-ai-patterns.js', ['--json', mild]);
  report = parseJson(r.stdout);
  f = report && report.findings.find((x) => x.type === 'prose-fragment-ratio');
  check('Fw-02 碎化 26% advisory（>25% 且 ≤40%）',
    f && f.severity === 'advisory' && f.ratio > 0.25 && f.ratio <= 0.4,
    `f=${JSON.stringify(f && [f.severity, f.ratio])}`);
  r = run('guyin-check-ai-patterns.js', [mild]);
  check('Fw-02 editorial 不触发默认门（block）', r.status === 0, `status=${r.status}`);

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
  r = run('guyin-check-ai-patterns.js', ['--json', heavy]);
  report = parseJson(r.stdout);
  f = report && report.findings.find((x) => x.type === 'prose-fragment-ratio');
  check('Fw-02 细纲碎化豁免后降 advisory（editorial，默认门 exit 0）',
    r.status === 0 && f && f.severity === 'advisory', `status=${r.status} f=${JSON.stringify(f && f.severity)}`);
}

// ============================================================
console.log('== Fw-06/E1 用户验收检查点门 guyin-check-trial-gate ==');
{
  // v3-A2（任务书 §4 A2）：用实际部署模板实例化（不手造简化表头）——同时回归
  // 标题括注「试读记录（活人反馈，Fw-06）」兼容；夹具项目含 ch1-3 正文（版本锚对象）。
  const TPL_PATH = path.join(REPO, 'skills', 'guyin-setup', 'templates', 'long', '追踪', '读者信号.md');
  const book = (name, rowsBuilder, chapterFiles) => {
    const dir = path.join(TMP, 'fw06v3', name);
    const files = chapterFiles || { 1: '第一章内容。', 2: '第二章内容。', 3: '第三章内容。' };
    for (const [ch, content] of Object.entries(files)) {
      fixture(`fw06v3/${name}/正文/第${String(ch).padStart(3, '0')}章_试.md`, `# 第${String(ch).padStart(3, '0')}章 试\n${content}\n`);
    }
    const chapters = Object.keys(files).map(Number).sort((a, b) => a - b);
    const last = chapters[chapters.length - 1];
    const anchor = run('guyin-check-trial-gate.js',
      ['--hash', '--project', dir, '--chapters', `1-${last}`]).stdout.trim();
    const tpl = fs.readFileSync(TPL_PATH, 'utf8');
    const rows = rowsBuilder(anchor);
    fixture(`fw06v3/${name}/追踪/读者信号.md`, `${tpl}\n${rows.join('\n')}\n`);
    return dir;
  };
  const row = (anchor, overrides) => {
    const base = {
      date: '9-14', src: '用户验收', reader: '表妹（没看过设定）', range: '1-3',
      will: '想，问订金是谁放的', who: '沈亦舟，闻碗就辨出地沟油', quote: '「面要热，账要清」',
      ability: '是', goal: '是', heat: '是：跟着松了口气', guess: '是：猜主角会拿订金做局',
      anchor: anchor || '', pref: '不适用', dispo: '保留：节奏稳，开写',
    };
    const v = { ...base, ...(overrides || {}) };
    return `| ${v.date} | ${v.src} | ${v.reader} | ${v.range} | ${v.will} | ${v.who} | ${v.quote} | ${v.ability} | ${v.goal} | ${v.heat} | ${v.guess} | ${v.anchor} | ${v.pref} | ${v.dispo} |`;
  };
  // E1：自定义检查点/表头的书（不走整套模板——续写段、延期、旧表兼容用）。
  const HDR14 = '| 日期 | 来源 | 试读人 | 章范围 | 想不想看下一章 | 记住了谁 | 想划下来的句子 | 能力实证 | 当下目标 | 情绪（原话） | 我猜对了 | 版本锚 | 相对偏好 | 处置 |';
  const SEP14 = '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|';
  const HDR13 = '| 日期 | 试读人 | 章范围 | 想不想看下一章 | 记住了谁 | 想划下来的句子 | 能力实证 | 当下目标 | 情绪热度 | 我猜对了 | 版本锚 | 相对偏好 | 处置 |';
  const SEP13 = '|---|---|---|---|---|---|---|---|---|---|---|---|---|';
  const row13 = (anchor, overrides) => {
    const base = {
      date: '9-14', reader: '表妹（没看过设定）', range: '1-3',
      will: '想，问订金是谁放的', who: '沈亦舟', quote: '「面要热，账要清」',
      ability: '是', goal: '是', heat: '是', guess: '是',
      anchor: anchor || '', pref: '不适用', dispo: '保留：节奏稳，开写',
    };
    const v = { ...base, ...(overrides || {}) };
    return `| ${v.date} | ${v.reader} | ${v.range} | ${v.will} | ${v.who} | ${v.quote} | ${v.ability} | ${v.goal} | ${v.heat} | ${v.guess} | ${v.anchor} | ${v.pref} | ${v.dispo} |`;
  };
  const customBook = (name, opts) => {
    const dir = path.join(TMP, 'fw06e1', name);
    const files = opts.files || { 1: '第一章内容。', 2: '第二章内容。', 3: '第三章内容。' };
    for (const [ch, content] of Object.entries(files)) {
      fixture(`fw06e1/${name}/正文/第${String(ch).padStart(3, '0')}章_试.md`, `# 第${String(ch).padStart(3, '0')}章 试\n${content}\n`);
    }
    const chapters = Object.keys(files).map(Number).sort((a, b) => a - b);
    const hashRange = opts.hashRange || `1-${chapters[chapters.length - 1]}`;
    const anchor = chapters.length
      ? run('guyin-check-trial-gate.js', ['--hash', '--project', dir, '--chapters', hashRange]).stdout.trim() : '';
    const parts = ['# 读者信号\n'];
    if (opts.cps && opts.cps.length) {
      parts.push('## 验收检查点\n\n| 段 | 覆盖范围 | 到点章 | 状态 |\n|---|---|---|---|\n');
      parts.push(`${opts.cps.join('\n')}\n`);
    }
    const hdr = opts.legacy ? [HDR13, SEP13] : [HDR14, SEP14];
    const body = (opts.rows || []).map((rb) => rb(anchor));
    parts.push(`## 试读记录（用户验收/独立读者，Fw-06）\n\n${[...hdr, ...body].join('\n')}\n`);
    fixture(`fw06e1/${name}/追踪/读者信号.md`, parts.join('\n'));
    return dir;
  };
  const tg = (dir, n, failOn) => run('guyin-check-trial-gate.js',
    ['--project', dir, '--chapter', String(n), '--json', ...(failOn ? [`--fail-on=${failOn}`] : [])]);

  // ch1-3 写作期静默（含无文件场景）。
  let r = tg(path.join(TMP, 'fw06v3', 'none'), 3);
  let report = parseJson(r.stdout);
  check('Fw-06 ch3 静默（写作期不需要试读）',
    r.status === 0 && report && report.findings.length === 0, `status=${r.status}`);

  // v3-A2：读者信号.md 缺失 + ch4 → 未完成手续 blocking（缺件不再静默放行）。
  r = tg(path.join(TMP, 'fw06v3', 'none'), 4);
  report = parseJson(r.stdout);
  check('v3-A2 读者信号缺失 + ch4 → blocking trial-gate-missing（缺件≠放行）',
    r.status === 1 && report.missing === true
      && report.findings[0].type === 'trial-gate-missing' && report.findings[0].severity === 'blocking',
    `status=${r.status} f=${JSON.stringify(report.findings)}`);

  // 文件在但无试读节 → blocking（模板已部署不填）。
  const noSec = path.join(TMP, 'fw06v3', 'nosec');
  fixture('fw06v3/nosec/追踪/读者信号.md', '# 读者信号\n\n| 章 | 追读 |\n|----|------|\n');
  r = tg(noSec, 4);
  report = parseJson(r.stdout);
  check('Fw-06 无试读记录节 → blocking trial-gate-missing',
    r.status === 1 && report.findings.length === 1
      && report.findings[0].type === 'trial-gate-missing' && report.findings[0].severity === 'blocking',
    `status=${r.status} f=${JSON.stringify(report.findings)}`);

  // 实际模板 + 占位行（未填）→ blocking（模板已部署不填）。
  const empty = book('empty', () => []);
  r = tg(empty, 4);
  report = parseJson(r.stdout);
  check('Fw-06 实际模板未填数据行 → blocking（模板填完可识别）',
    r.status === 1 && report.findings.some((f) => f.type === 'trial-gate-missing'),
    `status=${r.status} f=${JSON.stringify(report.findings.map((f) => f.type))}`);

  // 模板实例化 + --hash 版本锚 + 处置「保留」→ ch4 放行（完整手续闭环）。
  const good = book('good', (anchor) => [row(anchor)]);
  r = tg(good, 4);
  report = parseJson(r.stdout);
  check('v3-A2 模板+版本锚+处置保留 → ch4 手续完整放行 exit 0',
    r.status === 0 && report.findings.length === 0, `status=${r.status} f=${JSON.stringify(report.findings)}`);
  check('v3-A2 JSON 报告明示定位：手续门非满意度认证（不认证真人/品质）',
    typeof report.disclaimer === 'string' && /满意度/.test(report.disclaimer) && /真人/.test(report.disclaimer),
    `disclaimer=${JSON.stringify(report.disclaimer)}`);

  // 答案空白 → trial-gate-incomplete（空白不是反馈）。
  const blank = book('blank', (anchor) => [row(anchor, { will: '' })]);
  r = tg(blank, 4);
  report = parseJson(r.stdout);
  check('v3-A2 想不想看下一章空白 → blocking trial-gate-incomplete',
    r.status === 1 && report.findings.some((f) => f.type === 'trial-gate-incomplete' && f.severity === 'blocking'),
    `status=${r.status} f=${JSON.stringify(report.findings.map((f) => f.type))}`);

  // 负面回答合法：填「否」＋原话计入有效反馈；处置「待处理」→ 停在作者决策。
  const negative = book('negative', (anchor) => [row(anchor, { will: '否：不想看，主角太被动', dispo: '待处理' })]);
  r = tg(negative, 4);
  report = parseJson(r.stdout);
  check('v3-A2 负面回答「否」合法计入——不报 incomplete/missing，仅报处置待定',
    r.status === 1 && !report.findings.some((f) => f.type === 'trial-gate-incomplete')
      && !report.findings.some((f) => f.type === 'trial-gate-missing')
      && report.findings.some((f) => f.type === 'trial-gate-undecided'),
    `status=${r.status} f=${JSON.stringify(report.findings.map((f) => f.type))}`);
  const negativeKeep = book('negativekeep', (anchor) => [row(anchor, { will: '否：不想看，主角太被动', dispo: '保留并说明原因：负面原话留档，作者确认继续' })]);
  r = tg(negativeKeep, 4);
  report = parseJson(r.stdout);
  check('v3-A2 负面反馈＋处置保留 → 手续完整放行（负面≠非法）',
    r.status === 0 && report.findings.length === 0, `status=${r.status} f=${JSON.stringify(report.findings.map((f) => f.type))}`);

  // 版本锚缺失 → trial-gate-version。
  const noAnchor = book('noanchor', () => [row('')]);
  r = tg(noAnchor, 4);
  report = parseJson(r.stdout);
  check('v3-A2 缺版本锚 → blocking trial-gate-version',
    r.status === 1 && report.findings.some((f) => f.type === 'trial-gate-version' && f.severity === 'blocking'),
    `status=${r.status} f=${JSON.stringify(report.findings.map((f) => f.type))}`);

  // 正文改动后哈希不匹配 → 旧稿试读不能冒充新稿。
  const staleHash = book('stalehash', (anchor) => [row(anchor)]);
  fs.writeFileSync(path.join(staleHash, '正文', '第002章_试.md'), '# 第002章 试\n改过的第二章。\n');
  r = tg(staleHash, 4);
  report = parseJson(r.stdout);
  check('v3-A2 正文改动后版本锚不匹配 → blocking trial-gate-version（旧稿试读失效）',
    r.status === 1 && report.findings.some((f) => f.type === 'trial-gate-version' && /不匹配/.test(f.message)),
    `status=${r.status} f=${JSON.stringify(report.findings.map((f) => f.type))}`);

  // 处置空/待处理 → 有效反馈待作者决定，不放行。
  const undecided = book('undecided', (anchor) => [row(anchor, { dispo: '待处理' })]);
  r = tg(undecided, 4);
  report = parseJson(r.stdout);
  check('v3-A2 处置「待处理」→ blocking trial-gate-undecided',
    r.status === 1 && report.findings.some((f) => f.type === 'trial-gate-undecided'),
    `status=${r.status} f=${JSON.stringify(report.findings.map((f) => f.type))}`);

  // 处置「暂停」→ 不续写。
  const paused = book('paused', (anchor) => [row(anchor, { dispo: '暂停' })]);
  r = tg(paused, 4);
  report = parseJson(r.stdout);
  check('v3-A2 处置「暂停」→ blocking trial-gate-paused（不续写）',
    r.status === 1 && report.findings.some((f) => f.type === 'trial-gate-paused'),
    `status=${r.status} f=${JSON.stringify(report.findings.map((f) => f.type))}`);

  // 处置「修订@第4章」→ 写第4章本身放行；写第5章 scope 拦截。
  const revision = book('revision', (anchor) => [row(anchor, { dispo: '修订@第4章：主角被动，先改开篇' })]);
  r = tg(revision, 4);
  report = parseJson(r.stdout);
  check('v3-A2 处置「修订@第4章」→ 写第4章本身放行',
    r.status === 0 && report.findings.length === 0, `status=${r.status} f=${JSON.stringify(report.findings.map((f) => f.type))}`);
  r = tg(revision, 5);
  report = parseJson(r.stdout);
  check('v3-A2 处置「修订@第4章」→ 写第5章 blocking trial-gate-revision-scope（修订不开放后续新章）',
    r.status === 1 && report.findings.some((f) => f.type === 'trial-gate-revision-scope'),
    `status=${r.status} f=${JSON.stringify(report.findings.map((f) => f.type))}`);

  // 只覆盖 1-2 → blocking 且文案点出缺 ch3。
  const partial = book('partial', (anchor) => [row(anchor, { range: '1-2' })]);
  r = tg(partial, 4);
  report = parseJson(r.stdout);
  check('Fw-06 只覆盖 ch1-2 → blocking 且指出缺 ch3',
    r.status === 1 && report.findings.some((f) => f.type === 'trial-gate-missing' && /ch\s*3/.test(f.message)),
    `status=${r.status} f=${JSON.stringify(report.findings.map((f) => f.type))}`);

  // 两行拼合并集覆盖 1-3 → 放行。
  const merged = book('merged', (anchor) => [
    row(anchor, { date: '9-13', reader: '同事A', range: '1,2', will: '想', who: '母亲', quote: '无', ability: '否', goal: '是', heat: '否', guess: '否' }),
    row(anchor, { reader: '表妹', range: '3', will: '想', who: '沈亦舟', quote: '面要热账要清' }),
  ]);
  r = tg(merged, 4);
  report = parseJson(r.stdout);
  check('Fw-06 多行并集覆盖 ch1-3 → 放行',
    r.status === 0 && report.findings.length === 0, `status=${r.status} f=${JSON.stringify(report.findings)}`);

  // 试读人列空的行不计入覆盖 → blocking。
  const noReader = book('noreader', (anchor) => [row(anchor, { reader: '' })]);
  r = tg(noReader, 4);
  report = parseJson(r.stdout);
  check('Fw-06 试读人空＝无法证明真人 → blocking',
    r.status === 1 && report.findings.some((f) => f.type === 'trial-gate-missing'),
    `status=${r.status} f=${JSON.stringify(report.findings.map((f) => f.type))}`);

  // 周期 verify：覆盖止于 ch3，开写 ch7 → trial-gate-stale 须核实，默认门 exit 1，--fail-on=all 同。
  r = tg(good, 7);
  report = parseJson(r.stdout);
  check('Fw-06 ch7 试读止于 ch3 → verify trial-gate-stale（默认门 exit 1）',
    r.status === 1 && report.findings.length === 1 && report.findings[0].type === 'trial-gate-stale',
    `status=${r.status} f=${JSON.stringify(report.findings)}`);
  r = tg(good, 7, 'all');
  check('Fw-06 advisory 在 --fail-on=all 下 exit 1', r.status === 1, `status=${r.status}`);

  // 覆盖到 ch4，ch7 阈值 N-3=4 → 不提醒。
  const fresh = book('fresh', (anchor) => [row(anchor, { range: '1至4' })], { 1: '第一章内容。', 2: '第二章内容。', 3: '第三章内容。', 4: '第四章内容。' });
  r = tg(fresh, 7);
  report = parseJson(r.stdout);
  check('Fw-06 覆盖至 ch4 → ch7 无 stale 提醒',
    r.status === 0 && report.findings.length === 0, `status=${r.status} f=${JSON.stringify(report.findings.map((f) => f.type))}`);

  // --hash 子命令：输出「第N章:哈希」串（工具计算，供回填版本锚）。
  // 分隔符断言「；」而非「|」——版本锚要回填进 markdown 表格列，「|」会切列（实测教训）。
  const hashRun = run('guyin-check-trial-gate.js', ['--hash', '--project', good, '--chapters', '1-3']);
  check('v3-A2 --hash 输出可回填的版本锚串',
    hashRun.status === 0 && /^第1章:[0-9a-f]{12}；第2章:[0-9a-f]{12}；第3章:[0-9a-f]{12}$/.test(hashRun.stdout.trim()),
    `status=${hashRun.status} out=${hashRun.stdout.trim().slice(0, 80)}`);

  // ============ E1：反馈来源三分类（用户验收/独立读者有效，模型不顶替人） ============
  // 仅模型审读行覆盖 → trial-gate-source（同时缺人类覆盖报 missing）。
  const onlyModel = book('e1model', (anchor) => [row(anchor, { src: '模型审读', reader: 'GPT-5 审读' })]);
  r = tg(onlyModel, 4);
  report = parseJson(r.stdout);
  check('E1 仅模型审读行覆盖 → blocking trial-gate-source（模型不能顶替人）',
    r.status === 1 && report.findings.some((f) => f.type === 'trial-gate-source' && f.severity === 'blocking')
      && report.findings.some((f) => f.type === 'trial-gate-missing'),
    `status=${r.status} f=${JSON.stringify(report.findings.map((f) => f.type))}`);

  // 新表来源列空白 → incomplete-source。
  const blankSrc = book('e1blanksrc', (anchor) => [row(anchor, { src: '' })]);
  r = tg(blankSrc, 4);
  report = parseJson(r.stdout);
  check('E1 新表来源列空 → blocking trial-gate-incomplete-source',
    r.status === 1 && report.findings.some((f) => f.type === 'trial-gate-incomplete-source'),
    `status=${r.status} f=${JSON.stringify(report.findings.map((f) => f.type))}`);

  // 独立读者来源 → 完整放行（不强制作者本人）。
  const indep = book('e1indep', (anchor) => [row(anchor, { src: '独立读者' })]);
  r = tg(indep, 4);
  report = parseJson(r.stdout);
  check('E1 来源「独立读者」→ ch4 放行',
    r.status === 0 && report.findings.length === 0, `status=${r.status} f=${JSON.stringify(report.findings)}`);

  // 旧表无来源列：旧行暂计有效（默认门 exit 0），审计模式可见 source-legacy 提示。
  const legacy = customBook('e1legacy', { legacy: true, rows: [(anchor) => row13(anchor)] });
  r = tg(legacy, 4);
  report = parseJson(r.stdout);
  check('E1 旧表无来源列 → 默认门放行并出 editorial source-legacy',
    r.status === 0 && report.findings.length === 1
      && report.findings[0].type === 'trial-gate-source-legacy'
      && report.findings[0].severity === 'advisory',
    `status=${r.status} f=${JSON.stringify(report.findings.map((f) => f.type))}`);
  r = tg(legacy, 4, 'all');
  check('E1 旧表 source-legacy 在 --fail-on=all 下 exit 1', r.status === 1, `status=${r.status}`);

  // ============ E1：用户确认的验收检查点（续写登记/延期/暂停，默认节消失） ============
  // 续写段 12-18@19：ch4 无到点检查点（隐式默认不再生效）→ 静默；ch19 到点缺反馈 → missing。
  const cont = customBook('e1cont', {
    cps: ['| 续写·白银案连续段 | 12-18 | 19 | 启用 |'],
    rows: [], files: {},
  });
  r = tg(cont, 4);
  report = parseJson(r.stdout);
  check('E1 续写登记 12-18@19 → ch4 无到点检查点静默（不背 ch1-3 默认）',
    r.status === 0 && report.findings.length === 0, `status=${r.status} f=${JSON.stringify(report.findings)}`);
  r = tg(cont, 19);
  report = parseJson(r.stdout);
  check('E1 续写检查点 ch19 到点无反馈 → blocking missing（点名 ch12-18）',
    r.status === 1 && report.findings.some((f) => f.type === 'trial-gate-missing'
      && /ch12-18/.test(f.message) && /ch12/.test(f.message)),
    `status=${r.status} f=${JSON.stringify(report.findings.map((f) => [f.type, f.message]))}`);

  // 续写段到点＋人类反馈覆盖且版本匹配 → 放行。
  const contFiles = {};
  for (let c = 12; c <= 18; c += 1) contFiles[c] = `第${c}章内容。`;
  const contOk = customBook('e1contok', {
    cps: ['| 续写·白银案连续段 | 12-18 | 19 | 启用 |'],
    rows: [(anchor) => row(anchor, { src: '独立读者', reader: '同事（没看过细纲）', range: '12-18' })],
    files: contFiles, hashRange: '12-18',
  });
  r = tg(contOk, 19);
  report = parseJson(r.stdout);
  check('E1 续写检查点 ch19 反馈齐全（独立读者 12-18）→ 放行',
    r.status === 0 && report.findings.length === 0, `status=${r.status} f=${JSON.stringify(report.findings)}`);

  // 延期@第7章：ch6 静默（越过原到点章 4 不算违约）；ch7 到点验收段顺延为 ch1-6。
  const delay = customBook('e1delay', {
    cps: ['| 新书前三章 | 1-3 | 4 | 延期@第7章 |'],
    rows: [], files: {},
  });
  r = tg(delay, 6);
  report = parseJson(r.stdout);
  check('E1 检查点延期@第7章 → ch6 静默（显式延期非豁免，下一检查点已登记）',
    r.status === 0 && report.findings.length === 0, `status=${r.status} f=${JSON.stringify(report.findings)}`);
  r = tg(delay, 7);
  report = parseJson(r.stdout);
  check('E1 延期后 ch7 到点无反馈 → blocking missing（验收段顺延 ch1-6）',
    r.status === 1 && report.findings.some((f) => f.type === 'trial-gate-missing'
      && /ch1-6/.test(f.message)),
    `status=${r.status} f=${JSON.stringify(report.findings.map((f) => [f.type, f.message]))}`);
  const delayFiles = {};
  for (let c = 1; c <= 6; c += 1) delayFiles[c] = `延期书第${c}章内容。`;
  const delayOk = customBook('e1delayok', {
    cps: ['| 新书前三章 | 1-3 | 4 | 延期@第7章 |'],
    rows: [(anchor) => row(anchor, { src: '用户验收', reader: '作者本人', range: '1-6' })],
    files: delayFiles, hashRange: '1-6',
  });
  r = tg(delayOk, 7);
  report = parseJson(r.stdout);
  check('E1 延期后 ch7 验收覆盖 ch1-6 → 放行',
    r.status === 0 && report.findings.length === 0, `status=${r.status} f=${JSON.stringify(report.findings)}`);

  // 检查点状态「暂停」→ 到点即拦。
  const cpPaused = customBook('e1cppaused', {
    cps: ['| 新书前三章 | 1-3 | 4 | 暂停 |'],
    rows: [], files: {},
  });
  r = tg(cpPaused, 4);
  report = parseJson(r.stdout);
  check('E1 检查点状态暂停 → ch4 blocking trial-gate-paused',
    r.status === 1 && report.findings.some((f) => f.type === 'trial-gate-paused'),
    `status=${r.status} f=${JSON.stringify(report.findings.map((f) => f.type))}`);

  // 检查点登记畸形（范围/到点章无法解析）→ checkpoint-bad，不静默回退默认。
  const cpBad = customBook('e1cpbad', {
    cps: ['| 坏段 | 无范围 | 没号 | 启用 |'],
    rows: [], files: {},
  });
  r = tg(cpBad, 4);
  report = parseJson(r.stdout);
  check('E1 检查点登记畸形 → blocking trial-gate-checkpoint-bad',
    r.status === 1 && report.findings.some((f) => f.type === 'trial-gate-checkpoint-bad'),
    `status=${r.status} f=${JSON.stringify(report.findings.map((f) => f.type))}`);

  // 已登记更远的检查点（@19）抑制 ch7 stale 提醒——续写节奏由作者登记，不自动催。
  const contFar = customBook('e1contfar', {
    cps: ['| 续写·白银案连续段 | 12-18 | 19 | 启用 |'],
    rows: [(anchor) => row(anchor, { src: '独立读者', range: '1-3' })],
    files: { 1: '一。', 2: '二。', 3: '三。' }, hashRange: '1-3',
  });
  r = tg(contFar, 7);
  report = parseJson(r.stdout);
  check('E1 已登记未来检查点@19 → ch7 无 stale 提醒',
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

  // 有笔法文件无台账 → ledger-missing 须补账（verify）；默认门 exit 1，all 同。
  fixture('fw04miss/作者性/语言纪律.md', RULE_STUB);
  const miss = path.join(TMP, 'fw04miss');
  r = rc(miss);
  report = parseJson(r.stdout);
  check('Fw-04 笔法在/台账缺 → verify ledger-missing（默认门 exit 1）',
    r.status === 1 && report.governanceActive === true
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

  // C-01…C-08 红测样本已落仓内 fixture（T01 数据隔离：默认测试不读外部工作区）。
  const zyList = path.join(FIXTURES, '框架问题清单_C冲突样本.md');
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
  check('Fw-04 样本清单含 C-01…C-08 八条（仓内红测样本）',
    cRows.every(([id]) => zyText.includes(id)), '样本清单缺条');

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

  // 重号 + 空号：台账编号工程错误（hard），默认门 exit 1。
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
  check('Fw-09 C2 重号+空号 → hard（默认门 exit 1）',
    r.status === 1
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

  // 合成项目对照（T01 数据隔离：原追影真实项目对照改为仓内临时项目，保留断言意图）：
  // 台账 12 个 F 号，正文/大纲引用均已登记，零重号/空号/悬空引用。
  fixture('fw09sig/追踪/伏笔.md', [
    '# 伏笔当前状态', '', ...ledgerHeader,
    ...Array.from({ length: 12 }, (_, i) => ledgerRow(`F${String(i + 1).padStart(3, '0')}`, `第${i + 1}件已登记之事`)),
    '',
  ].join('\n'));
  fixture('fw09sig/大纲/细纲_第001章.md', '## 细纲（第 1 章）\n承接 F001 的埋设与 F005 的回收预期，本章不动。\n');
  fixture('fw09sig/正文/第001章_试.md', SCENE + '\n他想起编号 F012 还挂着，F003 那件也记得。\n');
  r = fc(path.join(TMP, 'fw09sig'));
  report = parseJson(r.stdout);
  check('Fw-09 C2 合成对照：12 编号无重号/空号/悬空引用',
    r.status === 0 && report.findings.length === 0 && report.registered.length === 12,
    `status=${r.status} n=${report.registered && report.registered.length} f=${JSON.stringify(report.findings).slice(0, 160)}`);
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
// E2 参考接口：生产者—消费者核对（拆文真实产物 vs 已停用旧布局）
// 旧召回入口（[存档] workflow-*/artifact-protocols）不能绕过新协议重新激活 剧情/ 路径。
// ============================================================
console.log('== E2 参考接口：拆文产物路径口径 ==');
{
  const OLD_RE = /`[^`]*剧情\/|剧情\/(节奏|情绪模块|README|故事线|\*|\{)|章节\/\*_摘要|_摘要\.md/;
  const BANNER = '旧产物路径停用';

  function scanConsult(consultDir, indexPath) {
    const indexTxt = fs.existsSync(indexPath) ? fs.readFileSync(indexPath, 'utf8') : '';
    const markOf = {};
    for (const m of indexTxt.matchAll(/^\|\s*([\w.-]+\.md)\s*\|\s*\[([^\]]+)\]/gm)) markOf[m[1]] = m[2];
    const result = [];
    for (const f of fs.readdirSync(consultDir).filter((x) => x.endsWith('.md'))) {
      const lines = fs.readFileSync(path.join(consultDir, f), 'utf8').split(/\r?\n/);
      const hitNos = [];
      lines.forEach((l, i) => { if (OLD_RE.test(l)) hitNos.push(i + 1); });
      if (hitNos.length) result.push({ f, mark: markOf[f] || '(未登记)', hitNos, banner: lines.some((l) => l.includes(BANNER)) });
    }
    return result;
  }

  // 长篇 consult：[方法] 文件命中旧路径的行必须自带「停用」声明；[存档] 文件必须顶部挂停用横幅；未登记文件零命中
  const longDir = path.join(REPO, 'skills', 'guyin-write', 'references', 'consult');
  const longHits = scanConsult(longDir, path.join(longDir, 'INDEX.md'));
  const longTxt = {};
  for (const f of fs.readdirSync(longDir).filter((x) => x.endsWith('.md'))) {
    longTxt[f] = fs.readFileSync(path.join(longDir, f), 'utf8');
  }
  const e2offenders = [];
  for (const h of longHits) {
    if (h.f === 'INDEX.md') continue; // 权威口径说明本身允许枚举旧路径
    if (h.mark.includes('存档')) {
      if (!h.banner) e2offenders.push(`${h.f} 是[存档]且仍引用旧产物但缺停用横幅`);
    } else {
      const lines = longTxt[h.f].split(/\r?\n/);
      const bad = h.hitNos.filter((n) => !/停用/.test(lines[n - 1]));
      if (bad.length) e2offenders.push(`${h.f}([${h.mark}]) 第 ${bad.join(',')} 行引用旧产物且无停用声明`);
    }
  }
  check('E2-1 [方法]入口零旧路径消费、[存档]旧入口全部挂停用横幅', e2offenders.length === 0,
    e2offenders.join('；') || '');
  for (const f of ['workflow-chapter.md', 'workflow-setup.md', 'workflow-daily.md', 'artifact-protocols.md']) {
    check(`E2-1 ${f} 停用横幅在体（正文旧路径不致复活）`, longTxt[f] && longTxt[f].includes(BANNER));
  }

  // 短篇 consult：无存档体，命中旧路径的行必须自带停用声明
  const shortDir = path.join(REPO, 'skills', 'guyin-short-write', 'references', 'consult');
  const shortHits = scanConsult(shortDir, path.join(shortDir, 'INDEX.md'));
  const shortBad = [];
  for (const h of shortHits) {
    const lines = fs.readFileSync(path.join(shortDir, h.f), 'utf8').split(/\r?\n/);
    const bad = h.hitNos.filter((n) => !/停用/.test(lines[n - 1]));
    if (bad.length) shortBad.push(`${h.f} 第 ${bad.join(',')} 行`);
  }
  check('E2-2 短篇 consult 旧路径仅存在于停用声明', shortBad.length === 0, shortBad.join('；'));
  check('E2-2 长短 cross-book-recall 副本字节一致（接口不分叉）',
    fs.readFileSync(path.join(longDir, 'cross-book-recall.md')).equals(
      fs.readFileSync(path.join(shortDir, 'cross-book-recall.md'))));

  // 新路径正向消费
  const recall = longTxt['cross-book-recall.md'];
  check('E2-3 cross-book-recall 阶段消费表挂真实产物（章节/第XXX章.md＋节奏.md＋情绪模块.md）',
    recall.includes('章节/第XXX章.md') && recall.includes('节奏.md') && recall.includes('情绪模块.md')
    && recall.includes('不自动同步') && recall.includes('对标未验证'));
  const ost = longTxt['outline-structure-theory.md'];
  check('E2-3 outline-structure-theory 迁移改章区间召回（节奏.md/逐章摘要/chA-chB，不再读剧情单元文件）',
    ost.includes('节奏.md') && ost.includes('章节/第XXX章.md') && ost.includes('chA-chB')
    && ost.includes('对标未验证'));
  check('E2-3 style-genre-modules 权威召回改挂书根新路径',
    longTxt['style-genre-modules.md'].includes('`情绪模块.md` / `节奏.md`'));

  // 生产者文档与登记入口
  const analyzeSkill = fs.readFileSync(path.join(REPO, 'skills', 'guyin-analyze', 'SKILL.md'), 'utf8');
  check('E2-4 analyze SKILL 声明真实产物且对标视图标手动不自动同步',
    analyzeSkill.includes('章节/第XXX章.md') && analyzeSkill.includes('节奏.md')
    && analyzeSkill.includes('情绪模块.md') && analyzeSkill.includes('手动复制的子集视图，不自动同步'));
  const exemplarsReadme = fs.readFileSync(path.join(REPO, 'skills', 'guyin-write', 'references', 'exemplars', 'README.md'), 'utf8');
  check('E2-4 exemplars README 登记拆文库真实路径＋仿写不升格（对标未验证）',
    exemplarsReadme.includes('拆文库/{书名}/原文/') && exemplarsReadme.includes('不自动同步')
    && /仿写切片永远标「仿写」[^]*对标未验证/.test(exemplarsReadme));
  const tplDingwei = fs.readFileSync(path.join(REPO, 'skills', 'guyin-setup', 'templates', 'long', '设定', '题材定位.md'), 'utf8');
  check('E2-4 题材定位模板：数据源拆文库＋对标手动子集＋对标未验证',
    tplDingwei.includes('章节/第XXX章.md') && tplDingwei.includes('不自动同步') && tplDingwei.includes('对标未验证'));
  const storySkill = fs.readFileSync(path.join(REPO, 'skills', 'guyin-story', 'SKILL.md'), 'utf8');
  const shortAnalyzeSkill = fs.readFileSync(path.join(REPO, 'skills', 'guyin-short-analyze', 'SKILL.md'), 'utf8');
  check('E2-4 guyin-story / guyin-short-analyze 入口均标手动复制不自动同步',
    storySkill.includes('不自动同步') && shortAnalyzeSkill.includes('不自动同步'));

  // 任何 SKILL/模板不得声称 对标 与拆文库自动同步（出现「自动同步」必须是否定句）
  const autoSyncClaims = [];
  for (const skillDir of fs.readdirSync(path.join(REPO, 'skills'))) {
    const sp = path.join(REPO, 'skills', skillDir, 'SKILL.md');
    if (fs.existsSync(sp)) {
      fs.readFileSync(sp, 'utf8').split(/\r?\n/).forEach((l, i) => {
        if (l.includes('自动同步') && !l.includes('不自动同步')) autoSyncClaims.push(`${skillDir}/SKILL.md:${i + 1}`);
      });
    }
  }
  check('E2-5 全仓 SKILL 无「自动同步」肯定表述', autoSyncClaims.length === 0, autoSyncClaims.join('；'));

  // 合成拆文产物：recall 文档枚举的新产物在合成树上全部可解析（生产者—消费者契约）
  const synthBook = path.join(TMP, 'e2-synth-project', '拆文库', '合成书A');
  fs.mkdirSync(path.join(synthBook, '章节'), { recursive: true });
  fs.mkdirSync(path.join(synthBook, '设定'), { recursive: true });
  fs.mkdirSync(path.join(synthBook, '角色'), { recursive: true });
  fs.mkdirSync(path.join(synthBook, '原文'), { recursive: true });
  for (let n = 1; n <= 6; n += 1) {
    const nn = String(n).padStart(3, '0');
    fs.writeFileSync(path.join(synthBook, '章节', `第${nn}章.md`),
      `# 第${nn}章\n- 事件：合成事件${n}\n- 情绪：合成情绪${n}\n- 钩子：合成钩子${n}\n- 伏笔进出：无\n- 角色变化：无\n`);
  }
  fs.writeFileSync(path.join(synthBook, '节奏.md'), '# 节奏\n## 爽点分布\n## 节奏曲线\nch1-6 合成曲线\n');
  fs.writeFileSync(path.join(synthBook, '情绪模块.md'), '# 情绪模块\n## 可复现模块\n模块甲（可替换要素：…）\n');
  fs.writeFileSync(path.join(synthBook, '拆文报告.md'), '# 拆文报告\n## 不建议模仿\n');
  fs.writeFileSync(path.join(synthBook, '文风.md'), '# 文风\n句长客观特征\n');
  fs.writeFileSync(path.join(synthBook, '设定', '世界观.md'), '# 世界观\n');
  fs.writeFileSync(path.join(synthBook, '角色', '主角.md'), '# 主角\n');
  fs.writeFileSync(path.join(synthBook, '原文', '第001章_开篇.txt'), '合成原文（用户合法持有）');
  const required = ['章节/第001章.md', '章节/第006章.md', '节奏.md', '情绪模块.md', '拆文报告.md', '文风.md',
    path.join('设定', '世界观.md'), path.join('角色', '主角.md'), path.join('原文', '第001章_开篇.txt')];
  const missing = required.filter((rel) => !fs.existsSync(path.join(synthBook, rel)));
  check('E2-6 合成拆文库具备召回文档枚举的全部真实产物', missing.length === 0, missing.join('、'));
  const chFiles = fs.readdirSync(path.join(synthBook, '章节'));
  check('E2-6 合成树无旧布局产物（剧情/、*_摘要.md）',
    !fs.existsSync(path.join(synthBook, '剧情')) && !chFiles.some((f) => /_摘要\.md$/.test(f)),
    chFiles.join(','));
  const ch1 = fs.readFileSync(path.join(synthBook, '章节', '第001章.md'), 'utf8');
  check('E2-6 逐章摘要承载章区间召回所需字段（事件/情绪/钩子）',
    /事件/.test(ch1) && /情绪/.test(ch1) && /钩子/.test(ch1));
}

// ============================================================
// E3 部署同步：三端执行层部署件与框架模板必须跟 canonical 协议同源
// （canonical agents 在 skills/guyin-write/agents/，部署件在 guyin-setup/templates/long/）
// ============================================================
console.log('== E3 部署同步（三端 agents / hook / 模板 / setup） ==');
{
  const TLong = path.join(REPO, 'skills', 'guyin-setup', 'templates', 'long');
  const agentFiles = {
    checker: [
      path.join(REPO, 'skills', 'guyin-write', 'agents', 'guyin-checker.md'),
      path.join(TLong, '.claude', 'agents', 'guyin-checker.md'),
      path.join(TLong, '.opencode', 'agents', 'guyin-checker.md'),
      path.join(TLong, '.codex', 'agents', 'guyin-checker.toml'),
    ],
    beatWriter: [
      path.join(REPO, 'skills', 'guyin-write', 'agents', 'guyin-beat-writer.md'),
      path.join(TLong, '.claude', 'agents', 'guyin-beat-writer.md'),
      path.join(TLong, '.opencode', 'agents', 'guyin-beat-writer.md'),
      path.join(TLong, '.codex', 'agents', 'guyin-beat-writer.toml'),
    ],
  };
  const checkerFresh = ['审读卡：先只读正文记录真实阅读反应', '分诊卡：单次判断'];
  const checkerStale = ['自检卡：先抄原文相关句', '本次输出保持确定', '做是非题与三选一判断'];
  for (const f of agentFiles.checker) {
    const c = fs.readFileSync(f, 'utf8');
    check(`E3-1 checker 同步 B2 审读卡协议：${path.relative(TLong, f).replace('..\\..\\..\\..\\', '')}`,
      checkerFresh.every((s) => c.includes(s)) && !checkerStale.some((s) => c.includes(s)),
      '缺新规则或残留旧措辞');
  }
  const beatFresh = ['不凑数、不注水、不"此处省略"', '正常正文与控制结果', '按人物此刻的处境写活'];
  for (const f of agentFiles.beatWriter) {
    const c = fs.readFileSync(f, 'utf8');
    check(`E3-1 beat-writer 四份协议体同源（富规则版）：${path.basename(path.dirname(path.dirname(f)))}/${path.basename(f)}`,
      beatFresh.every((s) => c.includes(s)));
  }
  // Fw-03 不得被同步破坏：模板部署件依旧零生效 model
  for (const [rel, re] of [
    ['.claude/agents/guyin-checker.md', /^model\s*:/m],
    ['.opencode/agents/guyin-checker.md', /^model\s*:/m],
    ['.codex/agents/guyin-checker.toml', /^model\s*=/m],
  ]) {
    const c = fs.readFileSync(path.join(TLong, rel), 'utf8');
    const active = c.split(/\r?\n/).filter((l) => !/^\s*#/.test(l)).some((l) => re.test(l));
    check(`E3-1 同步后 checker 仍无生效 model 行：${rel}`, !active);
  }

  // 模板 hook 含 D2 发布门
  const hookC = fs.readFileSync(path.join(TLong, '.claude', 'hooks', 'guyin-hook.js'), 'utf8');
  check('E3-2 模板 hook 含 D2 发布门（_publication 在途/损坏拦截）',
    /publicationBlocker/.test(hookC) && hookC.includes('_publication.json') && /D2/.test(hookC));

  // 模板 AGENTS.md 不变式含 D2/E1
  const agentsTpl = fs.readFileSync(path.join(TLong, 'AGENTS.md'), 'utf8');
  check('E3-3 模板 AGENTS.md 含隔离发布不变式（.guyin/work＋publish 唯一通道＋recover）',
    agentsTpl.includes('.guyin/work/{run_id}/') && agentsTpl.includes('publish')
    && agentsTpl.includes('recover'));
  check('E3-3 模板 AGENTS.md 含验收检查点不变式（用户/独立读者＋延期不静默豁免）',
    agentsTpl.includes('验收检查点') && agentsTpl.includes('用户验收/独立读者')
    && agentsTpl.includes('延期@第K章'));

  // 模板 README
  const readmeTpl = fs.readFileSync(path.join(TLong, 'README.md'), 'utf8');
  check('E3-3 模板 README：hook guard 行列发布门＋隔离发布段＋待审台账',
    /发布门/.test(readmeTpl) && readmeTpl.includes('candidate.md')
    && readmeTpl.includes('待审台账'));

  // setup SKILL：版本、重部署保护、旧项目升级、Phase0 必检
  const setupSkill = fs.readFileSync(path.join(REPO, 'skills', 'guyin-setup', 'SKILL.md'), 'utf8');
  check('E3-4 setup v0.8.0：重部署保护（差异/model 回填/备份/不盲目 replace）',
    /version:\s*0\.8\.0/.test(setupSkill) && setupSkill.includes('重部署保护')
    && setupSkill.includes('回填') && setupSkill.includes('upgrade-backup')
    && setupSkill.includes('不盲目 replace'));
  check('E3-4 setup：旧项目升级给待升级清单不自动重写＋实际加载路径报告',
    setupSkill.includes('待升级清单') && setupSkill.includes('不自动重写用户台账')
    && setupSkill.includes('实际加载路径'));
  check('E3-4 setup Phase 0 必检含 读者信号.md 与 待审台账.md',
    setupSkill.includes('追踪/读者信号.md') && setupSkill.includes('追踪/待审台账.md'));
}

// ============================================================
// F1 短篇/文案同步：连续场景/全文审读/隔离发布/固定单元 1/去强制多抽与情绪升降
// ============================================================
console.log('== F1 短篇协议（SKILL/模板/pitch/发布器） ==');
{
  const shortSkillP = path.join(REPO, 'skills', 'guyin-short-write', 'SKILL.md');
  const sw = fs.readFileSync(shortSkillP, 'utf8');
  check('F1-1 短篇继承连续场景＋全文审读＋隔离发布',
    sw.includes('连续场景执笔') && sw.includes('完整篇审读') && sw.includes('.guyin/work/{run_id}/')
    && sw.includes('publish 唯一通道'));
  check('F1-1 短篇不继承卷纲/第4章门',
    sw.includes('不继承') && sw.includes('第 4 章试读门') && sw.includes('trial-gate 不跑'));
  check('F1-1 固定单元 1：append 首发/revision 重发＋显式贯穿不靠文件名',
    sw.includes('固定整数单元号 1') && sw.includes('mode=append, chapter=1')
    && sw.includes('mode=revision, chapter=1') && sw.includes('不从文件名反解章号')
    && sw.includes('--unit 1'));
  check('F1-1 同项目多篇须先定稳定映射与状态隔离',
    sw.includes('同项目多篇不支持自动映射') && sw.includes('稳定单元映射与状态隔离'));
  check('F1-1 移除首 beat 强制多抽与固定情绪升降（SKILL 无旧配额）',
    !/必多采样|首 beat 必|500-1200|6-15 个|连续 2 个 beat|情绪强度无变化/.test(sw)
    && sw.includes('默认单稿') && sw.includes('不做机械升降'));
  check('F1-1 保留短篇篇幅与回报期限（wordcount 按情节节点定界）',
    sw.includes('保留短篇自身的篇幅与回报期限') && sw.includes('--min/--max'));

  const tplDir = path.join(REPO, 'skills', 'guyin-setup', 'templates', 'short', '大纲');
  const tplText = ['情节节点.md', '情绪曲线.md', '反转表.md']
    .map((n) => fs.readFileSync(path.join(tplDir, n), 'utf8')).join('\n');
  check('F1-1 短篇骨架模板去 beat 配额/必多采样/末beat',
    !/6-15|必多采样|末 beat|峰值 beat/.test(tplText) && tplText.includes('连续场景执笔'));

  const pitch = fs.readFileSync(path.join(REPO, 'skills', 'guyin-pitch', 'SKILL.md'), 'utf8');
  check('F1-1 pitch 只提取已发布正文卖点（短篇整篇发布后；不强塞）',
    pitch.includes('已正式发布正文') && pitch.includes('短篇须整篇已发布')
    && pitch.includes('反向强塞') && pitch.includes('细纲只用于这一步覆盖校验'));

  const py = fs.readFileSync(
    path.join(REPO, 'skills', 'guyin-write', 'scripts', 'guyin-tracking-commit.py'), 'utf8');
  check('F1-1 发布器指纹固化显式传 --unit（不靠文件名反解）',
    /"--commit", "--fail-on=hard",[\s\S]{0,120}"--unit", str\(chapter\)/.test(py));
  check('F1-1 发布器放行非章号 destination 仅限单元 1（多篇映射缺失即拒）',
    py.includes('非章号文件名仅允许短篇固定单元 1') && py.includes('不靠篇名猜序号'));
  check('F1-1 短篇 revision 存档名带篇名 stem',
    py.includes('单元{chapter:03d}_{stem}_发布前存档_'));

  const repJs = fs.readFileSync(
    path.join(REPO, 'skills', 'guyin-write', 'scripts', 'guyin-check-repetition.js'), 'utf8');
  check('F1-1 repetition 支持 --unit 且显式值压过文件名解析',
    repJs.includes("arg === '--unit'") && repJs.includes('options.unit') && repJs.includes('冲突'));
}

// ---- F1-2 --unit 运行时行为（合成短篇项目，真实执行） ----
console.log('== F1-2 repetition --unit 运行时 ==');
{
  const rain = '雨下了一夜，青石板路上积着浅浅的水洼，倒映出两侧歪斜的屋檐。他撑着一把旧油纸伞，沿着巷子慢慢往里走，鞋底踩过水洼，溅起的泥点打在裤脚上，他也不在意。';
  const proj = path.join(TMP, 'f1-short');
  const story = fixture('f1-short/正文/追妻.md', `追妻\n\n${rain}\n\n「你回来做什么。」她站在门帘后头，声音压得很低，像是怕惊动院里那盏灯。\n`);
  const libPath = path.join(proj, '追踪', '段落指纹库.json');
  const repHint = fs.readFileSync(path.join(S, 'guyin-check-repetition.js'), 'utf8');

  // 无 --unit：篇名文件必须被拒（JSON 模式错误详情不进流，以非零退出＋零扫描为据；
  // 不得静默当 0 章跳过）。非 JSON 模式提示文案另由静态断言锁住。
  let r = run('guyin-check-repetition.js', ['--json', '--project', proj, story]);
  let rejected = parseJson(r.stdout);
  check('F1-2 篇名文件无 --unit 拒绝并提示显式单元号',
    r.status === 2 && rejected && rejected.summary.files_scanned === 1
    && rejected.summary.paragraphs_scanned === 0,
    `status=${r.status} out=${r.stdout.slice(0, 160)}`);
  check('F1-2 拒绝文案含 --unit 指引（非 JSON 模式）',
    repHint.includes('filename must match') && repHint.includes('--unit'),
    'USAGE/报错文案缺 --unit 指引');

  // --commit --unit 1：库条目章号=1、file=篇名
  r = run('guyin-check-repetition.js', ['--json', '--project', proj, '--commit', '--unit', '1', story]);
  let report = parseJson(r.stdout);
  let lib = fs.existsSync(libPath) ? JSON.parse(fs.readFileSync(libPath, 'utf8')) : null;
  check('F1-2 --commit --unit 1 篇名文件入库（chapter=1/file=追妻.md）',
    r.status === 0 && report && report.summary.committed === 1
    && lib && lib.entries.length === 1 && lib.entries[0].chapter === 1
    && lib.entries[0].file === '追妻.md',
    `status=${r.status} out=${r.stdout.slice(0, 200)}`);

  // 复检 --unit 1：不欠账、exit 0
  r = run('guyin-check-repetition.js', ['--json', '--project', proj, '--unit', '1', story]);
  report = parseJson(r.stdout);
  check('F1-2 篇检 --unit 1 无指纹欠账（库 1 = 受检 1）',
    r.status === 0 && report && !report.findings.some((f) => f.type === 'fingerprint-arrears'),
    `status=${r.status} findings=${JSON.stringify(report && report.findings.map((f) => f.type))}`);

  // --unit 与文件名章号冲突 → 拒（不猜哪个对）
  const conflict = fixture('f1-short/正文/第001章_旧.md', `旧稿\n\n${rain}\n`);
  r = run('guyin-check-repetition.js', ['--json', '--project', proj, '--unit', '2', conflict]);
  check('F1-2 --unit 与文件名章号冲突即拒',
    r.status !== 0 && /冲突/.test(r.stderr || r.stdout),
    `status=${r.status} out=${(r.stderr || r.stdout).slice(0, 160)}`);

  // --unit 只接受单文件目标（目录内含两个章号文件 → 收集后 >1）
  fixture('f1-short/正文/第002章_二.md', `第二章\n\n${rain}\n`);
  r = run('guyin-check-repetition.js', ['--json', '--project', proj, '--unit', '1', path.join(proj, '正文')]);
  check('F1-2 --unit 配目录目标拒绝（多文件不共用一个显式单元号）',
    r.status !== 0 && /单文件/.test(r.stderr || r.stdout),
    `status=${r.status} out=${(r.stderr || r.stdout).slice(0, 160)}`);

  // --unit 非法值
  r = run('guyin-check-repetition.js', ['--json', '--project', proj, '--unit', '0', story]);
  check('F1-2 --unit 必须正整数',
    r.status !== 0 && /positive integer/.test(r.stderr || r.stdout));
}

// ============================================================
// F2 / T03 去掉反效果（任务书 §4）：正常破折号/内心活动/长对话/日常余韵不得被自动强改。
// 对照半（真实泄漏必拦）由既有测试承担：H2 整句/四字子句泄漏 blocking、工程词泄漏、
// beat 工程词 meta-leak-beat、K3 strip-framework-word、T1/T2 物证·能力·地理（事实矛盾）。
// ============================================================
console.log('== F2/T03 正常风格不误伤（破折号/内心/长对话/余韵 合成对照） ==');
{
  const cleanProse = [
    '他把银子推回去——这钱不能收，收了就说不清了。',
    '她垂着眼拨算盘，心里盘算：天亮前还有一班去府城的船，赶得上就赢一半。',
    '周掌柜把账本合上，问她：「你几时看出来的？」',
    '「他换手系绳的时候。」她给两人各倒了一碗茶，「跑船的人不打那种结。」',
    '「就凭一个绳结？」',
    '「我爹押了二十年镖。」她把碗搁下，「他教过我三种绳结各自绑什么货。」',
    '周掌柜没再追问，端起碗喝了一口，茶汤有点涩，他也没说什么。',
    '夜深下去，街面上的梆子敲过两响。她收了茶摊，把缺口碗一只只扣进木盆，',
    '水声很轻。明天还要起早，米缸见了底，路过粮铺得记着赊半升。',
  ].join('\n');
  const f = fixture('t03/正文/第001章_正常.md', `# 第001章 茶摊夜话\n\n${cleanProse}\n`);
  const r = run('guyin-check-ai-patterns.js', ['--json', f]);
  const rep = parseJson(r.stdout);
  // 破折号允许 editorial 观察（advisory、不阻断）；除此之外四类正常风格零报警，硬门 exit 0。
  const nonDash = rep ? rep.findings.filter((x) => x.type !== 'em-dash') : [];
  const dashAdvisory = rep && rep.findings.every((x) => x.type !== 'em-dash' || x.severity === 'advisory');
  check('T03 正常破折号仅 editorial 不阻断；内心/长对话/余韵零误报（硬门 exit 0）',
    r.status === 0 && rep && nonDash.length === 0 && dashAdvisory,
    `status=${r.status} types=${JSON.stringify(rep && rep.findings.map((x) => `${x.type}:${x.severity}`))}`);
  // 内心合法认知半句仍不计数（Fw-05 规则的 T03 对照位）
  const legal = fixture('t03/正文/第002章_内心.md',
    '她认得这个结。她想，跑船的人不会这么系绳。\n他心里清楚，这事再追下去要出人命，可脚没停。\n');
  const r2 = run('guyin-check-ai-patterns.js', ['--json', legal]);
  const rep2 = parseJson(r2.stdout);
  check('T03 合法内心认知（她想/心里清楚）不报 mono-count',
    r2.status === 0 && rep2 && !rep2.findings.some((x) => x.type === 'mono-count'),
    `types=${JSON.stringify(rep2 && rep2.findings.map((x) => x.type))}`);
}

// ============================================================
// F2 / T11 短篇端到端真实运行（不是正则断言）：
// 无数字篇名 → init(chapter=0) → append 单元1 发布清单全闸门 → 指纹/篇检/状态贯穿
// → 篇名 chapter=2 拒、第二篇冒单元1 拒 → revision 重发存档 → 发布中断 recover
// ============================================================
console.log('== F2/T11 短篇发布端到端（临时合成项目，真实进程） ==');
{
  const crypto = require('crypto');
  const pyBin = ['python3', 'python', 'py'].find((bin) => {
    try {
      return spawnSync(bin, ['-c', ''], { encoding: 'utf8' }).status === 0;
    } catch (e) {
      return false;
    }
  });
  const PYSCRIPT = path.join(S, 'guyin-tracking-commit.py');
  const REPJS = path.join(S, 'guyin-check-repetition.js');
  const h12 = (s) => crypto.createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex').slice(0, 12);
  const h12file = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex').slice(0, 12);
  const cleanEnv = { ...process.env };
  delete cleanEnv.GUYIN_PUBLISH_PAUSE_AFTER;

  // 短篇叙述段（无章号标题；句长够指纹收录）
  const Q1 = '雨在瓦当上连成线，沈知微把那封退回来的信压进妆奁底层，指腹蹭过火漆残痕，门外唢呐声正一遍一遍往巷子里灌。';
  const Q2 = '她扶着门框听了很久，认出来的是自己三年前亲手挑的那支迎亲调子，吹曲的人换了，节拍却一点没变。';
  const Q1R = '雨在瓦当上碎成珠，沈知微把那封退回来的信塞到妆奁最里层，指腹蹭过残损的火漆，门外唢呐声正一遍一遍漫进巷子。';
  const Q2R = '她靠着门框听了半晌，听出那是自己三年前亲口定下的迎亲调子，吹曲的人早换了，节拍却还和当年一样。';
  const storyText = (a, b) => `# 追妻\n\n${a}\n\n${b}\n`;
  const LEDGER = [
    '| 章号 | 来源 | 报警/发现 | 处置类别 | 正文版本 | 终态 | 决定依据 | 去向/备注 |',
    '|---|---|---|---|---|---|---|---|',
    '',
  ].join('\n');

  const initShort = (name) => {
    const book = path.join(TMP, name);
    fs.mkdirSync(path.join(book, '追踪', '角色状态'), { recursive: true });
    fs.mkdirSync(path.join(book, '正文'), { recursive: true });
    fs.writeFileSync(path.join(book, '追踪', '待审台账.md'), LEDGER, 'utf8');
    const initDoc = {
      schema_version: 1, book_title: name, last_chapter: 0,
      context: {
        position: { volume: '短篇', volume_start_chapter: 1, story_time: '婚日', scene: '巷口' },
        long_term_constraints: [], active_character_names: [], continuity_risks: [],
        recent_chapters: [], next_chapter_commitments: [],
      },
    };
    const initPath = path.join(book, 'init.json');
    fs.writeFileSync(initPath, JSON.stringify(initDoc), 'utf8');
    const rr = spawnSync(pyBin || 'python', [PYSCRIPT, 'init', '--input', initPath, '--project', book],
      { encoding: 'utf8', env: cleanEnv });
    if (rr.status !== 0) throw new Error(`T11 init failed: ${rr.stderr || rr.stdout}`);
    return book;
  };

  // 组装短篇发布清单（target.chapter 显式 1，destination 无数字篇名）
  const stageShort = (book, runId, candidate, opts = {}) => {
    const wsRel = `.guyin/work/${runId}`;
    const ws = path.join(book, wsRel);
    fs.mkdirSync(ws, { recursive: true });
    const candPath = path.join(ws, 'candidate.md');
    fs.writeFileSync(candPath, candidate, 'utf8');
    const chash = h12file(candPath);
    // E1/D2：审读与检查证据必须内嵌候选 hash12
    fs.writeFileSync(path.join(ws, 'review.md'), `# 全文审读\n候选 hash12=${chash}\n先初读再对骨架：反转铺垫齐、结尾回报给够。\n`, 'utf8');
    fs.writeFileSync(path.join(ws, 'checks.md'), `# 篇检证据\n候选 hash12=${chash}\nstrip/degeneration/integrity/ai-patterns/wordcount 全绿。\n`, 'utf8');
    const mode = opts.mode || 'append';
    const expected = opts.expected !== undefined ? opts.expected : 0;
    const chapter = opts.chapter !== undefined ? opts.chapter : 1;
    const dest = opts.destination || '正文/追妻.md';
    const title = opts.title || '追妻';
    const tx = {
      schema_version: 1, mode, chapter, chapter_title: title, expected_state_revision: expected,
      delta: {
        result: opts.result || '沈知微听见迎亲调子，认出是自己当年定下的那一支。',
        character_changes: [], foreshadow_changes: [], timeline_events: [], verdict_changes: [],
        evidence_changes: [], geo_changes: [], scene_changes: [], constraints: [],
        next_chapter_commitments: [], retired_context_items: [], retired_characters: [],
      },
      context: {
        position: { volume: '短篇', volume_start_chapter: 1, story_time: '婚日', scene: '巷口' },
        long_term_constraints: [], active_character_names: [], continuity_risks: [],
      },
      character_snapshots: {},
    };
    fs.writeFileSync(path.join(ws, 'tx.json'), JSON.stringify(tx), 'utf8');
    const proseFiles = fs.readdirSync(path.join(book, '正文')).filter((n) => !n.startsWith('.'));
    const manifest = {
      schema_version: 1, run_id: runId,
      target: { chapter, title, mode },
      candidate: `${wsRel}/candidate.md`,
      destination: dest,
      transaction: `${wsRel}/tx.json`,
      baseline: [
        { path: '追踪/_tracking-state.json', hash12: h12file(path.join(book, '追踪', '_tracking-state.json')) },
        { dir: '正文', files: proseFiles },
      ],
      expected_state_revision: expected,
      review: { mode: 'solo 全文通读', conclusion: '初读通过', evidence: [`${wsRel}/review.md`] },
      check_evidence: [`${wsRel}/checks.md`],
    };
    const manifestPath = path.join(ws, 'manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify(manifest), 'utf8');
    return { manifestPath, chash };
  };

  const readState = (b) => JSON.parse(fs.readFileSync(path.join(b, '追踪', '_tracking-state.json'), 'utf8'));
  const readPub = (b) => JSON.parse(fs.readFileSync(path.join(b, '追踪', '_publication.json'), 'utf8'));
  const libUnits = (b) => {
    const doc = JSON.parse(fs.readFileSync(path.join(b, '追踪', '段落指纹库.json'), 'utf8'));
    return (doc.entries || []).map((e) => `${e.chapter}:${e.file}`);
  };
  const runPy = (b, args, env) =>
    spawnSync(pyBin || 'python', [PYSCRIPT, ...args, '--project', b], { encoding: 'utf8', env: env || cleanEnv });

  if (!pyBin) {
    skip('F2/T11 短篇端到端全部用例', '未找到可用 python 解释器');
  } else {
    // ---- 1) 首发 append（无数字篇名，显式单元 1） ----
    const book = initShort('t11short');
    const firstText = storyText(Q1, Q2);
    const sg1 = stageShort(book, 'run-first', firstText);
    let rr = runPy(book, ['publish', '--input', sg1.manifestPath]);
    const dest = path.join(book, '正文', '追妻.md');
    check('T11 短篇 append 首发 publish exit 0',
      rr.status === 0, `status=${rr.status} err=${(rr.stderr || rr.stdout).trim().slice(0, 300)}`);
    let st = readState(book);
    check('T11 首发：候选安装到无数字篇名、state 至单元1 rev1、journal complete、锁释放',
      fs.readFileSync(dest, 'utf8') === firstText
      && st.last_committed_chapter === 1 && st.state_revision === 1
      && readPub(book).stage === 'complete'
      && !fs.existsSync(path.join(book, '追踪', '.track-lock')),
      `st=${st.last_committed_chapter}/${st.state_revision}`);
    check('T11 指纹贯穿：条目 chapter=1 file=追妻.md（不靠文件名反解）',
      libUnits(book).length === 2 && libUnits(book).every((u) => u === '1:追妻.md'),
      `units=${JSON.stringify(libUnits(book))}`);

    // ---- 2) 篇检真实运行：repetition --unit 1 对已安装篇无欠账 ----
    rr = spawnSync('node', [REPJS, '--json', '--project', book, '--unit', '1', dest],
      { encoding: 'utf8', env: cleanEnv });
    const rep = parseJson(rr.stdout);
    check('T11 篇检 repetition --unit 1 通过且无指纹欠账',
      rr.status === 0 && rep && !rep.findings.some((f) => f.type === 'fingerprint-arrears'),
      `status=${rr.status} findings=${JSON.stringify(rep && rep.findings.map((f) => f.type))}`);

    // ---- 3) 拒绝：chapter=2 的无数字篇名（多篇映射缺失） ----
    const bad2 = stageShort(book, 'run-bad2', storyText(Q1R, Q2R),
      { chapter: 2, destination: '正文/第二篇.md', title: '第二篇', expected: 1 });
    rr = runPy(book, ['publish', '--input', bad2.manifestPath]);
    check('T11 无数字篇名 chapter=2 拒绝（仅允许固定单元 1，不靠篇名猜序号）',
      rr.status !== 0 && /非章号文件名仅允许短篇固定单元 1|不靠篇名猜序号/.test(`${rr.stderr}\n${rr.stdout}`),
      `status=${rr.status} out=${(rr.stderr || rr.stdout).trim().slice(0, 200)}`);

    // ---- 4) 拒绝：第二篇冒充单元 1 再 append ----
    const dup1 = stageShort(book, 'run-dup1', storyText(Q1R, Q2R),
      { destination: '正文/另一篇.md', title: '另一篇', expected: 1 });
    rr = runPy(book, ['publish', '--input', dup1.manifestPath]);
    check('T11 第二篇 append 冒充单元 1 被发布门拒绝（修订须走 revision）',
      rr.status !== 0, `status=${rr.status} out=${(rr.stderr || rr.stdout).trim().slice(0, 200)}`);
    check('T11 拒绝后正式正文/状态零污染',
      fs.readdirSync(path.join(book, '正文')).filter((n) => n.endsWith('.md')).length === 1
      && readState(book).state_revision === 1,
      `正文=${fs.readdirSync(path.join(book, '正文')).join(',')}`);

    // ---- 5) revision 重发：旧稿入 _archive/单元001_追妻_发布前存档_*.md ----
    const revText = storyText(Q1R, Q2R);
    const sg2 = stageShort(book, 'run-rev', revText,
      { mode: 'revision', expected: 1, result: '修订：吹曲的人换了，节拍没变。' });
    rr = runPy(book, ['publish', '--input', sg2.manifestPath]);
    const archDir = path.join(book, '正文', '_archive');
    const archives = fs.existsSync(archDir)
      ? fs.readdirSync(archDir).filter((n) => /^单元001_追妻_发布前存档_.*\.md$/.test(n)) : [];
    st = readState(book);
    check('T11 revision exit0、存档名 单元001_追妻_发布前存档_*、内容=首发候选 hash',
      rr.status === 0 && archives.length === 1
      && h12file(path.join(archDir, archives[0])) === sg1.chash
      && fs.readFileSync(dest, 'utf8') === revText
      && st.state_revision === 2,
      `status=${rr.status} arch=${archives.length} rev=${st.state_revision} err=${(rr.stderr || '').slice(0, 160)}`);
    check('T11 revision 后指纹仍只有单元 1 一条篇名线',
      JSON.stringify([...new Set(libUnits(book))]) === JSON.stringify(['1:追妻.md']),
      `units=${JSON.stringify(libUnits(book))}`);

    // ---- 6) 发布中断：prepared 阶段正文不在位；recover 续跑与正常发布一致 ----
    const book2 = initShort('t11short-pause');
    const sg3 = stageShort(book2, 'run-pause', firstText);
    rr = runPy(book2, ['publish', '--input', sg3.manifestPath],
      { ...cleanEnv, GUYIN_PUBLISH_PAUSE_AFTER: 'prepared' });
    const pausedOk = rr.status === 3 && readPub(book2).stage === 'prepared'
      && !fs.existsSync(path.join(book2, '正文', '追妻.md'))
      && fs.existsSync(path.join(book2, '.guyin', 'work', 'run-pause', 'candidate.md'));
    rr = runPy(book2, ['recover']);
    st = readState(book2);
    check('T11 短篇 prepared 中断 exit3 且候选隔离（正文未安装），recover 后与正常发布一致',
      pausedOk && rr.status === 0 && readPub(book2).stage === 'complete'
      && fs.readFileSync(path.join(book2, '正文', '追妻.md'), 'utf8') === firstText
      && st.last_committed_chapter === 1 && st.state_revision === 1
      && libUnits(book2).length === 2 && libUnits(book2).every((u) => u === '1:追妻.md')
      && !fs.existsSync(path.join(book2, '追踪', '.track-lock')),
      `paused=${pausedOk} rec=${rr.status} err=${(rr.stderr || rr.stdout || '').trim().slice(0, 200)}`);

    // ---- 7) fingerprint_committed 中断后 recover 不重复固化 ----
    const book3 = initShort('t11short-fppause');
    const sg4 = stageShort(book3, 'run-fppause', firstText);
    rr = runPy(book3, ['publish', '--input', sg4.manifestPath],
      { ...cleanEnv, GUYIN_PUBLISH_PAUSE_AFTER: 'fingerprint_committed' });
    const fpPaused = rr.status === 3 && readPub(book3).stage === 'fingerprint_committed';
    rr = runPy(book3, ['recover']);
    const fpUnits = libUnits(book3);
    check('T11 fingerprint 中断 recover complete 且指纹不重复（仅 2 条段落条目，章1篇名）',
      fpPaused && rr.status === 0 && readPub(book3).stage === 'complete'
      && fpUnits.length === 2 && fpUnits.every((u) => u === '1:追妻.md'),
      `fpPaused=${fpPaused} rec=${rr.status} units=${JSON.stringify(fpUnits)}`);
  }
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
// T01 完成条件：必要测试（如 Python 环境组）未运行必须列缺项，不能计全通过。
if (skipped > 0) {
  console.log(`Result: 运行时脚本回归测试通过（缺项：${skipped} 项 SKIP，含未运行的必要测试，不构成全量通过）`);
} else {
  console.log('Result: 运行时脚本回归测试通过（全量）');
}
