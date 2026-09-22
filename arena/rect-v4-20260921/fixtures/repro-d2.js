const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = process.cwd();
const S = path.join(REPO, 'skills', 'guyin-write', 'scripts');
const PY = 'python';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'd2repro-'));
const book = path.join(TMP, '书');
fs.mkdirSync(path.join(book, '追踪', '角色状态'), { recursive: true });
fs.mkdirSync(path.join(book, '正文'), { recursive: true });
fs.writeFileSync(path.join(book, '追踪', '待审台账.md'),
  '| 章号 | 来源 | 报警/发现 | 处置类别 | 正文版本 | 终态 | 决定依据 | 去向/备注 |\n|---|---|---|---|---|---|---|---|\n\n');
const initDoc = {
  schema_version: 1, book_title: 'D2书', last_chapter: 0,
  context: { position: { volume: '卷一', volume_start_chapter: 1, story_time: '开篇前', scene: '未定' },
    long_term_constraints: [], active_character_names: [], continuity_risks: [],
    recent_chapters: [], next_chapter_commitments: [] },
};
fs.writeFileSync(path.join(TMP, 'init.json'), JSON.stringify(initDoc));
let r = spawnSync(PY, [path.join(S, 'guyin-tracking-commit.py'), 'init', '--input', path.join(TMP, 'init.json'), '--project', book], { encoding: 'utf8' });
console.log('init', r.status, r.stderr);

const P1 = '河风裹着鱼腥气扑进票房窗口，老周把六张勘合按在案上，指节因用力而泛白，烛火被穿堂风压得只剩一点豆光。';
const P2 = '后院堆着成捆的硝石，账房先生拿竹尺量麻袋口沿，报出的数字落在水渍里，谁也懒得再核对第二遍。';
const candidate = `# 第001章 开篇\n\n${P1}\n\n${P2}\n`;
const ws = path.join(book, '.guyin', 'work', 'run-1');
fs.mkdirSync(ws, { recursive: true });
fs.writeFileSync(path.join(ws, 'candidate.md'), candidate);
const crypto = require('crypto');
const chash = crypto.createHash('sha256').update(fs.readFileSync(path.join(ws, 'candidate.md'))).digest('hex').slice(0, 12);
fs.writeFileSync(path.join(ws, 'review.md'), `# 审读记录\n候选 hash12=${chash}\n模式：solo 全章通读。\n`);
fs.writeFileSync(path.join(ws, 'checks.md'), `# 检查证据\n候选 hash12=${chash}\n五测试全绿。\n`);
const tx = {
  schema_version: 1, mode: 'append', chapter: 1, chapter_title: '开篇', expected_state_revision: 0,
  delta: { result: '老周在票房核勘合，烛火被风压矮，他把六张凭据逐张按平。',
    character_changes: [], foreshadow_changes: [], timeline_events: [], verdict_changes: [],
    evidence_changes: [], geo_changes: [], scene_changes: [], constraints: [],
    next_chapter_commitments: [], retired_context_items: [], retired_characters: [] },
  context: { position: { volume: '第一卷', volume_start_chapter: 1, story_time: '开篇当日', scene: '渡口票房' },
    long_term_constraints: [], active_character_names: [], continuity_risks: [] },
  character_snapshots: {},
};
fs.writeFileSync(path.join(ws, 'tx.json'), JSON.stringify(tx));
fs.writeFileSync(path.join(ws, 'input.json'), JSON.stringify({
  schema_version: 1, target: { kind: 'long', chapter: 1, title: '开篇', mode: 'append' },
  authorization: { write: { source_id: 'U1', quote: '请试写第一章，不发布。' }, selection: null,
    publish: { source_id: 'U1', quote: '授权发布第一章。', scope: 'authorized-target', candidate_sha256: null,
      target: { chapter: 1, title: '开篇', mode: 'append' } } },
  sources: [{ id: 'U1', kind: 'user', text: '请试写第一章，不发布。\n\n授权发布第一章。' }],
  facts: [], locks: [], allowed_reuse: [], outline: null,
  style: { profile_id: 'relationship-payoff', profile_version: 1, selection_basis: 'framework-default', effective_features: ['x'] },
  wordcount: { min: 1, max: 100000 },
}));
const h12f = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex').slice(0, 12);
const hashed = fs.readdirSync(path.join(book, '正文')).filter((n) => n.endsWith('.md')).sort()
  .map((n) => ({ path: `正文/${n}`, hash12: h12f(path.join(book, '正文', n)) }));
const manifest = {
  schema_version: 2, run_id: 'run-1', target: { chapter: 1, title: '开篇', mode: 'append' },
  candidate: '.guyin/work/run-1/candidate.md', destination: '正文/第001章_开篇.md',
  transaction: '.guyin/work/run-1/tx.json', author_input: '.guyin/work/run-1/input.json',
  candidate_checks: '.guyin/work/run-1/check-evidence.json',
  baseline: [{ path: '追踪/_tracking-state.json', hash12: h12f(path.join(book, '追踪', '_tracking-state.json')) },
    { dir: '正文', files: hashed.map((h) => h.path), ...(hashed.length ? { files_hashed: hashed } : {}) }],
  expected_state_revision: 0,
  review: { mode: 'solo 全章通读', conclusion: '初读通过', evidence: ['.guyin/work/run-1/review.md'] },
  check_evidence: ['.guyin/work/run-1/checks.md'],
};
fs.writeFileSync(path.join(ws, 'manifest.json'), JSON.stringify(manifest));
r = spawnSync(PY, [path.join(S, 'guyin-tracking-commit.py'), 'preview', '--input', path.join(ws, 'manifest.json'), '--project', book], { encoding: 'utf8' });
console.log('preview exit', r.status);
console.log('STDERR', r.stderr.slice(0, 600));
const r2 = spawnSync(PY, [path.join(S, 'guyin-tracking-commit.py'), 'publish', '--input', path.join(ws, 'manifest.json'), '--project', book], { encoding: 'utf8' });
console.log('publish exit', r2.status);
console.log('PUB STDERR', r2.stderr.slice(0, 1200));
console.log('TMP', TMP);
