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
//   3. 注入面纪律：session 只注入结构状态（追踪/上下文、state、git 进度），
//      作者性/ 目录（气卡等）永不注入——气不进自动流。
//   4. 豁免权在台账：细纲/骨架缺失没有豁免通道，只能补纲；章检报警的豁免一律走
//      追踪/豁免台账.md（五测试），本核不认正文内标记。
//
// 书项目判定：目标文件父目录为「正文」，且其上级存在 大纲/ 或 追踪/ 目录——
// 非隐笔项目（目录名恰好叫"正文"的普通文件夹）静默放行。

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

// 大纲/ 下按整数章号匹配 细纲_第N章*.md（容忍补零差异与标题后缀）。
function hasOutlineFor(bookDir, num) {
  try {
    return fs.readdirSync(path.join(bookDir, '大纲'))
      .some((name) => {
        const m = /^细纲_第0*(\d+)章.*\.md$/.exec(name);
        return m !== null && parseInt(m[1], 10) === num;
      });
  } catch (e) {
    return false;
  }
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

// U4 覆盖门：Write/Edit 已存在的章文件时，正文/_archive/ 须有该章快照且其 mtime ≥
// 目标文件当前 mtime——裸奔覆盖式重写两次（v1、v3 稿永久丢失）的确定性封堵。
// 规则零语义判断（只比 mtime）：快照命名 第N章_vK_时间戳.md（同章号即认）；
// 每次连续改稿都要重新快照上一版＝「每一版都不许无存档消失」的语义。
function hasFreshSnapshot(bookDir, targetAbs, num) {
  try {
    const targetMtime = fs.statSync(targetAbs).mtimeMs;
    const archiveDir = path.join(bookDir, '正文', '_archive');
    return fs.readdirSync(archiveDir).some((n) => {
      const m = /^第0*(\d+)章.*\.md$/.exec(n);
      if (!m || parseInt(m[1], 10) !== num) return false;
      try {
        return fs.statSync(path.join(archiveDir, n)).mtimeMs >= targetMtime;
      } catch (e) {
        return false;
      }
    });
  } catch (e) {
    return false; // _archive 缺失 → 无快照
  }
}

// ---------------------------------------------------------- guard（阻断守卫）
function guard() {
  const target = payloadTarget(readStdin());
  if (!target) process.exit(0); // fail-open：无目标路径不判
  const abs = path.resolve(target);
  if (path.basename(path.dirname(abs)) !== '正文') process.exit(0);
  const bookDir = path.dirname(path.dirname(abs));
  if (!isBookDir(bookDir)) process.exit(0); // 非隐笔项目防误伤
  // D2 发布门（首建与覆盖共用）：在途/损坏发布未恢复前，正文一律不可动。
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
  const exists = fs.existsSync(abs);

  if (num !== null) {
    if (!exists) {
      // 细纲门：首建第 N 章须有第 N 章细纲（对应 guyin-write 停靠纪律：开书停在细纲交付）。
      if (!hasOutlineFor(bookDir, num)) {
        console.error(`⛔ 写正文被拦截：第 ${num} 章缺细纲（大纲/细纲_第${String(num).padStart(3, '0')}章.md）。`);
        console.error('   先走 guyin-write 补纲场景补建细纲，再写正文（不允许跳过细纲直接写作）。');
        process.exit(2);
      }
      // state 门：上一章追踪事务须已提交（落盘即提交追踪是项目不变式）。
      const st = readState(bookDir);
      if (stateProblem(st)) {
        console.error('⛔ 写正文被拦截：追踪状态缺失或 schema 不符（追踪/_tracking-state.json）。');
        console.error('   先完成项目初始化，或运行 scripts/guyin-tracking-commit.py 提交上一章事务。');
        process.exit(2);
      }
      if (st.last_committed_chapter < num - 1) {
        console.error(`⛔ 写正文被拦截：上一章（第 ${num - 1} 章）追踪事务未提交（last_committed_chapter=${st.last_committed_chapter}）。`);
        console.error('   先完成上一章的追踪提交与章检，再开新章。');
        process.exit(2);
      }
      // U1 待审门（D3）：更早章、版本匹配当前正文的未决 finding 阻塞开新章——检测必有终态，
      // 无声消失零成本是根因五；台账缺失/损坏同样拦截（不静默放行）。
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
    } else {
      // 续写/改稿：细纲门不适用，只校验 state 自身合规。
      if (stateProblem(readState(bookDir))) {
        console.error('⛔ 写正文被拦截：追踪状态缺失或 schema 不符（追踪/_tracking-state.json）。');
        console.error('   先修复追踪状态（scripts/guyin-tracking-commit.py），再续写。');
        process.exit(2);
      }
      // U4 覆盖门：动刀已存在章须先快照——裸奔覆盖 = 版本永久丢失（v1/v3 稿两代实证）。
      if (num !== null && !hasFreshSnapshot(bookDir, abs, num)) {
        console.error(`⛔ 覆盖已存在章被拦截：第 ${num} 章正文将被动刀，但 正文/_archive/ 无不早于现稿的快照。`);
        console.error('   先拷 `正文/_archive/第N章_vK_时间戳.md` 再动刀（每一版都不许无存档消失，U4）。');
        process.exit(2);
      }
    }
  } else if (!exists && !/^[._]/.test(base)) {
    // 骨架门：正文/ 下首建非章文件（短篇 {篇名}.md 等）时，大纲/ 须已有骨架件
    // （长篇细纲 / 短篇情节节点皆算）。跳过 . 开头与 _ 开头的工程文件。
    let hasSkeleton = false;
    try {
      hasSkeleton = fs.readdirSync(path.join(bookDir, '大纲')).some((n) => n.endsWith('.md'));
    } catch (e) {
      hasSkeleton = false;
    }
    if (!hasSkeleton) {
      console.error('⛔ 写正文被拦截：大纲/ 为空，正文前须先有骨架（长篇细纲 / 短篇情节节点）。');
      console.error('   先走 guyin-write（补纲）或 guyin-short-write（骨架三件）流程，再写正文。');
      process.exit(2);
    }
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
function session() {
  const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const lines = [];
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
    // 提交；已落盘章未提交（落盘与提交之间的中断）→ 提醒先补提交。git 同步等工具 touch 全库
    // 会整体误报——只提醒不拦截，诚实边界见 docs/05-实战护栏路线图.md §2 G5。
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
        lines.push(`追踪脱节：第 ${stale.join('、')} 章正文改动晚于最近追踪提交——若为 S 级修复，走 guyin-write 大修场景完成 tracking-commit 重提交。`);
      }
      if (untracked.length > 0) {
        lines.push(`第 ${untracked.join('、')} 章已落盘但追踪未提交（last_committed_chapter=${st.last_committed_chapter}）——先跑 guyin-tracking-commit.py 补提交再续写。`);
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
  if (lines.length === 0) process.exit(0); // 非书项目完全静默
  console.log('=== 隐笔会话恢复 ===');
  console.log(lines.join('\n'));
  console.log('先读 追踪/上下文.md 与 AGENTS.md 恢复状态再继续写作（compact / 新会话后必做）。');
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
