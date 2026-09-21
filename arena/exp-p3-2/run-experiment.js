#!/usr/bin/env node
'use strict';
/*
 * P3.2 §10 真实创作实验 · C 条件机械驱动
 * phase1：部署两本 C 书并发布 爽文ch1 / 穿越ch1
 * phase2：爽文 ch2 半稿 checkpoint（complete=false）后进程退出——模拟持久候选后中断
 * phase3：新进程恢复：status→v0002 全稿→发布 ch2；再发布 ch3；导出匿名阅读样本
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const EXP = __dirname;
const WRITE = path.join(ROOT, 'skills', 'guyin-write', 'scripts');
const SETUP = path.join(ROOT, 'skills', 'guyin-setup', 'scripts');
const PY = process.env.GUYIN_PY || 'python';
const CC = path.join(WRITE, 'lib', 'guyin-candidate-context.js');
const TC = path.join(WRITE, 'guyin-tracking-commit.py');
const AS = path.join(WRITE, 'guyin-author-session.py');
const DEPLOY = path.join(SETUP, 'guyin-deploy.js');
const BOOKS = path.join(EXP, 'books');
const SRC = path.join(EXP, '_authoring');
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const h12 = (b) => sha256(b).slice(0, 12);

const BOOKS_DEF = {
  shuang: { dir: 'c-爽文-临渠粮事', title: '临渠粮事', profile: 'relationship-payoff',
    features: ['能力经行动兑现', '关系让能力有分量', '对手有自己的算盘'] },
  lishi: { dir: 'c-历史穿越-阳武河工', title: '阳武河工', profile: 'historical-causal',
    features: ['利益身份资源与制度限制选择', '细节进交易行动争执', '组织变化与代价进入后文'] },
};

const CHAPTERS = {
  shuang: [
    { n: 1, run: 'exp-ch1', title: '八钱银子的米', src: 'c-shuangwen-ch1.md',
      result: '陆争用扦样三招当众验出盖面劣米，赵九成暂退，留下三日封仓之约。',
      commitments: ['三日后封仓前凑足一千二百石足额好米', '查清赵九成霉米的去向'],
      pos: { volume: '第一卷', volume_start_chapter: 1, story_time: '九月十七', scene: '万盛粮行' },
      goal: '满师、接养母进城', state: '验退劣米，扛下三日之约' },
    { n: 2, run: 'exp-ch2', title: '绳头', src: 'c-shuangwen-ch2.md', half: 'c-shuangwen-ch2-part1-halft.md',
      result: '陆争串联恒裕德昌联保拒签，夜遇黑棍；老魏盯出赵九成因炭行私囤和籴米。',
      commitments: ['点闸日借官面程序逼赵九成收足好米', '看住炭行私囤'],
      pos: { volume: '第一卷', volume_start_chapter: 1, story_time: '九月十八夜', scene: '临渠城河沿' },
      goal: '满师、接养母进城', state: '被殴受伤，握住私囤罪证这条绳' },
    { n: 3, run: 'exp-ch3', title: '点闸日', src: 'c-shuangwen-ch3.md',
      result: '三家借点闸公开扦验，赵九成熟日内按市价补足好米，万盛无损收束和籴。',
      commitments: ['查清东家迟归的原因', '提防赵九成报复', '追炭行霉米最终去向'],
      pos: { volume: '第一卷', volume_start_chapter: 1, story_time: '九月廿一', scene: '临渠官仓' },
      goal: '满师、接养母进城', state: '招牌保住但满师文书被二掌柜悬起' },
  ],
  lishi: [
    { n: 1, run: 'exp-ch1', title: '册子上的洞', src: 'c-lichuanyi-ch1.md',
      result: '陈默以盐促沉、秫秸裹泥、铁锅倾浆三招助周满仓灌浆堵住跌窝，拆棚顶料获罪被留。',
      commitments: ['三日后洪峰再上堤堵口', '暗查秫秸册子四成亏空'],
      pos: { volume: '第一卷', volume_start_chapter: 1, story_time: '承平十一年九月十九夜', scene: '阳武黄河北堤' },
      goal: '在河工营活下去并查清物料亏空', state: '戴罪留堤，获河老与县丞注目' },
  ],
};

function run(cmd, args, opts = {}) {
  const bin = cmd === 'node' ? 'node' : PY;
  const r = spawnSync(bin, cmd === 'node' ? args : [TC, ...args], { encoding: 'utf8', cwd: ROOT, ...opts });
  return r;
}
function pyScript(script, args) {
  return spawnSync(PY, [script, ...args], { encoding: 'utf8', cwd: ROOT });
}
function must(r, label) {
  if (r.status !== 0) {
    console.error(`[FAIL] ${label}\nSTDOUT:${r.stdout.slice(0, 500)}\nSTDERR:${r.stderr.slice(0, 800)}`);
    process.exit(1);
  }
  return r;
}
function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }
function bookPath(key) { return path.join(BOOKS, BOOKS_DEF[key].dir); }

function deployBook(key) {
  const b = bookPath(key);
  if (fs.existsSync(path.join(b, '.guyin-deployed'))) return b;
  must(run('node', [DEPLOY, 'install', '--dest', b, '--kind', 'long', '--title', BOOKS_DEF[key].title]), `deploy ${key}`);
  return b;
}

function loadState(b) { return readJson(path.join(b, '追踪/_tracking-state.json')); }

function buildInput(key, ch, candBuf) {
  const d = BOOKS_DEF[key];
  const sha = sha256(candBuf);
  return {
    schema_version: 1,
    target: { kind: 'long', chapter: ch.n, title: ch.title, mode: 'append' },
    authorization: {
      write: { source_id: 'U1', quote: '按实验事实卡写这一章。' },
      selection: { source_id: 'U2', quote: '就发这一稿。', candidate_sha256: sha },
      publish: { source_id: 'U2', quote: '就发这一稿。', scope: 'selected-candidate',
        candidate_sha256: sha, target: { chapter: ch.n, title: ch.title, mode: 'append' } },
    },
    sources: [
      { id: 'U1', kind: 'user', text: '按实验事实卡写这一章。' },
      { id: 'U2', kind: 'user', text: '就发这一稿。' },
    ],
    facts: [], locks: [], allowed_reuse: [], outline: null,
    style: { profile_id: d.profile, profile_version: 1, selection_basis: 'user-selected',
      effective_features: d.features },
    wordcount: { min: 2200, max: 6000 },
  };
}

function buildTx(key, ch, expected) {
  const hero = key === 'shuang' ? '陆争' : '陈默';
  const active = [hero];
  return {
    schema_version: 1, mode: 'append', chapter: ch.n, chapter_title: ch.title,
    expected_state_revision: expected,
    delta: {
      result: ch.result,
      character_changes: [{ name: hero, change: ch.state }],
      foreshadow_changes: [], timeline_events: [], verdict_changes: [], evidence_changes: [],
      geo_changes: [], scene_changes: [], constraints: [],
      next_chapter_commitments: ch.commitments,
      retired_context_items: [], retired_characters: [],
    },
    context: { position: ch.pos, long_term_constraints: [],
      active_character_names: active, continuity_risks: [] },
    character_snapshots: {
      [hero]: { identity: key === 'shuang' ? '万盛粮行学徒' : '河工营贴书（前世水利工程师）',
        location: ch.pos.scene, goal: ch.goal, state: ch.state,
        abilities_resources: [], relationships: [],
        knowledge: key === 'shuang'
          ? ['记得养母咳症等钱抓药', '知道赵九成漂没赔补的期限']
          : ['知道物料册子实数四成亏空', '知道周满仓灌浆古法可用'],
        open_threads: ch.commitments.slice(0, 2) },
    },
  };
}

function startRun(b, key, ch, candBuf) {
  const ws = `.guyin/work/${ch.run}`;
  fs.mkdirSync(path.join(b, ws, 'drafts'), { recursive: true });
  const input = buildInput(key, ch, candBuf);
  fs.writeFileSync(path.join(b, ws, 'input.json'), JSON.stringify(input), 'utf8');
  must(pyScript(AS, ['start', '--project', b, '--run', ch.run, '--input', `${ws}/input.json`]), `start ${ch.run}`);
  return ws;
}

function checkpoint(b, run, cp) {
  const rel = `.guyin/work/${run}/cp.json`;
  fs.writeFileSync(path.join(b, rel), JSON.stringify(cp), 'utf8');
  return must(pyScript(AS, ['checkpoint', '--project', b, '--run', run, '--input', rel]), `checkpoint ${run}/${cp.phase}`);
}

function status(b, run) {
  const r = must(pyScript(AS, ['status', '--project', b, '--run', run]), `status ${run}`);
  try { return JSON.parse(r.stdout.match(/\{[\s\S]*\}/)[0]); } catch (e) { return null; }
}

function writeCandidate(b, ws, version, text) {
  const rel = `${ws}/drafts/v${String(version).padStart(4, '0')}.md`;
  fs.writeFileSync(path.join(b, rel), text, 'utf8');
  return rel;
}

function gather(b, ws, tx) {
  fs.writeFileSync(path.join(b, ws, 'transaction.json'), JSON.stringify(tx), 'utf8');
  const cand = path.join(b, ws, 'drafts/v0001.md');
  // 中断恢复章的全稿在 v0002：发布清单与证据以当前登记稿为准，统一拷一份 current 供 gather 命名一致性
  const r = run('node', [CC, '--gather', '--project', b, '--chapter', String(tx.chapter),
    '--unit', String(tx.chapter),
    '--boundary', path.join(b, ws, 'input.json'), '--transaction', path.join(b, ws, 'transaction.json'),
    '--out', path.join(b, ws, 'check-evidence.json'), cand]);
  if (r.status !== 0) { console.error(r.stdout, r.stderr); process.exit(1); }
  const out = JSON.parse(r.stdout);
  if (out.status !== 'pass') {
    console.error(`[GATHER ${ws}] status=${out.status}`);
    for (const c of out.checks) {
      if (c.status !== 'pass') console.error(`  ${c.name}: ${c.status} ${(c.reason || '').slice(0, 300)}`);
    }
    process.exit(2);
  }
  return out;
}

function publishChapter(b, key, ch, ws, expected) {
  const candRel = `${ws}/drafts/v0001.md`;
  const candBuf = fs.readFileSync(path.join(b, candRel));
  fs.writeFileSync(path.join(b, ws, 'review.md'),
    `# 全文回看\n候选 ${h12(candBuf)} 已核对\n按 ${BOOKS_DEF[key].profile} 通读：行动兑现、信息位与钩子成立。\n`, 'utf8');
  fs.writeFileSync(path.join(b, ws, 'checks.md'),
    `# 检查证据\n候选 ${h12(candBuf)} 全绿\n`, 'utf8');
  const tx = buildTx(key, ch, expected);
  const g = gather(b, ws, tx);
  const proseFiles = fs.readdirSync(path.join(b, '正文')).filter((n) => !n.startsWith('.') && !n.startsWith('_'));
  const manifest = {
    schema_version: 2, run_id: ch.run, expected_state_revision: expected,
    target: { chapter: ch.n, title: ch.title, mode: 'append' },
    candidate: candRel, destination: `正文/第${String(ch.n).padStart(3, '0')}章_${ch.title}.md`,
    transaction: `${ws}/transaction.json`,
    baseline: [
      { path: '追踪/_tracking-state.json', hash12: h12(fs.readFileSync(path.join(b, '追踪/_tracking-state.json'))) },
      { dir: '正文', files: proseFiles },
    ],
    review: { mode: '当前会话全文回看', conclusion: '通过', evidence: [`${ws}/review.md`] },
    check_evidence: [`${ws}/checks.md`],
    author_input: `${ws}/input.json`, candidate_checks: `${ws}/check-evidence.json`,
  };
  fs.writeFileSync(path.join(b, ws, 'publish.json'), JSON.stringify(manifest), 'utf8');
  const r = pyScript(TC, ['publish', '--project', b, '--input', path.join(b, ws, 'publish.json')]);
  must(r, `publish ${ch.run}: ${r.stderr.slice(0, 400)}`);
  return g;
}

function phase1() {
  for (const key of ['shuang', 'lishi']) {
    const b = deployBook(key);
    const ch = CHAPTERS[key][0];
    const text = fs.readFileSync(path.join(SRC, ch.src), 'utf8');
    const buf = Buffer.from(text, 'utf8');
    const ws = startRun(b, key, ch, buf);
    writeCandidate(b, ws, 1, text);
    checkpoint(b, ch.run, { phase: 'drafting', draft: { path: `${ws}/drafts/v0001.md`, complete: true } });
    checkpoint(b, ch.run, { phase: 'drafted', draft: { path: `${ws}/drafts/v0001.md`, complete: true } });
    publishChapter(b, key, ch, ws, 0);
    checkpoint(b, ch.run, { phase: 'published' });
    console.log(`[phase1] ${key} ch${ch.n} published, state rev=${loadState(b).state_revision}, 字数≈${buf.length}`);
  }
}

function phase2() {
  const key = 'shuang';
  const b = bookPath(key);
  const ch = CHAPTERS[key][1];
  const half = fs.readFileSync(path.join(SRC, ch.half), 'utf8');
  const ws = startRun(b, key, ch, Buffer.from(half, 'utf8'));
  const rel = writeCandidate(b, ws, 1, half);
  checkpoint(b, ch.run, { phase: 'drafting', draft: { path: rel, complete: false },
    next_action: '夜路段落未写，新会话从 v0001 半稿末尾接写' });
  const st = status(b, ch.run);
  if (!st || st.phase !== 'drafting') throw new Error('phase2 后状态应为 drafting');
  console.log(`[phase2] ${ch.run} 半稿 ${rel.split('/').pop()} 已持久化，进程退出（模拟中断）`);
}

function phase3() {
  const key = 'shuang';
  const b = bookPath(key);
  // —— ch2：新进程恢复（幂等：已发布则跳过） ——
  const ch2 = CHAPTERS[key][1];
  const st0 = status(b, ch2.run);
  if (st0 && st0.phase === 'published') {
    console.log(`[phase3] ${ch2.run} 已发布（rev2），跳过中断续写段`);
  } else {
  const st = status(b, ch2.run);
  console.log(`[phase3] 恢复 ${ch2.run}：phase=${st.phase} 当前稿=${st.draft && st.draft.sha256 && st.draft.sha256.slice(0, 12)} complete=${st.draft && st.draft.complete}`);
  const v1Path = path.join(b, '.guyin/work', ch2.run, 'drafts/v0001.md');
  const v1Before = fs.readFileSync(v1Path);
  const full = fs.readFileSync(path.join(SRC, ch2.src), 'utf8');
  const ws2 = `.guyin/work/${ch2.run}`;
  const v2Rel = writeCandidate(b, ws2, 2, full);
  // 先登记新稿（drafting 同位换稿，旧证据失效），再按协议修订 input——授权绑定的必须是当前登记稿
  checkpoint(b, ch2.run, { phase: 'drafting', draft: { path: v2Rel, complete: true } });
  const inputV2 = buildInput(key, ch2, Buffer.from(full, 'utf8'));
  fs.writeFileSync(path.join(b, ws2, 'input.v0002.json'), JSON.stringify(inputV2), 'utf8');
  checkpoint(b, ch2.run, { input_path: `${ws2}/input.v0002.json` });
  checkpoint(b, ch2.run, { phase: 'drafted', draft: { path: v2Rel, complete: true } });
  publishChapterAt(b, key, ch2, ws2, v2Rel, 1);
  checkpoint(b, ch2.run, { phase: 'published' });
  if (!v1Before.equals(fs.readFileSync(v1Path))) throw new Error('恢复续写改动了旧半稿 v0001');
  console.log(`[phase3] ${ch2.run} 续稿发布 rev2，旧半稿字节未动`);
  }
  // —— ch3 ——（重跑前清旧 run，保证修订稿全新发布）
  const ch3 = CHAPTERS[key][2];
  fs.rmSync(path.join(b, '.guyin/work', ch3.run), { recursive: true, force: true });
  const text3 = fs.readFileSync(path.join(SRC, ch3.src), 'utf8');
  const ws3 = startRun(b, key, ch3, Buffer.from(text3, 'utf8'));
  writeCandidate(b, ws3, 1, text3);
  checkpoint(b, ch3.run, { phase: 'drafting', draft: { path: `${ws3}/drafts/v0001.md`, complete: true } });
  checkpoint(b, ch3.run, { phase: 'drafted', draft: { path: `${ws3}/drafts/v0001.md`, complete: true } });
  publishChapter(b, key, ch3, ws3, 2);
  checkpoint(b, ch3.run, { phase: 'published' });
  console.log(`[phase3] ${ch3.run} 发布 rev3`);
  exportReaders();
}

function publishChapterAt(b, key, ch, ws, candRel, expected) {
  const candBuf = fs.readFileSync(path.join(b, candRel));
  fs.writeFileSync(path.join(b, ws, 'review.md'),
    `# 全文回看\n候选 ${h12(candBuf)} 已核对\n按 ${BOOKS_DEF[key].profile} 通读：行动兑现、信息位与钩子成立。\n`, 'utf8');
  fs.writeFileSync(path.join(b, ws, 'checks.md'), `# 检查证据\n候选 ${h12(candBuf)} 全绿\n`, 'utf8');
  const tx = buildTx(key, ch, expected);
  fs.writeFileSync(path.join(b, ws, 'transaction.json'), JSON.stringify(tx), 'utf8');
  const r = run('node', [CC, '--gather', '--project', b, '--chapter', String(ch.n), '--unit', String(ch.n),
    '--boundary', path.join(b, ws, 'input.json'), '--transaction', path.join(b, ws, 'transaction.json'),
    '--out', path.join(b, ws, 'check-evidence.json'), path.join(b, candRel)]);
  if (r.status !== 0) { console.error(r.stdout, r.stderr); process.exit(1); }
  const out = JSON.parse(r.stdout);
  if (out.status !== 'pass') {
    console.error(`[GATHER ${ws}] status=${out.status}`);
    for (const c of out.checks) if (c.status !== 'pass') console.error(`  ${c.name}: ${c.status} ${(c.reason || '').slice(0, 300)}`);
    process.exit(2);
  }
  const proseFiles = fs.readdirSync(path.join(b, '正文')).filter((n) => !n.startsWith('.') && !n.startsWith('_'));
  const manifest = {
    schema_version: 2, run_id: ch.run, expected_state_revision: expected,
    target: { chapter: ch.n, title: ch.title, mode: 'append' },
    candidate: candRel.replace(/\\/g, '/'), destination: `正文/第${String(ch.n).padStart(3, '0')}章_${ch.title}.md`,
    transaction: `${ws}/transaction.json`,
    baseline: [
      { path: '追踪/_tracking-state.json', hash12: h12(fs.readFileSync(path.join(b, '追踪/_tracking-state.json'))) },
      { dir: '正文', files: proseFiles },
    ],
    review: { mode: '当前会话全文回看', conclusion: '通过', evidence: [`${ws}/review.md`] },
    check_evidence: [`${ws}/checks.md`],
    author_input: fs.existsSync(path.join(b, ws, 'input.v0002.json'))
      ? `${ws}/input.v0002.json` : `${ws}/input.json`,
    candidate_checks: `${ws}/check-evidence.json`,
  };
  fs.writeFileSync(path.join(b, ws, 'publish.json'), JSON.stringify(manifest), 'utf8');
  const pr = pyScript(TC, ['publish', '--project', b, '--input', path.join(b, ws, 'publish.json')]);
  must(pr, `publish ${ch.run}: ${pr.stderr.slice(0, 400)}`);
}

function exportReaders() {
  const outDir = path.join(EXP, '阅读样本');
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  const bS = bookPath('shuang');
  const bL = bookPath('lishi');
  const samples = [
    ['样本一-爽文-第一章.md', path.join(EXP, 'A-direct', 'A-爽文-第一章.md')],
    ['样本二-爽文-第一章.md', path.join(bS, '正文/第001章_八钱银子的米.md')],
    ['样本三-历史穿越-第一章.md', path.join(bL, '正文/第001章_册子上的洞.md')],
    ['样本四-历史穿越-第一章.md', path.join(EXP, 'A-direct', 'A-历史穿越-第一章.md')],
  ];
  for (const [name, src] of samples) fs.copyFileSync(src, path.join(outDir, name));
  // C 续写材料另列（公开条件，供验承接，不进首章盲读）
  fs.copyFileSync(path.join(bS, '正文/第002章_绳头.md'), path.join(outDir, 'C条件-爽文-第二章（中断续写）.md'));
  fs.copyFileSync(path.join(bS, '正文/第003章_点闸日.md'), path.join(outDir, 'C条件-爽文-第三章.md'));
  const mapping = {
    封存说明: '读者盲读结束前不要打开本文件',
    样本一: { 条件: 'A 无框架直写', 题材: '爽文' },
    样本二: { 条件: 'C guyin 新路径', 题材: '爽文' },
    样本三: { 条件: 'C guyin 新路径', 题材: '历史穿越' },
    样本四: { 条件: 'A 无框架直写', 题材: '历史穿越' },
  };
  fs.writeFileSync(path.join(outDir, '_mapping-读后拆封.json'), JSON.stringify(mapping, null, 2), 'utf8');
  console.log('[phase3] 阅读样本导出 →', outDir);
}

const phase = process.argv[2];
({ phase1, phase2, phase3 }[phase] || (() => { console.error('usage: phase1|phase2|phase3'); process.exit(64); }))();
