import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
from datetime import datetime, timezone

B = Path('D:/readbook-wpace/guyin-skills/arena/exp-work-quality-20260923-y01/g23-20260924/calibration/c1/C2')
W = Path('D:/readbook-wpace/guyin-skills/arena/exp-work-quality-20260923-y01/g23-20260924/framework/skills')
R = B / '.guyin/work/cal-c1'
S = W / 'guyin-write/scripts'
os.environ['PYTHONDONTWRITEBYTECODE'] = '1'
os.environ['PYTHONIOENCODING'] = 'utf-8'
sys.stdout.reconfigure(encoding='utf-8')


def now():
    return datetime.now(timezone.utc).isoformat()


def save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    text = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False, indent=2) + '\n'
    with path.open('x', encoding='utf-8', newline='\n') as f:
        f.write(text)


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def run(label, command):
    started = now()
    proc = subprocess.run(command, cwd=B, capture_output=True, env=os.environ)
    (R / 'logs').mkdir(exist_ok=True)
    with (R / 'logs' / (label + '.stdout.txt')).open('xb') as f:
        f.write(proc.stdout)
    with (R / 'logs' / (label + '.stderr.txt')).open('xb') as f:
        f.write(proc.stderr)
    record = {'label': label, 'command': command, 'cwd': str(B), 'started_at': started, 'ended_at': now(), 'exit_code': proc.returncode, 'stdout_path': str(R / 'logs' / (label + '.stdout.txt')), 'stderr_path': str(R / 'logs' / (label + '.stderr.txt'))}
    save(R / 'logs' / (label + '.json'), record)
    print(json.dumps(record, ensure_ascii=False))
    print(proc.stdout.decode('utf-8', errors='replace'))
    print(proc.stderr.decode('utf-8', errors='replace'))
    if proc.returncode:
        raise SystemExit(proc.returncode)
    return proc.stdout.decode('utf-8')


stage = sys.argv[1]
if stage == 'init':
    save(R / 'clock.json', {'first_recorded_at': now(), 'conversation_start_at': None, 'conversation_start_note': '首次工具前时刻不可核实；此时间早于 init/start，晚于输入读取与首次只读目录检查。'})
    known = ['追踪/_publication.json', '追踪/_tracking-state.json', '追踪/待审台账.md', '追踪/检查点.md']
    preflight = {'checked_at': now(), 'files': {x: (B / x).exists() for x in known}, 'other_runs': [p.name for p in (B / '.guyin/work').iterdir() if p.name != 'cal-c1'], 'this_run_preexisting_session': (R / 'author-session.json').exists(), 'hooks': 'not deployed; no installation authorized'}
    save(R / 'preflight.json', preflight)
    if any(preflight['files'].values()) or preflight['other_runs'] or preflight['this_run_preexisting_session']:
        raise SystemExit('Unexpected prior state; stop without replacement')
    run('01-pending-before-init', ['node', str(S / 'guyin-check-pending.js'), '--json', '--project', str(B), str(B / '追踪/待审台账.md')])
    profile = (B / 'inputs/profile.txt').read_text(encoding='utf-8').rstrip('\r\n')
    assert len(profile) == 537, len(profile)
    save(B / '大纲/批次公约.md', '# 批次公约\n\n- chapter=1；第1章；标题：锅边。\n- POV：第三人称有限视角；全段只进入程洁的内心。\n- 独立原创完整短场景，无前文；正文汉字 1000–1800；工程可见字符 1000–2400。\n- 起点来自 inputs/brief.txt，后续选择由作者决定；没有额外剧情锁。\n')
    save(B / '设定/题材定位.md', '# 题材定位\n\nY：相处；当代日常独立短场景。\n\n## 叙事风格\n\nprofile_id=relationship-payoff；profile_version=2；selection_basis=framework-default。\n\n' + profile + '\n')
    (B / '正文').mkdir(exist_ok=False)
    (R / 'drafts').mkdir(exist_ok=False)
    init = {'schema_version': 1, 'book_title': '锅边', 'last_chapter': 0, 'context': {'position': {'volume': '独立场景', 'volume_start_chapter': 1, 'story_time': '程洁搬走后的第一个星期六傍晚，来交还备用钥匙，敲门时', 'scene': '原合租房门外；杜青刚洗完头，厨房有饭香'}, 'long_term_constraints': ['第三人称有限视角，全段只进入程洁的内心'], 'active_character_names': ['程洁', '杜青'], 'continuity_risks': ['不能把程洁搬家写成与杜青闹翻；两人并非互诉所有事的挚友，也没有等待揭露的秘密'], 'recent_chapters': [], 'next_chapter_commitments': []}, 'character_snapshots': {'程洁': {'identity': '三十五岁，在家做书籍排版', 'location': '搬离原合租房后的第一个星期六傍晚，来到原房门外', 'goal': '交还备用钥匙，原以为说两句话就走；租小单间是为了一个人住', 'state': '刚搬到步行十分钟外的小单间，有自己的灶，桌子未送到，这些天在窗台吃饭', 'abilities_resources': ['从事书籍排版', '喜欢买大开本画册，为这些书付的搬家运费比买一张桌子贵', '仍持原房备用钥匙，尚未交还'], 'relationships': ['与杜青合住三年，未闹翻，会互尝新买的东西，各有不让对方碰的生活习惯', '两人不是互诉所有事的挚友，没有等待揭露的秘密'], 'knowledge': ['杜青习惯一次煮两人份的饭', '自己过去总嫌米饭偏硬，却会盛走锅边的一层'], 'open_threads': ['备用钥匙待交还', '新单间桌子尚未送到']}, '杜青': {'identity': '四十一岁，仍住原来的合租房', 'location': '原合租房内', 'goal': '未提供当下意图；不预填邀请吃饭或其他未来选择', 'state': '程洁敲门时刚洗完头，厨房里有饭香', 'abilities_resources': ['习惯一次煮两人份的饭'], 'relationships': ['与程洁合住三年，程洁搬走并非闹翻，会互尝新买的东西，各有不让对方碰的生活习惯', '两人不是互诉所有事的挚友，没有等待揭露的秘密'], 'knowledge': [], 'open_threads': []}}, 'foreshadow': [], 'timeline_events': [], 'verdicts': [], 'scenes': []}
    save(R / 'init.json', init)
    run('02-init', ['python', '-B', str(S / 'guyin-tracking-commit.py'), 'init', '--project', str(B), '--input', str(R / 'init.json')])
    save(B / '追踪/待审台账.md', '# 待审台账\n\n| 章号 | 来源 | 报警/发现 | 处置类别 | 正文版本 | 终态 | 决定依据 | 去向/备注 |\n| --- | --- | --- | --- | --- | --- | --- | --- |\n')
    run('03-pending-after-init', ['node', str(S / 'guyin-check-pending.js'), '--json', '--project', str(B), str(B / '追踪/待审台账.md')])
    for rel in ['追踪/_tracking-state.json', '追踪/上下文.md', '追踪/角色状态/程洁.md', '追踪/角色状态/杜青.md']:
        p = B / rel
        print('\nSOURCE ' + rel + ' SHA256=' + sha(p))
        print(p.read_text(encoding='utf-8'))

elif stage == 'start':
    profile = (B / 'inputs/profile.txt').read_text(encoding='utf-8').rstrip('\r\n')
    assert len(profile) == 537
    quote = '指定封存包不满足同路线双原创题条件，那你先帮我处理这个然后再进行G2/G3'
    assert quote in (B / 'inputs/generation-protocol.txt').read_text(encoding='utf-8')
    paths = ['inputs/brief.txt', 'inputs/profile.txt', 'inputs/generation-protocol.txt', 'inputs/framework-protocol.txt', '大纲/批次公约.md', '设定/题材定位.md', '追踪/_tracking-state.json', '追踪/上下文.md', '追踪/角色状态/程洁.md', '追踪/角色状态/杜青.md', '追踪/待审台账.md']
    sources = [{'id': 'U1', 'kind': 'user', 'text': quote}] + [{'id': 'F' + str(i + 1), 'kind': 'file', 'path': rel, 'sha256': sha(B / rel)} for i, rel in enumerate(paths)]
    brief = (B / 'inputs/brief.txt').read_text(encoding='utf-8')
    background = [line.strip() for line in brief.splitlines() if line.startswith(('程洁，', '杜青，', '搬走后的'))]
    doc = {'schema_version': 1, 'target': {'kind': 'long', 'chapter': 1, 'title': '锅边', 'mode': 'append'}, 'authorization': {'write': {'source_id': 'U1', 'quote': quote}, 'selection': None, 'publish': None}, 'sources': sources, 'facts': [{'text': s, 'source_id': 'F1'} for s in background], 'locks': [], 'allowed_reuse': [], 'outline': None, 'style': {'profile_id': 'relationship-payoff', 'profile_version': 2, 'selection_basis': 'framework-default', 'effective_features': [profile]}, 'wordcount': {'min': 1000, 'max': 2400}}
    save(R / 'input.json', doc)
    run('04-start', ['python', '-B', str(S / 'guyin-author-session.py'), 'start', '--project', str(B), '--run', 'cal-c1', '--input', '.guyin/work/cal-c1/input.json'])

elif stage in ('register', 'register-revision'):
    version = 'v0001' if stage == 'register' else 'v0002'
    labels = ['05-v0001-metrics', '06-checkpoint-drafted', '07-wordcount-v0001'] if version == 'v0001' else ['07b-v0002-metrics', '07c-checkpoint-revision', '07d-wordcount-v0002']
    checkpoint_name = 'checkpoint-drafted.json' if version == 'v0001' else 'checkpoint-revision.json'
    draft = R / ('drafts/' + version + '.md')
    js = 'const fs=require("fs"),crypto=require("crypto");const p=process.argv[1],b=fs.readFileSync(p),t=b.toString("utf8"),body=t.split(/\\r?\\n/).slice(1).join("\\n");console.log(JSON.stringify({path:p,sha256:crypto.createHash("sha256").update(b).digest("hex"),bytes:b.length,title:t.split(/\\r?\\n/)[0],han:(body.match(/\\p{Script=Han}/gu)||[]).length,body_non_whitespace:[...body.replace(/\\s/gu,"")].length,framework_visible_chars:body.replace(/\\s/gu,"").length},null,2));'
    output = run(labels[0], ['node', '-e', js, str(draft)])
    metrics = json.loads(output)
    metrics.update({'measured_at': now(), 'han_range': [1000, 1800], 'engineering_range': [1000, 2400], 'han_in_range': 1000 <= metrics['han'] <= 1800, 'engineering_in_range': 1000 <= metrics['body_non_whitespace'] <= 2400})
    save(R / (version + '-metrics.json'), metrics)
    save(R / checkpoint_name, {'phase': 'drafted', 'draft': {'path': '.guyin/work/cal-c1/drafts/' + version + '.md', 'complete': True}})
    run(labels[1], ['python', '-B', str(S / 'guyin-author-session.py'), 'checkpoint', '--project', str(B), '--run', 'cal-c1', '--input', '.guyin/work/cal-c1/' + checkpoint_name])
    run(labels[2], ['node', str(S / 'guyin-check-wordcount.js'), '--json', '--min=1000', '--max=2400', str(draft)])

elif stage == 'reviewed':
    save(R / 'checkpoint-reviewed.json', {'phase': 'reviewed', 'review': '.guyin/work/cal-c1/review.md', 'next_action': 'G2 校准停于 reviewed；等待独立读者验收。无选稿/发布授权，不推进 ready/publish。'})
    run('08-checkpoint-reviewed', ['python', '-B', str(S / 'guyin-author-session.py'), 'checkpoint', '--project', str(B), '--run', 'cal-c1', '--input', '.guyin/work/cal-c1/checkpoint-reviewed.json'])
    run('09-tracking-check', ['python', '-B', str(S / 'guyin-tracking-commit.py'), 'check', '--project', str(B)])
    run('10-final-pending', ['node', str(S / 'guyin-check-pending.js'), '--json', '--project', str(B), str(B / '追踪/待审台账.md')])
    run('11-author-status', ['python', '-B', str(S / 'guyin-author-session.py'), 'status', '--project', str(B), '--run', 'cal-c1'])
else:
    raise SystemExit('unknown stage')
