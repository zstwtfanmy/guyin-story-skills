#!/usr/bin/env node
'use strict';

// guyin-hook.js — 隐笔硬护栏 hook 核（宿主增强层，node 单文件，无 bash 依赖，Windows 友好）
//
// 三个子命令（宿主端注册见 ../settings.json，Claude Code；其他宿主无此机制时靠
// SKILL.md / AGENTS.md 纪律兜底——本层是增强不是承重）：
//   guard       PreToolUse(Write|Edit|MultiEdit)。stdin=工具负载 JSON。exit 2=阻断（stderr 引导文案）。
//   post-write  PostToolUse(Write|Edit|MultiEdit)。stdin 同上。exit 0 永不阻断，stdout 注入兜底提醒。
//   session     SessionStart(startup|resume|compact)。stdout 注入恢复摘要；无信息完全静默。
//
// 设计红线（对齐框架哲学，勿"顺手增强"）：
//   1. 确定性边界：只做存在性 / schema / 字数 / 极短 / mtime 同步性五类确定性信号；毒句式、
//      AI 句式、细纲照搬等规则权威在 skills/guyin-write/scripts/ 五个 guyin-check 脚本，本核零重复实现。
//   2. fail-open：解析失败、非隐笔项目、任何不确定一律放行——宁可漏拦不可误伤。
//   3. 注入面纪律：session 只注入结构状态（追踪/上下文、state、run 指针、git 进度），
//      作者性/ 目录（气卡等）永不注入——气不进自动流。
//   4. 豁免权在台账：章检报警的豁免一律走
//      追踪/豁免台账.md（五测试），本核不认正文内标记。
//   5. 正文只由 publish 安装（v4）：guard 不再以细纲/骨架/快照为直写许可——对正式章/篇的
//      直接 Write/Edit 一律拦，指引「先候选（.guyin/work/<run>/drafts/）、后 publish」。
//      publish 的文件安装不经 Write/Edit hook，本核也不提供可伪造的放行行标志。
//
// 书项目判定：目标文件父目录为「正文」，且其上级存在 大纲/ 或 追踪/ 目录——
// 非隐笔项目（目录名恰好叫"正文"的普通文件夹）静默放行。
//
// session 书根解析（v4，防宿主自动注入带偏）：
//   显式 --project <B> [--run <ID>] ＞ hook 自身部署锚（__dirname/../..，且锚下有
//   追踪/_tracking-state.json）＞ CLAUDE_PROJECT_DIR ＞ cwd；显式根/run 不存在即报告，
//   不静默回退另一本书；多个 run 只列候选不擅选。

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

// 章去空白字数下限：细纲目标驱动（O3，docs/06 §二；双口径 J1，docs/07 §二）——探测
// 大纲/细纲_第N章*.md 的「字数目标」：区间 X-Y 取下限 X（区间下限本身是作者接受的
// 最低值不再打折），单值 T 取 T×90%；细纲缺失或无字数目标 → 缺省 3000。区间正则
// 含全角横线变体，须先于单值正则试配，否则「3000-3300」被截为 3000。
// 同步注释契约（O3/D1）：本检查与技能库 skills/guyin-write/scripts/guyin-check-wordcount.js
// 的 resolveMin 是同一逻辑的两份实现——hook 为部署件随项目走、脚本在技能库，运行时路径
// 不保证可达，无法抽公共模块；改一处必改另一处（比值/缺省值/细纲探测口径）。
const CHAPTER_DEFAULT_MIN = 3000;
const CHAPTER_TARGET_RATIO = 0.9;

// 大纲/ 下按整数章号匹配 细纲_第N章*.md 并读「字数目标」行（容忍补零差异与标题后缀）。
function resolveChapterMin(bookDir, num) {
  try {
    const name = fs.readdirSync(path.join(bookDir, '大纲'))
      .find((n) => {
        const m = /^细纲_第0*(\d+)章.*\.md$/.exec(n);
        return m !== null && parseInt(m[1], 10) === num;
      });
    if (name) {
      const text = fs.readFileSync(path.join(bookDir, '大纲', name), 'utf8');
      for (const line of text.split(/\r?\n/)) {
        if (line.includes('字数目标')) {
          const range = /(\d+)\s*[-—－~～至]\s*(\d+)/.exec(line);
          if (range) return { min: Number(range[1]), origin: `细纲区间下限 ${range[1]}（目标 ${range[1]}-${range[2]}，J1）` };
          const m = /(\d+)/.exec(line);
          if (m) return { min: Math.round(Number(m[1]) * CHAPTER_TARGET_RATIO), origin: `细纲目标 ${m[1]} × 90%` };
        }
      }
    }
  } catch (e) {
    /* 大纲/ 缺失或读失败 → 走缺省 */
  }
  return { min: CHAPTER_DEFAULT_MIN, origin: `缺省 ${CHAPTER_DEFAULT_MIN}` };
}

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch (e) {
    return '';
  }
}

// 从工具负载抽目标路径：tool_input.file_path / path / filePath（Write/Edit/MultiEdit 三态）。
function payloadTarget(raw) {
  try {
    const p = JSON.parse(raw);
    const ti = p && p.tool_input;
    const v = ti && (ti.file_path || ti.path || ti.filePath);
    return typeof v === 'string' && v ? v : null;
  } catch (e) {
    return null;
  }
}

function chapterNum(base) {
  const m = /^第0*(\d+)章.*\.md$/.exec(base);
  return m ? parseInt(m[1], 10) : null;
}

function readState(bookDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(bookDir, '追踪', '_tracking-state.json'), 'utf8'));
  } catch (e) {
    return null;
  }
}

// D2 发布门：追踪/_publication.json 缺失=无在途发布（放行）；存在但损坏/阶段未到
// complete = 上次发布中断或落盘不一致，写正文一律拦，先 recover，不允许带着悬置
// 发布继续写（跨语言契约见 guyin-tracking-commit.py 发布状态机，任务书 §2.6）。
function publicationBlocker(bookDir) {
  const p = path.join(bookDir, '追踪', '_publication.json');
  if (!fs.existsSync(p)) return null;
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    return { broken: true, stage: null };
  }
  if (!doc || typeof doc !== 'object' || typeof doc.stage !== 'string') {
    return { broken: true, stage: null };
  }
  if (doc.stage === 'complete') return null;
  return { broken: false, stage: doc.stage, runId: doc.run_id || null };
}

function isBookDir(dir) {
  // 逐个探测：首项不存在时 statSync 抛异常，`||` 短路会直接跳 catch 把后面的探测全部
  // 吞掉（「有大纲无追踪」「有追踪无大纲」两种半项目都会被误判非书项目）。
  for (const sub of ['大纲', '追踪']) {
    try {
      if (fs.statSync(path.join(dir, sub)).isDirectory()) return true;
    } catch (e) {
      /* 试下一个标记目录 */
    }
  }
  return false;
}

// 去空白字数，与 guyin-check-wordcount.js 同口径：剥 YAML frontmatter 与 markdown 标题行。
function visibleChars(text) {
  const lines = text.split(/\r?\n/);
  let inFront = lines[0] !== undefined && lines[0].trim() === '---';
  let body = '';
  for (let i = 0; i < lines.length; i += 1) {
    if (inFront) {
      if (i > 0 && lines[i].trim() === '---') inFront = false;
      continue;
    }
    if (/^\s*#{1,6}\s/.test(lines[i])) continue;
    body += lines[i];
  }
  return body.replace(/\s/g, '').length;
}

function stateProblem(st) {
  // D1：接受 tracking-commit 支持的全谱 schema（4-7，读入兼容、写盘归一 v7）；
  // 旧模板的 schema 1 已废弃——模板现随 init 管线生成 v7 合法空态。
  return !st || ![4, 5, 6, 7].includes(st.schema_version) || !Number.isInteger(st.last_committed_chapter);
}

// ---------------------------------------------------------- U1/U4（docs/09 §二；D3 任务书 §2.4）
// U1 待审门（D3 八列契约）：解析 追踪/待审台账.md（八列按表头名定位，列序可调），
// 章号 < num、版本匹配当前正文且未终态的行数（0=过）。
//   - 处置类别 ∈ {hard, verify}——editorial 留审读记录不入台账，出现即数据异常；
//   - 正文版本 = hash12（文件字节 sha256 前 12 hex，与 guyin-check-trial-gate.js --hash
//     同口径）；空=按当前保守在册；与当前盘上正文不匹配的历史行只记录不阻塞；
//   - 终态严格完整匹配：未修复/修复中/未知字串均 open（E16）；
//   - 「升级作者」是等待态（Fw-07/D3）：「已裁决：」只是线索，仅用户真实决定转结
//     （终态列改五选一＋决定依据证据）才闭合；
//   - 证据（决定依据列）：修复=版本非空+复检／豁免=豁免台账／契约修订=偏差／
//     顺延=伏笔+数字／不适用=位置（章/行/段/L 号）+理由（去位置后 ≥6 字）；
//   - 台账缺失/损坏/读取失败 → {error}（guard 拦并报告，不再 fail-open——已部署项目
//     缺台账须停靠；非书项目由 guard 前置 isBookDir 放行，不误拦）。
// 同步注释契约（U1/D2）：与技能库 skills/guyin-write/scripts/guyin-check-pending.js 的
// parseLedger/rowOpenReason 是同一逻辑的两份实现（部署件/技能库路径不互通）；改一处必改
// 另一处（八列表头定位/严格匹配/等待态/证据/版本比对/损坏即错）。章号口径与脚本不同
// （hook 用 < num，脚本 --through 用 <= N），勿统一。
const PENDING_COLUMNS = ['章号', '来源', '报警/发现', '处置类别', '正文版本', '终态', '决定依据', '去向/备注'];
const PENDING_TERMINAL = ['修复', '豁免', '契约修订', '顺延', '不适用'];
const PENDING_HANDLING = ['hard', 'verify'];
const PENDING_HASH12 = /^[0-9a-f]{12}$/;

function pendingNaEvidence(basis) {
  const n = (basis || '').trim();
  if (!n) return false;
  const posRe = /(第\s*0*\d+\s*章|L\s*0*\d+|\d+\s*[行段]|行\s*\d+|段\s*\d+|:\s*0*\d+)/i;
  if (!posRe.test(n)) return false;
  return n.replace(/(第\s*0*\d+\s*章|L\s*0*\d+|\d+\s*[行段]|行\s*\d+|段\s*\d+|:\s*0*\d+)/gi, '').replace(/\s/g, '').length >= 6;
}

function pendingRowIsOpen(state, version, basis) {
  if (state === '' || state === '待审') return true;
  if (state === '升级作者') return true; // 等待态：仅用户真实决定转结（改五终态＋证据）
  if (!PENDING_TERMINAL.includes(state)) return true; // 严格完整匹配
  if (state === '修复') return !(version !== '' && basis.includes('复检'));
  if (state === '豁免') return !basis.includes('豁免台账');
  if (state === '契约修订') return !basis.includes('偏差');
  if (state === '顺延') return !(basis.includes('伏笔') && /\d/.test(basis));
  return !pendingNaEvidence(basis); // 不适用
}

function pendingChapterHash(bookDir, chNum) {
  try {
    const dir = path.join(bookDir, '正文');
    const name = fs.readdirSync(dir).find((n) => {
      const m = /^第0*(\d+)章.*\.md$/.exec(n);
      return m !== null && parseInt(m[1], 10) === chNum;
    });
    if (!name) return null;
    return crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, name))).digest('hex').slice(0, 12);
  } catch (e) {
    return null;
  }
}

function pendingBlockers(bookDir, num) {
  let text;
  try {
    text = fs.readFileSync(path.join(bookDir, '追踪', '待审台账.md'), 'utf8');
  } catch (e) {
    return { count: 0, error: `追踪/待审台账.md 读取失败（${e.code === 'ENOENT' ? '已部署项目缺台账' : e.message}）——走 /guyin-setup 修复或按模板建合法空表，不静默放行` };
  }
  let idx = null;
  let count = 0;
  let lineNo = 0;
  for (const line of text.split(/\r?\n/)) {
    lineNo += 1;
    const t = line.trim();
    if (!t.startsWith('|')) continue;
    if (t.includes('{{') || /^[-|:\s]+$/.test(t)) continue;
    const cells = t.split('|').map((c) => c.trim());
    if (idx === null) {
      const map = {};
      for (let c = 1; c < cells.length - 1; c += 1) {
        if (cells[c] === '') continue;
        if (map[cells[c]] !== undefined) return { count: 0, error: `待审台账表头列名重复「${cells[c]}」` };
        map[cells[c]] = c;
      }
      const missing = PENDING_COLUMNS.filter((n) => map[n] === undefined);
      if (missing.length > 0) {
        return { count: 0, error: `待审台账缺列「${missing.join('、')}」（八列契约，D3）——旧格式台账须按模板迁移` };
      }
      idx = map;
      continue;
    }
    if (cells.length - 2 !== PENDING_COLUMNS.length) {
      return { count: 0, error: `待审台账第 ${lineNo} 行损坏（${cells.length - 2} 列，应为 8）——不静默跳过` };
    }
    const chRaw = cells[idx['章号']];
    if (!/^\d+$/.test(chRaw)) {
      return { count: 0, error: `待审台账第 ${lineNo} 行章号「${chRaw}」非纯数字` };
    }
    if (!PENDING_HANDLING.includes(cells[idx['处置类别']])) {
      return { count: 0, error: `待审台账第 ${lineNo} 行处置类别「${cells[idx['处置类别']] || '（空）'}」非法——台账只收 hard/verify（editorial 留审读记录）` };
    }
    const version = cells[idx['正文版本']];
    if (version !== '' && !PENDING_HASH12.test(version)) {
      return { count: 0, error: `待审台账第 ${lineNo} 行正文版本「${version}」非法（须 hash12，--hash 生成禁手编）` };
    }
    const ch = parseInt(chRaw, 10);
    if (ch >= num) continue;
    const cur = pendingChapterHash(bookDir, ch);
    if (version !== '' && cur !== null && version !== cur) continue; // 历史版本行：只记录不阻塞
    if (pendingRowIsOpen(cells[idx['终态']], version, cells[idx['决定依据']])) count += 1;
  }
  if (idx === null) return { count: 0, error: '待审台账无八列表头——旧格式须按模板迁移（D3）' };
  return { count, error: null };
}

// ---------------------------------------------------------- guard（阻断守卫）
function guard() {
  const target = payloadTarget(readStdin());
  if (!target) process.exit(0); // fail-open：无目标路径不判
  const abs = path.resolve(target);
  if (path.basename(path.dirname(abs)) !== '正文') process.exit(0);
  const bookDir = path.dirname(path.dirname(abs));
  if (!isBookDir(bookDir)) process.exit(0); // 非隐笔项目防误伤
  // D2 发布门（最高优先）：在途/损坏发布未恢复前，正文一律不可动。
  const publication = publicationBlocker(bookDir);
  if (publication) {
    if (publication.broken) {
      console.error('⛔ 写正文被拦截：追踪/_publication.json 损坏（无法解析或字段缺失）。');
      console.error('   发布状态文件是发布器权威账本，损坏不得静默忽略；人工核查后运行 guyin-tracking-commit.py recover --project . 恢复。');
    } else {
      console.error(`⛔ 写正文被拦截：发布进行到一半（阶段=${publication.stage}，run_id=${publication.runId || '未知'}）。`);
      console.error('   先运行 guyin-tracking-commit.py recover --project . 续跑至 complete（或人工裁决），再写正文；禁止并行第二条发布。');
    }
    process.exit(2);
  }

  const base = path.basename(abs);
  const num = chapterNum(base);

  // 状态门（章号文件）：state 缺失/schema 不符、章序跳跃都不允许动正式章。
  if (num !== null) {
    const st = readState(bookDir);
    if (stateProblem(st)) {
      console.error('⛔ 写正文被拦截：追踪状态缺失或 schema 不符（追踪/_tracking-state.json）。');
      console.error('   先完成项目初始化，或运行 guyin-tracking-commit.py 处理在途发布/前章事务。');
      process.exit(2);
    }
    if (Number.isInteger(st.last_committed_chapter) && st.last_committed_chapter < num - 1) {
      console.error(`⛔ 写正文被拦截：上一章（第 ${num - 1} 章）追踪未发布（last_committed_chapter=${st.last_committed_chapter}）。`);
      console.error('   正式章按 last_committed+1 由 publish 顺序安装；先完成前章候选与发布（或 recover 在途发布），不靠直写建章。');
      process.exit(2);
    }
  }

  // U1 待审门（章号文件，新建/修订都查）：更早章、版本匹配当前正文的未决 finding 阻塞动章。
  if (num !== null) {
    const pending = pendingBlockers(bookDir, num);
    if (pending.error) {
      console.error(`⛔ 写正文被拦截：待审台账异常——${pending.error}。`);
      console.error('   台账是阻断账本，损坏不得静默跳过；修复后重试（guyin-check-pending.js 核查）。');
      process.exit(2);
    }
    if (pending.count > 0) {
      console.error(`⛔ 写正文被拦截：待审台账有 ${pending.count} 行未决（章号 < ${num}，版本匹配当前正文）。`);
      console.error('   先消费回填：终态五选一＋决定依据（修复=新版本+复检／豁免=豁免台账／契约修订=偏差／顺延=伏笔+章号／不适用=位置+理由）。');
      console.error('   「升级作者」是等待态——仅用户真实决定转结（终态列改五选一＋证据）；「已裁决：」字样不解除。');
      console.error('   正文改版后旧行只记录不阻塞；当前版本须有自己的处置（guyin-check-pending.js --project 核查）。');
      process.exit(2);
    }
  }

  // v4 唯一正文通道：正式章/篇（正文/ 直接下属的章号文件或篇名 .md）一律不许直写。
  // 工程文件（README、. / _ 开头）放行；_archive/ 不在「正文」直接层，本核不管。
  // 补细纲、补快照都不是直写许可——没有可由调用方伪造的 publish 放行标志。
  const isChapterFile = num !== null;
  const isStoryFile = !isChapterFile && base.endsWith('.md')
    && base !== 'README.md' && !/^[._]/.test(base);
  if (isChapterFile || isStoryFile) {
    console.error('⛔ 写正式正文被拦截：正式章/篇只由 tracking-commit.py publish 安装（先候选、后 publish）。');
    console.error('   先在 .guyin/work/{run_id}/drafts/ 写候选 vNNNN.md，跑候选检查链＋全文回看，拿到显式发布授权后 publish；');
    console.error('   修旧章/去味走 revision 候选（mode=revision）→重检→publish，不补细纲/快照直写，不原位覆盖正式稿。');
    process.exit(2);
  }

  process.exit(0);
}

// ---------------------------------------------------------- post-write（写后兜底网）
function postWrite() {
  const target = payloadTarget(readStdin());
  if (!target) process.exit(0);
  const abs = path.resolve(target);
  if (path.basename(path.dirname(abs)) !== '正文') process.exit(0);
  const bookDir = path.dirname(path.dirname(abs));
  if (!isBookDir(bookDir)) process.exit(0);
  const base = path.basename(abs);
  if (!base.endsWith('.md')) process.exit(0);

  let buf;
  try {
    buf = fs.readFileSync(abs);
  } catch (e) {
    process.exit(0); // 文件不在（删除等），无事可兜
  }
  const out = [];
  if (buf.length < 200) {
    out.push(`【落盘】正文仅 ${buf.length} 字节，疑似未写完 / 落盘失败（额度或超时中断？），请核对补写。`);
  }
  const num = chapterNum(base);
  if (num !== null) {
    // G5 追踪同步：写入已提交章（章号 ≤ last_committed_chapter）——改动不在追踪账本里。
    // 只提醒不拦截：hook 分不清大修重提交的时序中间态与事故，主体靠协议纪律（S 级唯一合法
    // 通道 = 大修场景 + tracking-commit 重提交，见 guyin-write SKILL.md 落盘硬门③）。
    const st = readState(bookDir);
    if (st && Number.isInteger(st.last_committed_chapter) && num <= st.last_committed_chapter) {
      out.push(`【追踪同步】第 ${num} 章为已提交章（追踪已记至第 ${st.last_committed_chapter} 章），本次改动不在追踪账本里。`);
      out.push('   影响事件定性/伏笔/角色状态/时间线的修复 → guyin-write 大修场景 + tracking-commit 重提交（S 级唯一合法通道）；纯文字 S3 → guyin-deslop。');
    }
    const count = visibleChars(buf.toString('utf8'));
    const { min, origin } = resolveChapterMin(bookDir, num);
    if (count < min) {
      out.push(`【字数】第 ${num} 章去空白 ${count} 字，低于下限 ${min}（${origin}；权威口径：guyin-check-wordcount.js，--min 可调）。`);
      out.push('   多为 beat 缺斤短两或拼接缺 beat——补写缺口 beat，勿机械注水。');
    }
  }
  if (out.length === 0) process.exit(0); // 无发现完全静默，不污染上下文
  console.log(`=== 隐笔正文兜底（${base}）===`);
  console.log(out.join('\n'));
  console.log('本网只是兜底：完整章检仍须按 guyin-write 步骤 6 依次跑四个 guyin-check 脚本；报警拦为待审，豁免走 追踪/豁免台账.md。');
  process.exit(0);
}

// ---------------------------------------------------------- session（恢复注入）

// 书根解析：显式 --project ＞ 部署锚（hook 位于 B/.claude/hooks/，锚下有 state 才算书）
// ＞ CLAUDE_PROJECT_DIR ＞ cwd。显式根非法要报告，不静默换一本书注入。
function parseSessionArgs(argv) {
  const out = { project: null, run: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--project') {
      out.project = argv[i + 1] || null;
      i += 1;
    } else if (argv[i].startsWith('--project=')) {
      out.project = argv[i].slice('--project='.length);
    } else if (argv[i] === '--run') {
      out.run = argv[i + 1] || null;
      i += 1;
    } else if (argv[i].startsWith('--run=')) {
      out.run = argv[i].slice('--run='.length);
    }
  }
  return out;
}

function looksLikeBook(dir) {
  try {
    return isBookDir(dir) && fs.statSync(path.join(dir, '追踪', '_tracking-state.json')).isFile();
  } catch (e) {
    return false;
  }
}

function resolveSessionRoot(explicit) {
  if (explicit) {
    const dir = path.resolve(explicit);
    if (!looksLikeBook(dir)) {
      return { root: null, explicitError: dir };
    }
    return { root: dir, explicit: true };
  }
  // 部署锚：__dirname = B/.claude/hooks
  const anchor = path.resolve(__dirname, '..', '..');
  if (looksLikeBook(anchor)) return { root: anchor, explicit: false, anchored: true };
  const envRoot = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  if (looksLikeBook(envRoot)) return { root: envRoot, explicit: false, anchored: false };
  return { root: null, explicit: false };
}

function discoverRuns(root) {
  const base = path.join(root, '.guyin', 'work');
  let names = [];
  try {
    names = fs.readdirSync(base, { withFileTypes: true })
      .filter((d) => d.isDirectory() && fs.existsSync(path.join(base, d.name, 'author-session.json')))
      .map((d) => d.name)
      .sort();
  } catch (e) {
    return [];
  }
  return names;
}

function readRunSummary(root, runId) {
  const file = path.join(root, '.guyin', 'work', runId, 'author-session.json');
  try {
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    return {
      run_id: runId,
      phase: typeof doc.phase === 'string' ? doc.phase : '?',
      draft: doc.draft && doc.draft.path ? path.basename(doc.draft.path) : null,
      complete: Boolean(doc.draft && doc.draft.complete),
      review: Boolean(doc.review),
      transaction: Boolean(doc.transaction),
      check_evidence: Boolean(doc.check_evidence),
      plan_patch: Boolean(doc.plan_patch),
      next_action: typeof doc.next_action === 'string' ? doc.next_action : null,
    };
  } catch (e) {
    return null;
  }
}

function session() {
  const args = parseSessionArgs(process.argv.slice(3));
  const resolved = resolveSessionRoot(args.project);
  if (resolved.explicitError) {
    console.log('=== 隐笔会话恢复 ===');
    console.log(`⚠️ 显式 --project 指向的书根不可用：${resolved.explicitError}`);
    console.log('   需要含 追踪/_tracking-state.json 的隐笔书根；未注入任何其他目录的状态，请核对 -project 后重试。');
    process.exit(0);
  }
  const root = resolved.root;
  if (!root) process.exit(0); // 非书项目/模板开发态：完全静默

  const lines = [];

  // 在途发布最先报：恢复动作只能是 recover，不能被「先补追踪提交」误导。
  const publication = publicationBlocker(root);
  if (publication) {
    if (publication.broken) {
      lines.push('⚠️ 追踪/_publication.json 损坏：停人工核查，再 guyin-tracking-commit.py recover；不要另写一稿绕过。');
    } else {
      lines.push(`⚠️ 发布在途（阶段=${publication.stage}，run_id=${publication.runId || '未知'}）：先 tracking-commit.py recover 收尾，禁止开新 run。`);
    }
  }

  // run 指针：显式 --run 校验存在性；未指定时只列候选，多个不擅选。
  const runs = discoverRuns(root);
  let chosenRun = null;
  if (args.run) {
    if (!runs.includes(args.run)) {
      lines.push(`⚠️ 显式 --run ${args.run} 不存在（${runs.length ? '候选：' + runs.join('、') : '本书无 run'}）；未自动选择其他 run。`);
    } else {
      chosenRun = args.run;
    }
  } else if (runs.length === 1) {
    chosenRun = runs[0];
  } else if (runs.length > 1) {
    lines.push(`存在多个未完成 run，须显式指定不擅选：${runs.join('、')}`);
    lines.push('   guyin-author-session.py status --project <B> --run <ID> 核对后再继续。');
  }
  if (chosenRun) {
    const s = readRunSummary(root, chosenRun);
    if (!s) {
      lines.push(`run ${chosenRun} 的 author-session.json 不可读：repair 前不自动猜恢复点。`);
    } else {
      const ev = [`review ${s.review ? '✓' : '✗'}`, `transaction ${s.transaction ? '✓' : '✗'}`,
        `check-evidence ${s.check_evidence ? '✓' : '✗'}`].join('，');
      lines.push(`当前 run：${s.run_id}（phase=${s.phase}，稿=${s.draft || '无'}${s.complete ? '/完整' : ''}；${ev}）`);
      if (s.next_action) lines.push(`下一动作：${s.next_action}`);
    }
  }

  const ctx = path.join(root, '追踪', '上下文.md');
  if (fs.existsSync(ctx)) {
    try {
      const head = fs.readFileSync(ctx, 'utf8').split(/\r?\n/).slice(0, 20).join('\n').trimEnd();
      lines.push('--- 当前位置（追踪/上下文.md 头部）---', head, '---');
    } catch (e) {
      /* 读不到就跳过这一节 */
    }
  }
  const st = readState(root);
  if (st && Number.isInteger(st.last_committed_chapter)) {
    lines.push(`追踪：已提交至第 ${st.last_committed_chapter} 章（state revision ${Number.isInteger(st.state_revision) ? st.state_revision : '?'}）。`);
    // G5 同步性扫描（fail-open）：已提交章正文 mtime 晚于 state（改动未进账本）→ 提醒走大修重
    // 提交；已落盘章未提交（落盘与提交之间的中断）→ 在途发布优先 recover，否则提醒补提交。
    try {
      const stateMtime = fs.statSync(path.join(root, '追踪', '_tracking-state.json')).mtimeMs;
      const stale = [];
      const untracked = [];
      for (const name of fs.readdirSync(path.join(root, '正文'))) {
        const m = /^第0*(\d+)章.*\.md$/.exec(name);
        if (!m) continue;
        const n = parseInt(m[1], 10);
        const mt = fs.statSync(path.join(root, '正文', name)).mtimeMs;
        if (n <= st.last_committed_chapter) {
          if (mt > stateMtime) stale.push(n);
        } else {
          untracked.push(n);
        }
      }
      if (stale.length > 0) {
        lines.push(`追踪脱节：第 ${stale.join('、')} 章正文改动晚于最近追踪提交——走 revision 候选＋tracking-commit 重提交/发布，不直写正式稿。`);
      }
      if (untracked.length > 0 && !publication) {
        lines.push(`第 ${untracked.join('、')} 章候选已就绪但未发布（last_committed_chapter=${st.last_committed_chapter}）——正式正文只由 publish 安装，先核 run 与授权。`);
      }
    } catch (e) {
      /* 正文/ 不在或读失败则跳过这一节 */
    }
  }
  try {
    const r = spawnSync('git', ['-C', root, 'log', '--oneline', '-3'], { encoding: 'utf8' });
    if (r.status === 0 && r.stdout.trim()) lines.push(`最近提交：\n${r.stdout.trim()}`);
  } catch (e) {
    /* git 不在场则跳过 */
  }
  if (lines.length === 0) process.exit(0); // 有书根但无信息：静默
  console.log('=== 隐笔会话恢复 ===');
  console.log(lines.join('\n'));
  console.log('先读 追踪/上下文.md、本 run input 与 AGENTS.md 恢复状态再继续写作（compact / 新会话后必做）。');
  process.exit(0);
}

// ------------------------------------------------------------ 分发（fail-open 总兜底）
const cmd = process.argv[2];
const handlers = { guard, 'post-write': postWrite, session };
const handler = handlers[cmd];
if (!handler) {
  console.error('usage: node guyin-hook.js <guard|post-write|session>');
  process.exit(2);
}
try {
  handler();
} catch (e) {
  process.exit(0); // 兜底不能反噬流程：任何异常按放行处理
}
