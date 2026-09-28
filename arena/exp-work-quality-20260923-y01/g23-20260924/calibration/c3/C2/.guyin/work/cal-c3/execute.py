import sys, json, subprocess, hashlib, datetime, time
from pathlib import Path

R = Path(__file__).resolve().parent
B = R.parents[2]
W = Path('D:/readbook-wpace/guyin-skills/arena/exp-work-quality-20260923-y01/g23-20260924/framework/skills')
S = W / 'guyin-write/scripts'
REL = '.guyin/work/cal-c3/'

def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()

def save(path, value):
    p = Path(path)
    with p.open('x', encoding='utf-8', newline='\n') as f:
        f.write(value if isinstance(value, str) else json.dumps(value, ensure_ascii=False, indent=2) + '\n')

def digest(path):
    data = Path(path).read_bytes()
    return {'path': str(Path(path)), 'sha256': hashlib.sha256(data).hexdigest(), 'bytes': len(data)}

def run(label, argv):
    start = now()
    t = time.monotonic()
    p = subprocess.run([str(a) for a in argv], capture_output=True)
    stdout = R / 'evidence' / (label + '.stdout.txt')
    stderr = R / 'evidence' / (label + '.stderr.txt')
    with stdout.open('xb') as f:
        f.write(p.stdout)
    with stderr.open('xb') as f:
        f.write(p.stderr)
    record = {'command': [str(a) for a in argv], 'cwd': str(Path.cwd()), 'started_at': start, 'ended_at': now(), 'elapsed_seconds': time.monotonic() - t, 'exit_code': p.returncode, 'stdout': digest(stdout), 'stderr': digest(stderr)}
    save(R / 'evidence' / (label + '.command.json'), record)
    print(json.dumps(record, ensure_ascii=False))
    print(p.stdout.decode('utf-8', errors='replace'))
    if p.stderr:
        print(p.stderr.decode('utf-8', errors='replace'), file=sys.stderr)
    return p.returncode

def require_run(label, argv):
    code = run(label, argv)
    if code:
        raise SystemExit(code)

if sys.argv[1] == 'prepare':
    save(R / 'evidence/preflight.json', {'observed_at': '2026-09-24T07:37:44.460553+00:00', 'observation': 'B原有且仅有inputs目录，内为brief.txt/profile.txt/generation-protocol.txt/framework-protocol.txt；完整os.walk未见其他文件或目录。', 'publication': 'absent', 'pending_ledger': 'absent; no rows existed', 'unknown_runs': [], 'original_tool_stdout_archived': False, 'note': '初次目录核查原始输出保留于宿主工具记录；此处为可核对转录，不冒充原始stdout。'})
    profile = (B / 'inputs/profile.txt').read_text(encoding='utf-8').rstrip('\r\n')
    assert len(profile) == 537, len(profile)
    save(B / '大纲/批次公约.md', '# 批次公约\n\n- 章号：第1章；chapter=1；mode=append；target.kind=long。\n- 标题：面要趁热（执行者起笔前决定）。\n- POV：第三人称有限，仅进入赵禾内心；苏笛笑的用意未知。\n- 从演出结束后的酒吧后门窄檐下起笔，不复演演出过程；已知背景见 inputs/brief.txt。\n- 完整短场景正文1000–1800个Unicode Script=Han码点；工程可见字符1000–2400，分别计量。\n- 无强制摊牌、和解、散伙、教训或点题结果；情节不预锁。\n- 这是执行者按派发协议制定的执行公约，不是用户原话或选稿授权。\n')
    save(B / '设定/题材定位.md', '# 题材定位\n\nY路线；都市业余乐队演出后的相处。独立原创短场景，以长篇第1章append隔离候选运行。\n\n## 叙事风格\n\nprofile_id=relationship-payoff；profile_version=2；selection_basis=framework-default。唯一来源为inputs/profile.txt完整537字符；不声称用户选中。\n\n' + profile + '\n')
    snapshots = {
        '赵禾': {'identity': '二十九岁，小公司会计，业余贝斯手', 'location': '酒吧后门窄檐下', 'goal': '收拾乐器；已有散场后陪苏笛吃面的承诺；明早须处理公司未完成的表', 'state': '演出刚结束，手指还酸，手机有同事消息，具体内容尚未设定', 'abilities_resources': ['业余弹贝斯；首歌漏词时和苏笛保持节奏'], 'relationships': ['与苏笛同龄，是大学以来玩音乐的朋友；曾合租，后来各自搬走', '与主唱莫圆同属小乐队'], 'knowledge': ['莫圆首歌忘词停了几拍后跟上，后几首顺利', '苏笛当时笑了；不知笑的用意', '场地方按约支付原定演出费，没有扣款或突然爆红机会'], 'open_threads': ['答应散场后陪苏笛吃面，尚未履行', '明早须去公司处理未完成的表', '手机同事消息尚待处理']},
        '苏笛': {'identity': '二十九岁，业余乐队鼓手', 'location': '酒吧后门窄檐下', 'goal': '收拾自己的乐器箱，后续选择未定', 'state': '演出刚结束，尚未与莫圆私谈首歌的停顿；曾笑，用意未知', 'abilities_resources': ['打鼓；与赵禾在漏词时维持节奏'], 'relationships': ['与赵禾是大学以来玩音乐的朋友，曾合租后各自搬走', '与莫圆同属小乐队'], 'knowledge': ['赵禾答应散场后陪自己吃面', '亲历首歌漏词和后续顺利演出'], 'open_threads': ['散场吃面约定未履行', '尚未与莫圆私谈刚才几拍']},
        '莫圆': {'identity': '三十三岁，小乐队主唱，常联系演出', 'location': '酒吧后门窄檐下', 'goal': '收拾自己的乐器箱；有不愿一直贴钱的顾虑', 'state': '首歌漏词后已跟上，后几首顺利；看到苏笛笑，尚未与其私谈', 'abilities_resources': ['主唱，常替乐队联系演出'], 'relationships': ['与赵禾、苏笛同属小乐队'], 'knowledge': ['首歌自己忘词停了几拍，节奏仍继续', '看到苏笛笑；不把笑的用意设定为真相', '场地方照约定支付原演出费'], 'open_threads': ['尚未与苏笛私谈漏词时几拍']}
    }
    init = {'schema_version': 1, 'book_title': '面要趁热', 'last_chapter': 0, 'context': {'position': {'volume': '独立短场景', 'volume_start_chapter': 1, 'story_time': '小酒吧演出刚结束，雨未停', 'scene': '酒吧后门窄檐下，三人收拾乐器箱；店员已拿出饮用水与外套'}, 'long_term_constraints': ['第三人称有限，仅进入赵禾内心'], 'active_character_names': ['赵禾', '苏笛', '莫圆'], 'continuity_risks': ['苏笛笑的用意未知，赵禾不能直接知道', '场地方没有扣费；不把漏词变成巨大职业危机'], 'recent_chapters': [], 'next_chapter_commitments': ['既有散场后陪苏笛吃面的承诺尚未履行，可履行、商量或留下后果', '赵禾明早须处理公司未完成的表']}, 'character_snapshots': snapshots, 'foreshadow': [], 'timeline_events': [], 'verdicts': [], 'scenes': []}
    save(R / 'init.json', init)
    require_run('01-init', [sys.executable, S / 'guyin-tracking-commit.py', 'init', '--project', B, '--input', R / 'init.json'])
    save(B / '追踪/待审台账.md', '# 待审台账\n\n| 章号 | 来源 | 报警/发现 | 处置类别 | 正文版本 | 终态 | 决定依据 | 去向/备注 |\n| --- | --- | --- | --- | --- | --- | --- | --- |\n')
    require_run('02-pending', ['node', S / 'guyin-check-pending.js', '--json', '--project', B, B / '追踪/待审台账.md'])
    quote = '指定封存包不满足同路线双原创题条件，那你先帮我处理这个然后再进行G2/G3'
    source_paths = ['inputs/brief.txt', 'inputs/profile.txt', 'inputs/generation-protocol.txt', 'inputs/framework-protocol.txt', '大纲/批次公约.md', '设定/题材定位.md', '追踪/上下文.md', '追踪/角色状态/赵禾.md', '追踪/角色状态/苏笛.md', '追踪/角色状态/莫圆.md', '追踪/_tracking-state.json', '追踪/待审台账.md']
    sources = [{'id': 'U1', 'kind': 'user', 'text': quote}] + [{'id': 'F' + str(i + 1), 'kind': 'file', 'path': p, 'sha256': digest(B / p)['sha256']} for i, p in enumerate(source_paths)]
    facts = ['赵禾二十九岁，在小公司做会计，业余弹贝斯；明早须处理未完成的表。', '苏笛与赵禾同龄，是大学以来一起玩音乐的朋友，曾合租后各自搬走。', '莫圆三十三岁，主唱，常联系演出，有不愿一直贴钱的顾虑。', '小乐队不指望靠它谋生，但各人认真在意的地方不同。', '首歌莫圆忘词停了几拍，苏笛赵禾保持节奏，莫圆后来跟上；后几首顺利。', '场地方照约定付原定演出费，无扣钱、无突然爆红的机会。', '苏笛当时笑了，莫圆看到了；笑的用意未知。', '赵禾演出前答应散场后陪苏笛吃面。', '三人现于酒吧后门窄檐下收拾乐器箱，雨未停，店员已拿出水和外套。', '赵禾手指酸，手机有同事消息；莫圆和苏笛还没私下谈过那几拍。']
    inp = {'schema_version': 1, 'target': {'kind': 'long', 'chapter': 1, 'title': '面要趁热', 'mode': 'append'}, 'authorization': {'write': {'source_id': 'U1', 'quote': quote}, 'selection': None, 'publish': None}, 'sources': sources, 'facts': [{'text': f, 'source_id': 'F1'} for f in facts], 'locks': [], 'allowed_reuse': [], 'outline': None, 'style': {'profile_id': 'relationship-payoff', 'profile_version': 2, 'selection_basis': 'framework-default', 'effective_features': [profile]}, 'wordcount': {'min': 1000, 'max': 2400}}
    save(R / 'input.json', inp)
    print('PREPARED_INPUT=' + str(R / 'input.json'))
elif sys.argv[1] == 'start':
    require_run('03-start', [sys.executable, S / 'guyin-author-session.py', 'start', '--project', B, '--run', 'cal-c3', '--input', REL + 'input.json'])
elif sys.argv[1] == 'draft':
    draft = R / 'drafts/v0001.md'
    js = "const fs=require('fs'),crypto=require('crypto');const p=process.argv[1],buf=fs.readFileSync(p),t=buf.toString('utf8'),body=t.slice(t.indexOf('\\n')+1);console.log(JSON.stringify({path:p,sha256:crypto.createHash('sha256').update(buf).digest('hex'),bytes:buf.length,han:(body.match(/\\p{Script=Han}/gu)||[]).length,non_whitespace:[...body].filter(x=>!/\\s/u.test(x)).length,measured_at:new Date().toISOString()},null,2));"
    require_run('04-v0001-metrics', ['node', '-e', js, draft])
    require_run('05-v0001-wordcount', ['node', S / 'guyin-check-wordcount.js', '--json', '--min=1000', '--max=2400', draft])
    save(R / 'checkpoint-drafted.json', {'phase': 'drafted', 'draft': {'path': REL + 'drafts/v0001.md', 'complete': True}})
    require_run('06-drafted', [sys.executable, S / 'guyin-author-session.py', 'checkpoint', '--project', B, '--run', 'cal-c3', '--input', REL + 'checkpoint-drafted.json'])
elif sys.argv[1] == 'review':
    save(R / 'checkpoint-reviewed.json', {'phase': 'reviewed', 'review': REL + 'review.md', 'next_action': 'G2当前会话已全文审读；保留初稿，等待后置用户质量验收；不申请ready、不发布。'})
    require_run('07-reviewed', [sys.executable, S / 'guyin-author-session.py', 'checkpoint', '--project', B, '--run', 'cal-c3', '--input', REL + 'checkpoint-reviewed.json'])
    require_run('08-tracking-check', [sys.executable, S / 'guyin-tracking-commit.py', 'check', '--project', B])
    require_run('09-status', [sys.executable, S / 'guyin-author-session.py', 'status', '--project', B, '--run', 'cal-c3'])
