// T05 后果消费：真实事务提交 → 派生视图 → 供下一场简报（本脚本只跑状态链，正文场景由 subagent 写）
const fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto'), { spawnSync } = require('child_process');
const ROOT = 'D:/readbook-wpace/guyin-skills';
const PYSCRIPT = path.join(ROOT, 'skills', 'guyin-write', 'scripts', 'guyin-tracking-commit.py');
const pyBin = ['python3', 'python', 'py'].find(bin => { try { return spawnSync(bin, ['-c', ''], { encoding: 'utf8' }).status === 0; } catch (e) { return false; } });
const B = path.join(os.tmpdir(), 't05-consequence');
fs.rmSync(B, { recursive: true, force: true });
const W = (rel, c) => { fs.mkdirSync(path.join(B, path.dirname(rel)), { recursive: true }); fs.writeFileSync(path.join(B, rel), c, 'utf8'); };
const h = s => crypto.createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex').slice(0, 12);
const runPy = (args, input) => {
  const r = spawnSync(pyBin || 'python', [PYSCRIPT, ...args, '--project', B, ...(input ? ['--input', input] : [])], { encoding: 'utf8' });
  if (r.status !== 0) { console.error('PYFAIL', args, r.stderr || r.stdout); process.exit(1); }
  return r;
};

fs.mkdirSync(path.join(B, '正文'), { recursive: true });
fs.mkdirSync(path.join(B, '追踪', '角色状态'), { recursive: true });
W('追踪/待审台账.md', '| 章号 | 来源 | 报警/发现 | 处置类别 | 正文版本 | 终态 | 决定依据 | 去向/备注 |\n|---|---|---|---|---|---|---|---|\n');
W('init.json', JSON.stringify({
  schema_version: 1, book_title: '渡口', last_chapter: 0,
  context: { position: { volume: '卷一', volume_start_chapter: 1, story_time: '雪后清晨', scene: '码头茶棚' }, long_term_constraints: [], active_character_names: [], continuity_risks: [], recent_chapters: [], next_chapter_commitments: [] },
}));
runPy(['init'], path.join(B, 'init.json'));

// 细纲里有一个「计划中、尚未发生」的事件——它不应进入状态
W('大纲/细纲_第002章_夜袭.md', '# 细纲 第002章（计划，未写未发布）\n- 设计事件：韩某当夜带人夜袭茶棚灭口。\n- 状态：仅是设计，没有正文，禁止入状态。\n');

const ch1 = `# 第001章 托牌\n\n雪后初晴，茶棚外的官道压出两道车辙。沈砚把父亲留下的半块腰牌用红绳系了，塞进陆冲掌心。\n\n"府城鼓楼西街，周记镖行，亲手交给周掌柜。"她盯着他的眼睛，"这件事我只托你一个人。"\n\n陆冲把腰牌贴胸收好，说了句等我回来。她信他——父亲死后，这世上她只剩这一个可以把后背交出去的人。\n`;
const ch2 = `# 第002章 绳头\n\n入夜，沈砚去后巷收晾干的毛巾，隔着柴扉的缝，看见陆冲站在巷口灯下。\n\n一个耳后带刀疤的汉子把一锭银子塞进他手里，陆冲反手递过去一样东西——红绳先露出来，再是那半块腰牌。他低声说："人还在茶棚，跑不了。"\n\n她贴着墙根站了很久，没有出声。原来她说"只托你一个人"的那个人，早把她卖了。红绳是她亲手系的，绳头的结她认得。\n`;

const stage = (runId, chapter, mode, expected, title, prose, delta) => {
  const wsRel = `.guyin/work/${runId}`; const ws = path.join(B, wsRel);
  fs.mkdirSync(ws, { recursive: true });
  W(`${wsRel}/candidate.md`, prose);
  const chash = crypto.createHash('sha256').update(fs.readFileSync(path.join(ws, 'candidate.md'))).digest('hex').slice(0, 12);
  W(`${wsRel}/review.md`, `# 审读\n候选 hash12=${chash}\nsolo 通读通过。\n`);
  W(`${wsRel}/checks.md`, `# 检查\n候选 hash12=${chash}\n全绿。\n`);
  W(`${wsRel}/tx.json`, JSON.stringify({
    schema_version: 1, mode, chapter, chapter_title: title, expected_state_revision: expected,
    delta: {
      result: delta.result,
      character_changes: delta.character_changes,
      foreshadow_changes: delta.foreshadow_changes || [],
      timeline_events: [], verdict_changes: [], evidence_changes: [], geo_changes: [], scene_changes: [],
      constraints: [], next_chapter_commitments: delta.next || [], retired_context_items: [], retired_characters: [],
    },
    context: { position: { volume: '卷一', volume_start_chapter: 1, story_time: delta.storyTime, scene: delta.scene }, long_term_constraints: [], active_character_names: ['沈砚', '陆冲'], continuity_risks: [] },
    character_snapshots: delta.snapshots,
  }));
  const proseFiles = fs.readdirSync(path.join(B, '正文')).filter(n => !n.startsWith('.') && n !== '_archive');
  W(`${wsRel}/manifest.json`, JSON.stringify({
    schema_version: 1, run_id: runId,
    target: { chapter, title, mode },
    candidate: `${wsRel}/candidate.md`,
    transaction: `${wsRel}/tx.json`,
    destination: `正文/第${String(chapter).padStart(3, '0')}章_${title}.md`,
    baseline: [
      { path: '追踪/_tracking-state.json', hash12: h(fs.readFileSync(path.join(B, '追踪/_tracking-state.json'))) },
      { dir: '正文', files: proseFiles },
    ],
    expected_state_revision: expected,
    review: { mode: 'solo 通读', conclusion: '通过', evidence: [`${wsRel}/review.md`] },
    check_evidence: [`${wsRel}/checks.md`],
  }));
  return path.join(ws, 'manifest.json');
};

const m1 = stage('run-1', 1, 'append', 0, '托牌', ch1, {
  result: '沈砚把腰牌托给陆冲，只信他一人。',
  storyTime: '雪后清晨', scene: '茶棚',
  character_changes: [
    { name: '沈砚', change: '把父亲留下的半块腰牌系上红绳，托陆冲带去府城周记镖行；认定陆冲是唯一可托的人（第1章原句：「这件事我只托你一个人。」）' },
    { name: '陆冲', change: '接下腰牌，答应亲手交给府城周掌柜（第1章原句：「等我回来。」）' },
  ],
  next: ['陆冲携腰牌赴府城'],
  snapshots: {
    '沈砚': { identity: '镖头遗女，茶棚帮工', location: '码头茶棚', goal: '借腰牌联络府城周掌柜查父亲旧案', state: '右手虎口裂伤；把全部指望押在陆冲身上', abilities_resources: ['半块腰牌', '茶棚'], relationships: ['陆冲：唯一可托后背的人'], knowledge: ['仇人姓韩', '腰牌是父亲遗物'], open_threads: ['腰牌能否送到府城'] },
    '陆冲': { identity: '押车镖师，欠沈父一命', location: '茶棚', goal: '携腰牌赴府城', state: '接托', abilities_resources: ['镖路'], relationships: ['沈砚：受她所托'], knowledge: ['腰牌要交周记镖行'], open_threads: [] },
  },
});
runPy(['publish'], m1);

const m2 = stage('run-2', 2, 'append', 1, '绳头', ch2, {
  result: '沈砚亲眼看见陆冲把腰牌交给耳后带刀疤的仇人，信任崩塌。',
  storyTime: '同日入夜', scene: '茶棚后巷',
  character_changes: [
    { name: '沈砚', change: '后巷目击陆冲收下刀疤汉子的银子并递出系红绳的半块腰牌，听见他说「人还在茶棚，跑不了」；不再信任陆冲，认定他已出卖自己（第2章原句：「早把她卖了」）' },
    { name: '陆冲', change: '叛变坐实：向耳后刀疤的仇人交出腰牌、收一锭银子、报出沈砚所在（第2章原句：「人还在茶棚，跑不了。」）' },
  ],
  foreshadow_changes: [],
  next: ['沈砚须另找通道向府城示警'],
  snapshots: {
    '沈砚': { identity: '镖头遗女，茶棚帮工', location: '茶棚后巷', goal: '在仇人动手前另找通道向府城示警', state: '虎口裂伤；目击叛变，信任崩塌，强撑未露声色', abilities_resources: ['半块腰牌已失', '茶棚', '熟客网络'], relationships: ['陆冲：已叛变，不可再信、须提防'], knowledge: ['仇人姓韩', '陆通向刀疤汉交出腰牌并收银子', '对方知道她在茶棚'], open_threads: ['如何绕过陆冲向府城报信', '仇人何时动手'] },
    '陆冲': { identity: '前镖师，已叛变', location: '后巷灯下', goal: '为韩姓仇人盯住沈砚', state: '收银交牌', abilities_resources: ['韩方给的银子'], relationships: ['沈砚：出卖对象', '刀疤汉：新主顾'], knowledge: ['沈砚藏在茶棚'], open_threads: [] },
  },
});
runPy(['publish'], m2);

// 派生视图核查
const state = JSON.parse(fs.readFileSync(path.join(B, '追踪/_tracking-state.json'), 'utf8'));
const views = {};
for (const f of ['上下文.md', '事件定性资产.md']) views[f] = fs.readFileSync(path.join(B, '追踪', f), 'utf8');
const charDir = path.join(B, '追踪', '角色状态');
views['角色状态/沈砚.md'] = fs.readFileSync(path.join(charDir, '沈砚.md'), 'utf8');
const stateBlob = JSON.stringify(state);
const allBlob = stateBlob + Object.values(views).join('\n');
const out = {
  last: state.last_committed_chapter, rev: state.state_revision,
  shenViewHasTrustBreak: views['角色状态/沈砚.md'].includes('陆冲：已叛变，不可再信、须提防')
    && views['角色状态/沈砚.md'].includes('在仇人动手前另找通道向府城示警'),
  shenViewOldTrustRetired: !views['角色状态/沈砚.md'].includes('唯一可托后背的人'),
  outlineOnlyEventLeaked: allBlob.includes('夜袭') || allBlob.includes('灭口'),
  nextCommitment: (state.context.next_chapter_commitments || []).slice(),
  activeNames: state.context.active_character_names,
};
console.log(JSON.stringify(out, null, 2));
W('_t05_view_check.json', JSON.stringify(out, null, 2));
console.log('PROJECT', B);
