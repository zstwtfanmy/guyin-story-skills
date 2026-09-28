import hashlib
import json
from pathlib import Path
from datetime import datetime, timezone
import sys

sys.stdout.reconfigure(encoding='utf-8')
B = Path('D:/readbook-wpace/guyin-skills/arena/exp-work-quality-20260923-y01/g23-20260924/calibration/c1/C2')
W = Path('D:/readbook-wpace/guyin-skills/arena/exp-work-quality-20260923-y01/g23-20260924/framework/skills')
R = B / '.guyin/work/cal-c1'


def load(p):
    return json.loads(p.read_text(encoding='utf-8'))


def digest(p):
    return hashlib.sha256(p.read_bytes()).hexdigest()


def source(p, role, ranges=None, reason=None):
    raw = p.read_bytes()
    lines = raw.splitlines(keepends=True)
    selected = raw if ranges is None else b''.join(b''.join(lines[a - 1:z]) for a, z in ranges)
    return {'path': str(p), 'role': role, 'sha256': hashlib.sha256(raw).hexdigest(), 'bytes': len(raw), 'loaded_ranges': ranges if ranges else [[1, len(lines)]], 'loaded_bytes': len(selected), 'loaded_sha256': hashlib.sha256(selected).hexdigest(), 'load_representation': '原文件字节范围，不含 Read/Grep 工具附加行号；B 派生视图经 init 命令 stdout 全文读取', 'reason': reason}


input_doc = load(R / 'input.json')
status = load(R / 'logs/11-author-status.stdout.txt')
state = load(B / '追踪/_tracking-state.json')
assert status['phase'] == 'reviewed' and status['status'] == 'resumable'
assert status['review'] and not status['transaction'] and not status['check_evidence']
assert input_doc['authorization']['selection'] is None and input_doc['authorization']['publish'] is None
assert input_doc['target'] == {'kind': 'long', 'chapter': 1, 'title': '锅边', 'mode': 'append'}
profile = (B / 'inputs/profile.txt').read_text(encoding='utf-8').rstrip('\r\n')
assert len(profile) == 537 and input_doc['style']['effective_features'] == [profile]
assert input_doc['wordcount'] == {'min': 1000, 'max': 2400}
assert state['state_revision'] == 0 and state['last_committed_chapter'] == 0
assert list((B / '正文').iterdir()) == []
assert not (B / '追踪/_publication.json').exists()
assert sorted(p.name for p in (B / '.guyin/work').iterdir()) == ['cal-c1']
assert sorted(p.name for p in (R / 'drafts').iterdir()) == ['v0001.md', 'v0002.md']

sources = []
for s in input_doc['sources']:
    if s['kind'] == 'file':
        p = B / s['path']
        assert digest(p) == s['sha256'], s['path']
        sources.append(source(p, '本书实际输入或起笔前派生材料', reason='原始授权/背景、完整 profile、边界与当前起点；所有 input.sources 均核对冻结哈希'))
    else:
        sources.append({'id': s['id'], 'kind': 'user', 'text': s['text'], 'sha256': hashlib.sha256(s['text'].encode('utf-8')).hexdigest(), 'bytes': len(s['text'].encode('utf-8')), 'provenance': 'inputs/generation-protocol.txt 第3行载明的真实授权原话；写作授权，不是用户选稿或发布'})

specs = [
    ('guyin-write/SKILL.md', None, '显式候选入口，全文读取；未调用宿主安装技能'),
    ('guyin-write/references/consult/tracking-transaction.md', None, '运行、input、init、checkpoint、逐章事务、preview 字段；Read 返回全文383行，含非本批适用的其他协议段，仅使用 G2 所需部分；例子不作文学取材'),
    ('guyin-write/scripts/guyin-author-session.py', [[13, 32], [43, 61], [146, 152], [311, 324], [483, 517]], '定向 Grep 核查 import、reviewed 门要求、wordcount、pending；只读实现，未修改'),
    ('guyin-write/scripts/guyin-check-pending.js', [[1, 220]], '确认缺台账/未部署的区别、八列表头及命令参数'),
    ('guyin-write/scripts/guyin-check-wordcount.js', [[1, 230]], '确认正文可见字符口径及显式 min/max，避免误用缺省3000'),
    ('guyin-review/SKILL.md', None, '仅初稿完成后的 review 阶段全文读取'),
    ('guyin-review/references/quality-rubric.md', None, '仅 review 阶段全文读取；形式中立，不给校准结果打 L 等级')
]
for rel, ranges, reason in specs:
    sources.append(source(W / rel, '框架白名单实际文本读取', ranges, reason))

runtime_entries = []
for name in ['guyin-tracking-commit.py', 'guyin-author-session.py', 'guyin-check-pending.js', 'guyin-check-wordcount.js']:
    p = W / 'guyin-write/scripts' / name
    runtime_entries.append({'path': str(p), 'sha256': digest(p), 'bytes': p.stat().st_size, 'use': '真实执行入口；不等于全文语义读取'})

versions = []
start_record = load(R / 'logs/04-start.json')
for version in ['v0001', 'v0002']:
    metrics = load(R / (version + '-metrics.json'))
    p = R / 'drafts' / (version + '.md')
    assert digest(p) == metrics['sha256']
    assert metrics['han_in_range'] and metrics['engineering_in_range']
    assert p.read_text(encoding='utf-8').splitlines()[0] == '# ' + input_doc['target']['title']
    metrics['filesystem_mtime_utc'] = datetime.fromtimestamp(p.stat().st_mtime, timezone.utc).isoformat()
    assert datetime.fromisoformat(metrics['filesystem_mtime_utc']) > datetime.fromisoformat(start_record['ended_at'])
    metrics['full_read_ranges'] = [[1, 103]]
    metrics['selected_for_experiment'] = version == 'v0002'
    versions.append(metrics)
assert versions[1]['sha256'].startswith(status['draft']['sha256'])
assert versions[1]['sha256'] in (R / 'review.md').read_text(encoding='utf-8')

commands = [load(p) for p in sorted((R / 'logs').glob('*.json'))]
assert len(commands) == 14 and all(x['exit_code'] == 0 for x in commands)
for command in commands:
    for key in ['stdout_path', 'stderr_path']:
        p = Path(command[key])
        command[key.replace('_path', '_sha256')] = digest(p)
        command[key.replace('_path', '_bytes')] = p.stat().st_size

recorded_start = load(R / 'clock.json')['first_recorded_at']
ended = datetime.now(timezone.utc).isoformat()
steps = [
    'Read brief', 'parallel wrapper', 'Read profile', 'Read generation protocol', 'Read framework protocol', 'Read W write entry',
    'parallel wrapper', 'TaskCreate', 'Read transaction protocol', 'Bash initial B-only preflight',
    'parallel wrapper', 'TaskUpdate in_progress', 'Glob pending filename', 'Grep author interface', 'Glob wordcount filename',
    'parallel wrapper', 'Read pending lines 1-220', 'Read wordcount lines 1-230', 'Write B run helper',
    'Bash init stage', 'Bash start stage', 'Write v0001', 'Bash register v0001',
    'parallel wrapper', 'Read full v0001', 'Read review entry',
    'parallel wrapper', 'Write first-read reaction', 'Glob quality rubric filename', 'Read quality rubric',
    'Write v0002', 'Edit B helper to register revision', 'Bash register v0002', 'Read full v0002',
    'Write full review', 'Bash reviewed and final status', 'Write finalizer', 'Bash finalize artifacts'
]
assert len(steps) == 38
result = {
    'schema_version': 1, 'task': 'G2原创校准 C1/Y/C2', 'book_root': str(B), 'framework_root': str(W), 'run_id': 'cal-c1', 'title': '锅边',
    'result_path': str(R / 'result.json'), 'phase': status['phase'], 'author_status': status['status'],
    'selected_draft': str(R / 'drafts/v0002.md'), 'selection_meaning': '执行者选择实验展示稿，绝非用户选稿授权',
    'authorization': input_doc['authorization'], 'target': input_doc['target'], 'locks': [],
    'profile': {'id': 'relationship-payoff', 'version': 2, 'selection_basis': 'framework-default', 'effective_features': [profile], 'characters': len(profile), 'utf8_bytes': len(profile.encode('utf-8')), 'sha256': hashlib.sha256(profile.encode('utf-8')).hexdigest(), 'freeze_note': '只移除输入文件末尾行终止符，不改正文537字符'},
    'wordcount_policy': {'han': '移除首行 Markdown 标题，仅数 Unicode Script=Han 码点，Node /\\p{Script=Han}/gu', 'han_min': 1000, 'han_max': 1800, 'body_non_whitespace': '移除首行标题，去 Unicode 空白后的码点数', 'framework': '框架去标题/空白后的 JS length；两稿无代理对差异，与正文非空白数相同；实际另跑 wordcount 原命令', 'engineering_min': 1000, 'engineering_max': 2400},
    'versions': versions, 'substantive_revision_count': 1, 'remaining_revision_budget': 0,
    'revision': {'hypothesis': '解除局部空间含混、对白接续和未铺设温度，保留相处场景和人物偏心', 'locations': [39, '71-73', 97], 'net_benefit': '执行者全文复读判断为正；可更顺畅定位座位、理解接话与包内物件状态，无情节扩充', 'cost': '少掉推椅垫的粗率动作、一处较显眼的玩笑回合和温度时间描写', 'quality_acceptance': None},
    'review': {'path': str(R / 'review.md'), 'sha256': digest(R / 'review.md'), 'bytes': (R / 'review.md').stat().st_size, 'first_read_path': str(R / 'review-first-read.txt'), 'first_read_sha256': digest(R / 'review-first-read.txt'), 'mode': '当前会话全文回看', 'quality_score': None, 'L_level': None},
    'sources': sources, 'runtime_entries': runtime_entries,
    'source_provenance_limits': ['W 哈希在本次归档时按实际文件字节采样；只声称所列段落进入当前会话，执行入口哈希不冒作整文件语义读取', '执行脚本的传递依赖由其正常加载，未独立追踪逐个运行时库，细单为 unknown；未对其文学取材'],
    'host_inherited_context': {'provenance': '系统/宿主自动注入，不可剥离', 'contents': ['宿主技能说明清单', '仓库路径与 git 历史摘要', '用户与项目记忆索引', '通用代理指令与工具说明'], 'sha256': 'unknown', 'bytes': None, 'active_use': False, 'disclosure': '仅披露其存在；未打开记忆文件、历史、报告、sealed、原小说或任何其他实验/对手稿，未将注入的项目观点当成创作素材'},
    'commands': commands, 'phase_evidence': {'init': 'logs/02-init.json', 'start': 'logs/04-start.json', 'drafted_v0001': 'logs/06-checkpoint-drafted.json', 'drafted_v0002': 'logs/07c-checkpoint-revision.json', 'reviewed': 'logs/08-checkpoint-reviewed.json', 'status': 'logs/11-author-status.json', 'draft_and_evidence_separate_checkpoints': True, 'first_draft_after_successful_start': True},
    'publication': {'called': False, 'ledger_exists': False, 'formal_prose_files': [], 'tracking_state_revision': state['state_revision'], 'last_committed_chapter': state['last_committed_chapter'], 'git_commit_called': False},
    'checks_not_run': ['gather 完整候选检查链', 'transaction/preview', 'ready/publish'],
    'blockers': [], 'unresolved': ['独立读者/用户质量验收后置；没有模型自评分或 L 等级', '修稿第7—9行略有为俏皮回应铺垫的痕迹，第99—103行照应稍整齐；作为非阻断审美限制保留', 'reviewed 不等于 ready，完整机器候选检查链未执行；G2 本次不要求'],
    'cost': {'model': 'unknown', 'provider': 'unknown', 'temperature': 'unknown', 'seed': 'unknown', 'model_switches': 0, 'tokens': None, 'tokens_reason': '宿主未提供可信 usage 账本', 'monetary_cost': None, 'subagents': 0, 'created_sessions': 0, 'draft_generations': 1, 'substantive_revisions': 1, 'full_draft_reads': 2, 'failed_commands': 0, 'retries': 0, 'raw_subprocess_commands': len(commands), 'conversation_started_at': None, 'first_recorded_at': recorded_start, 'finished_artifacts_at': ended, 'recorded_elapsed_seconds': (datetime.fromisoformat(ended) - datetime.fromisoformat(recorded_start)).total_seconds(), 'full_elapsed_seconds': None, 'time_note': '首次自动计时晚于只读输入与目录检查，整会话起点未精确记录，不捏造总耗时', 'tool_call_limit': 45, 'tool_calls_through_result_creation_including_wrappers': 38, 'tool_calls_including_wrappers': None, 'tool_calls_finalization_note': '最后任务状态更新后登记实际最终调用数；保守口径每个 parallel 包装调用也计一次', 'tool_events': [{'n': n + 1, 'event': event} for n, event in enumerate(steps)]},
    'limitations': ['未部署 hooks，未安装；手动 pending/未完成 run/无 publication 检查有实际结果', '没有修改任何 W 脚本、配置、权限、manifest 或正式树；Python 禁用写字节码', '初次只读 Bash 目录检查退出0，但当时控制台中文乱码，未把乱码误作状态失败；后续全程 UTF-8 并在本书记录 stdout/stderr', '首个 ls/存在性检查只保留宿主工具记录，后续 preflight.json 及14条命令输出有本地原始记录', '没有外部来源相似度检索或原创性鉴证；为当前会话独立原创，无已知作品取材'],
    'artifact_hashes': [{'path': str(p.relative_to(B)), 'sha256': digest(p), 'bytes': p.stat().st_size} for p in [R / 'input.json', R / 'init.json', R / 'author-session.json', R / 'preflight.json', R / 'run-calibration.py', R / 'finalize.py']]
}
with (R / 'result.json').open('x', encoding='utf-8', newline='\n') as f:
    json.dump(result, f, ensure_ascii=False, indent=2)
    f.write('\n')
assert load(R / 'result.json')['phase'] == 'reviewed'
print(json.dumps({'result': str(R / 'result.json'), 'phase': status['phase'], 'versions': [{'path': v['path'], 'han': v['han'], 'body_non_whitespace': v['body_non_whitespace'], 'sha256': v['sha256']} for v in versions], 'recorded_commands': len(commands), 'recorded_exit_codes': [x['exit_code'] for x in commands], 'blockers': []}, ensure_ascii=False, indent=2))
