import io, re

p = r"tests/run-tests.js"
with io.open(p, "r", encoding="utf-8") as f:
    src = f.read()

start_marker = "  // 组装一次发布的全部隔离输入"
end_marker = "    return { manifestPath, chash, txPath };\n  };"
s = src.index(start_marker)
e = src.index(end_marker, s) + len(end_marker)

new_block = '''  // 组装一次发布的全部隔离输入（工作区 .guyin/work/{runId}/），返回 manifest 路径与候选 hash。
  // v4 G-1/B-5：新发起一律 v2——写 input、先 preview 真实重跑检查链生成 R/check-evidence.json。
  const proseHashEntries = (book) => fs.readdirSync(path.join(book, '正文'))
    .filter((n) => !n.startsWith('.') && n.endsWith('.md'))
    .sort()
    .map((n) => ({ path: `正文/${n}`, hash12: h12file(path.join(book, '正文', n)) }));
  const stagePublish = (book, runId, candidate, opts = {}) => {
    const wsRel = `.guyin/work/${runId}`;
    const ws = path.join(book, wsRel);
    fs.mkdirSync(ws, { recursive: true });
    const candPath = path.join(ws, 'candidate.md');
    fs.writeFileSync(candPath, candidate, 'utf8');
    const chash = h12file(candPath);
    fs.writeFileSync(path.join(ws, 'review.md'), `# 审读记录\\n候选 hash12=${chash}\\n模式：solo 全章通读。\\n`, 'utf8');
    fs.writeFileSync(path.join(ws, 'checks.md'), `# 检查证据\\n候选 hash12=${chash}\\n五测试全绿。\\n`, 'utf8');
    const mode = opts.mode || 'append';
    const expected = opts.expected !== undefined ? opts.expected : 0;
    const result = opts.result || '老周在票房核勘合，烛火被风压矮，他把六张凭据逐张按平。';
    const txPath = path.join(ws, 'tx.json');
    fs.writeFileSync(txPath, mkTx(mode, 1, expected, result), 'utf8');
    const inputPath = path.join(ws, 'input.json');
    fs.writeFileSync(inputPath, JSON.stringify({
      schema_version: 1,
      target: { kind: 'long', chapter: 1, title: '开篇', mode },
      authorization: {
        write: { source_id: 'U1', quote: '请试写第一章，不发布。' },
        selection: null,
        publish: { source_id: 'U1', quote: '授权发布第一章。',
          scope: 'authorized-target', candidate_sha256: null,
          target: { chapter: 1, title: '开篇', mode } },
      },
      sources: [{ id: 'U1', kind: 'user',
        text: '请试写第一章，不发布。\\n\\n授权发布第一章。' }],
      facts: [], locks: [], allowed_reuse: [], outline: null,
      style: { profile_id: 'relationship-payoff', profile_version: 1,
        selection_basis: 'framework-default', effective_features: ['能力经行动兑现'] },
      wordcount: { min: 1, max: 100000 },
    }, null, 2), 'utf8');
    const checksRel = `${wsRel}/check-evidence.json`;
    const hashed = proseHashEntries(book);
    const manifest = {
      schema_version: 2, run_id: runId,
      target: { chapter: 1, title: '开篇', mode },
      candidate: `${wsRel}/candidate.md`,
      destination: opts.destination || '正文/第001章_开篇.md',
      transaction: `${wsRel}/tx.json`,
      author_input: `${wsRel}/input.json`,
      candidate_checks: checksRel,
      baseline: [
        { path: '追踪/_tracking-state.json', hash12: h12file(path.join(book, '追踪', '_tracking-state.json')) },
        { dir: '正文', files: hashed.map((h) => h.path),
          ...(hashed.length ? { files_hashed: hashed } : {}) },
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
    // B-5：首次 preview 真实重跑检查链并把证据原子生成到 R（不写正式正文/追踪/账本）。
    if (!opts.skipPreview) {
      const pv = runPy(['preview', '--input', manifestPath], book);
      if (pv.status !== 0 || !fs.existsSync(path.join(book, checksRel))) {
        throw new Error(`stagePublish preview 未通过：${(pv.stderr || pv.stdout || '').trim().slice(0, 400)}`);
      }
    }
    return { manifestPath, chash, txPath };
  };'''

nl = "\r\n" if "\r\n" in src[:4000] else "\n"
out = src[:s] + new_block.replace("\n", nl) + src[e:]
with io.open(p, "w", encoding="utf-8", newline="") as f:
    f.write(out)
print("patched stagePublish", s, e)
