import sys, json, hashlib, datetime
from pathlib import Path

R = Path(__file__).resolve().parent
B = R.parents[2]
W = Path('D:/readbook-wpace/guyin-skills/arena/exp-work-quality-20260923-y01/g23-20260924/framework/skills')

def load(p):
    return json.loads(Path(p).read_text(encoding='utf-8'))

def meta(p, scope, role):
    p = Path(p)
    data = p.read_bytes()
    return {'path': str(p), 'sha256': hashlib.sha256(data).hexdigest(), 'bytes': len(data), 'loaded_sections': scope, 'role': role}

def write_result(value, mode):
    with (R / 'result.json').open(mode, encoding='utf-8', newline='\n') as f:
        json.dump(value, f, ensure_ascii=False, indent=2)
        f.write('\n')

now = datetime.datetime.now(datetime.timezone.utc)
if len(sys.argv) > 1 and sys.argv[1] == 'accounting':
    result = load(R / 'result.json')
    result['cost']['tool_calls'] = {'leaf_calls': 34, 'parallel_dispatch_calls': 5, 'conservative_total': 39, 'scope': '截至本次最终记账Bash调用本身；包括所有Read/Grep/Glob/Write/Bash/Task调用及5个parallel包装调用，不含工具内部9个子进程重复计数。', 'limit': 45, 'basis': '当前可见会话逐条计数；初次result生成后新增TaskGet、TaskUpdate、TaskList、本次Bash，共4个叶子调用。'}
    result['cost']['ended_at'] = now.isoformat()
    result['cost']['seconds_since_first_clock_observation'] = (now - datetime.datetime.fromisoformat(result['cost']['first_clock_observation'])).total_seconds()
    write_result(result, 'w')
    print(json.dumps({'result': str(R / 'result.json'), 'phase': result['phase'], 'han': result['versions'][0]['han'], 'non_whitespace': result['versions'][0]['non_whitespace'], 'sha256': result['versions'][0]['sha256'], 'tool_calls': 39}, ensure_ascii=False))
    raise SystemExit(0)

inp = load(R / 'input.json')
status = load(R / 'evidence/09-status.stdout.txt')
metrics = load(R / 'evidence/04-v0001-metrics.stdout.txt')
wordcount = load(R / 'evidence/05-v0001-wordcount.stdout.txt')
assert status['phase'] == 'reviewed' and status['reasons'] == []
assert inp['authorization']['selection'] is None and inp['authorization']['publish'] is None
profile = (B / 'inputs/profile.txt').read_text(encoding='utf-8').rstrip('\r\n')
assert len(profile) == 537 and inp['style']['effective_features'] == [profile]
assert inp['wordcount'] == {'min': 1000, 'max': 2400}
assert inp['target'] == {'kind': 'long', 'chapter': 1, 'title': '面要趁热', 'mode': 'append'}
assert inp['locks'] == []
assert hashlib.sha256((R / 'drafts/v0001.md').read_bytes()).hexdigest() == metrics['sha256']
assert len(list((R / 'drafts').glob('v*.md'))) == 1
assert not list((B / '正文').iterdir()) and not (B / '追踪/_publication.json').exists()
assert 1000 <= metrics['han'] <= 1800
for source in inp['sources']:
    if source['kind'] == 'file':
        assert hashlib.sha256((B / source['path']).read_bytes()).hexdigest() == source['sha256']
commands = []
for p in sorted((R / 'evidence').glob('*.command.json')):
    item = load(p)
    assert item['exit_code'] == 0
    for stream in ['stdout', 'stderr']:
        assert hashlib.sha256(Path(item[stream]['path']).read_bytes()).hexdigest() == item[stream]['sha256']
    commands.append({'record': str(p.relative_to(R)), 'exit_code': item['exit_code'], 'elapsed_seconds': item['elapsed_seconds']})

sources = []
for name, lines in [('brief.txt', '1–12'), ('profile.txt', '1–2；正文537字符，不计行尾'), ('generation-protocol.txt', '1–19'), ('framework-protocol.txt', '1–22')]:
    sources.append(meta(B / 'inputs' / name, 'Read全文：' + lines, '派发输入'))
for path, scope in [
    ('guyin-write/SKILL.md', 'Read全文1–92'),
    ('guyin-write/references/consult/tracking-transaction.md', 'Read全文1–368；工具实际还返回370–383（续写状态卡）。所需段落：运行17–44、run/input/checkpoint46–123、preview125–164、init166–196、逐章事务230–328。'),
    ('guyin-review/SKILL.md', 'review阶段Read全文1–77'),
    ('guyin-review/references/quality-rubric.md', 'review阶段Read全文1–58')]:
    sources.append(meta(W / path, scope, '显式候选规范；未Invoke安装版Skill'))
for path, lines in [('追踪/上下文.md', '1–32'), ('追踪/角色状态/赵禾.md', '1–26'), ('追踪/角色状态/苏笛.md', '1–24'), ('追踪/角色状态/莫圆.md', '1–23')]:
    sources.append(meta(B / path, '起笔前Read全文' + lines, 'init真实派生视图'))
for source in inp['sources']:
    if source['kind'] == 'file' and source['path'] not in ['inputs/brief.txt', 'inputs/profile.txt', 'inputs/generation-protocol.txt', 'inputs/framework-protocol.txt', '追踪/上下文.md', '追踪/角色状态/赵禾.md', '追踪/角色状态/苏笛.md', '追踪/角色状态/莫圆.md']:
        sources.append(meta(B / source['path'], '生成/冻结及脚本校验全文件；不是额外Read全文', '本run来源与基线'))
for path, scope in [
    ('guyin-author-session.py', '定向Grep返回43–61、483–517、1026–1046；执行start/checkpoint/status入口，未语义通读全文件'),
    ('guyin-check-pending.js', '两次定向Grep；接口说明/台账缺失与CLI片段（含26–30、232–244），第一次输出被截断且未读宿主落盘副本；执行pending'),
    ('guyin-check-wordcount.js', '两次定向Grep；可见字符口径及CLI参数片段（含11–16、32–43、67–96、132–135），非全文；执行wordcount'),
    ('guyin-tracking-commit.py', '仅运行init/check；未作为文学材料读取源代码')]:
    sources.append(meta(W / 'guyin-write/scripts' / path, scope, '接口核查/真实执行'))
sources.append(meta(R / 'drafts/v0001.md', '初稿保存并计量后，Read全文1–98；仅本会话自稿', '全文自由审读对象'))
sources.append(meta(R / 'review.md', '当前会话生成全文；checkpoint读取核hash12', '审读证据'))

start_command = load(R / 'evidence/03-start.command.json')
draft_stat = (R / 'drafts/v0001.md').stat()
assert datetime.datetime.fromtimestamp(draft_stat.st_mtime, datetime.timezone.utc) > datetime.datetime.fromisoformat(start_command['ended_at'])
state = load(B / '追踪/_tracking-state.json')
result = {
    'schema_version': 1, 'run': 'cal-c3', 'book_root': str(B), 'framework_root': str(W),
    'target': inp['target'], 'phase': status['phase'], 'author_status': status['status'],
    'result_scope': 'G2独立原创短场景；真实init/start/drafted/全文review/reviewed已完成；不要求ready，未发布。',
    'versions': [metrics], 'selected_draft': str(R / 'drafts/v0001.md'),
    'selection_meaning': '执行者选择用于实验展示，不是用户选稿或质量验收。',
    'revision': {'substantive_revisions': 0, 'v0002': None, 'net_benefit': '未证明修订净收益，保留初稿。', 'tradeoff': '保留离场动作/钱款指代略急，以及返听中听见肚响的夸张；不以补解释和磨平俏皮换取表面齐整。'},
    'review': meta(R / 'review.md', '当前会话阅读全文后自写', '证据'),
    'authorization': inp['authorization'], 'locks': [],
    'profile': {'id': 'relationship-payoff', 'version': 2, 'selection_basis': 'framework-default', 'frozen_characters': 537, 'exact_match_to_input_file': True, 'input': meta(R / 'input.json', '全文被冻结并经start校验', '边界')},
    'measurement': {'han_rule': '移除首行Markdown标题，只数正文Unicode Script=Han码点；Node原生Unicode属性正则。', 'han_interval': [1000, 1800], 'non_whitespace_rule': '移除首行标题，按Unicode码点排除空白。', 'engineering_threshold': [1000, 2400], 'framework_wordcount': {'exit_code': 0, 'findings': wordcount['findings'], 'files_scanned': wordcount['files_scanned'], 'reported_visible_count': None, 'note': 'CLI的JSON仅返回findings及扫描路径，不返回数值；不将独立1464计数冒充CLI数值。', 'raw_stdout': 'evidence/05-v0001-wordcount.stdout.txt'}},
    'lifecycle': {'preflight': 'evidence/preflight.json', 'init_state_revision': 0, 'start_completed_at': start_command['ended_at'], 'draft_file_mtime': datetime.datetime.fromtimestamp(draft_stat.st_mtime, datetime.timezone.utc).isoformat(), 'start_succeeded_before_prose': True, 'draft_checkpoint': 'evidence/06-drafted.command.json', 'review_checkpoint': 'evidence/07-reviewed.command.json', 'separate_checkpoints': True, 'final_status': 'evidence/09-status.stdout.txt', 'formal_prose_files': [], 'publication_journal': None, 'candidate_context': 'not_run; G2不要求ready', 'transaction': None, 'preview': None},
    'sources': sources,
    'source_limits': {'source_hash_time': 'result生成时核完整SHA；input文件来源另由start冻结并经最终status复核未漂移。', 'runtime_transitive_imports': 'unknown：未对Python/Node传递依赖作加载插桩；这里只列显式查读文件与真实执行入口，不声称枚举所有运行时依赖。', 'host_automatic_context': 'unknown：宿主自动注入内容的完整路径/hash/字节数无法核实；未主动读取或写入长期记忆，未使用其他实验/旧稿材料。', 'additional_consult': [], 'network_access': False, 'delegation': False},
    'commands': commands,
    'raw_evidence': 'evidence/*.command.json保存实际argv、cwd、起止UTC、耗时、原始stdout/stderr路径及SHA/字节数和退出码；stdout/stderr按子进程原始字节保存，无覆盖。初次ls/os.walk只在宿主工具记录有原始输出，preflight.json明确是转录。',
    'cost': {'session_started_at': None, 'first_clock_observation': '2026-09-24T07:37:44.460553+00:00', 'ended_at': now.isoformat(), 'seconds_since_first_clock_observation': (now - datetime.datetime.fromisoformat('2026-09-24T07:37:44.460553+00:00')).total_seconds(), 'clock_note': '四份输入及两份规范开始读取时未采钟，真实会话起点和阅读耗时无法追溯，不能把首次采钟冒充会话起点。', 'tool_calls': {'leaf_calls': 30, 'parallel_dispatch_calls': 5, 'conservative_total': 35, 'scope': '截至首次result生成Bash，包括正在执行的该次调用；随后管理调用在最终记账补齐。', 'limit': 45}, 'command_count': len(commands), 'command_seconds': sum(c['elapsed_seconds'] for c in commands), 'failed_commands': 0, 'failed_tool_calls': 0, 'execution_retries': 0, 'search_refinements': 1, 'search_note': '第一次接口Grep输出截断，缩小模式补查一次；未读取持久化截断输出。', 'time_limit_minutes': 45, 'tokens': None},
    'model': {'selection': '当前默认模型，未切换', 'model_id': 'unknown', 'provider': 'unknown', 'temperature': 'unknown', 'seed': 'unknown', 'other_parameters': 'unknown'},
    'unresolved': [{'kind': 'editorial', 'location': 'drafts/v0001.md:81–85', 'issue': '离场动作和钱款指代局部含混，未修。', 'blocks_reviewed': False}, {'kind': 'editorial', 'location': 'drafts/v0001.md:69', 'issue': '返听中听见肚响的夸张和叙述重心损失，未修。', 'blocks_reviewed': False}, {'kind': 'user_quality_acceptance', 'issue': '统一后置；未获真实用户反馈，不产生文学质量评级。', 'blocks_reviewed': False}],
    'blockers': [], 'ready_claimed': False, 'published': False, 'deployment': False, 'git_used': False,
    'executor_controls': '本派发的chapter=1、标题、目录、计量和操作记录由执行者落实；不冒作用户原话。用户source只采用generation-protocol.txt第3行原话。'
}
write_result(result, 'x')
print(json.dumps({'result': str(R / 'result.json'), 'phase': status['phase'], 'han': metrics['han'], 'non_whitespace': metrics['non_whitespace'], 'sha256': metrics['sha256'], 'commands': len(commands), 'checks': 'source hashes, candidate hash, raw-output hashes, exact profile, chronology, empty formal prose all verified'}, ensure_ascii=False))
