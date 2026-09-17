'use strict';

// guyin-handling.js — 检查结果处置分类（共享模块，单一事实源）
//
// 依据 docs/框架整改实施任务书_吸引力闭环.md §2.4 检查契约：
//   不以正则执行稳定证明文学判断成立。所有检查结果在消费前统一为三种处置类别：
//
//   hard      可确定的工程错误、明确硬约定违约，或语义核实后的事实违约
//             → 修复前阻止发布/续写（进待审台账，终态消费后解除）
//   verify    可能剧透、知情越界、资产否定等，仍需上下文核实
//             → 带证据复核进待审台账；不能排除硬契约风险则暂停
//   editorial 比例、句式、比喻、记忆度等观察与编辑建议
//             → 留审读记录，不因未「清零」阻止写作；确有主要阅读失败按审读契约（2.3）处置
//
// 接口决定（任务书 §2.4）：脚本保留原有规则 ID（type）与证据（severity/line/excerpt），
// 逐规则补 handling——两种枚举不硬拼。缺分类、非法值或解析失败一律报工具错误（exit 2），
// 不能默认降为建议。
//
// CLI 退出口径（全脚本统一）：
//   0 = 无未决阻断；1 = 存在未决阻断；2 = 执行/输入错误。
//   --fail-on=block（默认）：hard 或 verify 任一存在即 1（两者都进待审台账、未终态阻塞）；
//   --fail-on=hard        ：仅 hard 计 1；
//   --fail-on=all         ：含 editorial 全计 1（审计模式）。
//   旧值 blocking 已废除——语义按 handling 重定义，调用方改用 block。
//   exit 1 的含义是「存在待处置项」，修复/豁免/契约修订/顺延/升级作者/不适用都能解除，
//   不要把 exit 1 解释为必须改正文。
//
// 主流程是唯一消费入口：hard/verify 进待审台账；editorial 进审读记录，
// 不再自动制造待审阻塞项。本模块只做分类与门判定，不消费、不改写。

const HARD = 'hard';
const VERIFY = 'verify';
const EDITORIAL = 'editorial';
const HANDLING_VALUES = [HARD, VERIFY, EDITORIAL];

// 失败模式（缺分类/非法值）统一抛出，调用方 die() 转 exit 2。
class HandlingError extends Error {
  constructor(message) {
    super(message);
    this.name = 'HandlingError';
  }
}

// ---- 逐规则分类表（type → handling）----
// 维护纪律：新增规则必须同时登记此处；删规则同步删条目。表未覆盖的 type 在
// finalizeFindings 里报工具错误——宁停勿猜（任务书：不能默认降为建议）。
// 个别规则需要按 finding 变体区分（如 meta-leak-beat 对话行内讨论属语义核实）：
// 发射点可直接在 finding 上写 handling，finalize 校验合法值后优先采用。
const RULE_HANDLING = {
  // --- guyin-check-beat.js ---
  'meta-leak-beat': HARD, // 对话行变体在发射点覆写为 verify
  'ban-violation': HARD,
  'skip-write': HARD, // 括号省略＝显式未完成输出；时间压缩词变体在发射点覆写为 editorial
  'dialogue-run': EDITORIAL,
  'mono-count': EDITORIAL,
  // （beat-too-short / beat-too-long 已废除：beat 降为节奏标签，无字数桶——长度权威归
  //  章级 wordcount，任务书 §2.2/§3 B）

  // --- guyin-check-degeneration.js ---
  'verbatim-repeat': VERIFY, // 可能是登记过的复沓锚句——须对照锚句登记核实
  'truncated': HARD,
  'placeholder-leak': HARD,
  'meta-leak': HARD,

  // --- guyin-check-integrity.js ---
  'avg-line-collapse': HARD,
  'mega-paragraph': HARD,
  'doubled-char': HARD,
  'char-storm': HARD,
  'quote-mismatch': HARD,

  // --- guyin-check-strip.js ---
  'strip-extra-heading': HARD,
  'strip-carryover': HARD,
  'strip-framework-word': VERIFY, // 世界内正当用法可能（宁报不拦，分诊核实）

  // --- guyin-check-wordcount.js ---
  'chapter-too-short': HARD, // 明确长度约定违约——修设计或改约定，不许填水
  'chapter-too-long': EDITORIAL,
  'chapter-length-uniform': EDITORIAL,

  // --- guyin-check-repetition.js ---
  'fingerprint-arrears': HARD, // 指纹欠账＝工程约定违约（原子双命令缺一不可）
  'para-repeat-near': VERIFY, // 跨章近乎照抄——可能是有意回环或登记资产，须对照锚句/台账核实
  'para-repeat-pattern': VERIFY, // 换词复读——回环是意图、坍缩是分布，须作者结合台账判读
  'imagery-domain-run': EDITORIAL,
  'metaphor-domain-stale': EDITORIAL,
  'phrase-echo-cross': EDITORIAL,
  'phrase-echo-ending': EDITORIAL,
  'phrase-echo-inline': EDITORIAL,

  // --- guyin-check-ai-patterns.js（句式/比例/比喻观察，editorial 起步）---
  'em-dash': EDITORIAL,
  'long-paragraph': EDITORIAL,
  'voice-contrast': EDITORIAL,
  'negation-parade': EDITORIAL,
  'formulaic-parallelism': EDITORIAL,
  'reverse-not-is': EDITORIAL,
  'explain-tic': EDITORIAL,
  'mid-trailer': EDITORIAL,
  'aphorism-tic': EDITORIAL,
  'trailer-ending': EDITORIAL,
  'trailer-summary': EDITORIAL,
  'quote-emphasis-tic': EDITORIAL,
  'micro-action-tic': EDITORIAL,
  'action-list-tic': EDITORIAL,
  'cliche-density-tic': EDITORIAL,
  'metaphor-density-tic': EDITORIAL,
  'reasoning-chain-tic': EDITORIAL,
  'system-notice-formality-tic': EDITORIAL,
  'overcompressed-prose-tic': EDITORIAL,
  'prose-fragment-ratio': EDITORIAL,
  'silence-density-tic': EDITORIAL,
  'low-connective-density-tic': EDITORIAL,
  'abstract-summary-tic': EDITORIAL,
  'period-stutter': EDITORIAL,
  'not-is-comparison': EDITORIAL,
  'phrase-quota': EDITORIAL,
  'sensory-repeat': EDITORIAL,
  'stutter-punct': EDITORIAL,
  'pov-drift': VERIFY, // POV 契约（批次公约）违约——事实性，须对照公约核实
  'dialogue-zero-information': EDITORIAL,

  // --- guyin-check-consistency.js（事实核对类，全部须上下文核实）---
  'evidence-status-conflict': VERIFY,
  'evidence-premature-use': VERIFY,
  'capability-unregistered': VERIFY,
  'place-unregistered': VERIFY,
  'direction-conflict': VERIFY,
  'route-contradiction': VERIFY,

  // --- guyin-check-narrative-asset.js ---
  'narrative-asset-violation': VERIFY, // 资产否定——须对照档位声明核实（任务书点名 verify）

  // --- guyin-check-outline-verdict.js ---
  'verdict-declaration-missing': VERIFY,
  'verdict-tier-conflict': VERIFY, // 细纲内部矛盾——须作者仲裁
  'verdict-tier-suspect': VERIFY,
  'verdict-tier2-uncompensated': HARD, // 档2无补偿声明＝明确协议违约
  'contract-violation': VERIFY,
  'contract-unregistered': VERIFY,

  // --- guyin-check-outline-slots.js ---
  'outline-missing-group-1': HARD, // 四组协议区块缺失（任务书 §2.1 四组化）——缺哪组报哪组
  'outline-missing-group-2': HARD,
  'outline-missing-group-3': HARD,
  'outline-missing-group-4': HARD,
  'outline-missing-wordcount': HARD,
  'outline-missing-anchor': HARD,
  'outline-missing-holdback': HARD,
  'outline-missing-terms': EDITORIAL,
  'qiyun-coord-uncovered': EDITORIAL,
  'outline-instruction-echo': EDITORIAL,
  'outline-genre-contract-missing': VERIFY,
  // （outline-missing-hook / -multiline / -scenes / -contract / -timecheck /
  //  -emotion-beats / outline-scene-floor-conflict 已废除：对应字段随四组化删除，
  //  存量旧格式不追溯——删掉的栏目不能仍由脚本强制补回，任务书 §2.1/§3 B）

  // --- guyin-check-outline-deliver.js ---
  'outline-term-missing': VERIFY, // 锚定戏整场漏写——细纲承诺 vs 正文履行，须对照核实
  'outline-term-unanchored': VERIFY, // 术语首现未台词级锚定——工艺词泄漏契约风险
  'outline-anchor-missing': VERIFY, // 锚句声明未落地——免报通道不免落地义务，须核实
  'outline-signature-preempted': VERIFY, // 跨章签名句归属/剧透风险——须对照归属登记核实
  // （outline-hook-offtail / outline-hook-quote-mismatch 已废除：章尾钩子字段随四组化
  //  删除；签名句聚合收窄为仅复沓锚句，任务书 §2.1/§3 B）
  // （guyin-check-outline-copy.js 无 per-rule findings 结构——纯文本退出口径，exit 1 即「有重合待复核」＝verify 语义，无表项）

  // --- guyin-check-authority-leak.js ---
  'authority-source-empty': VERIFY, // 作者性件缺件——补件核实
  'authority-leak': HARD, // 精神件字面泄漏＝明确硬契约（H1）违约
  'authority-leak-suspect': VERIFY, // 近似命中——须上下文核实

  // --- guyin-check-foreshadow-id.js ---
  'foreshadow-empty-id': HARD, // 台账编号工程错误
  'foreshadow-duplicate-id': HARD,
  'foreshadow-ref-unregistered': VERIFY, // 悬空引用——可能是笔误或漏登记，须核实

  // --- guyin-check-hook-rotation.js ---
  'hook-run': EDITORIAL,
  'burst-without-charge': EDITORIAL,
  'hook-cut-entity-missing': VERIFY, // 钩子缺实体——须对照细纲声明核实
  'hook-cut-quota': EDITORIAL,

  // --- guyin-check-opening-retention.js ---
  'outline-opening-promise-missing': HARD, // ch001-003 第一组「读者承诺」行缺失/空值（开篇入口声明，缺行即细纲不完整）
  // （opening-retention-missing 已废除：四留存字段被 ch001-003 第一组「读者承诺」行
  //  替代——旧格式四字段在场视为合法历史格式不追溯，任务书 §2.1/§3 B）

  // --- guyin-check-trial-gate.js ---
  'trial-gate-missing': HARD, // 手续门缺件
  'trial-gate-incomplete': HARD,
  'trial-gate-version': HARD, // 版本锚与正文哈希不符
  'trial-gate-undecided': HARD, // 有效反馈未处置
  'trial-gate-paused': HARD, // 用户暂停态——停就真停
  'trial-gate-revision-scope': HARD,
  'trial-gate-stale': VERIFY, // 检查点节奏提醒——须作者核对/登记下一检查点
  'trial-gate-source': HARD, // 只有模型审读行覆盖检查点——模型不能顶替人（E1）
  'trial-gate-incomplete-source': HARD, // 新表有来源列但行内空着/无法识别（E1）
  'trial-gate-checkpoint-bad': HARD, // 检查点登记表畸形（范围/到点章无法解析，E1）
  'trial-gate-source-legacy': EDITORIAL, // 旧表无来源列：旧行暂计有效，提示补登（E1 不追溯）

  // --- guyin-check-reader-signal.js ---
  'reader-cliff': EDITORIAL, // 掉崖归因观察，终判归作者
  // （drop-point 已废除 E1：「连续两章不推主线即弃书」是自动归因，任务书 §3 E 取消）

  // --- guyin-check-flesh.js ---
  'flesh-trait-break': VERIFY,
  'tool-character': VERIFY,

  // --- guyin-check-pitch.js ---
  'hype-title': EDITORIAL,
  'blurb-missing-promise': VERIFY, // 简介承诺缺正文支撑——对照正文核实
  'title-missing': EDITORIAL,
  'title-too-long': EDITORIAL,
  'title-abstract': EDITORIAL,
  'title-hook-mismatch': EDITORIAL,

  // --- guyin-check-rule-conflict.js ---
  'rule-conflict-ledger-missing': VERIFY, // 治理件缺失——须补台账
  'rule-conflict-unadjudicated': VERIFY, // 未仲裁冲突——等待作者仲裁

  // --- guyin-impact-map.js（结构手术影响面清单）---
  'impact-dangling-foreshadow': VERIFY, // 悬空债须过堂
  'impact-verdict-asset': VERIFY,
  'impact-patch-spread': VERIFY,

  // --- guyin-normalize-punctuation.js（格式工程错误）---
  'html-comment-unclosed': HARD,
  'markdown-divider': HARD,
  'quote-style': HARD, // 引号规格是批次公约明确约定——可确定违约
  'ellipsis': EDITORIAL, // 停顿标点归一（……→中文标点）——文风规格观察，与 ai-patterns em-dash 同族
  'double-hyphen': EDITORIAL, // 停顿标点归一（--→中文标点）——同上
};

// ---- 公共 API ----

function handlingFor(type) {
  return Object.prototype.hasOwnProperty.call(RULE_HANDLING, type) ? RULE_HANDLING[type] : null;
}

// 逐条盖章并校验：finding.handling 已有合法值则优先（变体覆写），否则查表；
// 两者皆无 → 抛 HandlingError（调用方转 exit 2，不能默认降为建议）。
function finalizeFindings(findings, scriptName) {
  const unclassified = [];
  for (const f of findings) {
    if (f.handling !== undefined) {
      if (!HANDLING_VALUES.includes(f.handling)) {
        throw new HandlingError(
          `${scriptName}: finding type=${f.type} 带非法 handling 值「${f.handling}」（合法值：${HANDLING_VALUES.join('/')})`);
      }
      continue;
    }
    const h = handlingFor(f.type);
    if (h === null) {
      unclassified.push(f.type);
      continue;
    }
    f.handling = h;
  }
  if (unclassified.length > 0) {
    throw new HandlingError(
      `${scriptName}: 以下规则 type 未登记 handling 分类（lib/guyin-handling.js RULE_HANDLING），宁停勿猜：${[...new Set(unclassified)].join(', ')}`);
  }
  return findings;
}

// --fail-on 解析：block（默认，hard+verify）/ hard / all。旧值 blocking 拒收并给迁移提示。
function parseFailOn(rawValue, defaultValue) {
  const v = rawValue === undefined ? (defaultValue || 'block') : rawValue;
  if (v === 'blocking') {
    throw new HandlingError(
      `--fail-on=blocking 已废除（处置分类按 handling 重定义）：改用 block（hard+verify，默认）/ hard / all`);
  }
  if (v !== 'block' && v !== 'hard' && v !== 'all') {
    throw new HandlingError(`--fail-on must be 'block', 'hard' or 'all'（got '${v}'）`);
  }
  return v;
}

// 门判定：是否存在未决阻断（按 failOn 口径）。editorial 在默认门下永不阻断。
function gateTripped(findings, failOn) {
  if (failOn === 'all') return findings.length > 0;
  if (failOn === 'hard') return findings.some((f) => f.handling === HARD);
  return findings.some((f) => f.handling === HARD || f.handling === VERIFY);
}

// 文本行输出用的标签（severity 保留原值，行首展示处置类别）。
function label(f) {
  return `${f.handling}/${f.severity}`;
}

module.exports = {
  HARD,
  VERIFY,
  EDITORIAL,
  HANDLING_VALUES,
  HandlingError,
  handlingFor,
  finalizeFindings,
  parseFailOn,
  gateTripped,
  label,
};
