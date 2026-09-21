#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const handling = require('./lib/guyin-handling');

// ---------- D2 项目级互斥锁（任务书 §2.6，跨语言同协议） ----------
// 同步注释契约（D2）：与同目录 guyin-tracking-commit.py 的 ProjectLock 是同一协议两份
// 实现（python 发布器持锁经 --under-lock 调本脚本时，node 只验锁存在不重入；改锁路径/
// owner.json 字段/死锁判定，两处必同步）。commit/backfill/指纹写入/指纹恢复/journal
// 推进共享这一把锁，无「跳过锁」开关。
const LOCK_DIRNAME = '.track-lock';

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return true; // 无法判定 → fail-closed
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM'; // ESRCH=死进程；EPERM=存活无权限；libuv 把 Windows 87 映射 ESRCH
  }
}

function acquireProjectLock(bookDir, label) {
  const lockDir = path.join(bookDir, '追踪', LOCK_DIRNAME);
  fs.mkdirSync(path.dirname(lockDir), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fs.mkdirSync(lockDir);
      fs.writeFileSync(path.join(lockDir, 'owner.json'),
        `${JSON.stringify({ pid: process.pid, host: os.hostname(), label, started_at: new Date().toISOString() }, null, 2)}\n`,
        'utf8');
      return lockDir;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let owner = null;
      try { owner = JSON.parse(fs.readFileSync(path.join(lockDir, 'owner.json'), 'utf8')); } catch (_) { /* 无 owner 按损坏锁处理 */ }
      if (owner && !pidAlive(owner.pid)) {
        // 持锁进程已死：改名挪走后重试，不直接 rmtree 活锁。
        const stale = path.join(path.dirname(lockDir), `${LOCK_DIRNAME}.stale-${Date.now()}`);
        try {
          fs.renameSync(lockDir, stale);
          fs.rmSync(stale, { recursive: true, force: true });
          continue;
        } catch (e2) {
          die(`项目锁目录无法清理：${lockDir}（持锁进程已死但目录挪不动）——请人工检查后删除重试`);
        }
      }
      die(`项目被占用：${lockDir} 已被另一进程持有（${(owner && owner.label) || '未知'}，pid=${owner && owner.pid}）——同一本书串行提交/发布；确认无其它进程后人工删除该锁目录重试`);
    }
  }
  die('项目锁获取失败（清理陈旧锁后仍被占用）');
  return null;
}

function releaseProjectLock(lockDir) {
  if (!lockDir) return;
  try { fs.rmSync(lockDir, { recursive: true, force: true }); } catch (e) { /* 释放只做 best-effort */ }
}

function atomicWrite(target, content) {
  const tmp = `${target}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, target);
}

const USAGE = `Usage: node guyin-check-repetition.js [--json] [--fail-on=block|hard|all] [--commit] [--project <根>] <正文文件... | 正文目录>
       node guyin-check-repetition.js --recover-library --project <根> [--under-lock] <根/正文>
       （--under-lock：发布器内部接口——锁已由 tracking-commit.py publish/recover 持有时只验锁存在，勿手工使用）
       （--unit <N>：显式单元号，短篇单篇项目固定 1；提供后只接受单文件且不从文件名反解章号，F1）

段落指纹库（P6，docs/04-优化路线图.md §3 P6）：跨章复读检测。
单文件密度检查拦不住跨章复读——那是 flash 级模型分布坍缩的直接产物（04 §2.2），
是最常见的中期死因之一。本脚本维护段落指纹库（<项目>/追踪/段落指纹库.json）：
新章入库前先查历史，相似度达阈值报「疑似重复描写」。

  para-repeat-near    (verify) bigram Jaccard ≥ 0.90（近乎照抄）——处置直达改写卡：两段原文
                      并排 + 方向「换比喻域」。其中约七成可直接删，但脚本只标不删，
                      删令由作者确认；可能是有意回环或登记资产，须对照锚句/台账核实
  para-repeat-pattern (verify) Jaccard 0.72-0.90（换词复读/结构雷同）——升级作者，结合意象
                      台账判「有意回环还是坍缩」：回环是意图，坍缩是分布，flash 判不了
  fingerprint-arrears (hard) 指纹库欠账：库登记章号落后受检正文（章检模式）——先
                      --commit 补齐再过章检

两条全部 advisory（只标不拦）。查询只比对叙述段（≥40 字且引号内字符占比 <50%），
台词与短句不进指纹库。--commit 在追踪提交时固化终稿指纹（同章旧指纹先清再插，幂等）。

意象台账（P6-2，与指纹库同源）：--commit 同时扫叙述段比喻句按域登记（追踪/意象台账.md），
「人物之眼」改写协议的消费端——换域，而不是换词。台账扩域（N2，docs/07）：渲染层加
「复读短语」节与明细类型列（比喻/复读短语），N1 窗口高频短语 --commit 时自动沉淀入台账
（登记零人工，只收自动来源）；手势类措辞多变无机械消费端，不设列——归复盘点名＋作者
仲裁，确认后以字符串近似进 短语黑名单.md（I2 通道，项目自有文件不受渲染覆盖）。

  imagery-domain-run   (editorial) 同域比喻滑窗内密度过高（3 章窗口内同域 ≥3 次）——同一比喻域
                       反复采撷即该域疲劳，改写时换域不换词（消费台账选未用域）
  metaphor-domain-stale (editorial) 本章主导比喻域连续驻留超阈值（默认 >4 章，--domain-stale=N 可调，
                       B3）——61-63 做饭域三章同值的全篇固化形态；源头治理在批次公约
                       （B1 声明＋换域计划），本 advisory 是汇侧兜底

与 04 原案的偏差（实测对撞，实测赢）：原案「64 位 SimHash + 海明距离 ≤3」，实测段落级
换词复读（仅换 4 个名词）海明距离即达 10——SimHash 为文档级设计，短段落 70 个 bigram
中 12 对扰动足以翻转 10 位，对坍缩真形态（换名词复用整段结构）钝感不足。改用字符
bigram 集合的 Jaccard 相似度（实测换 4 词复读 ≈0.83，随机不同段 <0.3），倒排索引加速，
同阈值两档分级不变。

───────────────────────────────────────────────────────────────────────────────

复读雷达（N1，docs/07 §一/§二）：短语级跨章复读检测，治「tic 发现靠人工」——旧 tic 靠
复盘报告点名（滞后一批）、新 tic 靠下一份复盘报告（永远慢一拍），穷举式黑名单结构性
追不上复读冲动（E7 实证：旧的清掉、五类新的顶上）。治理对象是「复读度」本身：

  phrase-echo-cross    (editorial) 跨章窗口（本章＋近 5 章）同 4-8 字短语 ≥3 次——疑似新 tic，
                       仲裁：进黑名单限额（I2 通道）或豁免台账
  phrase-echo-ending   (editorial) 同章 ≥2 次且末次落章尾 20% 区域——E6 章尾同图重复形态
  phrase-echo-inline   (editorial) 同章中段同 4-8 字短语 ≥2 次（SP1，docs/11 §一）——A1' 同拍重复
                       形态：够不到 cross（需 ≥3）/ending（末次落章尾）的剩余出口。
                       疑似 beat 拼接伤或新 tic，处置同 cross（黑名单或豁免台账），
                       或登记 追踪/复沓锚句.md（签名资产）豁免

三条均 editorial 宁报不拦（拦截权归五测试）。黑名单降级为仲裁通道：雷达自动发现 →
台账自动沉淀（N2）→ 作者仲裁 → 黑名单精确限额 → 写前注入（N3）→ 章检复扫。
防噪三规格（v1.1）：① 不跨标点边界——按标点切段后段内成词，否则「的时候他」类
虚词搭配是汉语常态，虚词占比过滤救不了；② 子串归并——同一 tic 多长度命中只报最长形；
③ 报告截断 top10，其余只进计数。过滤：角色名/地名命中跳过；虚词占比 >50% 不报。
统计口径与指纹库同源：只扫叙述段（台词口头禅是人物特征不是 tic）。phrases 节只存
窗口复现 ≥2 的短语（{phrase, total, last, recent}，recent 按章存样本，整条按最近章
≥当前−10 修剪、样本按检测窗口修剪）——全量 n-gram 每章上万条，不滤必膨胀。
--commit 时随指纹固化同步统计（与意象台账同一原子双命令）；章检模式只报告。

--fail-on=block（默认）hard/verify 任一存在即 1；hard 仅 hard；all 含 editorial（审计模式）。
--commit/--recover-library 持项目锁（追踪/.track-lock，与 tracking-commit.py 共享）。
--recover-library：指纹库损坏（无法解析/形状非法）时的受保护恢复——先隔离成
  段落指纹库.corrupt-<时间戳>.json，再从正式 正文/ 全量基线重放，最后复检：
  复检存在阻断（exit 1）绝不冒充恢复成功；库健康时 no-op exit 0。普通 --commit
  遇库损坏只报错不放行（须显式走本恢复路径，D2 任务书 §2.6）。
Exit codes: 0=无未决阻断/恢复成功, 1=存在未决阻断(hard/verify)/恢复后复检有阻断,
            2=执行/输入错误, 3 不使用。`;

const NEAR_THRESHOLD = 0.9;
const PATTERN_THRESHOLD = 0.72;
const IMAGERY_WINDOW = 3; // 滑窗章数
const IMAGERY_RUN = 3;    // 窗内同域次数阈值
const DOMAIN_STALE_DEFAULT = 4; // B3：主导域连续驻留章数阈值（超过才报）

// ---------- N1 复读雷达参数（docs/07 §一） ----------
const ECHO_N_MIN = 4;        // n-gram 滑窗下限（字）
const ECHO_N_MAX = 8;        // n-gram 滑窗上限
const ECHO_CROSS_RUN = 3;    // 跨章窗口内同短语 ≥3 次 → phrase-echo-cross
const ECHO_ENDING_RUN = 2;   // 同章 ≥2 次且末次落章尾 20% → phrase-echo-ending
const ECHO_INLINE_RUN = 2;   // SP1（docs/11 §一）：同章复读门（A1' 同拍重复形态——够不到 cross/ending 的剩余形态出口）
const ECHO_WINDOW = 5;       // 跨章检测窗口（章）
const ECHO_STORE_SPAN = 10;  // phrases 整条修剪线（最近章 < 当前−10 删，v1.1 存储规格）
const ECHO_TOP = 10;         // 报告截断 top10（防噪规格③），其余只进计数
const ECHO_TAIL_RATIO = 0.8; // 章尾 20% 区域起点（章叙述文本的 80% 处之后）
// 虚词表（docs/07 §一）：占比 >50% 的组合不报——「的时候他」类高频搭配是汉语常态。
const ECHO_STOPWORDS = ['的', '了', '着', '是', '在', '和', '就', '被'];
// 标点切段集：n-gram 不跨标点边界（防噪规格①），段内成词。
// SP2（docs/11 §一）：字符类加 "——直引号对白也不跨边界成词（n-gram 不产出
// 「的钱你」类跨引号拼接串）。Y1 拍板新章统一直引号后的检测器适配。
const ECHO_SPLIT = /[，。！？；：、「」『』“”‘’…—·（）()《》<>"\n]/;

// 比喻标记词：多字优先，单字「如」需排除复合词（如果/如何/如今/如此/例如/不如/犹如/宛如/譬如）。
const METAPHOR_WORDS = ['仿佛', '宛如', '恍若', '如同', '好似', '犹如', '好像', '恰似', '像', '似', '如'];
const RU_EXCLUDE_NEXT = ['何', '果', '今', '此', '同', '例'];
const RU_EXCLUDE_PREV = ['不', '犹', '宛', '譬', '假'];

// 比喻域关键词表（机械可查，可演进）：按命中关键词数取多者，平局取先。
const DOMAINS = [
  { name: '自然', keys: ['风', '雨', '雪', '云', '雾', '霜', '露', '山', '河', '江', '海', '溪', '湖', '月', '日', '星', '雷', '潮'] },
  { name: '动物', keys: ['兽', '鸟', '鱼', '虫', '蛇', '狼', '虎', '鹰', '犬', '马', '蝉', '蚁', '鹤', '猫', '鼠'] },
  { name: '器物', keys: ['刀', '剑', '锁', '镜', '灯', '钟', '琴', '鼓', '秤', '尺', '网', '线', '针', '绳', '匣', '锯', '钉', '瓷'] }, // 瓷归器物（N2 顺带修报告 F6 分类误差：曾误归自然）
  { name: '身体', keys: ['骨', '血', '心', '手', '眼', '喉', '脊', '背', '皮', '发', '眉', '指', '脉'] },
  { name: '食物', keys: ['茶', '酒', '盐', '糖', '米', '面', '药', '汤', '油', '醋', '饭', '菜'] },
  { name: '商贾', keys: ['账', '票', '银', '钱', '买', '卖', '商', '价', '市', '当'] },
  { name: '宗教', keys: ['香', '神', '佛', '鬼', '魂', '符', '庙', '经', '咒', '妖', '碑'] },
  { name: '建筑', keys: ['墙', '门', '窗', '梁', '檐', '井', '牢', '塔', '桥', '阶'] },
];

const options = { json: false, commit: false, recoverLibrary: false, underLock: false, prepublish: false, project: null, targets: [], failOn: 'block', domainStale: DOMAIN_STALE_DEFAULT, unit: null };

for (let i = 2; i < process.argv.length; i += 1) {
  const arg = process.argv[i];
  if (arg === '--json') {
    options.json = true;
  } else if (arg === '--commit') {
    options.commit = true;
  } else if (arg === '--prepublish') {
    // v4（§6.2）：ready 前对候选做只读复读检查——指纹欠账是“发布后未固化”的门，
    // 候选尚未发布，欠账在此天然存在；该门仍由发布器指纹步骤负责，不在 ready 链拦。
    options.prepublish = true;
  } else if (arg === '--recover-library') {
    options.recoverLibrary = true;
  } else if (arg === '--under-lock') {
    options.underLock = true;
  } else if (arg.startsWith('--unit=')) {
    const v = Number(arg.slice('--unit='.length));
    if (!Number.isInteger(v) || v < 1) die('--unit must be a positive integer');
    options.unit = v;
  } else if (arg === '--unit') {
    const v = Number(process.argv[i + 1]);
    if (!Number.isInteger(v) || v < 1) die('--unit must be a positive integer');
    options.unit = v;
    i += 1;
  } else if (arg.startsWith('--domain-stale=')) {
    const v = Number(arg.slice('--domain-stale='.length));
    if (!Number.isInteger(v) || v < 1) die('--domain-stale must be a positive integer');
    options.domainStale = v;
  } else if (arg.startsWith('--project=')) {
    options.project = arg.slice('--project='.length);
  } else if (arg === '--project') {
    options.project = process.argv[i + 1] || die('--project requires a value');
    i += 1;
  } else if (arg.startsWith('--fail-on=')) {
    try {
      options.failOn = handling.parseFailOn(arg.slice('--fail-on='.length), 'block');
    } catch (error) {
      die(error.message);
    }
  } else if (arg === '-h' || arg === '--help') {
    process.stdout.write(`${USAGE}\n`);
    process.exit(0);
  } else if (arg.startsWith('-')) {
    die(`Unknown option: ${arg}`);
  } else {
    options.targets.push(arg);
  }
}

if (options.targets.length === 0) die('No chapter file or directory provided');
if (options.underLock && !options.commit && !options.recoverLibrary) {
  die('--under-lock 是发布器内部接口，只能与 --commit/--recover-library 同用');
}
if (options.recoverLibrary && !options.project) die('--recover-library 必须显式 --project <书根>');

// ---------- 文件收集：目录 → 第NNN章.md；文件原样 ----------

const files = [];
let failed = false;
for (const target of options.targets) {
  const full = path.resolve(target);
  let stat;
  try {
    stat = fs.statSync(full);
  } catch (error) {
    failed = true;
    if (!options.json) console.error(`${target}: unable to stat (${error.message})`);
    continue;
  }
  if (stat.isDirectory()) {
    let entries;
    try {
      entries = fs.readdirSync(full);
    } catch (error) {
      failed = true;
      if (!options.json) console.error(`${target}: unable to read directory (${error.message})`);
      continue;
    }
    for (const name of entries.sort()) {
      if (/^第\d+章.*\.md$/.test(name)) files.push(path.join(full, name));
    }
  } else {
    files.push(full);
  }
}

const CHAPTER_FILE = /第\s*0*(\d+)\s*章/;

// F1：短篇固定单元号 1（单短篇项目）。--unit 是显式单元号——文件名不再被反向解析当章号：
// 仅允许单文件目标；文件名自身带章号且与 --unit 冲突一律报错（不猜哪个对）。
if (options.unit !== null) {
  if (files.length !== 1) {
    die('--unit <N> 只支持单文件目标（短篇一篇一个显式单元号；目录/多文件沿用文件名章号）');
  }
  const encoded = CHAPTER_FILE.exec(path.basename(files[0]));
  if (encoded && Number(encoded[1]) !== options.unit) {
    die(`--unit=${options.unit} 与文件名章号 第${encoded[1]}章 冲突——显式单元号与文件名只能信一个，先改调用`);
  }
}

// ---------- 复读雷达（N1）：n-gram 统计 + 防噪三规格 ----------

// 虚词占比 >50% 不报（「的时候他」4 字仅 1 字命中虚词表救不了它的是长搭配；
// 短搭配靠切段防噪①：不跨标点边界后，「的他了着」类纯虚词串先被这里拦住）。
function echoNoisy(phrase) {
  let stop = 0;
  for (const ch of phrase) {
    if (ECHO_STOPWORDS.includes(ch)) stop += 1;
  }
  return stop * 2 > phrase.length;
}

// 实体名过滤器：bigram 预筛（名字内部相邻字对）+ 精确 includes。
// 预筛集合只含名字内部的字对，「衡阳」不含「燕衡」字对不会误伤。
function buildEntityFilter(names) {
  const bigrams = new Set();
  for (const name of names) {
    for (let i = 0; i + 1 < name.length; i += 1) bigrams.add(name.slice(i, i + 1));
  }
  return (phrase) => {
    let maybe = false;
    for (let i = 0; i + 1 < phrase.length && !maybe; i += 1) {
      if (bigrams.has(phrase.slice(i, i + 1))) maybe = true;
    }
    if (!maybe) return false;
    return names.some((n) => n.length >= 2 && phrase.includes(n));
  };
}

// 章叙述文本 → Map(短语 → 出现次数)。4-8 字滑窗，按标点切段后段内成词（防噪①）。
// n > 段长时内层循环条件不成立自然跳过，无需额外界。
function echoCounts(text) {
  const counts = new Map();
  for (const seg of text.split(ECHO_SPLIT)) {
    if (seg.length < ECHO_N_MIN) continue;
    for (let n = ECHO_N_MIN; n <= ECHO_N_MAX; n += 1) {
      for (let i = 0; i + n <= seg.length; i += 1) {
        const g = seg.slice(i, i + n);
        counts.set(g, (counts.get(g) || 0) + 1);
      }
    }
  }
  return counts;
}

// 指纹库定位：--project 优先，否则从目标目录向上找 追踪/ ----------

function locateLibrary(chapterDirs) {
  if (options.project) return path.join(path.resolve(options.project), '追踪', '段落指纹库.json');
  for (const dir of chapterDirs) {
    let cur = dir;
    for (let depth = 0; depth < 4; depth += 1) {
      const candidate = path.join(cur, '追踪');
      if (fs.existsSync(candidate)) return path.join(candidate, '段落指纹库.json');
      const parent = path.dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
  }
  return null;
}

const chapterDirs = [...new Set(files.map((f) => path.dirname(f)))];
const libraryPath = files.length > 0 ? locateLibrary(chapterDirs) : null;

// ---------- D2：写状态操作持锁；--recover-library 先隔离损坏库 ----------
let lockHeld = null;
let quarantinePath = null;
{
  const projectRoot = options.project
    ? path.resolve(options.project)
    : (libraryPath ? path.dirname(path.dirname(libraryPath)) : null);
  if (options.commit || options.recoverLibrary) {
    if (options.underLock) {
      if (!projectRoot || !fs.existsSync(path.join(projectRoot, '追踪', LOCK_DIRNAME))) {
        die('--under-lock 要求项目锁已由发布器持有（追踪/.track-lock 不存在）');
      }
    } else {
      if (!projectRoot) die('--commit/--recover-library 需要项目根（用 --project 指定，或在 正文/ 内运行）');
      lockHeld = acquireProjectLock(projectRoot, options.recoverLibrary ? 'recover-library' : 'fingerprint-commit');
    }
  }
  if (options.recoverLibrary) {
    // 基线重放须覆盖正式 正文/ 全量（只重放单章无法复检未受影响内容）。
    if (options.targets.length !== 1) die('--recover-library 只接受一个目标：正式 正文/ 目录');
    let targetStat;
    try { targetStat = fs.statSync(path.resolve(options.targets[0])); }
    catch (e) { die(`--recover-library 目标无法读取：${e.message}`); }
    if (!targetStat.isDirectory()) die('--recover-library 目标必须是正式 正文/ 目录（基线全量重放）');
    if (libraryPath) {
      let damaged = false;
      if (fs.existsSync(libraryPath)) {
        try {
          const doc = JSON.parse(fs.readFileSync(libraryPath, 'utf8'));
          if (!doc || typeof doc !== 'object' || !Array.isArray(doc.entries)
            || doc.entries.some((e) => !e || !Array.isArray(e.grams))) damaged = true;
        } catch (e) { damaged = true; }
      }
      if (damaged) {
        const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
        quarantinePath = libraryPath.replace(/\.json$/, `.corrupt-${stamp}.json`);
        try {
          fs.renameSync(libraryPath, quarantinePath);
        } catch (e) {
          die(`损坏库隔离失败（${e.message}）——停用户核查，不静默重建`);
        }
      }
    }
  }
}
process.on('exit', () => releaseProjectLock(lockHeld));
process.on('uncaughtException', (e) => { releaseProjectLock(lockHeld); throw e; });

// ---------- 段落 bigram 集合（去重排序，即段落指纹）----------

function gramsOf(text) {
  const grams = new Set();
  for (let i = 0; i + 1 < text.length; i += 1) {
    grams.add(text.slice(i, i + 2));
  }
  return [...grams].sort();
}

// ---------- 段落切分与叙述段过滤 ----------

function isNarrative(para) {
  if (para.length < 40) return false;
  let inQuote = false;
  let quoted = 0;
  for (const ch of para) {
    if (ch === '"') { inQuote = !inQuote; continue; } // SP2：直引号对白开闭同形翻转，对白内字符不计入 quoted——台词口头禅不再被当 tic
    if (ch === '“' || ch === '「') inQuote = true;
    else if (ch === '”' || ch === '」') inQuote = false;
    else if (inQuote) quoted += 1;
  }
  return quoted * 2 < para.length;
}

// ---------- 意象台账（P6-2）：比喻句抽取 + 域分类 + 角色就近归属 ----------

// 人名词典：_tracking-state.json 的 characters 键（缺失则角色不归属，fail-open）。
function loadCharacterNames() {
  if (!libraryPath) return [];
  const statePath = path.join(path.dirname(libraryPath), '_tracking-state.json');
  try {
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    return state && typeof state === 'object' && state.characters ? Object.keys(state.characters) : [];
  } catch (error) {
    return [];
  }
}

// 实体名词典（N1 过滤用）：characters + geo 键——角色名/地名命中的 n-gram 跳过
// （「燕衡的手」是人名搭配不是 tic）。fail-open：state 缺失则不过滤。
function loadEntityNames() {
  if (!libraryPath) return [];
  const statePath = path.join(path.dirname(libraryPath), '_tracking-state.json');
  try {
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    if (!state || typeof state !== 'object') return [];
    return [...Object.keys(state.characters || {}), ...Object.keys(state.geo || {})];
  } catch (error) {
    return [];
  }
}

// SP1 白名单（docs/11 §一）：追踪/复沓锚句.md 登记的签名实体——有意复沓的仪式资产
// （算盘/空位/残珠类）非复读。候选短语含任一登记实体 → 跳过（与 ai-patterns Z7
// loadAnchorRegistry 同源同语义，无文件/空表 → 返回 []，fail-open）。
// 解析同型：剥表格语法、滤 <br/> 残渣与 {{}} 占位符、跳过表头与 HTML 注释块。
function loadAnchorWhitelist() {
  if (!libraryPath) return [];
  const anchorPath = path.join(path.dirname(libraryPath), '复沓锚句.md');
  let text;
  try {
    text = fs.readFileSync(anchorPath, 'utf8');
  } catch (error) {
    return [];
  }
  const entities = [];
  let inComment = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (inComment) {
      if (line.includes('-->')) inComment = false;
      continue;
    }
    if (line.includes('<!--')) {
      if (!line.includes('-->')) inComment = true;
      continue;
    }
    if (!line.startsWith('|')) continue;
    const cells = line.split('|').map((c) => c.trim());
    if (cells.length < 2) continue;
    let entity = cells[1];
    if (!entity || entity === '实体' || entity.includes('{{')) continue;
    entity = entity.replace(/<br\s*\/?\/?>/gi, '').trim();
    if (!entity) continue;
    entities.push(entity);
  }
  return entities;
}

// 标记词位置（-1 = 非比喻句）；域分类优先取喻体侧（标记词后），喻体无命中再退回全句。
function metaphorAnchor(sentence) {
  for (let i = 0; i < sentence.length; i += 1) {
    for (const word of METAPHOR_WORDS) {
      if (!sentence.startsWith(word, i)) continue;
      if (word === '如') {
        const next = sentence[i + 1] || '';
        const prev = sentence[i - 1] || '';
        if (RU_EXCLUDE_NEXT.includes(next) || RU_EXCLUDE_PREV.includes(prev)) continue;
        return i;
      }
      return i;
    }
  }
  return -1;
}

function classifyDomain(sentence) {
  let best = null;
  let bestHits = 0;
  for (const domain of DOMAINS) {
    let hits = 0;
    for (const key of domain.keys) {
      if (sentence.includes(key)) hits += 1;
    }
    if (hits > bestHits) {
      best = domain.name;
      bestHits = hits;
    }
  }
  return best;
}

// 角色就近归属：比喻句内人名优先，否则同段落最后出现的人名（70-80% 准确率够登记用）。
function nearestCharacter(sentence, para, names) {
  if (names.length === 0) return '';
  for (const name of names) {
    if (sentence.includes(name)) return name;
  }
  let found = '';
  let at = -1;
  for (const name of names) {
    const pos = para.lastIndexOf(name);
    if (pos > at) {
      at = pos;
      found = name;
    }
  }
  return found;
}

// 叙述段 → 比喻句登记条目（句切分按 。！？；，保留句内完整语境）。
function extractMetaphors(para, chapter, names) {
  const out = [];
  for (const sentence of para.split(/[。！？]/)) {
    const s = sentence.trim();
    const anchor = s ? metaphorAnchor(s) : -1;
    if (anchor < 0) continue;
    const domain = classifyDomain(s.slice(anchor + 1)) || classifyDomain(s) || '未分类';
    out.push({
      chapter,
      domain,
      character: nearestCharacter(s, para, names),
      excerpt: s.slice(0, 40),
    });
  }
  return out;
}

// ---------- 指纹库读写（schema 3：imagery + phrases/N1；v2 无 phrases 视为空）----------

const LIB_SCHEMA = 3;

function loadLibrary() {
  if (!libraryPath) return { schema_version: LIB_SCHEMA, entries: [], imagery: [], phrases: [] };
  let raw;
  try {
    raw = fs.readFileSync(libraryPath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { schema_version: LIB_SCHEMA, entries: [], imagery: [], phrases: [] };
    throw error;
  }
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch (error) {
    die(`${libraryPath}: unable to parse library (${error.message})——库损坏须走显式恢复：node guyin-check-repetition.js --recover-library --project <书根> 正文（隔离备份+基线重放+复检，D2），不得静默重建`);
  }
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.entries)) {
    die(`${libraryPath}: library must contain an "entries" array——形状损坏须走 --recover-library（D2），不得静默重建`);
  }
  if (!Array.isArray(doc.imagery)) doc.imagery = [];
  if (!Array.isArray(doc.phrases)) doc.phrases = []; // schema 2 旧库 → N1 phrases 视为空，下次 --commit 自动补齐
  for (const e of doc.entries) {
    if (!Array.isArray(e.grams)) {
      die(`${libraryPath}: entry ${e.chapter || '?'}-${e.para || '?'} missing "grams" (rebuild with --recover-library)`);
    }
  }
  return doc;
}

// 倒排索引：bigram → 库内条目下标。候选命中计数即交集大小，天然完成剪枝。
function buildInverted(entries) {
  const inverted = new Map();
  for (let i = 0; i < entries.length; i += 1) {
    for (const gram of entries[i].grams) {
      if (!inverted.has(gram)) inverted.set(gram, []);
      inverted.get(gram).push(i);
    }
  }
  return inverted;
}

// ---------- 主流程 ----------

const library = loadLibrary();
const inverted = buildInverted(library.entries);
const characterNames = loadCharacterNames();
const entityNames = loadEntityNames();
const isEntityPhrase = buildEntityFilter(entityNames);
const anchorWhitelist = loadAnchorWhitelist(); // SP1：复沓锚句白名单（与 ai-patterns Z7 同源）
const phraseIndex = new Map(library.phrases.map((p) => [p.phrase, p])); // 短语 → 库条目（O(1) 窗口查询）
const findings = [];
const pending = [];        // --commit 待入库指纹
const pendingImagery = []; // --commit 待入库比喻句
const batchImagery = [];   // 本批已处理章的比喻句（同批多章时窗口统计需要）
const batchChapters = new Set();
const scannedChapters = []; // I1 欠账检测：本批受检正文章号
const batchEchoAgg = new Map(); // N1 批级聚合：短语 → Map(章号 → 次数)，commit 时与库合并
let echoSuppressed = 0;     // top10 截断外只进计数的候选数（防噪规格③）
let paragraphsScanned = 0;

// B3 主导域驻留：章 → Map(域 → 次数)。库内旧登记先入表，批内章扫描时整章替换
// （重跑幂等：同章以现稿为准，不与库内旧样本叠加）；主导域＝计数最大域（平局取先，
// 保守少报）。无登记章视同证据缺失，驻留链断开不猜（fail-open）。
const domainCountsByChapter = new Map();
for (const m of library.imagery) {
  let counts = domainCountsByChapter.get(m.chapter);
  if (!counts) {
    counts = new Map();
    domainCountsByChapter.set(m.chapter, counts);
  }
  counts.set(m.domain, (counts.get(m.domain) || 0) + 1);
}
function dominantDomain(chapter) {
  const counts = domainCountsByChapter.get(chapter);
  if (!counts) return null;
  let best = null;
  let bestN = 0;
  for (const [domain, n] of counts) {
    if (n > bestN) {
      best = domain;
      bestN = n;
    }
  }
  return best;
}

for (const file of files) {
  // 单元号解析：显式 --unit 优先（F1：不靠文件名反解）；缺省回退文件名 第NNN章。
  let chapter;
  if (options.unit !== null) {
    chapter = options.unit;
  } else {
    const nameMatch = CHAPTER_FILE.exec(path.basename(file));
    if (!nameMatch) {
      failed = true;
      if (!options.json) console.error(`${file}: filename must match 第NNN章.md（短篇等无章号文件须显式 --unit <单元号>）`);
      continue;
    }
    chapter = Number(nameMatch[1]);
  }
  let input;
  try {
    input = fs.readFileSync(file, 'utf8');
  } catch (error) {
    failed = true;
    if (!options.json) console.error(`${file}: unable to read (${error.message})`);
    continue;
  }
  const lines = input.split(/\r?\n/);
  let chapterPara = 0;
  const currentImagery = [];
  const narrativeParts = []; // N1：章叙述段聚合，章末复读检测的输入（只收叙述段，与指纹库同口径）
  for (let i = 0; i < lines.length; i += 1) {
    const para = lines[i].trim();
    if (!isNarrative(para)) continue;
    chapterPara += 1;
    paragraphsScanned += 1;
    narrativeParts.push(para);
    currentImagery.push(...extractMetaphors(para, chapter, characterNames));
    const grams = gramsOf(para);
    // 查历史：倒表计数 = 交集大小 → Jaccard；同章旧指纹不比（重写场景先清后插）。
    const hits = new Map();
    for (const gram of grams) {
      for (const id of inverted.get(gram) || []) {
        hits.set(id, (hits.get(id) || 0) + 1);
      }
    }
    let best = null;
    for (const [id, common] of hits) {
      const entry = library.entries[id];
      if (entry.chapter === chapter) continue;
      const jac = common / (grams.length + entry.grams.length - common);
      if (jac >= PATTERN_THRESHOLD && (best === null || jac > best.jac)) {
        best = { entry, jac };
      }
    }
    if (best) {
      const near = best.jac >= NEAR_THRESHOLD;
      findings.push({
        file: path.relative('.', file),
        line: i + 1,
        column: 1,
        type: near ? 'para-repeat-near' : 'para-repeat-pattern',
        severity: 'advisory',
        message: near
          ? `疑似照抄（相似度 ${best.jac.toFixed(2)}）：与第${best.entry.chapter}章（${best.entry.file} 第${best.entry.para}段）几乎相同——处置直达改写卡：两段原文并排，方向「换比喻域」；约七成可直接删，删令由作者确认。`
          : `换词复读（相似度 ${best.jac.toFixed(2)}）：与第${best.entry.chapter}章（${best.entry.file} 第${best.entry.para}段）结构雷同——升级作者结合意象台账判「有意回环还是坍缩」：回环是意图，坍缩是分布。`,
        excerpt: para.slice(0, 60),
        match: {
          chapter: best.entry.chapter,
          file: best.entry.file,
          para: best.entry.para,
          excerpt: best.entry.excerpt,
          similarity: Number(best.jac.toFixed(4)),
        },
      });
    }
    if (options.commit || options.recoverLibrary) {
      pending.push({
        chapter,
        para: chapterPara,
        excerpt: para.slice(0, 60),
        file: path.basename(file),
        grams,
      });
    }
  }

  if (options.commit || options.recoverLibrary) pendingImagery.push(...currentImagery);
  batchImagery.push(...currentImagery);
  batchChapters.add(chapter);
  scannedChapters.push(chapter);
  scanChapterEcho(chapter, narrativeParts.join('\n'), file);

  // 意象域密度（P6-2）：本章参与后，滑窗（IMAGERY_WINDOW 章）内同域 ≥IMAGERY_RUN 次
  // 才报——历史旧密度不在本章参与时不报（已在密度形成那章报过）。同批多章时窗口
  // 取「库内旧数据（排除本批章）+ 本批已处理章」，重跑幂等。
  const domainCount = new Map();
  for (const m of currentImagery) domainCount.set(m.domain, (domainCount.get(m.domain) || 0) + 1);
  const windowStart = chapter - IMAGERY_WINDOW + 1;
  const windowImagery = library.imagery
    .filter((e) => e.chapter >= windowStart && e.chapter < chapter && !batchChapters.has(e.chapter))
    .concat(batchImagery.filter((e) => e.chapter >= windowStart && e.chapter < chapter));
  for (const e of windowImagery) {
    domainCount.set(e.domain, (domainCount.get(e.domain) || 0) + 1);
  }
  const chapterDomainHits = new Set(currentImagery.map((m) => m.domain));
  for (const [domain, count] of domainCount) {
    if (count >= IMAGERY_RUN && chapterDomainHits.has(domain)) {
      findings.push({
        file: path.relative('.', file),
        line: 1,
        column: 1,
        type: 'imagery-domain-run',
        severity: 'advisory',
        message: `比喻域疲劳：「${domain}」域在近 ${IMAGERY_WINDOW} 章窗口内出现 ${count} 次——同一域反复采撷即坍缩；改写时查意象台账换域不换词（人物之眼）。`,
        excerpt: `第${chapter}章 × ${domain}域`,
      });
    }
  }

  // B3 主导域固化：本章域计数整章替换（现稿为准）→ 主导域向前数连续驻留章数，
  // 超阈值报 advisory。源头治理在批次公约（B1 域声明＋换域计划），此处汇侧兜底。
  const currentDomainCounts = new Map();
  for (const m of currentImagery) {
    currentDomainCounts.set(m.domain, (currentDomainCounts.get(m.domain) || 0) + 1);
  }
  domainCountsByChapter.set(chapter, currentDomainCounts);
  const dominant = dominantDomain(chapter);
  if (dominant) {
    let run = 1;
    for (let c = chapter - 1; c > 0; c -= 1) {
      if (dominantDomain(c) !== dominant) break;
      run += 1;
    }
    if (run > options.domainStale) {
      findings.push({
        file: path.relative('.', file),
        line: 1,
        column: 1,
        type: 'metaphor-domain-stale',
        severity: 'advisory',
        message: `比喻域固化：「${dominant}」域已连续 ${run} 章主导本章比喻（阈值 ${options.domainStale}，--domain-stale=N 可调）——按 大纲/批次公约.md 的换域计划切新域；源头是批次公约声明（B1），本 advisory 是汇侧兜底（B3）。`,
        excerpt: `第${chapter}章 × ${dominant}域 × 连续${run}章`,
      });
    }
  }
}

// 章末复读检测（N1）：章叙述文本 vs 库+批内样本（检测窗口 [chapter−5, chapter−1]）。
// 同短语同时满足 cross 与 ending 时只报 cross（更严重，双报冗余）。库样本排除本批章
// 号（重跑幂等，同意象窗口统计的 batchChapters 排除哲学）；批内样本取自 batchEchoAgg。
// 子串归并（防噪②）+ 频次降序 top10 截断（防噪③）。
function scanChapterEcho(chapter, narrativeText, file) {
  if (!narrativeText) return;
  const counts = echoCounts(narrativeText);
  const floor = chapter - ECHO_WINDOW;
  const candidates = [];
  for (const [phrase, count] of counts) {
    if (echoNoisy(phrase) || isEntityPhrase(phrase)) continue;
    // SP1 白名单（docs/11 §一）：复沓锚句.md 登记的签名实体豁免——有意复沓的仪式资产非复读。
    if (anchorWhitelist.some((w) => phrase.includes(w))) continue;
    let winLib = 0;
    const libEntry = phraseIndex.get(phrase);
    if (libEntry) {
      for (const s of libEntry.recent || []) {
        if (s.c >= floor && s.c < chapter && !batchChapters.has(s.c)) winLib += s.n;
      }
    }
    for (const [c, n] of batchEchoAgg.get(phrase) || []) {
      if (c >= floor && c < chapter) winLib += n;
    }
    if (count + winLib >= ECHO_CROSS_RUN) {
      candidates.push({ phrase, count, winLib, total: count + winLib, type: 'phrase-echo-cross' });
    } else if (count >= ECHO_ENDING_RUN
      && narrativeText.lastIndexOf(phrase) / narrativeText.length >= ECHO_TAIL_RATIO) {
      candidates.push({ phrase, count, winLib, total: count + winLib, type: 'phrase-echo-ending' });
    } else if (count >= ECHO_INLINE_RUN) {
      // SP1 第三分支（docs/11 §一）：同章中段同拍重复——够不到 cross（需 ≥3）与 ending
      // （末次须落章尾 20%）的剩余同章 ≥2 形态出口。else-if 链天然互斥，零双报。
      candidates.push({ phrase, count, winLib, total: count + winLib, type: 'phrase-echo-inline' });
    }
    // 批级聚合（--commit 合并用）：全部过滤后短语入聚合，入库门槛在合并时判（total ≥2）
    let agg = batchEchoAgg.get(phrase);
    if (!agg) {
      agg = new Map();
      batchEchoAgg.set(phrase, agg);
    }
    agg.set(chapter, (agg.get(chapter) || 0) + count);
  }
  candidates.sort((a, b) => b.phrase.length - a.phrase.length || b.total - a.total);
  const merged = [];
  for (const cand of candidates) {
    if (merged.some((m) => m.phrase.includes(cand.phrase))) continue; // 子串让位最长形
    merged.push(cand);
  }
  merged.sort((a, b) => b.total - a.total);
  echoSuppressed += Math.max(0, merged.length - ECHO_TOP);
  for (const cand of merged.slice(0, ECHO_TOP)) {
    findings.push({
      file: path.relative('.', file),
      line: 1,
      column: 1,
      type: cand.type,
      severity: 'advisory',
      message: cand.type === 'phrase-echo-cross'
        ? `复读雷达：「${cand.phrase}」跨章窗口内出现 ${cand.total} 次（本章 ${cand.count} + 近 ${ECHO_WINDOW} 章 ${cand.winLib}）——疑似新 tic（E7 形态），仲裁：确认后进 追踪/短语黑名单.md 限额（I2 通道）或登记豁免台账；宁报不拦，一时口滑可忽略。`
        : cand.type === 'phrase-echo-ending'
        ? `章尾复读：「${cand.phrase}」本章 ${cand.count} 次且末次落章尾 20% 区域——E6 章尾同图重复形态：末段换图或删一处，别在张力点上原地打转。`
        : `同章复读：「${cand.phrase}」本章出现 ${cand.count} 次（非章尾形态）——同拍重复疑似 beat 拼接伤或新 tic；处置：确认有意复沓→登记 追踪/复沓锚句.md（签名资产）或豁免台账；否则改写卡删一处/换形。`,
      excerpt: cand.phrase,
    });
  }
}

// 台账视图：域聚合表 + 复读短语节（N2）+ 类型明细，人物之眼改写协议的查询端。
// 比喻与复读短语均为自动来源（N2：只收自动来源，手势类无机械消费端不设列）。
function renderImageryView(imagery, phrases) {
  const lines = [
    '# 意象台账',
    '',
    '> 比喻/闲笔资产登记（P6-2）＋复读短语自动沉淀（N2）：哪个域、被谁用过几次。「人物之眼」改写协议的消费端——**换域，而不是换词**。',
    '> 改写时查此表：某域已被同一角色反复采撷就换未用域，换词不换域仍是坍缩。',
    '',
  ];
  if (imagery.length > 0) {
    const byDomain = new Map();
    for (const m of imagery) {
      if (!byDomain.has(m.domain)) byDomain.set(m.domain, []);
      byDomain.get(m.domain).push(m);
    }
    lines.push('| 域 | 次数 | 角色分布 | 最近章 |');
    lines.push('|---|---|---|---|');
    for (const [domain, items] of [...byDomain.entries()].sort((a, b) => b[1].length - a[1].length)) {
      const roles = new Map();
      for (const m of items) {
        const r = m.character || '未归属';
        roles.set(r, (roles.get(r) || 0) + 1);
      }
      const roleText = [...roles.entries()].map(([r, c]) => `${r}(${c})`).join(' ');
      const lastChapter = Math.max(...items.map((m) => m.chapter));
      lines.push(`| ${domain} | ${items.length} | ${roleText} | 第${lastChapter}章 |`);
    }
  } else {
    lines.push('> 暂无比喻句登记（叙述段含「像/如/仿佛」等标记词时自动登记）。');
  }
  // 复读短语节（N2 沉淀 / N3 取数源）：写前 {{禁止}} 注入从这里读，零新步骤。
  lines.push('', '## 复读短语（N1 自动沉淀）');
  if (!(phrases && phrases.length > 0)) {
    lines.push('> 暂无（雷达未捕获窗口复现 ≥2 的短语，或尚未 --commit 固化）。');
  } else {
    lines.push('> 写前注入取数（cards/README {{禁止}}）：取「最近章 ≥ 当前−5」条目，编排层选 ≤3 条贴卡。');
    lines.push('', '| 短语 | 窗口累计 | 最近章 |');
    lines.push('|---|---|---|');
    for (const p of [...phrases].sort((a, b) => (b.last || 0) - (a.last || 0) || (b.total || 0) - (a.total || 0))) {
      lines.push(`| ${p.phrase} | ${p.total} | 第${p.last || 0}章 |`);
    }
  }
  // 类型明细（N2）：比喻/复读短语混排，按章号降序取最近 100 条。
  lines.push('', '## 明细（最近 100 条）');
  const detailRows = [
    ...imagery.map((m) => ({ chapter: m.chapter, type: '比喻', domain: m.domain, meta: m.character || '—', text: m.excerpt })),
    ...(phrases || []).map((p) => ({ chapter: p.last || 0, type: '复读短语', domain: '—', meta: `${p.total || 0} 次`, text: p.phrase })),
  ].sort((a, b) => b.chapter - a.chapter).slice(0, 100);
  for (const r of detailRows) {
    lines.push(`- 第${r.chapter}章｜${r.type}｜${r.domain}｜${r.meta}｜「${r.text}」`);
  }
  return `${lines.join('\n')}\n`;
}

// ---------- --commit：同章旧指纹/旧意象先清再插，写盘 + 台账视图（N1 含 phrases 合并） ----------

let committed = 0;
if ((options.commit || options.recoverLibrary) && pending.length > 0) {
  const touchedChapters = [...new Set(pending.map((e) => e.chapter))];
  library.entries = library.entries.filter((e) => !touchedChapters.includes(e.chapter));
  library.entries.push(...pending);
  library.imagery = library.imagery.filter((e) => !touchedChapters.includes(e.chapter));
  library.imagery.push(...pendingImagery);
  // N1 phrases 三步合并（幂等）：① 清 touched 章旧样本 ② 并入批级聚合（新条目须
  // 复现 ≥2 才建，防膨胀——全量 n-gram 每章上万条，不滤必膨胀）③ 修剪+派生重算：
  // total/last 恒为 recent 的派生值，窗口口径自动一致，重跑同章结果不变。
  const maxTouched = Math.max(...touchedChapters);
  for (const p of library.phrases) {
    p.recent = (p.recent || []).filter((s) => !touchedChapters.includes(s.c));
  }
  // U3 同族去重：批内候选按长度降序排，是已保留条目子串的直接丢弃（只记最长命中）——
  // 一个 8 字 tic 不再拖 4-7 字子串各记一行（v4 "袖袋里的算盘"一族 14 行的表膨胀形态，
  // {{禁止}} 注入取数被噪音污染）。「已保留」＝实际入库（并入既有条目或新条目过 ≥2
  // 门槛）；最长形复现 <2 未入库时不吞子串——子串自身 ≥2 仍是真信号。门槛本身不动
  // （提 ≥3 会漏"钱压在碗底下×2"类真缺陷，不采）；跨批旧短形态无新样本补给，靠
  // 修剪线（last < max−10）自然老化出库。
  const retainedPhrases = [];
  const mergeAgg = [];
  for (const [phrase, byChapter] of [...batchEchoAgg.entries()].sort((a, b) => b[0].length - a[0].length)) {
    if (retainedPhrases.some((kept) => kept.includes(phrase))) continue; // 子串让位最长形
    let batchTotal = 0;
    for (const n of byChapter.values()) batchTotal += n;
    const existing = phraseIndex.get(phrase);
    if (!existing && batchTotal < 2) continue; // 入库门槛：窗口复现 ≥2 才建新条目（docs/07 N1）
    retainedPhrases.push(phrase);
    mergeAgg.push([phrase, byChapter, existing]);
  }
  for (const [phrase, byChapter, existing] of mergeAgg) {
    let entry = existing;
    if (!entry) {
      entry = { phrase, total: 0, last: 0, recent: [] };
      library.phrases.push(entry);
      phraseIndex.set(phrase, entry);
    }
    for (const [c, n] of byChapter) entry.recent.push({ c, n });
  }
  library.phrases = library.phrases.filter((p) => {
    p.recent = p.recent.filter((s) => s.c >= maxTouched - ECHO_STORE_SPAN);
    p.total = p.recent.reduce((acc, s) => acc + s.n, 0);
    p.last = p.recent.reduce((acc, s) => Math.max(acc, s.c), 0);
    return p.total >= 2 && p.last >= maxTouched - ECHO_STORE_SPAN;
  });
  phraseIndex.clear();
  for (const p of library.phrases) phraseIndex.set(p.phrase, p);
  library.schema_version = LIB_SCHEMA;
  if (libraryPath) {
    try {
      fs.mkdirSync(path.dirname(libraryPath), { recursive: true });
      // D2：原子临时替换（同目录 rename，半截写盘不产生损坏库）。
      atomicWrite(libraryPath, `${JSON.stringify(library, null, 2)}\n`);
      atomicWrite(path.join(path.dirname(libraryPath), '意象台账.md'), renderImageryView(library.imagery, library.phrases));
      committed = pending.length;
    } catch (error) {
      failed = true;
      if (!options.json) console.error(`${libraryPath}: unable to write library (${error.message})`);
    }
  } else {
    failed = true;
    if (!options.json) console.error('--commit requires a project root (use --project or run inside 正文/)');
  }
}

// ---------- D2：--recover-library 基线重放后的复检（不冒充通过，任务书 §2.6） ----------
if (options.recoverLibrary) {
  if (failed) {
    if (options.json) {
      console.log(JSON.stringify({ recovered: false, quarantine: quarantinePath || null, error: 'replay_write_failed' }));
    } else {
      console.error('指纹库恢复失败：基线重放写盘出错（见上）。');
    }
    process.exit(2);
  }
  if (!quarantinePath) {
    // 库健康（或不存在、刚由普通重放生成）：no-op，不破坏好库。
    if (options.json) console.log(JSON.stringify({ recover_library: 'healthy', quarantine: null }));
    else console.error('指纹库可解析且形状合法，无需恢复。');
    process.exit(0);
  }
  // 复检：以重建后的库对同一正式正文目录跑一次只读 --fail-on=block 全扫。
  const verify = spawnSync(process.execPath,
    [__filename, '--json', '--fail-on=block', path.resolve(options.targets[0])],
    { encoding: 'utf8' });
  const ok = verify.status === 0;
  if (options.json) {
    let verification = { status: verify.status };
    try { verification.scan = JSON.parse(verify.stdout || '{}'); } catch (_) { verification.stdout = verify.stdout || null; }
    console.log(JSON.stringify({
      recovered: ok,
      quarantine: quarantinePath,
      chapters: scannedChapters.length,
      verification,
    }));
  } else {
    process.stdout.write(verify.stdout || '');
    console.error(`损坏库已隔离至 ${quarantinePath}，并从正式正文基线全量重放；复检${ok ? '通过' : `存在阻断/错误（exit ${verify.status}）——恢复不把检测失败冒充通过`}。`);
  }
  process.exit(verify.status === 0 ? 0 : (verify.status === 1 ? 1 : 2));
}

// ---------- I1 指纹库欠账检测（章检模式，docs/06 §三） ----------
// 库最大登记章号 < 受检正文最大章号 → blocking。时序依据（E3）：写章循环第 6 步（追踪
// 提交+指纹固化）先于第 7 步章检——章检时当前章应已入库，落后 1 章即欠账、无容差（勿按
// 「章检先于提交」的直觉加 off-by-one 容差；库 ≥ 受检——如回炉重检旧章——不报）。
// --commit 模式不查（commit 本身就是补齐动作）。存量欠账项目首跑必红是设计行为（D10）：
// 白银案录现状指纹库到 ch61、正文到 ch63，下次章检首跑即报，须先 --commit 补登 62/63。
if (!options.commit && !options.prepublish && scannedChapters.length > 0 && libraryPath) {
  const targetMax = Math.max(...scannedChapters);
  const libraryMax = library.entries.reduce((acc, e) => Math.max(acc, e.chapter), 0);
  if (libraryMax < targetMax) {
    findings.push({
      file: path.relative('.', files[0]),
      line: 1,
      column: 1,
      type: 'fingerprint-arrears',
      severity: 'blocking',
      message: `指纹库欠账：库登记至第 ${libraryMax} 章，受检正文至第 ${targetMax} 章——第 ${libraryMax + 1} 章起未固化，先跑 --commit 补齐再过章检（写章循环第 6 步：追踪提交+指纹固化为原子双命令）`,
      excerpt: '',
    });
  }
}

try {
  handling.finalizeFindings(findings, 'guyin-check-repetition.js');
} catch (error) {
  die(error.message);
}

const summary = {
  files_scanned: files.length,
  paragraphs_scanned: paragraphsScanned,
  library_entries: library.entries.length,
  near_hits: findings.filter((f) => f.type === 'para-repeat-near').length,
  pattern_hits: findings.filter((f) => f.type === 'para-repeat-pattern').length,
  imagery_hits: findings.filter((f) => f.type === 'imagery-domain-run').length,
  domain_stale_hits: findings.filter((f) => f.type === 'metaphor-domain-stale').length,
  echo_hits: findings.filter((f) => f.type.startsWith('phrase-echo-')).length,
  echo_suppressed: echoSuppressed,
  phrases_stored: library.phrases.length,
  arrears_hits: findings.filter((f) => f.type === 'fingerprint-arrears').length,
  committed,
};

if (options.json) {
  process.stdout.write(`${JSON.stringify({ summary, findings }, null, 2)}\n`);
} else {
  if (summary.library_entries === 0 && !options.commit) {
    console.log(`# 指纹库为空（首章或未 --commit 过）：${summary.paragraphs_scanned} 段叙述段暂无历史可比`);
  }
  for (const f of findings) {
    console.log(`${f.file}:${f.line}:${f.column}: [${handling.label(f)}] ${f.type}: ${f.message}`);
  }
  if (summary.echo_suppressed > 0) {
    console.log(`# 复读雷达另有 ${summary.echo_suppressed} 个候选超 top10 截断未列出（防噪③，只进计数）`);
  }
  if (options.commit && committed > 0) {
    console.log(`# 已固化 ${committed} 段指纹入库（${summary.library_entries} 条在库；短语台账 ${summary.phrases_stored} 条）`);
  }
}

if (failed) process.exit(2);
process.exit(handling.gateTripped(findings, options.failOn) ? 1 : 0);

function die(message) {
  console.error(message);
  console.error(USAGE.trimEnd());
  process.exit(2);
}
