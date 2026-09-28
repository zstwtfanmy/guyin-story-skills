#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const handling = require('./lib/guyin-handling');

const USAGE = `Usage: node guyin-check-pitch.js [--json] [--fail-on=block|hard|all] name <书名> [<书名>...]
       node guyin-check-pitch.js [--json] [--fail-on=block|hard|all] blurb --blurb <简介文件> <大纲目录>
       node guyin-check-pitch.js [--json] [--fail-on=block|hard|all] titles <目录>

开书文案三判据（P7，docs/04-优化路线图.md §3 P7）——拆文能力的反向应用，
候选过滤与覆盖检查归脚本，外选与终判归作者。

  name   书名十年测试：候选含时效热词即标 [热词名]——热词是借来的势能，
         风过了名字就死；剥离热词后剩下的（人名/意象/悬念）才是名字自己的。
  blurb  简介钩子覆盖校验：前三章细纲的章尾钩子内容关键词在简介中的覆盖率——
         危机钩可隐（隐而不发是钩力），期待钩必须露（许诺要给足）；漏覆盖报
         blurb-missing-promise——简介是承诺清单，写进去的必须兑现。
  titles 章节标题判据：≤8 字、非纯抽象词（往事/心结/疑云类无钩力）、与本章
         钩子类型不错位（错位=把钩子拆了：危机章配剧透名、反转章配「真相大白」）。

处置分类（lib/guyin-handling）：hype-title / title-missing / title-too-long /
  title-abstract / title-hook-mismatch = editorial（默认门不阻断，终判归作者）；
  blurb-missing-promise = verify（简介承诺缺正文支撑，须对照核实——默认门阻断）。
Exit codes: 0 = 无未决阻断; 1 = 存在未决阻断（hard/verify）; 2 = 执行/输入错误。
--fail-on=block（默认）hard+verify 计 1; hard 仅 hard; all 含 editorial（审计模式）。`;

const HYPE_WORDS = [
  '开局', '系统', '神豪', '赘婿', '无敌', '签到', '重生', '穿越', '逆袭', '爽文',
  '我在', '直播', '别惹', '震惊', '全球', '高手', '下山', '退婚', '战神', '龙王',
];
const ABSTRACT_WORDS = ['往事', '心结', '疑云', '波澜', '思绪', '感慨', '回忆', '情绪', '感悟', '那些事'];
// 钩子错位剧透词：标题把本章钩子拆了（危机章配化险为夷/反转章配真相大白）。
const SPOILER_BY_HOOK = {
  '危机': ['化险为夷', '危机解除', '转危为安', '大难不死'],
  '反转': ['真相大白', '水落石出', '原委揭开', '内幕全揭'],
};
const HOOK_TYPES = ['危机', '反转', '期待', '悬念', '情绪'];
const HOOK_LINE = /[-*]\s*章尾钩子[：:]\s*(危机|反转|期待|悬念|情绪)[^—]*—\s*(.+)/;

const options = { json: false, failOn: 'block', command: null, blurbFile: null, targets: [] };

for (let i = 2; i < process.argv.length; i += 1) {
  const arg = process.argv[i];
  if (arg === '--json') {
    options.json = true;
  } else if (arg.startsWith('--fail-on=')) {
    try {
      options.failOn = handling.parseFailOn(arg.slice('--fail-on='.length));
    } catch (e) {
      die(e.message);
    }
  } else if (arg === '--blurb') {
    options.blurbFile = process.argv[i + 1] || die('--blurb requires a value');
    i += 1;
  } else if (arg === '-h' || arg === '--help') {
    process.stdout.write(`${USAGE}\n`);
    process.exit(0);
  } else if (arg.startsWith('-')) {
    die(`Unknown option: ${arg}`);
  } else if (options.command === null) {
    if (arg !== 'name' && arg !== 'blurb' && arg !== 'titles') die(`Unknown command: ${arg}`);
    options.command = arg;
  } else {
    options.targets.push(arg);
  }
}

if (!options.command) die('Command required (name | blurb | titles)');
if (options.targets.length === 0) die('No arguments provided for the command');

function die(message) {
  console.error(message);
  console.error(USAGE.trimEnd());
  process.exit(2);
}

const findings = [];
let report = { summary: {}, findings };

// ---------- name：十年测试 ----------

if (options.command === 'name') {
  const names = options.targets;
  const rows = names.map((name) => {
    const hits = HYPE_WORDS.filter((w) => name.includes(w));
    return { name, hype: hits, verdict: hits.length ? '热词名' : '过十年' };
  });
  for (const row of rows) {
    if (row.hype.length > 0) {
      findings.push({
        type: 'hype-title',
        severity: 'advisory',
        message: `书名「${row.name}」含时效热词（${row.hype.join('、')}）——热词是借来的势能，风过了名字就死；剥离热词看剩下什么，剩不下东西就不是它自己的名字。`,
        excerpt: row.name,
      });
    }
  }
  report.summary = { tested: names.length, hype: rows.filter((r) => r.hype.length).length };
  report.names = rows;
}

// ---------- blurb：钩子覆盖 ----------

if (options.command === 'blurb') {
  if (!options.blurbFile) die('blurb command requires --blurb <简介文件>');
  let blurb;
  try {
    blurb = fs.readFileSync(path.resolve(options.blurbFile), 'utf8');
  } catch (error) {
    die(`unable to read blurb file: ${error.message}`);
  }
  const outlineDir = path.resolve(options.targets[0]);
  const hooks = [];
  try {
    for (const name of fs.readdirSync(outlineDir).sort()) {
      const m = /第\s*0*(\d+)\s*章/.exec(name);
      if (!m || !/^细纲_第\d+章.*\.md$/.test(name)) continue;
      const chapter = Number(m[1]);
      if (chapter > 3) continue; // 只查前三章（开书承诺窗口）
      const text = fs.readFileSync(path.join(outlineDir, name), 'utf8');
      for (const line of text.split(/\r?\n/)) {
        const hm = HOOK_LINE.exec(line);
        if (hm) hooks.push({ chapter, type: hm[1], content: hm[2].trim() });
      }
    }
  } catch (error) {
    die(`unable to read outline directory: ${error.message}`);
  }
  // 钩子内容关键词抽取：取 ≥2 字的名词片段（去停用词，简单起见取全部 2-4 字滑窗子串的命中判定）
  const STOP = /^[的了着在是和与有把这那]$/;
  const rows = hooks.map((h) => {
    const keywords = [];
    for (let len = 2; len <= 4; len += 1) {
      for (let i = 0; i + len <= h.content.length; i += 1) {
        const seg = h.content.slice(i, i + len);
        if (STOP.test(seg[0]) || STOP.test(seg[seg.length - 1])) continue;
        if (blurb.includes(seg)) keywords.push(seg);
      }
    }
    const covered = keywords.length > 0;
    if (!covered && h.type === '期待') {
      findings.push({
        type: 'blurb-missing-promise',
        severity: 'advisory',
        message: `简介漏了第${h.chapter}章期待钩的承诺（钩子：${h.content.slice(0, 30)}）——期待钩必须露在简介里（许诺要给足），危机钩可隐。`,
        excerpt: `第${h.chapter}章 × ${h.type}`,
      });
    }
    if (!covered && h.type !== '期待') {
      findings.push({
        type: 'blurb-missing-promise',
        severity: 'advisory',
        message: `简介与第${h.chapter}章${h.type}钩零关键词交集（钩子：${h.content.slice(0, 30)}）——${h.type === '危机' ? '危机钩可隐，确认为有意隐藏则豁免' : '该钩承诺应能在简介中找到映射'}。`,
        excerpt: `第${h.chapter}章 × ${h.type}`,
      });
    }
    return { chapter: h.chapter, type: h.type, covered, content: h.content.slice(0, 30) };
  });
  report.summary = { hooks_checked: hooks.length, covered: rows.filter((r) => r.covered).length };
  report.hooks = rows;
}

// ---------- titles：标题判据 ----------

if (options.command === 'titles') {
  const dir = path.resolve(options.targets[0]);
  const entries = [];
  try {
    for (const name of fs.readdirSync(dir).sort()) {
      const m = /第\s*0*(\d+)\s*章(?:_(.+))?\.md$/.exec(name);
      if (!m) continue;
      entries.push({ file: name, chapter: Number(m[1]), title: m[2] || '', hook: null });
    }
  } catch (error) {
    die(`unable to read directory: ${error.message}`);
  }
  // 钩子类型从细纲目录（同级 大纲/）或同文件内找
  for (const entry of entries) {
    const text = fs.readFileSync(path.join(dir, entry.file), 'utf8');
    const hm = /章尾钩子[：:]\s*(危机|反转|期待|悬念|情绪)/.exec(text);
    if (hm) entry.hook = hm[1];
  }
  for (const entry of entries) {
    if (!entry.title) {
      findings.push({
        type: 'title-missing',
        severity: 'advisory',
        message: `第${entry.chapter}章文件名无标题段——门面工程缺块砖。`,
        excerpt: entry.file,
      });
      continue;
    }
    if (entry.title.length > 8) {
      findings.push({
        type: 'title-too-long',
        severity: 'advisory',
        message: `第${entry.chapter}章标题「${entry.title}」${entry.title.length} 字 > 8——标题长则钩力散，压到 8 字内。`,
        excerpt: entry.title,
      });
    }
    if (ABSTRACT_WORDS.some((w) => entry.title.includes(w))) {
      findings.push({
        type: 'title-abstract',
        severity: 'advisory',
        message: `第${entry.chapter}章标题「${entry.title}」是抽象词——抽象词无钩力（读者扫不到具体画面）；换具象名词或动作。`,
        excerpt: entry.title,
      });
    }
    const spoilers = SPOILER_BY_HOOK[entry.hook] || [];
    if (entry.hook && spoilers.some((w) => entry.title.includes(w))) {
      findings.push({
        type: 'title-hook-mismatch',
        severity: 'advisory',
        message: `第${entry.chapter}章标题「${entry.title}」把${entry.hook}钩拆了——标题把结果说了，正文钩子就没了；标题止步于缺口。`,
        excerpt: `${entry.title} × ${entry.hook}`,
      });
    }
  }
  report.summary = { titles_checked: entries.length, findings: findings.length };
  report.titles = entries.map((e) => ({ chapter: e.chapter, title: e.title, hook: e.hook }));
}

// ---------- 输出 ----------

try {
  handling.finalizeFindings(findings, 'guyin-check-pitch');
} catch (e) {
  die(e.message);
}

if (options.json) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  console.log(`# pitch 检查（${options.command}）：${findings.length} 条 advisory`);
  for (const f of findings) console.log(`⚠ [${handling.label(f)}] ${f.type}: ${f.message}`);
  if (findings.length === 0) console.log('（零报警——过机械判据，终判归作者）');
}

process.exit(handling.gateTripped(findings, options.failOn) ? 1 : 0);
