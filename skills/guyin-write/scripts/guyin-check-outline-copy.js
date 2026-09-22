#!/usr/bin/env node
/**
 * check-outline-copy.js — 细纲照搬检测
 *
 * 治的病：细纲把情节点写成成品散文句，正文只剩誊抄，质量被锁死在细纲水平。
 * 实测正文与细纲连续重合最高 13.5%、单段最长 40 字，且重合段落多为叙述而非台词
 * ——即全章最好的那几句在细纲阶段就写完了。
 *
 * 判定：正文与同章细纲连续重合 > 阈值（默认 15 字）即报出
 * ——细纲只锁功能与结果，句子一律在正文现场写。
 *
 * 词面相同不等于不良照搬：系统面板、任务要求、固定专名本就该保持一致。因此本脚本
 * 只提供证据（位置与片段），是否重写由当前会话读上下文语义判断（verify 轨）——
 * 每条都要有结论，不允许只报不改，也不为归零机械改写。
 * 判定保留的只由主会话补进细纲锚句，不允许检查对象自行改写细纲白名单——
 * 否则误判的重合会被写进白名单，复扫时不再报出，第二层复核失明。
 *
 * 免报：细纲「复沓锚句」字段下列出的原话允许逐字落地——誓言、系统面板、
 * 旧案原话等写细纲时判定必须原文出现的部分，逐行一条。只扣除锚句自身的精确区间，
 * 前后剩余片段照常按阈值判定，避免紧挨锚句的照搬被顺带赦免。
 * 豁免量单独统计并在报告末尾列出，滥用锚句绕过检测时一眼可见。
 *
 * 由当前会话在候选上调用（候选链汇总器与收尾复扫同一份实现，口径一致）。
 * 不进 hook：正文兜底 hook 的共享核是四端共用的，不为单项检测扩面。
 *
 * 用法：
 *   node check-outline-copy.js <正文路径...>                    # 自动找同章细纲（旧纯文本模式）
 *   node check-outline-copy.js --outline <细纲路径> <正文路径...> # 指定细纲（旧纯文本模式）
 *   node check-outline-copy.js --json --project <B> --chapter N [--unit N] [--outline <细纲>] <候选>
 *                                                              # v4 候选链显式模式（JSON）
 *
 * 位置参数一律按正文处理，与 check-ai-patterns.js 的 `<file...>` 口径一致：
 * 收尾复扫用 `正文/第XXX章_*.md` 这类通配传多章时，多出来的正文不能被当成细纲吞掉
 * ——那会让首个文件比错对象、其余文件根本不检，静默退 0 报「干净」。
 *
 * 退出码：0 = 干净或无法判定（缺细纲/非分章正文）；1 = 有重合待复核。
 * 无发现时完全静默，不污染上下文。
 *
 * 处置口径（lib/guyin-handling.js 契约 §2.4）：本脚本无 per-rule findings 结构，
 * exit 1 即「有重合待复核」——语义等同处置分类 verify（须上下文核实、进待审台账），
 * 故不接 --fail-on / RULE_HANDLING 表项，CLI 与退出口径维持原样。
 */

'use strict'
const fs = require('fs')
const path = require('path')

const MIN_RUN = 16 // 判定阈值：连续重合 >15 字，即 >=16
const REPORT_TOP = 8 // 最多列出的片段数

function read(p) {
  try {
    return fs.readFileSync(p, 'utf8').replace(/^﻿/, '')
  } catch {
    return null
  }
}

/** 只留汉字——剥掉标点/加粗/【】后比对，防止细纲标注造成假阴性 */
function hanOnly(s) {
  return s.replace(/[^一-鿿]/g, '')
}

/**
 * P2（docs/07 §二）：剥除细纲「执行偏差（写后回填）」区后再比对。
 * 该区是写后回填件：变体行会引用正文原句（≥MIN_RUN 即判「誊抄」假警报），每个
 * 回填了偏差区的章都会在章检出假警报。区块起于行首标题含「执行偏差」，止于下一个
 * 标题行或文末；细纲无该区时原样返回（剥除量 0）。剥除量并入报告末尾统计（与锚句
 * 豁免同呈报哲学：授权通道可见可审计，滥用偏差区绕过检测时一眼可见）。
 */
function stripDeviationBlock(outline) {
  const kept = []
  let stripped = 0
  let inBlock = false
  for (const line of outline.split(/\r?\n/)) {
    if (/^#{1,6}\s/.test(line)) {
      inBlock = /执行偏差/.test(line)
      if (inBlock) continue
    } else if (inBlock) {
      stripped += hanOnly(line).length
      continue
    }
    kept.push(line)
  }
  return { text: kept.join('\n'), stripped }
}

/**
 * 抽出细纲「复沓锚句」字段下的原话，一行一条。
 * 只认这一个字段，不扫情节点序列——锚句集中在固定区块，情节点保持只写「要发生什么」。
 * 区块终止于行首无缩进的下一个字段（`- xxx`）或下一个小节标题，因此条目本身
 * 用 `1.` 编号、缩进 `-` 列表或纯文本都能正确提取，不必额外标记。
 */
function extractAnchors(outline) {
  const m = outline.match(/复沓锚句[^：:\n]*[：:]([\s\S]*?)(?=\n[-*+]\s|\n#{1,6}\s|$)/)
  if (!m) return []
  return m[1]
    .split("\n")
    // 去掉列表符号与「点N：」这类落点前缀，只留原话本身
    .map((line) => line.replace(/^\s*[-*+]?\s*(?:\d+[.、)]\s*)?(?:点\s*\d+\s*[：:])?/, ""))
    .map((line) => hanOnly(line))
    .filter((a) => a.length >= 2)
}

/**
 * 在片段里定位锚句的精确出现区间，挖掉后返回剩余子段与豁免字数。
 * 不能只判「片段包含锚句」就整段放行——贪心扫描求的是最长延伸，锚句嵌在中间时
 * 会连同紧挨着它的未授权重合一起赦免。
 */
function splitByAnchors(frag, anchors) {
  // 片段完全落在某条锚句内：整段豁免（抄了锚句的一部分，仍在授权范围）
  if (anchors.some((a) => a.includes(frag))) return { rest: [], anchoredLen: frag.length }

  const spans = []
  for (const a of anchors) {
    for (let from = 0; from + a.length <= frag.length; ) {
      const at = frag.indexOf(a, from)
      if (at < 0) break
      spans.push([at, at + a.length])
      from = at + 1 // 同一锚句重复出现要逐次记录
    }
  }
  if (!spans.length) return { rest: [frag], anchoredLen: 0 }

  spans.sort((x, y) => x[0] - y[0])
  const merged = [spans[0]] // 多锚句重叠/相邻时并成一段，避免重复计数
  for (const [s, e] of spans.slice(1)) {
    const last = merged[merged.length - 1]
    if (s <= last[1]) last[1] = Math.max(last[1], e)
    else merged.push([s, e])
  }

  const rest = []
  let cursor = 0
  let anchoredLen = 0
  for (const [s, e] of merged) {
    if (s > cursor) rest.push(frag.slice(cursor, s))
    anchoredLen += e - s
    cursor = e
  }
  if (cursor < frag.length) rest.push(frag.slice(cursor))
  return { rest, anchoredLen }
}

/** 定位同章细纲：遍历 大纲/ 按章号正则匹配，支持带后缀的文件名 */
function findOutline(proseFile) {
  const base = path.basename(proseFile)
  // 短篇没有章号：正文.md 与 小节大纲.md 在同目录平铺
  if (base === '正文.md') {
    const sibling = path.join(path.dirname(proseFile), '小节大纲.md')
    return fs.existsSync(sibling) ? sibling : null
  }
  const m = base.match(/^第\s*0*(\d+)\s*章/)
  if (!m) return null
  const chapter = m[1]
  const dir = path.join(path.dirname(path.dirname(proseFile)), '大纲')
  try {
    for (const file of fs.readdirSync(dir)) {
      const fm = file.match(/^细纲_第0*(\d+)章.*\.md$/)
      if (fm && fm[1] === chapter) return path.join(dir, file)
    }
  } catch {}
  return null
}

function main() {
  const proseFiles = []
  let explicitOutline = null
  const argv = process.argv.slice(2)
  for (let k = 0; k < argv.length; k++) {
    if (argv[k] === '--outline') explicitOutline = argv[++k] || null
    else proseFiles.push(argv[k])
  }
  if (!proseFiles.length) {
    process.stderr.write('用法: node check-outline-copy.js [--outline <细纲路径>] <正文路径...>\n')
    return 0
  }
  // 逐个文件独立判定；任一文件有重合即整体退 1
  let status = 0
  for (const proseFile of proseFiles) {
    if (checkOne(proseFile, explicitOutline)) status = 1
  }
  return status
}

function checkOne(proseFile, explicitOutline) {
  const prose = read(proseFile)
  if (prose === null) return 0

  const outlineFile = explicitOutline || findOutline(proseFile)
  if (!outlineFile) return 0
  const outline = read(outlineFile)
  if (outline === null) return 0

  const result = inspectCopy(proseFile, prose, outlineFile)
  if (!result.hits.length) {
    // 全部命中都是锚句豁免：静默放行，但把豁免量报出来供人工复核滥用
    if (result.anchoredCount) {
      process.stdout.write(
        `细纲照搬检测（${path.basename(proseFile)}）：无未授权誊抄；` +
          `另有 ${result.anchoredCount} 处 ${result.anchored} 字为复沓锚句的逐字落地。` +
          (result.deviationStripped ? `另剥除执行偏差区 ${result.deviationStripped} 字（写后回填授权，不比对）。` : '') +
          '\n'
      )
    }
    return 0
  }

  const hits = result.hits
  const rate = ((result.copied * 100) / result.P).toFixed(1)
  const out = [
    `=== 细纲照搬检测（${path.basename(proseFile)}）===`,
    `正文 ${result.P} 字，与 ${path.basename(outlineFile)} 连续重合 >${MIN_RUN - 1} 字的片段 ${hits.length} 处，共 ${result.copied} 字（${rate}%）。`,
    `逐条对照原文判断：确属把细纲叙述搬进正文就重写——细纲只锁功能与结果，句子在正文现场写；系统面板、誓词、案卷原话、固定专名等功能性重合可保留。每条都要有结论，不为归零机械改写。保留项由主会话补进细纲「复沓锚句」，不允许改细纲来自行消警。`,
  ]
  hits
    .sort((a, b) => b.len - a.len)
    .slice(0, REPORT_TOP)
    .forEach((h) => out.push(`  · ${h.len} 字「${h.frag}」`))
  if (hits.length > REPORT_TOP) out.push(`  · …另有 ${hits.length - REPORT_TOP} 处`)
  if (result.anchoredCount) out.push(`（另有 ${result.anchoredCount} 处 ${result.anchored} 字为复沓锚句的逐字落地，不计入誊抄）`)
  if (result.deviationStripped) out.push(`（比对前已剥除执行偏差区 ${result.deviationStripped} 字：写后回填授权通道，不计入誊抄）`)
  process.stdout.write(out.join('\n') + '\n')
  return 1
}

/**
 * 检测核（纯文本旧模式与显式 JSON 模式共用）：返回结构化结果，不打印、不退出。
 * { P, hits:[{frag,len}], copied, anchored, anchoredCount, deviationStripped }
 */
function inspectCopy(proseFile, prose, outlineFile) {
  const outline = read(outlineFile)
  if (outline === null) return { P: 0, hits: [], copied: 0, anchored: 0, anchoredCount: 0, deviationStripped: 0 }

  // 正文去掉标题行后比对；细纲先剥除「执行偏差」区（P2，写后回填授权通道）
  const P = hanOnly(prose.replace(/^#.*$/gm, ''))
  const { text: outlineBody, stripped: deviationStripped } = stripDeviationBlock(outline)
  const O = hanOnly(outlineBody)
  if (P.length < MIN_RUN || O.length < MIN_RUN) {
    return { P, hits: [], copied: 0, anchored: 0, anchoredCount: 0, deviationStripped }
  }

  // 复沓锚句列出的原话允许逐字落地，命中后计入豁免、不判誊抄
  const anchors = extractAnchors(outline)

  // 贪心扫描：每个起点二分求「仍是细纲子串」的最长延伸，命中区间不重叠
  const hits = []
  let copied = 0
  let anchored = 0
  let anchoredCount = 0
  let i = 0
  while (i < P.length) {
    let best = 0
    if (i + MIN_RUN <= P.length && O.includes(P.substr(i, MIN_RUN))) {
      best = MIN_RUN
      let lo = MIN_RUN
      let hi = Math.min(P.length - i, 200)
      while (lo <= hi) {
        const mid = (lo + hi) >> 1
        if (O.includes(P.substr(i, mid))) {
          best = mid
          lo = mid + 1
        } else hi = mid - 1
      }
    }
    if (best) {
      const frag = P.substr(i, best)
      const { rest, anchoredLen } = splitByAnchors(frag, anchors)
      if (anchoredLen) {
        anchored += anchoredLen
        anchoredCount++
      }
      // 挖掉锚句后的剩余子段仍是细纲子串，只需按阈值重判
      for (const seg of rest) {
        if (seg.length >= MIN_RUN) {
          hits.push({ frag: seg, len: seg.length })
          copied += seg.length
        }
      }
      i += best
    } else i++
  }
  return { P, hits, copied, anchored, anchoredCount, deviationStripped }
}

// ============================================================
// B-1 候选链显式模式：--project/--chapter（--unit 短篇），JSON 报告。
// 无细纲＝not_applicable（exit0＋原因）；显式 --outline 不可读＝exit2（不假通过）。
// ============================================================
'use strict'
const cc = require('./lib/guyin-candidate-context')
const handling = require('./lib/guyin-handling')

function runExplicitCopy() {
  let ctx
  try {
    ctx = cc.resolveContext(process.argv.slice(2))
  } catch (e) {
    console.error(e.code === 'CTX_INPUT' ? `输入错误：${e.message}` : String(e))
    process.exit(2)
  }
  const asJson = ctx.flags.has('--json')
  const failOpt = [...ctx.flags].find((f) => f.startsWith('--fail-on='))
  const failOn = failOpt ? handling.parseFailOn(failOpt.slice('--fail-on='.length)) : 'block'
  const candidateText = fs.readFileSync(ctx.candidateAbs, 'utf8')

  // 无真实细纲：显式模式下列为 not_applicable＋原因，不造四组过门，也不冒充 pass。
  if (!ctx.outlineAbs) {
    const doc = ctx.notApplicable('未提供本章真实细纲（--outline）：细纲照搬检查不适用')
    doc.files_scanned = [ctx.candidateRel] // 候选确实读过（区分于缺件/零扫描）
    if (asJson) {
      process.stdout.write(`${JSON.stringify(doc, null, 2)}\n`)
    } else {
      process.stdout.write('outline-copy(explicit): not_applicable（无细纲）\n')
    }
    process.exit(0)
  }

  // 复用纯文本模式的检测核（显式细纲；候选即受检正文）。
  const result = inspectCopy(ctx.candidateAbs, candidateText, ctx.outlineAbs)
  const findings = result.hits.map((h, i) => ({
    file: ctx.candidateRel,
    line: 1, column: 1,
    type: 'outline-copy-overlap',
    severity: 'advisory',
    handling: 'verify',
    length: h.len,
    message: `与细纲连续重合 ${h.len} 字（阈值 >${MIN_RUN - 1}）：细纲只锁功能与结果，句子在正文现场写；功能性重合保留须登记复沓锚句`,
    excerpt: h.frag,
  }))
  const status = findings.length ? 'findings' : 'pass'
  const report = {
    script: 'guyin-check-outline-copy.js',
    script_sha256: cc.sha256File(__filename),
    status,
    target: { chapter: ctx.chapter, unit: ctx.unit, candidate: ctx.candidateRel, candidate_sha256: ctx.candidateHash },
    outline: ctx.outlineRel,
    files_scanned: [ctx.candidateRel],
    target_files: [ctx.candidateRel],
    reference_files: [ctx.outlineRel],
    anchored_count: result.anchoredCount,
    anchored_chars: result.anchored,
    deviation_stripped: result.deviationStripped,
    findings,
  }
  if (asJson) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  else process.stdout.write(`outline-copy(explicit): ${status}（${findings.length} 处未授权重合）\n`)
  process.exit(findings.length && handling.gateTripped(findings, failOn) ? 1 : 0)
}

if (process.argv.includes('--project')) {
  runExplicitCopy()
}

try {
  process.exit(main())
} catch {
  process.exit(0)
}
