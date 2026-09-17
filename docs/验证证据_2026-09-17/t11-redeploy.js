const fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto'), { spawnSync } = require('child_process');
const ROOT = 'D:/readbook-wpace/guyin-skills';
const T = path.join(ROOT, 'skills', 'guyin-setup', 'templates', 'long');
const MERGE = path.join(ROOT, 'skills', 'guyin-setup', 'scripts', 'merge-claude-settings.js');
const B = path.join(os.tmpdir(), 't11-deploy-old');
fs.rmSync(B, { recursive: true, force: true });
const W = (rel, c) => { fs.mkdirSync(path.join(B, path.dirname(rel)), { recursive: true }); fs.writeFileSync(path.join(B, rel), c, 'utf8'); };
const h = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex').slice(0, 12);
const results = [];
const ok = (name, cond, extra = '') => { results.push([cond ? 'PASS' : 'FAIL', name, extra]); };

// ---- 1. 构造 0.11.0 旧项目（特征仿追影：自定义 model、旧 hook、13列旧表、小说正文） ----
W('.guyin-deployed', JSON.stringify({ deployed_at: '2026-09-15T12:58:00Z', guyin_version: '0.11.0', form: 'long+short', book_name: 't11旧书' }, null, 2));
W('.claude/agents/guyin-beat-writer.md', '---\nname: guyin-beat-writer\nmodel: deepseek-flash\ntools: ()\n---\n\n# 旧版执行层（0.11.0，含已淘汰措辞：三硬动作）\n');
W('.claude/agents/guyin-checker.md', '---\nname: guyin-checker\n---\n\n# 旧审读（无分诊卡/审读卡）\n');
W('.claude/agents/my-private-tool.md', '---\nname: my-private-tool\n---\n# 来源不明的用户自有部署件，不得盲目 replace\n');
W('.claude/hooks/guyin-hook.js', '// 旧 hook 0.11.0：无 publicationBlocker / _publication 门\nmodule.exports={};\n');
W('.claude/settings.json', JSON.stringify({
  model: 'sonnet-top',
  permissions: { allow: ['Bash(git status)'] },
  hooks: {
    PreToolUse: [
      { matcher: 'Bash', hooks: [{ type: 'command', command: 'node .myhooks/custom-check.js' }] },
      { matcher: 'Write|Edit|MultiEdit', hooks: [{ type: 'command', command: 'node .claude/hooks/guyin-hook.js guard-old', timeout: 5 }] },
    ],
  },
}, null, 2));
W('.codex/agents/guyin-beat-writer.toml', '# 旧 codex 执行层\n[agent.guyin-beat-writer]\n');
W('.codex/agents/guyin-checker.toml', '[agent.guyin-checker]\n');
W('.opencode/agents/guyin-beat-writer.md', '---\nname: guyin-beat-writer\n---\n旧 opencode 执行层\n');
W('.opencode/agents/guyin-checker.md', '---\nname: guyin-checker\n---\n旧 opencode 审读\n');
W('.opencode/commands/guyin.md', '旧命令\n');
W('AGENTS.md', '# t11旧书\n\n这是用户自己的路由文件，create-if-absent 不得覆盖。\n');
W('README.md', '# 旧 README 用户内容\n');
W('正文/第001章_试手.md', '# 第001章 试手\n\n他推开院门，槐花落了一肩，这是作者的小说正文，一个字都不许动。\n');
W('追踪/待审台账.md', '| 章号 | 来源 | 报警/发现 | 处置类别 | 正文版本 | 终态 | 决定依据 | 去向/备注 |\n|---|---|---|---|---|---|---|---|\n');
W('追踪/读者信号.md', '# 读者信号（旧 13 列试读表）\n\n| 日期 | 试读人 | 章范围 | 想不想看下一章 | 记住了谁 | 想划下来的句子 | 能力实证 | 当下目标 | 情绪热度 | 我猜对了 | 哪里想弃 | 弃书风险 | 备注 |\n|---|---|---|---|---|---|---|---|---|---|---|---|---|\n| 2026-09-10 | 甲 | 1-3 | 想 | 主角 | 句子A | 有 | 活下去 | 8 | 对 | 无 | 低 | 旧行保留 |\n');
W('作者性/气卡.md', '# 用户气卡（私有，不迁移不改写）\n');

const userFiles = ['正文/第001章_试手.md', '追踪/读者信号.md', '追踪/待审台账.md', 'AGENTS.md', 'README.md', '作者性/气卡.md', '.claude/agents/my-private-tool.md'];
const before = Object.fromEntries(userFiles.map(f => [f, h(path.join(B, f))]));

// ---- 2. 提取三端非注释生效 model（v0.8.0 第1步） ----
const extractModels = (file) => {
  const out = [];
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (t.startsWith('#') || t.startsWith('//') || t.startsWith(';')) continue;
    const m = t.match(/^model\s*[:=]\s*(.+)$/);
    if (m) out.push(m[1].trim());
  }
  return out;
};
const stash = {
  claude: extractModels(path.join(B, '.claude/agents/guyin-beat-writer.md')),
  codex: extractModels(path.join(B, '.codex/agents/guyin-beat-writer.toml')),
  opencode: extractModels(path.join(B, '.opencode/agents/guyin-beat-writer.md')),
};
ok('提取自定义 model（claude=deepseek-flash；codex/opencode 空＝等同solo）',
  JSON.stringify(stash.claude) === JSON.stringify(['deepseek-flash']) && stash.codex.length === 0 && stash.opencode.length === 0,
  JSON.stringify(stash));

// ---- 3. 差异三栏 ----
const willRefresh = ['.claude/agents/guyin-beat-writer.md', '.claude/agents/guyin-checker.md', '.claude/hooks/guyin-hook.js',
  '.codex/agents/guyin-beat-writer.toml', '.codex/agents/guyin-checker.toml',
  '.opencode/agents/guyin-beat-writer.md', '.opencode/agents/guyin-checker.md', '.opencode/commands/guyin.md'];
const willKeep = ['AGENTS.md', 'README.md', '正文/', '追踪/', '作者性/', 'settings 自定义键(model/permissions/用户hook)'];
const needConfirm = ['.claude/agents/my-private-tool.md（来源不明 → 用户决定：保留）'];
console.log('=== 差异三栏 ===\n[将刷新]', willRefresh.join(', '), '\n[将保留]', willKeep.join(', '), '\n[需确认]', needConfirm.join(', '));

// ---- 4. 备份旧部署件 + MANIFEST ----
const day = new Date().toISOString().slice(0, 10);
const bak = path.join(B, '.guyin', 'upgrade-backup', day);
const manifest = [];
for (const rel of willRefresh) {
  const src = path.join(B, rel), dst = path.join(bak, rel);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
  manifest.push(`${rel}\t旧=0.11.0 → 新=0.14.0(templates)\t回填=${rel === '.claude/agents/guyin-beat-writer.md' ? 'model: deepseek-flash' : '—'}`);
}
W('.guyin/upgrade-backup/' + day + '/MANIFEST.txt', manifest.join('\n') + '\n');
ok('备份落 .guyin/upgrade-backup/{日期}/ 且旧 beat-writer 含 model',
  fs.existsSync(path.join(bak, '.claude/agents/guyin-beat-writer.md'))
  && extractModels(path.join(bak, '.claude/agents/guyin-beat-writer.md')).join() === 'deepseek-flash'
  && fs.existsSync(path.join(bak, 'MANIFEST.txt')), bak);

// ---- 5. replace 执行层；未知件不动 ----
const cpDir = (s, d) => {
  fs.mkdirSync(d, { recursive: true });
  for (const e of fs.readdirSync(s, { withFileTypes: true })) {
    const sp = path.join(s, e.name), dp = path.join(d, e.name);
    if (e.isDirectory()) cpDir(sp, dp); else fs.copyFileSync(sp, dp);
  }
};
cpDir(path.join(T, '.claude/agents'), path.join(B, '.claude/agents'));
cpDir(path.join(T, '.claude/hooks'), path.join(B, '.claude/hooks'));
cpDir(path.join(T, '.codex'), path.join(B, '.codex'));
cpDir(path.join(T, '.opencode'), path.join(B, '.opencode'));

// ---- 6. settings 走真实 merge 脚本 ----
const mr = spawnSync('node', [MERGE, '--template', path.join(T, '.claude/settings.json'), '--target', path.join(B, '.claude/settings.json')], { encoding: 'utf8' });
ok('merge-claude-settings.js 真实执行 exit0', mr.status === 0, (mr.stderr || mr.stdout).slice(0, 200));
const merged = JSON.parse(fs.readFileSync(path.join(B, '.claude/settings.json'), 'utf8'));
const cmds = JSON.stringify(merged.hooks);
ok('settings：guyin 三 hook 更新注册、用户 hook/permissions/model 键保留',
  cmds.includes('guyin-hook.js guard') && cmds.includes('guyin-hook.js session') && cmds.includes('guyin-hook.js post-write')
  && cmds.includes('custom-check.js') && merged.permissions && merged.model === 'sonnet-top' && !cmds.includes('guard-old'), '');

// ---- 7. 回填 model ----
const bp = path.join(B, '.claude/agents/guyin-beat-writer.md');
let bc = fs.readFileSync(bp, 'utf8');
const anchor = '# 有可用低模型时自行加一行：model: <你的低模型 ID>';
if (!bc.includes(anchor)) throw new Error('anchor missing');
bc = bc.replace(anchor, anchor + '\nmodel: deepseek-flash');
fs.writeFileSync(bp, bc, 'utf8');
ok('回填后非注释生效 model: deepseek-flash，且新协议正文生效（无三硬动作）',
  extractModels(bp).join() === 'deepseek-flash' && bc.includes('材料不足：缺什么') && !bc.includes('三硬动作'), '');
ok('checker 仍零生效 model（等同 solo 提示保留）', extractModels(path.join(B, '.claude/agents/guyin-checker.md')).length === 0, '');
const hookNew = fs.readFileSync(path.join(B, '.claude/hooks/guyin-hook.js'), 'utf8');
ok('新 hook D2 发布门真实落位（publicationBlocker/_publication.json）',
  hookNew.includes('publicationBlocker') && hookNew.includes('_publication.json'), '');
ok('来源不明部署件 my-private-tool.md 原样保留（用户选保留）',
  h(path.join(B, '.claude/agents/my-private-tool.md')) === before['.claude/agents/my-private-tool.md'], '');

// ---- 8. 用户内容零改动 ----
let untouched = true; const touched = [];
for (const f of userFiles) { if (h(path.join(B, f)) !== before[f]) { untouched = false; touched.push(f); } }
ok('小说正文/追踪台账/AGENTS/README/作者性/旧13列信号表全部字节不变', untouched, touched.join(','));
const signal = fs.readFileSync(path.join(B, '追踪/读者信号.md'), 'utf8');
ok('旧 13 列读者信号表未被冒充新格式（无验收检查点节，列为待升级）',
  !signal.includes('验收检查点') && signal.includes('想不想看下一章'), '');

// ---- 9. AGENTS.md 不自动追加 ----
ok('AGENTS.md 旧版未被覆盖（建议补丁不由部署器自动写入）',
  fs.readFileSync(path.join(B, 'AGENTS.md'), 'utf8') === '# t11旧书\n\n这是用户自己的路由文件，create-if-absent 不得覆盖。\n', '');

// ---- 10. 新部署标记 ----
W('.guyin-deployed', JSON.stringify({
  deployed_at: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
  guyin_version: '0.14.0', form: 'long+short', book_name: 't11旧书',
  upgraded_from: '0.11.0',
  model_backfills: { '.claude/agents/guyin-beat-writer.md': 'deepseek-flash' },
  backup: '.guyin/upgrade-backup/' + day,
  pending_upgrades: ['追踪/读者信号.md 13列旧表 → 待升级（手动）'],
}, null, 2));
const dep = JSON.parse(fs.readFileSync(path.join(B, '.guyin-deployed'), 'utf8'));
ok('部署标记更新为 0.14.0 且记录回填/备份/待升级清单',
  dep.guyin_version === '0.14.0' && dep.upgraded_from === '0.11.0' && dep.pending_upgrades.length === 1, '');

console.log('\n=== T11 重部署真实运行结果 ===');
for (const [s, n, e] of results) console.log(`${s}  ${n}${e ? '  | ' + e : ''}`);
console.log(`\n项目目录: ${B}`);
console.log(`备份目录: ${bak}`);
process.exit(results.some(r => r[0] === 'FAIL') ? 1 : 0);
