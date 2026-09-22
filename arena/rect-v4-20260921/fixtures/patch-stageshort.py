import io

p = r"tests/run-tests.js"
with io.open(p, "r", encoding="utf-8", newline="") as f:
    lines = f.readlines()

start = next(i for i, l in enumerate(lines)
             if "const proseFiles = fs.readdirSync(path.join(book, '正文'))" in l)
end = next(i for i in range(start, len(lines)) if "return { manifestPath, chash };" in lines[i])
print("range", start + 1, end + 1, "nl=", repr(lines[start][-2:]))

new = '''    // G-1 v2：短篇新发起也走真实 input + gather 证据 + 强基线。
    const candBuf = fs.readFileSync(candPath);
    const candSha = crypto.createHash('sha256').update(candBuf).digest('hex');
    fs.writeFileSync(path.join(ws, 'input.json'), JSON.stringify({
      schema_version: 1, target: { kind: 'short', chapter, title, mode },
      authorization: {
        write: { source_id: 'U1', quote: '写这篇追妻。' },
        selection: { source_id: 'U2', quote: '就发这一版进正文。', candidate_sha256: candSha },
        publish: { source_id: 'U2', quote: '就发这一版进正文。', scope: 'selected-candidate',
          candidate_sha256: candSha, target: { chapter, title, mode } },
      },
      sources: [{ id: 'U1', kind: 'user', text: '写这篇追妻。' },
        { id: 'U2', kind: 'user', text: '就发这一版进正文。' }],
      facts: [], locks: [], allowed_reuse: [], outline: null,
      style: { profile_id: 'relationship-payoff', profile_version: 1,
        selection_basis: 'user-selected', effective_features: ['情绪经动作外显'] },
      wordcount: { min: 1, max: 100000 },
    }), 'utf8');
    const CCShort = path.join(S, 'lib', 'guyin-candidate-context.js');
    const gr = spawnSync('node', [CCShort, '--gather', '--project', book, '--chapter', String(chapter),
      '--unit', String(chapter),
      '--boundary', path.join(ws, 'input.json'), '--transaction', path.join(ws, 'tx.json'),
      '--out', path.join(ws, 'check-evidence.json'), candPath], { encoding: 'utf8', env: cleanEnv });
    const gout = JSON.parse(gr.stdout || '{}');
    if (gout.status !== 'pass') {
      throw new Error('T11 gather not pass: ' + JSON.stringify((gout.checks || [])
        .filter((c) => c.status !== 'pass').map((c) => `${c.name}:${c.status}:${(c.reason || '').slice(0, 80)}`)));
    }
    const hashed = fs.readdirSync(path.join(book, '正文')).filter((n) => !n.startsWith('.') && n.endsWith('.md')).sort()
      .map((n) => ({ path: `正文/${n}`, hash12: h12file(path.join(book, '正文', n)) }));
    const manifest = {
      schema_version: 2, run_id: runId,
      target: { chapter, title, mode },
      candidate: `${wsRel}/candidate.md`,
      destination: dest,
      transaction: `${wsRel}/tx.json`,
      author_input: `${wsRel}/input.json`,
      candidate_checks: `${wsRel}/check-evidence.json`,
      baseline: [
        { path: '追踪/_tracking-state.json', hash12: h12file(path.join(book, '追踪/_tracking-state.json')) },
        { dir: '正文', files: hashed.map((h) => path.basename(h.path)),
          ...(hashed.length ? { files_hashed: hashed } : {}) },
      ],
      expected_state_revision: expected,
      review: { mode: 'solo 全文通读', conclusion: '初读通过', evidence: [`${wsRel}/review.md`] },
      check_evidence: [`${wsRel}/checks.md`],
    };
    const manifestPath = path.join(ws, 'manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify(manifest), 'utf8');
    return { manifestPath, chash };
'''

nl = "\r\n" if lines[start].endswith("\r\n") else "\n"
out = lines[:start] + [new.replace("\n", nl)] + lines[end + 1:]
with io.open(p, "w", encoding="utf-8", newline="") as f:
    f.writelines(out)
print("patched")
