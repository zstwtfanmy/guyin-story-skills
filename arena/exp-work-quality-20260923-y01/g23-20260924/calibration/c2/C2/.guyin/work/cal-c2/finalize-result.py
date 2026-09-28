from pathlib import Path
from datetime import datetime, timezone
import hashlib
import json

B = Path('D:/readbook-wpace/guyin-skills/arena/exp-work-quality-20260923-y01/g23-20260924/calibration/c2/C2')
W = Path('D:/readbook-wpace/guyin-skills/arena/exp-work-quality-20260923-y01/g23-20260924/framework/skills')
R = B / '.guyin/work/cal-c2'


def load(path):
    return json.loads(path.read_text(encoding='utf-8'))


def info(path):
    data = path.read_bytes()
    return {'path': path.as_posix(), 'sha256': hashlib.sha256(data).hexdigest(), 'bytes': len(data)}


status = load(R / 'execution/13-status.stdout.txt')
assert status['phase'] == 'reviewed' and status['reasons'] == []
boundary = load(R / 'input.json')
assert boundary['authorization']['selection'] is None
assert boundary['authorization']['publish'] is None
assert boundary['locks'] == []
assert boundary['wordcount'] == {'min': 1000, 'max': 2400}
assert ''.join(boundary['style']['effective_features']) == (B / 'inputs/profile.txt').read_text(encoding='utf-8').strip()
assert len(''.join(boundary['style']['effective_features'])) == 537
assert not (B / '追踪/_publication.json').exists()
assert not list((B / '正文').iterdir())
for source in boundary['sources']:
    if source['kind'] == 'file':
        assert info(B / source['path'])['sha256'] == source['sha256']

specs = [
    (B / 'inputs/brief.txt', None, '开场已知背景与任务'),
    (B / 'inputs/profile.txt', None, '唯一完整文风'),
    (B / 'inputs/generation-protocol.txt', None, '授权原话、预算和计量'),
    (B / 'inputs/framework-protocol.txt', None, 'G2执行控制'),
    (W / 'guyin-write/SKILL.md', None, '显式候选入口'),
    (W / 'guyin-write/references/consult/tracking-transaction.md', None, '运行/input/init/checkpoint/逐章事务/preview；实际全文加载'),
    (W / 'guyin-write/scripts/guyin-check-pending.js', 100, '仅接口区'),
    (W / 'guyin-write/scripts/guyin-check-wordcount.js', 95, '仅接口区；此前Grep展示了该文件相关预览，完整缓存未读'),
    (B / '追踪/上下文.md', None, '开篇派生上下文'),
    (B / '追踪/角色状态/梁序.md', None, '完整起始角色快照'),
    (B / '追踪/角色状态/钱瑛.md', None, '完整起始角色快照'),
    (B / '追踪/_tracking-state.json', None, '初始化权威状态'),
    (R / 'drafts/v0001.md', None, '初稿完整自由审读'),
    (W / 'guyin-review/SKILL.md', None, '仅审读阶段加载'),
    (W / 'guyin-review/references/quality-rubric.md', None, '通用审读依据'),
    (R / 'drafts/v0002.md', None, '修稿完整复读'),
]
loads = []
for path, limit, reason in specs:
    item = info(path)
    lines = path.read_bytes().splitlines(keepends=True)
    stop = len(lines) if limit is None else limit
    region = b''.join(lines[:stop])
    item.update({'access': 'model-content-read', 'lines': f'1-{stop}', 'full_file_read': limit is None, 'loaded_region_bytes': len(region), 'loaded_region_sha256': hashlib.sha256(region).hexdigest(), 'reason': reason})
    loads.append(item)

versions = []
for ver, metric, wc in [('v0001', '06-v0001-metrics', '07-v0001-wordcount'), ('v0002', '09-v0002-metrics', '10-v0002-wordcount')]:
    data = load(R / f'execution/{metric}.stdout.txt')
    report = load(R / f'execution/{wc}.stdout.txt')
    assert info(R / f'drafts/{ver}.md')['sha256'] == data['sha256']
    data.update({'version': ver, 'han_range_pass': 1000 <= data['body_han'] <= 1800, 'framework_wordcount': {'min': 1000, 'max': 2400, 'exit_code': load(R / f'execution/{wc}.json')['exit_code'], 'findings': report['findings'], 'files_scanned': len(report['files_scanned']), 'reported_numeric_count': None, 'note': '框架JSON不返回数值count；正文非空白计量独立列出，不冒充脚本数值输出。', 'raw_output': f'execution/{wc}.stdout.txt'}})
    versions.append(data)

commands = []
for path in sorted((R / 'execution').glob('[0-9][0-9]-*.json')):
    item = load(path)
    commands.append({'name': item['name'], 'exit_code': item['exit_code'], 'record': path.relative_to(R).as_posix(), 'stdout': item['stdout_path'], 'stderr': item['stderr_path']})

now = datetime.now(timezone.utc)
result = {
    'schema_version': 1,
    'run': 'cal-c2',
    'book_root': B.as_posix(),
    'framework_root': W.as_posix(),
    'target': boundary['target'],
    'phase': status['phase'],
    'phase_evidence': 'execution/13-status.stdout.txt',
    'versions': versions,
    'selected_draft': (R / 'drafts/v0002.md').as_posix(),
    'selection_role': '执行者选择用于实验展示，不是用户选稿授权。',
    'authorization': boundary['authorization'],
    'revision': {'substantive_rounds': 1, 'net_benefit': '四处动作/时间表达更连贯，去掉配角认证解释；保留争执、私心与未决周末分工。', 'loss': '少了遥控器小笑点及堵住一词的压缩感。', 'evidence': ['review-v0001.md', 'review.md', 'revision.diff']},
    'model': {'selection': 'current-default-unchanged', 'model_id': 'unknown', 'provider': 'unknown', 'temperature': 'unknown', 'seed': 'unknown', 'tokens': None},
    'loaded_sources': loads,
    'hash_timing_note': '清单哈希在收尾时按原始字节计算；B内起笔来源逐一比对input冻结哈希无漂移。W读取瞬间未另留哈希快照，不虚称有实时访问追踪。',
    'own_generated_operational_artifacts': [info(R / name) for name in ['init.json', 'input.json', 'checkpoint-drafted.json', 'checkpoint-v0002-drafted.json', 'checkpoint-reviewed.json', 'review-v0001.md', 'review.md', 'revision.diff', 'author-session.json', 'finalize-result.py']] + [info(B / name) for name in ['大纲/批次公约.md', '设定/题材定位.md', '追踪/待审台账.md']],
    'executed_framework_entrypoints': [dict(info(W / 'guyin-write/scripts' / name), access='runtime-execution-not-full-model-read') for name in ['guyin-tracking-commit.py', 'guyin-author-session.py', 'guyin-check-pending.js', 'guyin-check-wordcount.js']],
    'automatic_host_context': {'path': 'unknown', 'sha256': 'unknown', 'bytes': None, 'note': '宿主自动注入无法独立核实；未主动读取或写入长期记忆，未主动加载其他实验/原书/旧稿/安装版技能。'},
    'runtime_transitive_dependencies': {'manifest': None, 'note': '未做运行时模块跟踪，不虚称掌握隐式依赖逐文件加载清单。'},
    'execution_records': commands,
    'shell_failure': {'tool_call_including_wrappers': 39, 'exit_code': 2, 'stdout': '', 'stderr': "/usr/bin/bash: -c: line 45: unexpected EOF while looking for matching `''\n", 'capture': '从宿主返回错误逐字转录；没有伪造原始stderr文件。', 'resolution': '拆分过长汇总调用：登记/终验命令单独执行，结果汇总另存本run脚本执行；未重试原命令，未重写正文。'},
    'timing': {'session_started_at': None, 'first_observed_at': '2026-09-24T07:38:16.317066+00:00', 'recorded_at': now.isoformat(), 'observed_elapsed_seconds': (now - datetime.fromisoformat('2026-09-24T07:38:16.317066+00:00')).total_seconds(), 'note': '初始输入读取早于首次时钟观测，完整端到端耗时不能精确恢复；起笔文件时间晚于start成功。'},
    'tool_cost': {'calls_observed_through_result_write': 42, 'includes_parallel_wrappers': True, 'parallel_wrappers': 4, 'total_at_finalization': None, 'framework_and_measurement_processes': 15, 'nonzero_framework_processes': 0, 'failed_bash_tool_calls': 1, 'same_command_retries': 0, 'split_recovery_attempts': 1, 'minor_tool_issue': '一次Grep输出过长，只展示预览；转为定向Read两个接口区，未打开缓存。', 'preflight_raw_capture': '最初目录/解释器探测、目录创建原始输出仅在宿主工具记录；execution/preflight.json保留观测，未伪造原始文件。'},
    'budgets': {'max_tool_calls': 45, 'max_minutes': 45, 'substantive_revision_max': 1},
    'unresolved': {'blocking_findings': [], 'quality_acceptance': '等待后续独立评读/用户验收，未给质量分数或L等级。', 'ready_requirements': 'G2止于reviewed；transaction、preview与完整候选检查链未执行，不声称ready。', 'story_choice': '若下周找不到代班如何处置，有意未解决；非工程阻断。'},
    'boundaries': {'delegated': False, 'network': False, 'git': False, 'published': False, 'installed_or_deployed': False, 'changed_W': False, 'changed_profile_or_threshold': False, 'selection_null': True, 'publish_null': True, 'official_prose_empty': True, 'publication_absent': True, 'state_revision': 0, 'last_committed_chapter': 0},
}
with (R / 'result.json').open('x', encoding='utf-8', newline='\n') as stream:
    json.dump(result, stream, ensure_ascii=False, indent=2)
print(json.dumps({'result': (R / 'result.json').as_posix(), 'phase': result['phase'], 'versions': [{key: item[key] for key in ['version', 'sha256', 'body_han', 'body_non_whitespace']} for item in versions]}, ensure_ascii=False, indent=2))
