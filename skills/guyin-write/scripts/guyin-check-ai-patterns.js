#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const USAGE = `Usage: node check-ai-patterns.js [--check] [--json] [--fail-on=blocking|all] <file...>

Detect high-risk AI-flavor prose patterns that need human rewrite:
  - negative setup followed by positive flip in the same sentence
  - comma/semicolon/colon + positive flip
  - sentence break + positive flip
  - repeated negative setup followed by positive flip
  - em-dash (按功能改写), 碎句号 (连续短叙述句), 长段落 (按镜头断段)
  - 微动作复读 (「了下/了一下」式轻量补语高密度，电报体指纹)
  - 抽象总结复读 (命运/棋局/这一刻终于明白/才刚刚开始，AI 结尾腔)
  - 套词密度过高 (仿佛/一丝/深吸一口气/平静无波等禁用词聚集)
  - 比喻密度过高 (像/好像/仿佛/如同等比喻标记成片复现)
  - 解释链密度过高 (知道/明白/这意味着/必须/需要等判断链聚集)
  - 系统公告公文腔过密 (方括号系统/规则行里硬规则词聚集)
  - 过度精炼短段 (长文本里短叙述段过密且自然连接偏少)
  - prose-fragment-ratio (Fw-02 密/疏双轨配套: ≤15字叙述段占比 >25% advisory / >40% blocking; 样本不足静默; 细纲声明「碎化豁免」降 advisory)
  - silence-density-tic (Fw-05: 引号外「没答/没说话/没接话/没吭声/不说话」>3/千字, 人物沉默反应套路化, advisory)
  - dialogue-zero-information (Fw-05: 仅 ch1-3 启发式, 主角邻近发问=0 且对白中位≤5字 双中, advisory; 无批次公约 POV 静默)
  - 低连接密度 (引号外叙述功能词/白话连接偏少且中长句不足，像提纲/电报体)
  - 监控摄像头式动作清单 (同段连续摆放动作动词，缺少视角温度/情绪缓冲)
  - 音量反差腔 (声音不高/不大…却…, 实战漏网句式)
  - 否定排比 (没有X，没有Y…连排 / 没X…只是Y 先否定后肯定, 实战漏网句式)
  - 工整并列 (至于X不X，怎么X / 同动词「不V A，不V B」，含台词，advisory)
  - 反序对比 (是A，不是B — not-is 的反序变种, 实战漏网句式)
  - 预告式总结收尾 (文末窗口 没人知道/才刚刚开始/正朝着…压了过去, 实战漏网句式)
  - 章尾状态总结体 (文末窗口 这一夜注定/这一切都结束了/新的人生才刚刚开始/命运的齿轮)
  - 引号强调滥用 (叙述里 1-4 字短词加引号强调，密度型)
  - 科普腔 (台词内定义/行话讲解标记聚集，密度型 advisory)
  - 段中预告腔 (叙述层未来指向标记出现在段中而非章尾, 实战漏网句式)
  - 金句腔 (双短句对仗断言收拍「A是B的，C是D的。」, 实战漏网句式)
  - phrase quota (项目 追踪/短语黑名单.md 登记短语超限: 每章 ≤N / 近 5 章 ≤N / 相邻章禁用, advisory; 无该文件静默)
  - cross-chapter sensory-repeat (同一情绪落点的谓语动作跨章重复: 咽口水/手心出汗/咬唇等身体动作 tic 在 ≥2 章命中, advisory; 白名单 追踪/复沓锚句.md 登记的签名物件豁免; 无该文件静默)
  - stutter-punct (SP3, docs/11 §一): 同字夹冒号「这:这」确定性错字——应为「这……这」; advisory, 扫全文(对白内外都扫), 出现即报非密度型
  - pov-drift (PV2, docs/11 §二): 第三有限视角越界——对手/配角内心直写 ≥2 处(1 处静默), advisory; 显式人名 + 一跳代词回指 + 「他/她哪是/哪要的是」弱信号; 无批次公约 POV 行/POV=全知/多视角 → fail-open 静默

Each finding carries severity: blocking by default for generation/deslop cleanup (not-is-comparison / em-dash / voice-contrast / negation-parade / reverse-not-is / trailer-ending / trailer-summary). This is a local style/readability gate, not an AIGC detector score; functional human text can be marked for review instead of hard-edited for a detector.
或 advisory (period-stutter / long-paragraph / micro-action-tic / action-list-tic / abstract-summary-tic / cliche-density-tic / metaphor-density-tic / reasoning-chain-tic / system-notice-formality-tic / overcompressed-prose-tic / prose-fragment-ratio / silence-density-tic / low-connective-density-tic / quote-emphasis-tic / formulaic-parallelism / explain-tic / mid-trailer / aphorism-tic / phrase-quota / sensory-repeat / stutter-punct / pov-drift / dialogue-zero-information，是提示，justified 的长推理/氛围段可保留；prose-fragment-ratio 占比 >40% 时升 blocking，碎化豁免后回降)。
--fail-on=blocking 只在出现 blocking finding 时退出 1；默认 --fail-on=all 有任何 finding 即退出 1。

The script reports findings only. It never rewrites text, because the safe fix is
contextual: usually delete the negative setup, write the positive term directly,
or show it via action/detail.`;

const STOP_CHARS = new Set(['。', '！', '？', '!', '?', '\n']);
const SOFT_SEPARATORS = new Set(['，', ',', '、', '；', ';', '：', ':']);
const HARD_SEPARATORS = new Set(['。', '.', '！', '!', '？', '?']);
const MAX_NEGATIVE_SPAN = 80;
const MAX_POSITIVE_SPAN = 80;

// 碎句号：连续 STUTTER_MIN_RUN 个「叙述」短句（每句可见字数 ≤ STUTTER_MAX_SENTENCE）无呼吸。
// 只数叙述句，跳过对话/弹幕/系统播报（成片短句是这些体裁的正常形态，不算碎句号）。
const STUTTER_MIN_RUN = 6;
const STUTTER_MAX_SENTENCE = 5;
// 长段落：单段原始字符数超过阈值即提示按镜头断段（手机阅读保守阈值，正常单段远低于此）。
const LONG_PARAGRAPH_CHARS = 200;

// 微动作复读：「V了下 / V了一下 / 拍了两下 / 松了半圈」式轻量补语在叙述里高密度复现，
// 容易形成删减过头的电报体指纹。只扫引号外叙述；密度与次数双门槛同时达标才报，
// 单次出现是正常中文。
const MICRO_TIC_PATTERN = /了(?:[一两三几半])?[下阵圈道声眼口气会]/g;
const MICRO_TIC_MIN_HITS = 5;
const MICRO_TIC_PER_KILO = 6;

// 监控摄像头式动作清单：同一段连续堆叠通用动作动词（伸手/拿起/取过/挑开/放下/转身等），
// 且用逗号/顿号串联成步骤表时，读感像无视角温度的监控记录。只做 advisory；
// 打斗/追逐等功能性动作编排可保留或人工复核。
const ACTION_LIST_VERB_PATTERN = /伸手|抬手|探手|拿起|拿过|取出|取过|掏出|摸出|抓起|攥住|握住|捏住|按住|推开|拉开|打开|关上|放下|递给|挑开|掀开|扯开|拧开|倒出|端起|转身|回头|抬头|低头|弯腰|俯身|走到|走向|坐下|站起|看向|看着|盯着|扫过/g;
const ACTION_LIST_MIN_HITS = 5;
const ACTION_LIST_MIN_SEPARATORS = 4;

// 抽象总结复读：模板化段落常把角色当下经历拔成「命运/棋局/
// 这一刻终于明白/才刚刚开始」的作者总结。单个词可能服务题材；高密度聚集才报。
const ABSTRACT_SUMMARY_PATTERNS = [
  /这一刻[，,]?[^\n。！？!?]{0,24}(?:终于|才)(?:明白|意识到)/g,
  /从这一刻开始/g,
  /(?:命运|宿命)[^\n。！？!?]{0,28}(?:齿轮|棋局|獠牙|改写|推向|安排)/g,
  /早已[^\n。！？!?]{0,8}(?:布好|安排好)[^\n。！？!?]{0,8}(?:棋局|局)/g,
  /前所未有的(?:决意|清醒|勇气|力量|恐惧|平静|信念)/g,
  /(?:反击|复仇|战争|较量|故事|命运)[^\n。！？!?]{0,12}才刚刚开始/g,
  /(?:新的开始|全新的开始)/g,
];
const ABSTRACT_SUMMARY_MIN_HITS = 3;
const ABSTRACT_SUMMARY_PER_KILO = 4;

// 套词密度：单个「仿佛/一丝」可能是正常中文，高密度聚集才会形成模板腔。
// 词表只收本 repo banned-words 中已明确标为高危的形态，避免把普通功能词一网打尽。
const CLICHE_PATTERNS = [
  /仿佛|犹如|宛若|如同/g,
  /一丝|一抹|些许|几分|隐约|毫无征兆|几不可闻|微不可察/g,
  /深吸一口气|缓缓|微微|轻轻|淡淡/g,
  /眼中闪过|嘴角勾起|眸光微微一闪|指节泛白|目光锐利|眼神锐利|眉头微皱|眉眼低垂|瞳孔(?:微|一|骤|急)?(?:收)?缩/g,
  /心中涌起一股|心头一震|心中一动|心下了然|心中暗道|心中一凛|心底泛起/g,
  /不容置疑|不容置喙|不易察觉|显而易见|毫无疑问|不可否认/g,
  /声音不大[，,]?却带着|语气平静无波|平静无波|声音平直|听不出情绪/g,
  /不知何时|唾手可得|无声翻涌|沉默(?:在[^。！？!?\n]{0,16})?蔓延|难以言说/g,
  /散发着一股|冰冷的光|格外刺眼|深邃而冰冷/g,
  // banned-words 一级补收（2026-08，与上游词表对账）：过渡套路/万能状语限定式/淬毒通感/「显得有些」。
  // 同为密度型 advisory；「坚定/深邃」等单字形容与「不禁/不由得」等近功能词不收——误报换不来收益。
  /不由自主|情不自禁|自然而然|话锋一转|取而代之的是/g,
  /，带着(?:一丝|一抹|些许|几分|不易察觉|难以言喻|说不出的?|几不可察)/g,
  /(?:眼|目)(?:里|中|底|神)?淬[了着]/g,
  /显得有些/g,
];
const CLICHE_DENSITY_MIN_HITS = 8;
const CLICHE_DENSITY_PER_KILO = 12;

// 比喻密度：单个生活化比喻可服务画面；“像/好像/仿佛/如同”成片复现时，
// 容易变成 AI 式修辞堆叠。只做 advisory，修法是删到必要数量并回到具体画面，
// 不是把“像”换成另一组比喻词。
const METAPHOR_MARKER_PATTERN = /好像|像是|仿佛|宛如|如同|犹如|(?<![不头图画影录摄肖])像(?![头像素])/g;
const METAPHOR_LIKE_PHRASE_PATTERN = /(?:死|水|冰|火|潮水|石头|木头|机器|纸|铁|鬼|死人|刀|针|网|墙)一样/g;
const METAPHOR_DENSITY_MIN_HITS = 7;
const METAPHOR_DENSITY_PER_KILO = 3;

// 解释链密度：常见“他知道/他明白/这意味着/必须需要”
// 连续替读者推理，读感像报告。单个判断词可服务推理；高密度聚集才提示回到角色当下证据。
const REASONING_CHAIN_PATTERNS = [
  { key: 'mental', core: true, pattern: /(?<![不没未无])(?:他|她|我)?(?:知道|明白|意识到|清楚|判断|确认|分析)/g },
  { key: 'connector', core: true, pattern: /这意味着|也就是说|换句话说|真正的问题(?:在于)?|问题在于|关键在于|在这种情况下|按照这个逻辑|只有这样|想到这里/g },
  { key: 'modal', core: true, pattern: /(?:(?<!不)(?:必须|需要|应该|只要|就会|可能|可以|能够|无法)|不能)[^。！？!?\n]{0,16}(?:判断|确认|承担|维持|稳住|控制|扩大|失控|带来|造成|理解|默认|回家|进门|核对|筛选|减少|建立|风险|结果|秩序|责任)/g },
  { key: 'abstract', core: false, pattern: /(?:任务|条件|风险|来源|逻辑|局面|结果|责任|秩序|规则|信息不足|决策能力)/g },
];
const REASONING_CHAIN_MIN_HITS = 8;
const REASONING_CHAIN_CORE_MIN_HITS = 4;
const REASONING_CHAIN_MIN_BUCKETS = 2;
const REASONING_CHAIN_PER_KILO = 18;

// 系统公告公文腔：只看成片方括号规则/面板行里的硬规则词。
// 这不是特定题材词表；单条严肃规则、日常叙述或普通对话不触发。
const NOTICE_FORMAL_PATTERNS = [
  /不得|必须|不可|禁止|严禁|应当|须|需|务必/g,
  /当前|本公告|本规则|本系统|提示|任务失败|临时权限|权限|状态|等级/g,
  /维持|公共区域|秩序|优先|惩罚|处罚|违规|指令|执行/g,
  /被视为|同样计入|计入|承担|责任|单位|撤回|转发|截图/g,
];
const NOTICE_FORMAL_CORE_PATTERN = /不得|必须|不可|禁止|严禁|应当|须|需|务必|被视为|同样计入|计入/g;
const NOTICE_FORMAL_MIN_LINES = 4;
const NOTICE_FORMAL_MIN_HITS = 12;
const NOTICE_FORMAL_CORE_MIN_HITS = 5;
const NOTICE_FORMAL_PER_KILO = 60;

// 过度精炼短段：过度处理样本里常见大量 15 字以内叙述段，且“的/了/就/着/过/呢/吧/啊”等
// 自然连接偏少；对照文本通常保留更多自然连接。此项只做 advisory，禁止机械注水。
const OVERCOMPRESSED_PROSE_PARTICLE_PATTERN = /[的了就着过呢吧啊呀嘛]/g;
const OVERCOMPRESSED_PROSE_MIN_CHARS = 1200;
const OVERCOMPRESSED_PROSE_MIN_PARAS = 45;
const OVERCOMPRESSED_PROSE_SHORT_MAX_CHARS = 15;
const OVERCOMPRESSED_PROSE_SHORT_RATIO = 0.58;
const OVERCOMPRESSED_PROSE_PARTICLE_PER_KILO = 85;

// Fw-02 碎化率（密/疏双轨的机械配套，细纲协议「密/疏双轨」节）：单章 ≤15 字「叙述段」
// （一行=一段，剥引号只算引号外叙述）占比 >25% advisory、>40% blocking。
// 与 overcompressed 的区别：那条要短段多+语气词少双条件，这条只看碎化占比，故阈值更低且分两档。
// 样本规模不足静默（短 beat/片段不判）；低压/过场章在 大纲/细纲_第NNN章.md 声明「碎化豁免」后
// blocking 降为 advisory（降级在主循环处理，因为细纲定位需要受检文件路径）。
const PROSE_FRAGMENT_MAX_CHARS = 15;
const PROSE_FRAGMENT_ADVISORY_RATIO = 0.25;
const PROSE_FRAGMENT_BLOCKING_RATIO = 0.40;
const PROSE_FRAGMENT_MIN_CHARS = 800;
const PROSE_FRAGMENT_MIN_PARAS = 30;

// Fw-05 沉默短语密度（追影 ch001-003 实证：人物反应全靠「没答/没说话」带过，对话无信息增量）：
// 只扫引号外叙述；「没答案」「没接住」等非沉默用法用后字排除。每千字 >3 次 advisory。
// 样本不足 1000 字静默（密度型阈值的自然窗口，同 low-connective 的 fail-open 哲学）。
const SILENCE_TIC_PATTERN = /没答(?!案)|没说话|没接(?:话|茬)?(?![住过到起力])|没吭声|不说话/g;
const SILENCE_TIC_PER_KILO = 3;
const SILENCE_TIC_MIN_CHARS = 1000;

// 低连接密度：单纯低功能词会误抓有大量中长句的文本；
// 因此必须叠加“中长句不足”，并只看引号外叙述。这是 overcompressed 的短窗口补充，只做 advisory。
const LOW_CONNECTIVE_FUNCTION_TERMS = ['的', '了', '就', '在', '是', '也', '都', '还', '又', '把', '被', '给', '这个', '那个', '里面', '以后', '时候', '现在', '因为', '所以', '但是', '不过', '然后', '已经', '还是', '起来', '出来', '下去'];
const LOW_CONNECTIVE_PLAIN_TERMS = ['的', '了', '就', '也', '还', '又', '这个', '那个', '东西', '事情', '时候', '里面', '以后', '一下', '一点', '有点', '还是'];
const LOW_CONNECTIVE_MIN_CHARS = 800;
const LOW_CONNECTIVE_FUNCTION_PER_KILO = 100;
const LOW_CONNECTIVE_PLAIN_PER_KILO = 65;
const LOW_CONNECTIVE_LONG_SENTENCE_CHARS = 30;
const LOW_CONNECTIVE_LONG_SENTENCE_RATIO = 0.08;

// either-or「不是A就是B / 不是A也是B」里紧贴的「是」是连词的一部分，不是肯定项系动词。
// 含「不」以沿用「不是A，也不是B」第二个否定段不算翻转的旧排除。
const COMPACT_EITHER_OR_PREV = new Set(['不', '就', '也']);
// 句尾语气/反问助词；「…，是吗 / 是吧 / 是嘛」是反问尾巴，不是否定后的肯定翻转。
const TAG_PARTICLES = new Set(['吗', '吧', '嘛']);
// 段首确认语；「不是第一次来。是的，他还记得……」里的「是的/是啊」
// 是承接确认，不是「不是 A，是 B」的肯定翻转。
const AFFIRMATION_TAG_PARTICLES = new Set(['的', '啊', '呀', '呢']);
const AFFIRMATION_TAG_BOUNDARY = new Set(['', '，', ',', '。', '.', '！', '!', '？', '?', '、', '；', ';', '：', ':', '\n', '\r', '\t', ' ']);

// 成对引号（台词/系统播报/弹幕）的字符对，stripQuoted 与 quotedRanges 共用一份来源。
// 引号片段一律不跨行（字符类里排掉 \n）：正文漏一个收引号很常见（多段台词只在末段收尾、
// 全半角引号混用都会漏），若允许跨行配对，一个未闭合的开引号会把后面成百上千字全算成
// 「引号内」，让 quotedRanges 的消费方（not-is 跨行扫描）把整段叙述静默豁免掉。
const QUOTE_PAIRS = [['「', '」'], ['『', '』'], ['【', '】'], ['“', '”'], ['‘', '’'], ['"', '"'], ["'", "'"]];
const QUOTE_SOURCES = QUOTE_PAIRS.map(([open, close]) => `${escapeRegExp(open)}[^${escapeRegExpCharClass(close)}\\n]*${escapeRegExp(close)}`);

// ---- 实战测试漏网句式（来源：实战写作抓到的真实漏网例句；2026-07 校准）----
// 校准基线：《万疆》真人正文 20 章（第1/10/20/…/190章）+ demo 前 20 章。
// blocking 规则要求真人语料命中 ≈0（每 20 章 ≤1 处且人工判定确属该句式）；数据见各规则注释。

// 音量反差腔（实战漏网 A）：「声音不高，第一句却稳稳压住了整个大厅。」
// 旧网只有套词密度桶里的「声音不大，却带着」，音量词/转折词一换就漏。
// 引号外叙述逐处 blocking；修法是删掉音量铺垫，直接写声音落进场子的具体效果。
// 校准：《万疆》20 章 0 命中，demo 前 20 章 0 命中。
const VOICE_CONTRAST_PATTERN = /声音(?:并)?不[大高响亮][^。！？!?\n]{0,16}[却但偏]/g;

// 否定排比（实战漏网 B）：「没有伴奏，没有和声，没有提词器。」同句 ≥2 个「没有X，」连排；
// 变体「他没炫技，没有那种…架势。他只是唱」先否定铺垫、再用「只是/只会/只有」收肯定。
// 只收「没/没有」段，不收「不X」段——真人叙述里「不哭不闹」类太常见，收进来误报换不来收益。
// 光杆「没」还得挡两类非否定用法，否则正常叙述会被判成排比：
//   1) 黏着语素（沉没/淹没/埋没/出没/隐没…）——前字排除，「船沉没在雾里，没人回头，…只有…」不算；
//   2) 时间惯用语（没多久/没过多久/没等X）——后字排除，「没多久，没等她撑伞，…只有…」不算。
// 「没有X」段不带这两种歧义（黏着语素后接不出「有」，时间惯用语已被后字排除覆盖），
// 第一条连排式照旧不加护栏。
// 校准：《万疆》20 章 0 命中，demo 前 20 章 0 命中。
const NEGATION_PARADE_PATTERNS = [
  /(?:没有[^。！？!?\n，,]{1,12}[，,]){2}/g,
  /(?<![沉淹埋出隐湮吞覆漫泯])没(?!有?过?多久)(?:有)?[^。！？!?\n，,]{1,12}[，,]\s*没(?!有?过?多久)(?:有)?[^。！？!?\n，,]{1,16}[，,。.][^。！？!?\n，,]{0,6}只(?:是|会|有)/g,
];
const CROSS_NEGATION_START = /^不是[^。！？!?\n]{1,24}[。！？!?]?$/;
const CROSS_NEGATION_MIDDLE = /^(?:也|还)不是[^。！？!?\n]{1,24}[。！？!?]?$/;
const CROSS_NEGATION_END = /^只是[^。！？!?\n]{1,32}[。！？!?]?$/;

// 两类常见但不能直接判错的工整框架，只做 advisory。与 blocking 规则不同，这里故意扫描
// 台词：自然点单「不放辣，不放葱」靠对象最短长度排除；更长的同动词清单交语义审查判断功能。
const DECISION_FRAME_PATTERN = /至于([\u3400-\u9fff]{1,3})不\1[，,]\s*怎么\1/g;
const REPEATED_NEGATIVE_VERB_PATTERN = /不([\u3400-\u9fff]{1,2})([\u3400-\u9fff]{2,8})[，,]\s*不\1([\u3400-\u9fff]{2,8})/g;

// 反序对比腔（实战漏网 C）：「是真嗓子，不是修音修出来的」——not-is-comparison 的反序变种。
// 复用 not-is 的排除基建：引号内剥离（maskQuoted）、「是的/是啊」确认语（isAffirmationTagAt）；
// 前字排除从 either-or 的 不/就/也 扩展到全部「X是」连词/副词合成词（还是/只是/可是/但是/
// 于是/倒是/像是/若是/要是/正是/便是/总是/老是/更是/最是/算是/怕是/凡是/或是/即是/自是/
// 竟是/原是/本是/仍是/许是/净是/光是/单是/尽是）；「是不是」问句起头与「不是吗/不是么/
// 不是吧」反问尾巴单独排除。
// 校准：《万疆》20 章 0 命中，demo 前 20 章 0 命中，按 blocking 实现。
const REVERSE_NOT_IS_PATTERN = /是([^。！？!?\n，,]{1,12})[，,]\s*(?:而)?不是([^。！？!?\n]{1,20})/g;
const REVERSE_NOT_IS_PREV_EXCLUDE = new Set([...COMPACT_EITHER_OR_PREV, '还', '只', '可', '但', '于', '倒', '像', '若', '要', '正', '便', '总', '老', '更', '最', '算', '怕', '凡', '或', '即', '自', '竟', '原', '本', '仍', '许', '净', '光', '单', '尽']);

// 预告式总结收尾（实战漏网 D）：「没人知道，这才刚刚开头。」「一场…震惊接力，正朝着…缓缓压了过去。」
// 章尾替读者预告下一章走向是 AI 收尾腔。只扫文末窗口（剥引号后可见字数，按行取整），
// 正文中段的「没人知道」多为普通叙述，不误伤；引号内台词（「没人知道…」）不计。
// 「正式拉开序幕/帷幕」是场内事件的报幕式陈述（真人语料「钟声再度响起，比赛正式拉开序幕」），
// 不是叙述者预告，前置 lookbehind 排除。
// 校准：《万疆》20 章排除「正式拉开序幕」2 处报幕句后 0 命中，demo 前 20 章 0 命中。
const TRAILER_ENDING_PATTERN = /没人知道|谁也不知道|谁也没想到|殊不知|不知道的是|(?:这)?才刚刚开(?:始|头)|正(?:朝着|向着)[^。！？!?\n]{0,24}(?:压|涌|袭|逼)(?:了?过去|了?过来|来)|(?<!正式)拉开(?:序幕|帷幕)|即将(?:开始|来临|降临)/g;
const TRAILER_ENDING_WINDOW_CHARS = 600;

// 章尾状态总结体：把细纲「结尾设定/收束状态」原样写成总结句收章（「这一夜注定无人入眠」
// 「这一切都结束了」「新的人生才刚刚开始」「命运的齿轮」）。与 trailer-ending 共用文末窗口，
// 区别是它盖章过去、trailer-ending 预告将来；收的都是 banned-words 已按名禁掉的形态。
// 不收「(这|那)一刻…终于明白」：真人语料里那是正常的认知节拍，短篇第一人称审判句还是卖点
// （short-craft「审判金句 / 心死余韵」），密度型由 advisory 的 abstract-summary-tic 兜。
// 各分支都要求落在句末断言位，否则会吃进条件从句（等这一切结束了，我们就…）、动补
// （这一切都说明得非常清楚）、成语跨匹配（这一刻…命中注定）、系表（这一战的结果是注定的）、
// 及物用法（就这样…才结束了这个话题）、场内报幕（就这样…宣布…圆满落幕）和否定认知
// （他不知道这一切意味着什么）——最后一类靠 (?!什么) 排掉间接疑问，那是盖章的反面。
// 校准（文末 600 字窗口，命中逐条人工复核）：qimao 章中段 20000 章命中 1 处（0.005%）、
// heiyan 整篇 3999 篇命中 22 处（0.550%，全部是上列禁用形态）；同批既有 trailer-ending
// 分别命中 1.345% / 6.602%——本规则误报面显著小于已上线的同窗口规则。短篇整篇即收口，
// 基线天然高于长篇章中段，故两个总体分别报数。
const TRAILER_SUMMARY_PATTERN = /这一(?:夜|天|刻|战|年|局|役)[，,]?[^。！？!?，,\n]{0,6}(?<!命中)(?<!是)注定[^。！？!?\n]{0,8}[。！]|就这样[，,][^。！？!?，,\n]{0,8}(?:一切|全部)[^。！？!?，,\n]{0,4}(?:结束了|落幕|收场)[。！]|这一切[，,]?[^。！？!?，,\n]{0,6}(?:都)?(?:说明|意味着|结束了)(?!的)(?:(?!什么)[^。！？!?\n]){0,6}[。！]|(?:新的篇章|新的旅程|崭新的篇章|新的人生)[^。！？!?\n]{0,6}(?:开始|拉开|展开)|命运[^。！？!?\n]{0,6}齿轮/g;

// 引号强调滥用（实战漏网 E，advisory 密度型，风格照 metaphor-density-tic）：
// 叙述里短词加引号强调（他是被请来"把关"的）。只数叙述层 1-4 字成对引号片段；
// 排除项：【】系统面板载体、引语动词（说|道|问|喊|答|念|叫|回|吼|嘀咕，加细 骂|写|读|唱）
// 前 6 字/后 3 字邻接的极短台词、引号内含句读的台词、引号外无叙述的行（独立台词/
// 弹幕流/拟声词连发）、引号套引号（台词内强调）。全文 ≥3 处报一条——单处强调是
// 正常修辞，密度高才是模板腔。
// 校准：demo 前 20 章 0 章过阈值；《万疆》20 章 2 章过阈值（海报标语“我在番城”系列、
// “邀战书”等转述载体，真人也这么写），所以该规则只做 advisory，不升 blocking。
const QUOTE_EMPHASIS_MIN_HITS = 3;
const QUOTE_EMPHASIS_MAX_VISIBLE = 4;
const QUOTE_EMPHASIS_SPEECH_VERB_PATTERN = /[说道问喊答念叫回吼骂写读唱嘀咕]/;

// 科普腔（05 实战护栏 L1，advisory 密度型，扫引号内台词）：AI 让角色开口当教科书，
// 一段台词连发定义/行话讲解（「会票就是商号开的借据式票据，认票不认人，凭票取银」）。
// 只扫引号内：叙述层的解释归 reasoning-chain，角色台词里的定义连发才是科普腔指纹；
// 【】面板是系统载体不算台词。次数与每千字双门槛，全文只报一条。
// 校准：隐笔 ch001「认票不认人」单发静默；对照版 ch001 一段台词连发 3 形态过阈报警。
const EXPLAIN_TIC_PATTERN = /所谓|的意思是|指的是|简单(?:地)?说|说白了|换句话说|通俗(?:地)?说|认[^\s，。！？、]{1,3}不认[^\s，。！？、]{1,3}|凭[^\s，。！？、]{1,4}[取兑]|就是[^\s，。！？、]{1,12}的[^\s，。！？、]{1,8}/g;
const EXPLAIN_TIC_MIN_HITS = 3;
const EXPLAIN_TIC_PER_KILO = 3;

// 段中预告腔（05 实战护栏 L2，advisory 逐处，扫引号外叙述）：预告标记出现在段中而非
// 章尾（「这笔账早晚要一样一样摆上桌」「他们迟早会想」）。章尾窗口归 trailer-ending；
// 这里是叙述层在段中间替读者预告未来，悬念被提前泄掉。只扫引号外：角色台词里的
// 「迟早/早晚」是人物语言，不拦。词表收窄到「要/会/得」后缀高置信形态，宁漏不拦错。
const MID_TRAILER_PATTERN = /却不知[道]?|殊不知|迟早[要会得]|早晚[要会得]|总有一天|有朝一日|待到那时|还不知道的是/g;

// 金句腔（05 实战护栏 L3，advisory 逐处，扫引号外叙述）：复盘/转折段「A是B的，C是D的。」
// 双短句对仗断言收拍（「戏是人家排的，他是登台的。」）。列举式证据链「票是假的，
// 章是仿的，有人见过真票」第二分句后接逗号继续流水，不命中——句号收拍独立成拍
// 才是金句腔；修法是把结论埋回事件/动作，让读者自己得出，别在叙述层替读者盖章。
// 校准：ch36 修复版「表是死的，人是活的。」会命中——功能性策略句人工判读后保留
//（与 quote-emphasis 在《万疆》的 advisory 先例同理：真人也这么写，只提示不拦）。
const APHORISM_PATTERN = /[\u4e00-\u9fa5A-Za-z0-9]{1,6}是[\u4e00-\u9fa5A-Za-z0-9]{1,10}的[，,][\u4e00-\u9fa5A-Za-z0-9]{1,6}是[\u4e00-\u9fa5A-Za-z0-9]{1,10}的[。！？]/g;

const options = {
  json: false,
  files: [],
  failOn: 'all',
};

for (let i = 2; i < process.argv.length; i += 1) {
  const arg = process.argv[i];
  if (arg === '--check') {
    // Accepted for symmetry with normalize-punctuation.js; detection is always check-only.
  } else if (arg === '--json') {
    options.json = true;
  } else if (arg.startsWith('--fail-on=')) {
    const v = arg.slice('--fail-on='.length);
    if (v !== 'blocking' && v !== 'all') die(`--fail-on must be 'blocking' or 'all'`);
    options.failOn = v;
  } else if (arg === '-h' || arg === '--help') {
    process.stdout.write(`${USAGE}\n`);
    process.exit(0);
  } else if (arg.startsWith('-')) {
    die(`Unknown option: ${arg}`);
  } else {
    options.files.push(arg);
  }
}

if (options.files.length === 0) {
  die('No files provided');
}

// I2 phrase-quota 缓存：主循环（下方 for）先于文件尾函数区的顶层 const 执行，声明须置于循环前。
const phraseBlacklistCache = new Map();
const siblingChaptersCache = new Map();
// Z7 跨章体感重复缓存：同上，主循环先于函数区执行，声明须置于循环前。
const anchorRegistryCache = new Map();
const siblingTextCache = new Map();
// PV2 视角纪律缓存：批次公约 POV 规格行 + _tracking-state 角色名表，同上须置于循环前。
const povPactCache = new Map();
const povStateCache = new Map();
// Z7 身体动作 tic 模式表（主循环经 findSensoryRepeatTic 引用，须置于循环前）。
const SENSORY_REPEAT_PATTERNS = [
  /咽了?口水/g,
  /手心(发|冒)?汗/g,
  /掌心(发|冒)?汗/g,
  /咬了?下?嘴唇?/g,
  /攥紧(了)?拳头?/g,
  /指节泛白/g,
  /喉咙(发紧|一紧)/g,
  /心跳(加速|骤然|猛地?加快|骤快)/g,
  /眉(头|心)紧(锁|蹙)/g,
  /瞳孔(微|一|骤)?缩/g,
  /脊背(发凉|一僵)/g,
  /后背(发凉|一僵)/g,
  /鼻尖(发酸|一酸)/g,
  /眼眶(发红|一热)/g,
  /太阳穴(突突|跳动)/g,
  /喉结(滚动|上下?动)/g,
];
// SP3 口吃标点正则（主循环经 findStutterPunct 引用，须置于循环前）。
const STUTTER_RE = /([\u4e00-\u9fa5])[：:]\1/g;
// PV2 心理动词词表 + 自由间接引语弱信号（主循环经 findPovDrift 引用，须置于循环前）。
const POV_PSYCH_RE = /拿不准|纳闷|琢磨|寻思|暗想|思忖|盘算|心里(?:叫苦|发慌|打鼓|没底)|暗自|犯嘀咕|打定了?主意|备好了?|心道|暗忖|心想|觉得/g;
const POV_FREE_INDIRECT_RE = /[他她][^。！？]{0,6}哪(?:是|要的是)/;

let failed = false;
const allFindings = [];

for (const file of options.files) {
  const fullPath = path.resolve(file);
  let input;
  try {
    input = fs.readFileSync(fullPath, 'utf8');
  } catch (error) {
    failed = true;
    if (!options.json) console.error(`${file}: unable to read (${error.message})`);
    continue;
  }

  const findings = scanDocument(input).map((finding) => ({ file, ...finding }));
  // I2 phrase-quota：需要文件路径定位项目黑名单与相邻章，故在主循环接线而非 scanProsePatterns。
  findings.push(...findPhraseQuota(fullPath, input).map((finding) => ({ file, ...finding })));
  // Z7 跨章体感重复（docs/10 §一 Z7）：扫全卷需兄弟章文本，故在主循环接线。
  findings.push(...findSensoryRepeatTic(fullPath, input).map((finding) => ({ file, ...finding })));
  // SP3 口吃标点（docs/11 §一）：确定性错字，出现即报，故在主循环接线（与 Z7 同型一行）。
  findings.push(...findStutterPunct(fullPath, input).map((finding) => ({ file, ...finding })));
  // PV2 视角纪律（docs/11 §二）：读批次公约 POV 规格 + 扫叙述层心理动词命中，故在主循环接线。
  findings.push(...findPovDrift(fullPath, input).map((finding) => ({ file, ...finding })));
  // Fw-05 对话零信息启发式（仅 ch001-003）：读批次公约 POV 定位主角，两弱信号同中才报，故主循环接线。
  findings.push(...findDialogueZeroInformation(fullPath, input).map((finding) => ({ file, ...finding })));
  // Fw-02 碎化豁免：细纲显式声明「碎化豁免」后，碎化率 blocking 降 advisory（低压/过场章通道）。
  if (hasFragmentExemption(fullPath)) {
    for (const finding of findings) {
      if (finding.type === 'prose-fragment-ratio' && finding.severity === 'blocking') {
        finding.severity = 'advisory';
        finding.message += '【细纲已声明碎化豁免，降级 advisory】';
      }
    }
  }
  allFindings.push(...findings);
}

if (options.json) {
  process.stdout.write(`${JSON.stringify({ findings: allFindings }, null, 2)}\n`);
} else {
  for (const finding of allFindings) {
    console.log(`${finding.file}:${finding.line}:${finding.column}: [${finding.severity}] ${finding.type}: ${finding.message} (${finding.excerpt})`);
  }
}

if (failed) process.exit(2);
// --fail-on=blocking 只在出现 blocking finding 时退出 1（advisory 仅报告）；默认 all 沿用「有任何 finding 即 1」。
const hasBlocking = allFindings.some((f) => f.severity === 'blocking');
if (options.failOn === 'blocking' ? hasBlocking : allFindings.length > 0) process.exit(1);

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function escapeRegExpCharClass(text) {
  return text.replace(/[\\\]^-]/g, '\\$&');
}

function die(message) {
  console.error(message);
  console.error(USAGE.trimEnd());
  process.exit(2);
}

function scanDocument(input) {
  const lines = input.split(/\r?\n/);
  const findings = [];
  let fence = null;
  let inFrontMatter = hasYamlFrontMatter(lines);
  let block = [];
  const proseLines = [];

  const flushBlock = () => {
    if (block.length === 0) return;
    findings.push(...scanBlock(block));
    block = [];
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();

    if (inFrontMatter) {
      if (index > 0 && trimmed === '---') inFrontMatter = false;
      continue;
    }

    const fenceMarker = parseFenceMarker(trimmed);
    if (fence) {
      if (fenceMarker && fenceMarker.char === fence.char && fenceMarker.length >= fence.length) {
        fence = null;
      }
      continue;
    }

    if (fenceMarker) {
      flushBlock();
      fence = fenceMarker;
      continue;
    }

    block.push({ text: line, lineNo: index + 1 });
    proseLines.push({ text: line, lineNo: index + 1 });
  }

  flushBlock();
  findings.push(...scanProsePatterns(proseLines));
  findings.sort((a, b) => a.line - b.line || a.column - b.column);
  return findings;
}

// 段落级检测：碎句号（连续短叙述句）、长段落、破折号（按功能改写，非机械替换）。
function scanProsePatterns(proseLines) {
  const findings = [];

  for (const { text, lineNo } of proseLines) {
    const trimmed = text.trim();
    if (!trimmed || isDivider(trimmed) || isStructural(trimmed)) continue;

    const dashPattern = /——|—|--+/g;
    let dash;
    while ((dash = dashPattern.exec(text)) !== null) {
      findings.push({
        line: lineNo,
        column: dash.index + 1,
        type: 'em-dash',
        severity: 'blocking',
        message: '破折号按功能改写：打断→动作 beat/短句，拖长音→省略或动作，插入说明→逗号/冒号；勿一律改句号。',
        excerpt: compact(text.slice(Math.max(0, dash.index - 8), dash.index + dash[0].length + 8)),
      });
    }

    if (trimmed.length > LONG_PARAGRAPH_CHARS) {
      findings.push({
        line: lineNo,
        column: 1,
        type: 'long-paragraph',
        severity: 'advisory',
        message: `段落过长（${trimmed.length} 字）：按镜头/新动作/新线索/视线切换断段，别一段到底。`,
        excerpt: compact(trimmed.slice(0, 40)),
      });
    }
  }

  findings.push(...findVoiceContrast(proseLines));
  findings.push(...findNegationParade(proseLines));
  findings.push(...findFormulaicParallelism(proseLines));
  findings.push(...findReverseNotIs(proseLines));
  findings.push(...findTrailerEnding(proseLines));
  findings.push(...findQuoteEmphasisTic(proseLines));
  findings.push(...findPeriodStutter(proseLines));
  findings.push(...findMicroActionTic(proseLines));
  findings.push(...findActionListTic(proseLines));
  findings.push(...findAbstractSummaryTic(proseLines));
  findings.push(...findClicheDensityTic(proseLines));
  findings.push(...findMetaphorDensityTic(proseLines));
  findings.push(...findReasoningChainTic(proseLines));
  findings.push(...findNoticeFormalityTic(proseLines));
  findings.push(...findOvercompressedProseTic(proseLines));
  findings.push(...findProseFragmentRatioTic(proseLines));
  findings.push(...findSilenceDensityTic(proseLines));
  findings.push(...findLowConnectiveDensityTic(proseLines));
  findings.push(...findExplainTic(proseLines));
  findings.push(...findMidTrailerTic(proseLines));
  findings.push(...findAphorismTic(proseLines));
  return findings;
}

// 音量反差腔（实战漏网 A）：引号外叙述逐处 blocking，位置与摘录取自原文
// （maskQuoted 等长占位保偏移；命中片段不含问号占位符，故不会落进占位区）。
function findVoiceContrast(proseLines) {
  const findings = [];

  for (const { text, lineNo } of proseLines) {
    const trimmed = text.trim();
    if (!trimmed || isDivider(trimmed) || isStructural(trimmed)) continue;
    const masked = maskQuoted(text);
    VOICE_CONTRAST_PATTERN.lastIndex = 0;
    let match;
    while ((match = VOICE_CONTRAST_PATTERN.exec(masked)) !== null) {
      findings.push({
        line: lineNo,
        column: match.index + 1,
        type: 'voice-contrast',
        severity: 'blocking',
        message: '音量反差腔：「声音不大/不高…却/但…」是 AI 高频反差模板；删掉音量铺垫，直接写声音落进场子的具体效果（谁停了手、哪排安静了）。',
        excerpt: compact(text.slice(match.index, match.index + match[0].length)),
      });
    }
  }

  return findings;
}

// 否定排比（实战漏网 B）：同句「没有X，」连排 / 先否定后「只是」收肯定。
// 可能在同一片文字上重叠命中，按区间去重只报一次。
function findNegationParade(proseLines) {
  const findings = [];

  for (const { text, lineNo } of proseLines) {
    const trimmed = text.trim();
    if (!trimmed || isDivider(trimmed) || isStructural(trimmed)) continue;
    const masked = maskQuoted(text);

    const spans = [];
    for (const pattern of NEGATION_PARADE_PATTERNS) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(masked)) !== null) {
        spans.push([match.index, match.index + match[0].length]);
      }
    }
    spans.sort((a, b) => a[0] - b[0]);

    let lastEnd = -1;
    for (const [start, end] of spans) {
      if (start < lastEnd) {
        lastEnd = Math.max(lastEnd, end);
        continue;
      }
      lastEnd = end;
      findings.push({
        line: lineNo,
        column: start + 1,
        type: 'negation-parade',
        severity: 'blocking',
        message: '否定排比：「没有X，没有Y…」/「没X，没有Y，只是Z」是 AI 高频排比模板；删掉否定清单，直接写现场实际有什么，最多留一个最有信息量的否定。',
        excerpt: compact(text.slice(start, end)),
      });
    }
  }

  return findings;
}

function findFormulaicParallelism(proseLines) {
  const findings = [];

  for (const { text, lineNo } of proseLines) {
    const trimmed = text.trim();
    if (!trimmed || isDivider(trimmed) || isStructural(trimmed)) continue;
    for (const [pattern, message] of [
      [DECISION_FRAME_PATTERN, '「至于X不X，怎么X」把同一决定拆成工整栏目；若只是复述细纲，压成角色当下的一次判断或直接动作。'],
      [REPEATED_NEGATIVE_VERB_PATTERN, '同动词「不V A，不V B」容易写成否定清单；含台词也要按语境复核，保留真正有功能的一项即可。'],
    ]) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(text)) !== null) {
        findings.push({
          line: lineNo,
          column: match.index + 1,
          type: 'formulaic-parallelism',
          severity: 'advisory',
          message,
          excerpt: compact(match[0]),
        });
      }
    }
  }

  // 跨段「不是A / 也不是B / 只是C」既可能是细纲复述，也可能是正常的
  // 辩解、悬念排除或情绪递进。纯句法无法稳定区分，因此只给 advisory，交给语义复核。
  const window = [];
  for (const { text, lineNo } of proseLines) {
    const trimmed = text.trim();
    if (!trimmed) continue;
    if (isDivider(trimmed) || isStructural(trimmed)) {
      window.length = 0;
      continue;
    }
    if (window.length && lineNo - window[window.length - 1].lineNo > 2) window.length = 0;
    window.push({ text: maskQuoted(trimmed), original: trimmed, lineNo });
    if (window.length > 3) window.shift();
    if (window.length !== 3) continue;
    if (!CROSS_NEGATION_START.test(window[0].text)
      || !CROSS_NEGATION_MIDDLE.test(window[1].text)
      || !CROSS_NEGATION_END.test(window[2].text)) continue;
    findings.push({
      line: window[0].lineNo,
      column: 1,
      type: 'formulaic-parallelism',
      severity: 'advisory',
      message: '跨段「不是… / 也不是… / 只是…」可能是工整否定铺排，也可能承担辩解或悬念排除；通读语境，只在重复细纲或拖慢画面时改写。',
      excerpt: compact(window.map((entry) => entry.original).join(' / ')),
    });
  }

  return findings;
}

// 反序对比腔（实战漏网 C）：「是A，不是B」。排除基建复用 not-is-comparison：
// 引号内剥离、「是的/是啊」确认语；前字合成词与反问尾巴见 REVERSE_NOT_IS_PREV_EXCLUDE 注释。
function findReverseNotIs(proseLines) {
  const findings = [];

  for (const { text, lineNo } of proseLines) {
    const trimmed = text.trim();
    if (!trimmed || isDivider(trimmed) || isStructural(trimmed)) continue;
    const masked = maskQuoted(text);
    REVERSE_NOT_IS_PATTERN.lastIndex = 0;
    let match;
    while ((match = REVERSE_NOT_IS_PATTERN.exec(masked)) !== null) {
      const start = match.index;
      // 「就是/也是/还是/只是/可是…」里的「是」是合成词一部分，不是肯定项系动词。
      if (REVERSE_NOT_IS_PREV_EXCLUDE.has(masked[start - 1])) continue;
      // 「是不是…」问句起头。
      if (masked[start + 1] === '不') continue;
      // 「是的，…不是…」承接确认语（复用 not-is 的判定）。
      if (isAffirmationTagAt(masked, start)) continue;
      // 「…，不是吗/不是么/不是吧」反问尾巴。
      if (/^[吗么吧]/.test(match[2])) continue;
      findings.push({
        line: lineNo,
        column: start + 1,
        type: 'reverse-not-is',
        severity: 'blocking',
        message: '反序对比腔：「是A，不是B」与「不是A，是B」同族；删掉后置否定，直接写 A 的具体表现，或用细节让读者自己对比。',
        excerpt: compact(text.slice(start, start + match[0].length)),
      });
    }
  }

  return findings;
}

// 科普腔（L1）：统计引号内台词（【】面板除外）的定义标记密度。次数与每千字双门槛，
// 全文只报一条（分布级指纹）。台词字数做分母——科普腔是台词内部的自指密度。
function findExplainTic(proseLines) {
  let hits = 0;
  let speechChars = 0;
  let firstLine = null;
  const samples = [];

  for (const { text, lineNo } of proseLines) {
    const trimmed = text.trim();
    if (!trimmed || isDivider(trimmed) || isStructural(trimmed)) continue;
    const quoted = quotedOnly(text);
    if (!quoted) continue;
    speechChars += visibleLength(quoted);
    EXPLAIN_TIC_PATTERN.lastIndex = 0;
    let match;
    while ((match = EXPLAIN_TIC_PATTERN.exec(quoted)) !== null) {
      hits += 1;
      if (firstLine === null) firstLine = lineNo;
      if (samples.length < 6 && !samples.includes(match[0])) samples.push(match[0]);
    }
  }

  if (speechChars === 0 || hits < EXPLAIN_TIC_MIN_HITS) return [];
  const perKilo = (hits / speechChars) * 1000;
  if (perKilo < EXPLAIN_TIC_PER_KILO) return [];

  return [{
    line: firstLine,
    column: 1,
    type: 'explain-tic',
    severity: 'advisory',
    message: `科普腔：台词内定义/行话讲解标记 ${hits} 处；角色不是教科书，把定义拆进冲突与追问里，让读者跟着案情自己弄懂，别一段台词一口气讲完。`,
    excerpt: compact(samples.join(' ')),
  }];
}

// 段中预告腔（L2）：引号外叙述逐处 advisory（masked 等长占位保偏移；问号占位符
// 不在词表字符集内，命中不会落进引号区）。
function findMidTrailerTic(proseLines) {
  const findings = [];
  for (const { text, lineNo } of proseLines) {
    const trimmed = text.trim();
    if (!trimmed || isDivider(trimmed) || isStructural(trimmed)) continue;
    const masked = maskQuoted(text);
    MID_TRAILER_PATTERN.lastIndex = 0;
    let match;
    while ((match = MID_TRAILER_PATTERN.exec(masked)) !== null) {
      findings.push({
        line: lineNo,
        column: match.index + 1,
        type: 'mid-trailer',
        severity: 'advisory',
        message: '段中预告腔：叙述层在段中替读者预告未来（早晚要/迟早会/总有一天/却不知）；预告把悬念提前泄掉，删掉这句或改成当下可见的证据，未来让事件自己揭晓。',
        excerpt: compact(text.slice(Math.max(0, match.index - 6), match.index + match[0].length + 10)),
      });
    }
  }
  return findings;
}

// 金句腔（L3）：引号外叙述逐处 advisory。只认「第二分句句号收拍」的严格对仗形态，
// 逗号续写的列举句不命中（见常量注释校准）。
function findAphorismTic(proseLines) {
  const findings = [];
  for (const { text, lineNo } of proseLines) {
    const trimmed = text.trim();
    if (!trimmed || isDivider(trimmed) || isStructural(trimmed)) continue;
    const masked = maskQuoted(text);
    APHORISM_PATTERN.lastIndex = 0;
    let match;
    while ((match = APHORISM_PATTERN.exec(masked)) !== null) {
      findings.push({
        line: lineNo,
        column: match.index + 1,
        type: 'aphorism-tic',
        severity: 'advisory',
        message: '金句腔：双短句对仗断言收拍（A是B的，C是D的。）是替读者盖章的复盘腔；把结论埋回具体事件与动作，让对仗感从证据里长出来，别在叙述层直接断言。',
        excerpt: compact(text.slice(match.index, match.index + match[0].length)),
      });
    }
  }
  return findings;
}

// 引号内文本拼接（科普腔用）：取成对引号内部（含台词内强调引号，都是角色语言），
// 跳过【】系统面板载体。无引号返回空串。
function quotedOnly(text) {
  const ranges = quotedRanges(text);
  if (ranges.length === 0) return '';
  return ranges
    .filter(([start]) => text[start] !== '【')
    .map(([start, end]) => text.slice(start + 1, end - 1))
    .join('');
}

// 预告式总结收尾（实战漏网 D）：只扫文末窗口。从文末往回收集叙述行，
// 直到剥引号后的可见字数达到窗口大小（按行取整，边界行整行计入）。
function findTrailerEnding(proseLines) {
  const windowLines = [];
  let accumulated = 0;

  for (let i = proseLines.length - 1; i >= 0 && accumulated < TRAILER_ENDING_WINDOW_CHARS; i -= 1) {
    const { text } = proseLines[i];
    const trimmed = text.trim();
    if (!trimmed || isDivider(trimmed) || isStructural(trimmed)) continue;
    windowLines.unshift(proseLines[i]);
    accumulated += visibleLength(stripQuoted(trimmed));
  }

  const findings = [];
  for (const { text, lineNo } of windowLines) {
    const masked = maskQuoted(text);
    TRAILER_ENDING_PATTERN.lastIndex = 0;
    let match;
    while ((match = TRAILER_ENDING_PATTERN.exec(masked)) !== null) {
      findings.push({
        line: lineNo,
        column: match.index + 1,
        type: 'trailer-ending',
        severity: 'blocking',
        message: '预告式总结收尾：「没人知道/才刚刚开始/正朝着…压了过去」是 AI 章尾预告腔；结尾停在具体动作、画面或一句台词上，悬念让事件自己挂住，别替读者预告下一章。',
        excerpt: compact(text.slice(match.index, match.index + match[0].length)),
      });
    }
    TRAILER_SUMMARY_PATTERN.lastIndex = 0;
    let summaryMatch;
    while ((summaryMatch = TRAILER_SUMMARY_PATTERN.exec(masked)) !== null) {
      findings.push({
        line: lineNo,
        column: summaryMatch.index + 1,
        type: 'trailer-summary',
        severity: 'blocking',
        message: '章尾状态总结体：「这一夜注定…/这一切都结束了/新的人生才刚刚开始/命运的齿轮」是把细纲的收束状态原样写成了总结句；收束状态是规划口径，正文落到最后一个具体动作、画面或台词上，别替读者盖章。',
        excerpt: compact(text.slice(summaryMatch.index, summaryMatch.index + summaryMatch[0].length)),
      });
    }
  }

  return findings;
}

// 引号强调滥用（实战漏网 E）：统计叙述层 1-4 字成对引号强调片段，全文只报一条
// （密度型分布指纹）。台词类排除见 QUOTE_EMPHASIS_* 常量注释。
function findQuoteEmphasisTic(proseLines) {
  let hits = 0;
  let firstLine = null;
  const samples = [];

  for (const { text, lineNo } of proseLines) {
    const trimmed = text.trim();
    if (!trimmed || isDivider(trimmed) || isStructural(trimmed)) continue;
    // 引号外没有叙述的行（独立台词/弹幕流/拟声词连发「“叮咚~”“叮咚~”」）整行跳过：
    // 强调滥用是叙述层指纹，没有叙述就无所谓强调。
    if (visibleLength(stripQuoted(trimmed)) === 0) continue;
    const ranges = quotedRanges(text);

    for (const [start, end] of ranges) {
      if (text[start] === '【') continue; // 系统面板/公告载体，不是强调引号
      // 引号套引号：台词内部的强调属于角色语言，不算叙述层强调滥用。
      if (ranges.some(([s2, e2]) => s2 <= start && end <= e2 && (s2 !== start || e2 !== end))) continue;
      const inner = text.slice(start + 1, end - 1);
      const visible = visibleLength(inner);
      if (visible < 1 || visible > QUOTE_EMPHASIS_MAX_VISIBLE) continue;
      if (/[。！？!?…，,；;：:]/.test(inner)) continue; // 含句读的是台词/播报，不是强调
      const before = text.slice(Math.max(0, start - 6), start);
      const after = text.slice(end, end + 3);
      if (QUOTE_EMPHASIS_SPEECH_VERB_PATTERN.test(before) || QUOTE_EMPHASIS_SPEECH_VERB_PATTERN.test(after)) continue; // 引语动词邻接=极短台词
      hits += 1;
      if (firstLine === null) firstLine = lineNo;
      if (samples.length < 6 && !samples.includes(inner)) samples.push(inner);
    }
  }

  if (hits < QUOTE_EMPHASIS_MIN_HITS) return [];

  return [{
    line: firstLine,
    column: 1,
    type: 'quote-emphasis-tic',
    severity: 'advisory',
    message: `引号强调滥用：叙述里 1-4 字短词加引号强调 ${hits} 处；只留真正反讽/转述必要的一两处，其余去掉引号直接写，或换成具体动作让读者自己品。`,
    excerpt: compact(samples.join(' ')),
  }];
}

// 微动作复读：统计引号外叙述里「了X量词」轻量补语的密度。次数与每千字密度双门槛，
// 全文只报一条（这是分布级指纹，不是逐处问题）。
function findMicroActionTic(proseLines) {
  let hits = 0;
  let narrativeChars = 0;
  let firstLine = null;
  const samples = [];

  for (const { text, lineNo } of proseLines) {
    const trimmed = text.trim();
    if (!trimmed || isDivider(trimmed) || isStructural(trimmed)) continue;
    const narrative = stripQuoted(trimmed);
    narrativeChars += visibleLength(narrative);
    MICRO_TIC_PATTERN.lastIndex = 0;
    let match;
    while ((match = MICRO_TIC_PATTERN.exec(narrative)) !== null) {
      hits += 1;
      if (firstLine === null) firstLine = lineNo;
      if (samples.length < 6 && !samples.includes(match[0])) samples.push(match[0]);
    }
  }

  if (narrativeChars === 0 || hits < MICRO_TIC_MIN_HITS) return [];
  const perKilo = (hits / narrativeChars) * 1000;
  if (perKilo < MICRO_TIC_PER_KILO) return [];

  return [{
    line: firstLine,
    column: 1,
    type: 'micro-action-tic',
    severity: 'advisory',
    message: `微动作复读：「了下/了一下」式轻量补语 ${hits} 处（${perKilo.toFixed(1)}/千字）；同一反应模板高密度复现是机械指纹，合并动作 beat、换具体细节，别每个动作都补一个轻反应尾巴。`,
    excerpt: compact(samples.join(' ')),
  }];
}

function findActionListTic(proseLines) {
  const findings = [];

  for (const { text, lineNo } of proseLines) {
    const trimmed = text.trim();
    if (!trimmed || isDivider(trimmed) || isStructural(trimmed)) continue;
    const narrative = stripQuoted(trimmed).trim();
    if (!narrative) continue;

    ACTION_LIST_VERB_PATTERN.lastIndex = 0;
    const verbs = [];
    let match;
    while ((match = ACTION_LIST_VERB_PATTERN.exec(narrative)) !== null) {
      verbs.push(match[0]);
    }

    if (verbs.length < ACTION_LIST_MIN_HITS) continue;
    const separators = (narrative.match(/[，、；;]/g) || []).length;
    if (separators < ACTION_LIST_MIN_SEPARATORS) continue;

    findings.push({
      line: lineNo,
      column: 1,
      type: 'action-list-tic',
      severity: 'advisory',
      message: `监控摄像头式动作清单：同段连续动作动词 ${verbs.length} 个、分隔符 ${separators} 个；合并琐碎步骤，只保留有情绪/情节功能的动作，必要时用角色犹豫、误判或环境反馈做缓冲。`,
      excerpt: compact(verbs.slice(0, 8).join(' ')),
    });
  }

  return findings;
}

// 套词密度：统计引号外叙述中的高危禁用词聚集。不是逐词替换器；只在密度高到
// 形成模板腔时提示，修法是删总结、换具体动作/物件/对话，不是同义词轮换。
function findClicheDensityTic(proseLines) {
  let hits = 0;
  let narrativeChars = 0;
  let firstLine = null;
  const samples = [];

  for (const { text, lineNo } of proseLines) {
    const trimmed = text.trim();
    if (!trimmed || isDivider(trimmed) || isStructural(trimmed)) continue;
    const narrative = stripQuoted(trimmed);
    narrativeChars += visibleLength(narrative);

    for (const pattern of CLICHE_PATTERNS) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(narrative)) !== null) {
        hits += 1;
        if (firstLine === null) firstLine = lineNo;
        if (samples.length < 8 && !samples.includes(match[0])) samples.push(match[0]);
      }
    }
  }

  if (narrativeChars === 0 || hits < CLICHE_DENSITY_MIN_HITS) return [];
  const perKilo = (hits / narrativeChars) * 1000;
  if (perKilo < CLICHE_DENSITY_PER_KILO) return [];

  return [{
    line: firstLine,
    column: 1,
    type: 'cliche-density-tic',
    severity: 'advisory',
    message: `套词密度过高：高危 AI 套词 ${hits} 处（${perKilo.toFixed(1)}/千字）；不要同义词轮换，改成角色当下可见的动作、物件、对话和具体后果。`,
    excerpt: compact(samples.join(' ')),
  }];
}

// 比喻密度：统计引号外叙述中“像/好像/仿佛/如同”等比喻标记。
// 单个比喻不是问题；高密度成片时才提示，避免把文本改成另一种修辞模板。
function findMetaphorDensityTic(proseLines) {
  let hits = 0;
  let narrativeChars = 0;
  let firstLine = null;
  const samples = [];

  for (const { text, lineNo } of proseLines) {
    const trimmed = text.trim();
    if (!trimmed || isDivider(trimmed) || isStructural(trimmed)) continue;
    const narrative = stripQuoted(trimmed);
    narrativeChars += visibleLength(narrative);

    METAPHOR_MARKER_PATTERN.lastIndex = 0;
    let match;
    while ((match = METAPHOR_MARKER_PATTERN.exec(narrative)) !== null) {
      hits += 1;
      if (firstLine === null) firstLine = lineNo;
      const sample = sentenceAround(narrative, match.index);
      if (samples.length < 6 && sample && !samples.includes(sample)) samples.push(sample);
    }

    METAPHOR_LIKE_PHRASE_PATTERN.lastIndex = 0;
    while ((match = METAPHOR_LIKE_PHRASE_PATTERN.exec(narrative)) !== null) {
      const prefix = narrative.slice(Math.max(0, match.index - 8), match.index);
      if (/好像|像是|像|仿佛|宛如|如同|犹如/.test(prefix)) continue;
      hits += 1;
      if (firstLine === null) firstLine = lineNo;
      const sample = sentenceAround(narrative, match.index);
      if (samples.length < 6 && sample && !samples.includes(sample)) samples.push(sample);
    }
  }

  if (narrativeChars === 0 || hits < METAPHOR_DENSITY_MIN_HITS) return [];
  const perKilo = (hits / narrativeChars) * 1000;
  if (perKilo < METAPHOR_DENSITY_PER_KILO) return [];

  return [{
    line: firstLine,
    column: 1,
    type: 'metaphor-density-tic',
    severity: 'advisory',
    message: `比喻密度过高：像/好像/仿佛/如同等比喻标记 ${hits} 处（${perKilo.toFixed(1)}/千字）；保留最有叙事功能的少数比喻，其余回到具体动作、物件、声音或后果，不要换成新比喻。`,
    excerpt: compact(samples.join(' | ')),
  }];
}

// 解释链密度：统计引号外叙述中“知道/明白/这意味着/必须需要”等判断链。
// 全篇只报一条；修法不是补结构虚词，而是把判断落到动作、物件、对话和现场反馈。
function findReasoningChainTic(proseLines) {
  let hits = 0;
  let coreHits = 0;
  let narrativeChars = 0;
  let firstLine = null;
  const samples = [];
  const buckets = new Set();

  for (const { text, lineNo } of proseLines) {
    const trimmed = text.trim();
    if (!trimmed || isDivider(trimmed) || isStructural(trimmed)) continue;
    const narrative = stripQuoted(trimmed);
    narrativeChars += visibleLength(narrative);

    for (const { pattern, key, core } of REASONING_CHAIN_PATTERNS) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(narrative)) !== null) {
        hits += 1;
        if (core) coreHits += 1;
        buckets.add(key);
        if (firstLine === null) firstLine = lineNo;
        const sample = compact(match[0]);
        if (samples.length < 8 && !samples.includes(sample)) samples.push(sample);
      }
    }
  }

  if (narrativeChars === 0 || hits < REASONING_CHAIN_MIN_HITS) return [];
  if (coreHits < REASONING_CHAIN_CORE_MIN_HITS || buckets.size < REASONING_CHAIN_MIN_BUCKETS) return [];
  const perKilo = (hits / narrativeChars) * 1000;
  if (perKilo < REASONING_CHAIN_PER_KILO) return [];

  return [{
    line: firstLine,
    column: 1,
    type: 'reasoning-chain-tic',
    severity: 'advisory',
    message: `解释链密度过高：知道/明白/这意味着/必须/需要等判断链 ${hits} 处（${perKilo.toFixed(1)}/千字）；像逻辑报告时，把判断落到角色当下可见的动作、物件、对话和现场反馈。`,
    excerpt: compact(samples.join(' | ')),
  }];
}

// 系统/规则行如果连续像 API 文档或政府公文，读者容易闻到机器味。
// 修法不是删除规则，而是保留功能后把一部分硬词改成白话或具体后果。
function findNoticeFormalityTic(proseLines) {
  let hits = 0;
  let noticeChars = 0;
  let noticeLines = 0;
  let coreHits = 0;
  let firstLine = null;
  const samples = [];

  for (const { text, lineNo } of proseLines) {
    const trimmed = text.trim();
    if (!/^【[^】]+】$/.test(trimmed)) continue;
    noticeLines += 1;
    noticeChars += visibleLength(trimmed);

    NOTICE_FORMAL_CORE_PATTERN.lastIndex = 0;
    while (NOTICE_FORMAL_CORE_PATTERN.exec(trimmed) !== null) coreHits += 1;

    for (const pattern of NOTICE_FORMAL_PATTERNS) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(trimmed)) !== null) {
        hits += 1;
        if (firstLine === null) firstLine = lineNo;
        const sample = compact(match[0]);
        if (samples.length < 8 && !samples.includes(sample)) samples.push(sample);
      }
    }
  }

  if (noticeLines < NOTICE_FORMAL_MIN_LINES || noticeChars === 0 || hits < NOTICE_FORMAL_MIN_HITS || coreHits < NOTICE_FORMAL_CORE_MIN_HITS) return [];
  const perKilo = (hits / noticeChars) * 1000;
  if (perKilo < NOTICE_FORMAL_PER_KILO) return [];

  return [{
    line: firstLine,
    column: 1,
    type: 'system-notice-formality-tic',
    severity: 'advisory',
    message: `系统公告公文腔过密：方括号规则行中硬规则词 ${hits} 处（${perKilo.toFixed(1)}/千字）；保留为角色看见的屏幕/公告/规则载体，只在载体内部白话化部分硬词，或补角色当场看懂的具体后果，不改成叙述者解释。`,
    excerpt: compact(samples.join(' | ')),
  }];
}

// 长文本整体过于“精炼”：短段很多、自然连接偏少，读起来像处理过的梗概/分镜表。
// 修法是通读后补断裂处，不是为凑阈值全局加“的/了/就”。
function findOvercompressedProseTic(proseLines) {
  let narrativeChars = 0;
  let narrativeParas = 0;
  let shortParas = 0;
  let particles = 0;
  let firstLine = null;
  const samples = [];

  for (const { text, lineNo } of proseLines) {
    const trimmed = text.trim();
    if (!trimmed || isDivider(trimmed) || isStructural(trimmed) || /^【[^】]+】$/.test(trimmed)) continue;
    const narrative = stripQuoted(trimmed).trim();
    const len = visibleLength(narrative);
    if (len === 0) continue;

    if (firstLine === null) firstLine = lineNo;
    narrativeParas += 1;
    narrativeChars += len;
    if (len <= OVERCOMPRESSED_PROSE_SHORT_MAX_CHARS) {
      shortParas += 1;
      if (samples.length < 6) samples.push(narrative);
    }

    OVERCOMPRESSED_PROSE_PARTICLE_PATTERN.lastIndex = 0;
    while (OVERCOMPRESSED_PROSE_PARTICLE_PATTERN.exec(narrative) !== null) particles += 1;
  }

  if (narrativeChars < OVERCOMPRESSED_PROSE_MIN_CHARS || narrativeParas < OVERCOMPRESSED_PROSE_MIN_PARAS) return [];
  const shortRatio = shortParas / narrativeParas;
  if (shortRatio < OVERCOMPRESSED_PROSE_SHORT_RATIO) return [];
  const particlePerKilo = (particles / narrativeChars) * 1000;
  if (particlePerKilo >= OVERCOMPRESSED_PROSE_PARTICLE_PER_KILO) return [];

  return [{
    line: firstLine,
    column: 1,
    type: 'overcompressed-prose-tic',
    severity: 'advisory',
    message: `过度精炼短段：叙述段 ${narrativeParas} 个，其中 ${shortParas} 个≤${OVERCOMPRESSED_PROSE_SHORT_MAX_CHARS}字（${(shortRatio * 100).toFixed(0)}%），自然连接 ${particlePerKilo.toFixed(1)}/千字偏少；先通读判断，确有提纲感再补断裂处和必要结构虚词，有意短镜头可留，别机械注水。`,
    excerpt: compact(samples.join(' | ')),
  }];

}

// Fw-02 碎化率：引号外叙述段（一行=一段）中 ≤15 字短段的占比。只报一条；
// >40% blocking、>25% advisory，样本不足静默。细纲「碎化豁免」降级在主循环处理。
function findProseFragmentRatioTic(proseLines) {
  let narrativeChars = 0;
  let narrativeParas = 0;
  let shortParas = 0;
  let firstLine = null;
  const samples = [];

  for (const { text, lineNo } of proseLines) {
    const trimmed = text.trim();
    if (!trimmed || isDivider(trimmed) || isStructural(trimmed) || /^【[^】]+】$/.test(trimmed)) continue;
    const narrative = stripQuoted(trimmed).trim();
    const len = visibleLength(narrative);
    if (len === 0) continue;

    if (firstLine === null) firstLine = lineNo;
    narrativeParas += 1;
    narrativeChars += len;
    if (len <= PROSE_FRAGMENT_MAX_CHARS) {
      shortParas += 1;
      if (samples.length < 6) samples.push(narrative);
    }
  }

  if (narrativeChars < PROSE_FRAGMENT_MIN_CHARS || narrativeParas < PROSE_FRAGMENT_MIN_PARAS) return [];
  const ratio = shortParas / narrativeParas;
  if (ratio <= PROSE_FRAGMENT_ADVISORY_RATIO) return [];
  const blocking = ratio > PROSE_FRAGMENT_BLOCKING_RATIO;

  return [{
    line: firstLine,
    column: 1,
    type: 'prose-fragment-ratio',
    severity: blocking ? 'blocking' : 'advisory',
    ratio: Number(ratio.toFixed(3)),
    message: `${blocking ? '碎化严重' : '碎化率偏高'}：叙述段 ${narrativeParas} 个，${shortParas} 个≤${PROSE_FRAGMENT_MAX_CHARS}字（${(ratio * 100).toFixed(0)}%，阈值 ${blocking ? '40' : '25'}%）；一句一段过多会磨掉层次——密点合并出 ≥40 字连续段、疏点也须成段 ≥25 字（细纲协议密/疏双轨，Fw-02）。低压/过场章可在细纲声明「碎化豁免」后复检。`,
    excerpt: compact(samples.join(' | ')),
  }];
}

// Fw-05 沉默短语密度：引号外叙述里「没答/没说话/没接话/没吭声/不说话」>3/千字——
// 人物反应总用沉默带过的机械指纹，追影开篇对话零信息增量的伴随特征。只报一条 advisory。
function findSilenceDensityTic(proseLines) {
  let narrativeChars = 0;
  let hits = 0;
  let firstLine = null;
  const samples = [];

  for (const { text, lineNo } of proseLines) {
    const trimmed = text.trim();
    if (!trimmed || isDivider(trimmed) || isStructural(trimmed)) continue;
    const narrative = stripQuoted(trimmed);
    narrativeChars += visibleLength(narrative);
    SILENCE_TIC_PATTERN.lastIndex = 0;
    let match;
    while ((match = SILENCE_TIC_PATTERN.exec(narrative)) !== null) {
      hits += 1;
      if (firstLine === null) firstLine = lineNo;
      if (samples.length < 6) samples.push(match[0]);
    }
  }

  if (narrativeChars < SILENCE_TIC_MIN_CHARS) return [];
  const perKilo = (hits / narrativeChars) * 1000;
  if (perKilo <= SILENCE_TIC_PER_KILO) return [];

  return [{
    line: firstLine,
    column: 1,
    type: 'silence-density-tic',
    severity: 'advisory',
    message: `沉默短语密度偏高：引号外叙述「没答/没说话/没接话/没吭声/不说话」${hits} 处（${perKilo.toFixed(1)}/千字，阈值 3）——人物反应总用沉默带过，对话缺信息增量；用有增量的动作或回话替代沉默套路（Fw-05）。`,
    excerpt: compact(samples.join(' | ')),
  }];
}

// 低连接密度：长文本/中短窗口里，引号外叙述的功能词和白话连接同时偏低，且缺少中长承接句，
// 会呈现“提纲/电报体”分布。修法是恢复必要连接和句群，不是全局补词。
function findLowConnectiveDensityTic(proseLines) {
  let bodyChars = 0;
  let functionHits = 0;
  let plainHits = 0;
  let firstLine = null;
  const sentences = [];
  const samples = [];

  for (const { text, lineNo } of proseLines) {
    const trimmed = text.trim();
    if (!trimmed || isDivider(trimmed) || isStructural(trimmed)) continue;

    // 只看引号外叙述。台词/弹幕/系统播报可以天然短促，混入统计会把体裁特征误当电报体。
    const narrative = stripQuoted(trimmed).trim();
    const narrativeLen = visibleLength(narrative);
    if (narrativeLen === 0) continue;

    if (firstLine === null) firstLine = lineNo;
    bodyChars += narrativeLen;
    functionHits += countTerms(narrative, LOW_CONNECTIVE_FUNCTION_TERMS);
    plainHits += countTerms(narrative, LOW_CONNECTIVE_PLAIN_TERMS);

    for (const sentence of splitSentences(narrative)) {
      const len = visibleLength(sentence);
      if (len === 0) continue;
      sentences.push(len);
      if (len <= 12 && samples.length < 6) samples.push(sentence);
    }
  }

  if (bodyChars < LOW_CONNECTIVE_MIN_CHARS || sentences.length === 0) return [];
  const functionPerKilo = (functionHits / bodyChars) * 1000;
  if (functionPerKilo >= LOW_CONNECTIVE_FUNCTION_PER_KILO) return [];
  const plainPerKilo = (plainHits / bodyChars) * 1000;
  if (plainPerKilo >= LOW_CONNECTIVE_PLAIN_PER_KILO) return [];
  const longSentenceRatio = sentences.filter((len) => len >= LOW_CONNECTIVE_LONG_SENTENCE_CHARS).length / sentences.length;
  if (longSentenceRatio >= LOW_CONNECTIVE_LONG_SENTENCE_RATIO) return [];

  return [{
    line: firstLine,
    column: 1,
    type: 'low-connective-density-tic',
    severity: 'advisory',
    message: `低连接密度：引号外叙述功能词 ${functionPerKilo.toFixed(1)}/千字、白话连接 ${plainPerKilo.toFixed(1)}/千字，且≥${LOW_CONNECTIVE_LONG_SENTENCE_CHARS}字承接句仅 ${(longSentenceRatio * 100).toFixed(0)}%；容易像提纲/电报体。通读后补必要连接和中长句群，别机械注水。`,
    excerpt: compact(samples.join(' | ')),
  }];
}

// 抽象总结复读：统计引号外叙述中的高抽象收束模板。全篇只报一条，提醒回到角色
// 当下可见的文件、动作、对话或物理后果；不要用命运大词替读者总结。
function findAbstractSummaryTic(proseLines) {
  let hits = 0;
  let narrativeChars = 0;
  let firstLine = null;
  const samples = [];

  for (const { text, lineNo } of proseLines) {
    const trimmed = text.trim();
    if (!trimmed || isDivider(trimmed) || isStructural(trimmed)) continue;
    const narrative = stripQuoted(trimmed);
    narrativeChars += visibleLength(narrative);

    for (const pattern of ABSTRACT_SUMMARY_PATTERNS) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(narrative)) !== null) {
        hits += 1;
        if (firstLine === null) firstLine = lineNo;
        const sample = compact(match[0]);
        if (samples.length < 6 && !samples.includes(sample)) samples.push(sample);
      }
    }
  }

  if (narrativeChars === 0 || hits < ABSTRACT_SUMMARY_MIN_HITS) return [];
  const perKilo = (hits / narrativeChars) * 1000;
  if (perKilo < ABSTRACT_SUMMARY_PER_KILO) return [];

  return [{
    line: firstLine,
    column: 1,
    type: 'abstract-summary-tic',
    severity: 'advisory',
    message: `抽象总结复读：命运/棋局/这一刻终于明白/才刚刚开始等作者总结 ${hits} 处（${perKilo.toFixed(1)}/千字）；回到角色当下可见的文件、动作、对话或物理后果，别替读者盖章。`,
    excerpt: compact(samples.join(' | ')),
  }];
}

function findPeriodStutter(proseLines) {
  const findings = [];
  let runLen = 0;
  let runStartLine = null;
  let runSample = [];

  const flush = () => {
    if (runLen >= STUTTER_MIN_RUN) {
      findings.push({
        line: runStartLine,
        column: 1,
        type: 'period-stutter',
        severity: 'advisory',
        message: `碎句号：连续 ${runLen} 个短句无呼吸；按目标句长把碎句合并成中长句、补回画面与连接（见本 skill 句长/疏密节奏规则）。`,
        excerpt: compact(runSample.join(' ')),
      });
    }
    runLen = 0;
    runStartLine = null;
    runSample = [];
  };

  for (const { text, lineNo } of proseLines) {
    const trimmed = text.trim();
    if (!trimmed) continue; // 空行是一句一段排版，不打断叙述连贯
    if (isDivider(trimmed) || isStructural(trimmed)) {
      flush(); // 分隔线/markdown 结构行：重置碎句计数
      continue;
    }
    const narrative = stripQuoted(trimmed);
    if (visibleLength(narrative) === 0) {
      flush(); // 纯对话/弹幕/系统播报：成片短句是正常形态，重置碎句计数
      continue;
    }
    // 只数引号外叙述句：混合行（叙述+引号内物件/短台词）的引号外片段仍参与碎句计数。
    for (const sentence of splitSentences(narrative)) {
      if (visibleLength(sentence) <= STUTTER_MAX_SENTENCE) {
        if (runLen === 0) runStartLine = lineNo;
        runLen += 1;
        if (runSample.length < 6) runSample.push(sentence);
      } else {
        flush();
      }
    }
  }
  flush();
  return findings;
}

function isDivider(trimmed) {
  return /^-{3,}$/.test(trimmed) || /^[*_]{3,}$/.test(trimmed);
}

// markdown 结构行（标题/列表/引用/表格）不是叙述正文，长段落/碎句号/破折号检测都跳过。
function isStructural(trimmed) {
  return /^(#{1,6}\s|>\s?|[-*+]\s|\d+[.)]\s|\|)/.test(trimmed)
    || /^第[零一二三四五六七八九十百千万\d]+章(?:\s|_|$)/.test(trimmed);
}

// 去掉成对引号内的片段（台词/系统播报），只留引号外叙述。碎句号判定用：纯对话/弹幕成片短句
// 是体裁正常形态（豁免），但「叙述 + 引号内物件/短台词」混合行的引号外叙述仍要参与短句计数。
function stripQuoted(text) {
  let out = text;
  for (const src of QUOTE_SOURCES) out = out.replace(new RegExp(src, 'g'), '');
  return out;
}

// 把成对引号片段（含引号）替换为等长问号占位：既豁免引号内台词/播报，又保住原文
// 偏移量，供逐处 blocking 规则定位与截取原文摘录（stripQuoted 会移位，不适合定位）。
// 占位字符用「？」而不是「。」：占位既要截断各规则的 [^。！？!?…] 否定类（？与句号在每条
// 规则的否定类里等效），又不能落在任何规则的接受位。句号占位会替 trailer-summary 的句末
// [。！] 伪造出终止符，让「这一战注定是「血屠」的开端，…」这类引号里放代号/绰号的叙述行
// 被误报，且报出的『这一战注定是。』在原文里 grep 不到。占位长度不变，故偏移与摘录窗口不漂移。
function maskQuoted(text) {
  let out = text;
  for (const src of QUOTE_SOURCES) {
    out = out.replace(new RegExp(src, 'g'), (m) => '？'.repeat(m.length));
  }
  return out;
}

// 返回引号内片段（含引号本身）的 [start, end) 区间，供 not-is 对比句豁免台词用。
function quotedRanges(text) {
  const ranges = [];
  for (const src of QUOTE_SOURCES) {
    const re = new RegExp(src, 'g');
    let match;
    while ((match = re.exec(text)) !== null) ranges.push([match.index, match.index + match[0].length]);
  }
  return ranges;
}

function insideRanges(pos, ranges) {
  return ranges.some(([start, end]) => pos >= start && pos < end);
}

function splitSentences(trimmed) {
  return trimmed
    .split(/[。！？!?]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function sentenceAround(text, index) {
  let start = index;
  while (start > 0 && !STOP_CHARS.has(text[start - 1])) start -= 1;
  let end = index;
  while (end < text.length && !STOP_CHARS.has(text[end])) end += 1;
  return compact(text.slice(start, end).trim());
}

function visibleLength(sentence) {
  const matched = sentence.match(/[一-鿿Ａ-ｚA-Za-z0-9]/g);
  return matched ? matched.length : 0;
}

function countTerms(text, terms) {
  let count = 0;
  for (const term of terms) {
    let index = text.indexOf(term);
    while (index !== -1) {
      count += 1;
      index = text.indexOf(term, index + term.length);
    }
  }
  return count;
}

function parseFenceMarker(trimmedLine) {
  const match = /^(?:`{3,}|~{3,})/.exec(trimmedLine);
  if (!match) return null;
  return { char: match[0][0], length: match[0].length };
}

function hasYamlFrontMatter(lines) {
  if (!lines[0] || lines[0].trim() !== '---') return false;
  let sawYamlField = false;
  for (let i = 1; i < Math.min(lines.length, 40); i += 1) {
    const trimmed = lines[i].trim();
    if (trimmed === '---') return sawYamlField;
    if (/^[A-Za-z0-9_-]+:\s*/.test(trimmed)) sawYamlField = true;
  }
  return false;
}

function scanBlock(block) {
  const text = block.map((entry) => entry.text).join('\n');
  const lineStarts = [];
  let cursor = 0;

  for (const entry of block) {
    lineStarts.push({ offset: cursor, lineNo: entry.lineNo });
    cursor += entry.text.length + 1;
  }

  return findNotIsComparisons(text, (offset) => positionForOffset(lineStarts, offset));
}

function positionForOffset(lineStarts, offset) {
  let low = 0;
  let high = lineStarts.length - 1;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const current = lineStarts[mid];
    const next = lineStarts[mid + 1];

    if (offset < current.offset) {
      high = mid - 1;
    } else if (next && offset >= next.offset) {
      low = mid + 1;
    } else {
      return {
        line: current.lineNo,
        column: offset - current.offset + 1,
      };
    }
  }

  return { line: lineStarts[0].lineNo, column: 1 };
}

function findNotIsComparisons(text, getPosition) {
  const findings = [];
  const quoted = quotedRanges(text);
  let offset = 0;

  while (offset < text.length) {
    const start = text.indexOf('不是', offset);
    if (start === -1) break;

    // 引号内是台词/系统播报：口语里「不是A，是B」是自然辩解/反问，不算叙述层 AI 对比句式
    // （与碎句号一致豁免引号内容）。
    if (insideRanges(start, quoted)) {
      offset = start + 2;
      continue;
    }

    // Avoid the common yes/no question fragment “是不是”.
    if (start > 0 && text[start - 1] === '是') {
      offset = start + 2;
      continue;
    }

    const candidate = text.slice(start);
    const markerEnd = findPositiveFlipEnd(candidate);

    if (markerEnd === -1) {
      offset = start + 2;
      continue;
    }

    const raw = trimTrailingNoise(extractFinding(candidate, markerEnd));
    if (raw.length >= 4) {
      const position = getPosition(start);
      findings.push({
        line: position.line,
        column: position.column,
        type: 'not-is-comparison',
        severity: 'blocking',
        message: '高频 AI 对比句式；删掉否定铺垫，直接写后项，或改成动作/细节呈现。',
        excerpt: compact(raw),
      });
    }

    offset = start + Math.max(raw.length, 2);
  }

  return findings;
}

function findPositiveFlipEnd(candidate) {
  let index = 2; // after “不是”
  let scanned = 0;
  let crossedSeparator = false;

  while (index < candidate.length && scanned <= MAX_NEGATIVE_SPAN) {
    const char = candidate[index];

    if (startsWithAt(candidate, index, '而是')) return index + 2;

    if (SOFT_SEPARATORS.has(char)) {
      const next = skipGap(candidate, index + 1);
      if (startsWithAt(candidate, next, '而是')) return next + 2;
      if (candidate[next] === '是' && !TAG_PARTICLES.has(candidate[next + 1]) && !isAffirmationTagAt(candidate, next)) return next + 1;
      crossedSeparator = true;
    }

    if (HARD_SEPARATORS.has(char)) {
      const next = skipGap(candidate, index + 1);
      if (candidate[next] === '是' && !TAG_PARTICLES.has(candidate[next + 1]) && !isAffirmationTagAt(candidate, next)) return next + 1;
      if (char !== '.') break;
      crossedSeparator = true;
    }

    if (STOP_CHARS.has(char)) break;

    // Catch compact forms such as “不是A是B”, but only within the first clause —
    // before any separator. After a separator the trailing “是” of a conjunction
    // (只是/可是/但是/还是/于是/倒是/总是…) is part of that word, not a positive
    // copula (issue #166 false-positive class). Post-separator flips are still
    // caught when separator-adjacent (“，是”/“，而是”) by the separator branches
    // above; subject-present flips like “，他是”/“，那是” are intentionally NOT
    // caught here — there is no separator-local way to tell them from a
    // conjunction without a word list, and on a hard rescan-to-0 gate a false
    // positive (forcing a rewrite of good prose) costs more than missing this
    // rarer form. The “是” in the either-or idiom “不是A就是B / 也是B” is part of
    // the 就是/也是 conjunction, not a copula, so 就/也 are excluded too. Also never
    // treat the “是” inside a second negative fragment (“不是A，也不是B”) as the flip.
    if (char === '是' && !COMPACT_EITHER_OR_PREV.has(candidate[index - 1]) && !crossedSeparator) {
      return index + 1;
    }

    index += 1;
    scanned += 1;
  }

  return -1;
}

function extractFinding(candidate, markerEnd) {
  let end = markerEnd;
  const limit = Math.min(candidate.length, markerEnd + MAX_POSITIVE_SPAN);

  while (end < limit) {
    if (STOP_CHARS.has(candidate[end])) break;
    end += 1;
  }

  return candidate.slice(0, end);
}

function startsWithAt(text, index, needle) {
  return text.slice(index, index + needle.length) === needle;
}

function isAffirmationTagAt(text, index) {
  if (text[index] !== '是') return false;
  const particle = text[index + 1];
  if (!AFFIRMATION_TAG_PARTICLES.has(particle)) return false;
  const boundary = text[index + 2] || '';
  return AFFIRMATION_TAG_BOUNDARY.has(boundary);
}

// 跳过行内空白与换行（含空行/段落间距），停在下一个实义字符。原实现只吞一个换行，
// 会漏掉跨空行的「不是A。（空行）是B」这类分段揭示句。
function skipGap(text, index) {
  while (index < text.length && (isInlineSpace(text[index]) || text[index] === '\n')) index += 1;
  return index;
}

function isInlineSpace(char) {
  return char === ' ' || char === '\t' || char === '\r';
}

function trimTrailingNoise(text) {
  return text.replace(/[\s|）)】\]]+$/u, '');
}

function compact(text) {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length > 80 ? `${normalized.slice(0, 77)}...` : normalized;
}

// ---------- I2 短语黑名单（docs/06-卷三开局复盘整改计划.md §三）----------

// 项目可配置 tic 词表：追踪/短语黑名单.md（模板初始空表，词表归项目填——决策 §八-3：
// 每本书的 tic 不同，框架只给机制不预置词表；报告 A4 词表仅作模板注释示例）。
// 超限一律 advisory（误报风险高，宁报不拦）；「稳住别慌」类作者性字面归 H2 blocking
// 管（guyin-check-authority-leak.js），两级不混（docs/06 §1.5）。无黑名单文件静默
//（短篇同理：文件存在即生效，模板不预置）。兼任 W3 工艺词登记位：本书题材工艺词
//（「社会脸」类）漏进正文在此报。

// 从受检文件向上（≤4 层）定位 追踪/短语黑名单.md。
function locatePhraseBlacklist(file) {
  let cur = path.dirname(path.resolve(file));
  for (let depth = 0; depth < 4; depth += 1) {
    const candidate = path.join(cur, '追踪', '短语黑名单.md');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return null;
}


// 解析表格 | 短语 | 限额 |：跳过表头、占位行（{{...}}）与 HTML 注释块（模板示例区）。
// 限额三档可同格并存：每章 ≤N / 近 5 章 ≤N / 相邻章禁用；无法识别的写法跳过该行。
function loadPhraseBlacklist(file) {
  const blacklistPath = locatePhraseBlacklist(file);
  if (!blacklistPath) return null;
  if (phraseBlacklistCache.has(blacklistPath)) return phraseBlacklistCache.get(blacklistPath);
  const entries = [];
  let inComment = false;
  let text = '';
  try {
    text = fs.readFileSync(blacklistPath, 'utf8');
  } catch (error) {
    return null;
  }
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
    if (cells.length < 3) continue;
    const phrase = cells[1];
    const quota = cells[2] || '';
    if (!phrase || phrase === '短语' || phrase.includes('{{')) continue;
    const entry = { phrase };
    let matched = false;
    let m = /每章\s*[≤<=]\s*(\d+)/.exec(quota);
    if (m) { entry.perChapter = Number(m[1]); matched = true; }
    m = /近\s*5\s*章\s*[≤<=]\s*(\d+)/.exec(quota);
    if (m) { entry.window = Number(m[1]); matched = true; }
    if (/相邻章\s*禁用/.test(quota)) { entry.adjacent = true; matched = true; }
    if (!matched) continue;
    entries.push(entry);
  }
  const result = { path: blacklistPath, entries };
  phraseBlacklistCache.set(blacklistPath, result);
  return result;
}

// 文件名章号（第061章.md / 第61章-标题.md / ch61.md）；无法解析返回 null。
function parseChapterNumber(basename) {
  let m = /第\s*0*(\d+)\s*章/.exec(basename);
  if (m) return Number(m[1]);
  m = /ch(?:apter)?[._\-\s]?0*(\d+)/i.exec(basename);
  if (m) return Number(m[1]);
  return null;
}


// 同目录章文件映射（章号 → 文件名，首个命中优先）。窗口/相邻档的供给源。
function listSiblingChapters(file) {
  const dir = path.dirname(path.resolve(file));
  if (siblingChaptersCache.has(dir)) return siblingChaptersCache.get(dir);
  const map = new Map();
  try {
    for (const name of fs.readdirSync(dir)) {
      const num = parseChapterNumber(name);
      if (num != null && !map.has(num)) map.set(num, name);
    }
  } catch (error) { /* 目录不可读则无窗口/相邻供给 */ }
  siblingChaptersCache.set(dir, map);
  return map;
}

// 非重叠字面计数，附首次命中行列（报告定位用）。
function countPhrase(text, phrase) {
  let count = 0;
  let firstLine = null;
  let firstColumn = null;
  let idx = text.indexOf(phrase);
  while (idx !== -1) {
    count += 1;
    if (firstLine === null) {
      const before = text.slice(0, idx);
      firstLine = (before.match(/\n/g) || []).length + 1;
      const lastNewline = before.lastIndexOf('\n');
      firstColumn = idx - lastNewline;
    }
    idx = text.indexOf(phrase, idx + phrase.length);
  }
  return { count, firstLine, firstColumn };
}

// phrase-quota 主检测：每章档按受检文件计数；近 5 章档 = 受检文件 + 同目录前 4 章合并；
// 相邻档 = 本章 ≥1 且前一章 ≥1（B7「相邻章不共用同一身体锚点」的机制化）。
// 本章零命中时三档均不触发（advisory 指导本章改写，前章窗口已在其落盘章检时覆盖）。
function findPhraseQuota(fullPath, input) {
  const blacklist = loadPhraseBlacklist(fullPath);
  if (!blacklist || blacklist.entries.length === 0) return [];
  const findings = [];
  const chapterNum = parseChapterNumber(path.basename(fullPath));
  const siblings = chapterNum == null ? new Map() : listSiblingChapters(fullPath);
  const dir = path.dirname(path.resolve(fullPath));

  const readSibling = (num) => {
    const name = siblings.get(num);
    if (!name) return null;
    try {
      return fs.readFileSync(path.join(dir, name), 'utf8');
    } catch (error) {
      return null;
    }
  };

  const prevText = chapterNum == null ? null : readSibling(chapterNum - 1);
  const windowTexts = [];
  if (chapterNum != null) {
    for (let back = 1; back <= 4; back += 1) {
      const sibling = readSibling(chapterNum - back);
      if (sibling != null) windowTexts.push(sibling);
    }
  }

  for (const entry of blacklist.entries) {
    const here = countPhrase(input, entry.phrase);
    if (here.count === 0) continue;
    const push = (message) => {
      findings.push({
        line: here.firstLine,
        column: here.firstColumn,
        type: 'phrase-quota',
        severity: 'advisory',
        message,
        excerpt: entry.phrase,
      });
    };
    if (entry.perChapter != null && here.count > entry.perChapter) {
      push(`短语「${entry.phrase}」本章 ${here.count} 次，超每章限额 ${entry.perChapter}（追踪/短语黑名单.md 登记；改写复用点或删并）`);
    }
    if (entry.window != null) {
      const windowCount = windowTexts.reduce((acc, t) => acc + countPhrase(t, entry.phrase).count, 0) + here.count;
      if (windowCount > entry.window) {
        push(`短语「${entry.phrase}」近 5 章 ${windowCount} 次（含本章 ${here.count} 次），超窗口限额 ${entry.window}（追踪/短语黑名单.md 登记）`);
      }
    }
    if (entry.adjacent && prevText != null) {
      const prevCount = countPhrase(prevText, entry.phrase).count;
      if (prevCount >= 1) {
        push(`短语「${entry.phrase}」与前一章连用（前章 ${prevCount} 次、本章 ${here.count} 次）——相邻章禁用档（B7 相邻章不共用同一身体锚点的事故形态）`);
      }
    }
  }
  return findings;
}

// ---------- Z7 跨章体感重复（docs/10-认知落差与感知层建设计划.md §一 Z7）----------

// 防空心检查（18 个防缺陷脚本之后第一个）：检测的不是写得错，是写得不像同一个人。
// 同一情绪落点的谓语动作跨章重复 → advisory（「咽口水」×2、「手心出汗」×2）。
// 白名单：追踪/复沓锚句.md 登记的世界内实体（算盘/空位/残珠类签名资产显式受保护）。
// 实证倒逼（§〇.5 ch36/61）：指腹搭算盘边 / 指尖拨空位 = 签名物件复沓仪式，非体感复读。
// 判据区分：报警对象 = 谓语动作重复（咽口水/手心出汗 ×2）；白名单 = 复沓锚句登记的世界内实体。

// 从受检文件向上（≤4 层）定位 追踪/复沓锚句.md（与 locatePhraseBlacklist 同构）。
function locateAnchorRegistry(file) {
  let cur = path.dirname(path.resolve(file));
  for (let depth = 0; depth < 4; depth += 1) {
    const candidate = path.join(cur, '追踪', '复沓锚句.md');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return null;
}

// 解析表格 | 实体 |：跳过表头、占位行（{{...}}）与 HTML 注释块（模板示例区）。
function loadAnchorRegistry(file) {
  const registryPath = locateAnchorRegistry(file);
  if (!registryPath) return null;
  if (anchorRegistryCache.has(registryPath)) return anchorRegistryCache.get(registryPath);
  const entities = [];
  let inComment = false;
  let text = '';
  try {
    text = fs.readFileSync(registryPath, 'utf8');
  } catch (error) {
    return null;
  }
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
    const entity = cells[1];
    if (!entity || entity === '实体' || entity.includes('{{')) continue;
    entities.push(entity);
  }
  const result = { path: registryPath, entities };
  anchorRegistryCache.set(registryPath, result);
  return result;
}

// 目录级全量兄弟章文本缓存（扫全卷用，避免 O(N²) 重读——首章受检时全读并缓存，
// 后续兄弟章复用同一目录缓存）。
function loadSiblingTexts(fullPath, chapterNum) {
  const dir = path.resolve(path.dirname(fullPath));
  if (siblingTextCache.has(dir)) return siblingTextCache.get(dir);
  const siblings = listSiblingChapters(fullPath);
  const texts = new Map();
  for (const [num, name] of siblings) {
    if (num === chapterNum) continue;
    try {
      texts.set(num, fs.readFileSync(path.join(dir, name), 'utf8'));
    } catch (error) { /* 兄弟章不可读则跳过 */ }
  }
  siblingTextCache.set(dir, texts);
  return texts;
}

// 提取匹配所在句子（前后推到句末标点），用于白名单实体命中判断。
function sentenceAroundOffset(text, offset) {
  let start = 0;
  for (let i = offset - 1; i >= 0; i -= 1) {
    if (/[。！？!?\n]/.test(text[i])) { start = i + 1; break; }
  }
  let end = text.length;
  for (let i = offset; i < text.length; i += 1) {
    if (/[。！？!?\n]/.test(text[i])) { end = i; break; }
  }
  return text.slice(start, end);
}

// Z7 主检测：每个身体动作 tic 模式本章命中且任一兄弟章亦命中 → advisory。
// 白名单：命中句含 追踪/复沓锚句.md 登记的实体 → 跳过（签名资产保护）。
// 无登记文件静默（无白名单，仅 tic 跨章重复检测仍跑）。
// 单模式本章只报首个跨章命中（单章密度归 cliche-density 管，不在此复读）。
function findSensoryRepeatTic(fullPath, input) {
  const findings = [];
  const chapterNum = parseChapterNumber(path.basename(fullPath));
  if (chapterNum == null) return findings; // 无法解析章号 → 无兄弟章可比，跳过
  const siblingTexts = loadSiblingTexts(fullPath, chapterNum);
  if (siblingTexts.size === 0) return findings; // 无兄弟章（开篇章）→ 跳过
  const registry = loadAnchorRegistry(fullPath);
  const whitelist = registry ? registry.entities : [];
  const siblingValues = Array.from(siblingTexts.values());

  for (const pattern of SENSORY_REPEAT_PATTERNS) {
    const localRe = new RegExp(pattern.source, 'g');
    let m;
    while ((m = localRe.exec(input)) !== null) {
      const hitPhrase = m[0];
      const hitOffset = m.index;
      // 白名单：命中句含登记实体 → 跳过（签名资产复沓仪式，非体感复读）
      if (whitelist.length > 0) {
        const sentence = sentenceAroundOffset(input, hitOffset);
        if (whitelist.some((e) => sentence.includes(e))) continue;
      }
      // 跨章撞：任一兄弟章亦命中该模式
      const crossChapter = siblingValues.some((t) => {
        const r = new RegExp(pattern.source, 'g');
        return r.test(t);
      });
      if (!crossChapter) continue;
      const before = input.slice(0, hitOffset);
      const firstLine = (before.match(/\n/g) || []).length + 1;
      const lastNewline = before.lastIndexOf('\n');
      const firstColumn = hitOffset - lastNewline;
      findings.push({
        line: firstLine,
        column: firstColumn,
        type: 'sensory-repeat',
        severity: 'advisory',
        message: `身体动作 tic「${hitPhrase}」跨章重复（扫全卷 ≥2 章命中）——同一情绪落点的谓语动作复读是空心不是错。改写为差异化体感，或确认有意复沓则登记于 追踪/复沓锚句.md`,
        excerpt: hitPhrase,
      });
      break; // 同一模式本章只报首个跨章命中（单章密度归 cliche-density 管）
    }
  }
  return findings;
}

// ---------- SP3 口吃标点（docs/11 §一 SP3）----------

// 确定性错字检测：同一汉字 + 冒号（全角/半角）+ 同字——「这：这」应为「这……这」。
// 正常中文「X：X」近零出现（冒号后接同字的口吃是唯一高频形态）。扫描全文（对白内外
// 都扫——B2' 实证在对白内：「客官，这：这是正经路数来的」）。出现即报，非密度型
// （确定性错字不做阈值）。
// STUTTER_RE 已置于主循环前（与 SENSORY_REPEAT_PATTERNS 同区，避免 TDZ）。

function findStutterPunct(fullPath, input) { // eslint-disable-line no-unused-vars
  const findings = [];
  let m;
  STUTTER_RE.lastIndex = 0;
  while ((m = STUTTER_RE.exec(input)) !== null) {
    const hitPhrase = m[0];
    const hitOffset = m.index;
    const before = input.slice(0, hitOffset);
    const firstLine = (before.match(/\n/g) || []).length + 1;
    const lastNewline = before.lastIndexOf('\n');
    const firstColumn = hitOffset - lastNewline;
    findings.push({
      line: firstLine,
      column: firstColumn,
      type: 'stutter-punct',
      severity: 'advisory',
      message: `「${hitPhrase}」同字夹冒号——口吃/重复应作「${m[1]}……${m[1]}」；确定性错字，改写卡直接修。`,
      excerpt: hitPhrase,
    });
  }
  return findings;
}

// ---------- PV2 视角纪律（docs/11 §二 PV2）----------

// 第三有限视角越界检测：B1' 实证形态是「代词回指的对手内心」（「他忽然拿不准眼前这位」
// ——「他」指书办非 POV 燕衡）。两档判据：显式人名形态（机械稳）＋一跳代词回指
// （启发式，advisory 容错）＋「他/她哪是/哪要的是」自由间接引语弱信号（B1' L37 形态）。
// 心理动词词表与 beat.js PSYCH_VERBS 同源＋B1' 实证补收「拿不准/备好/打定主意」。
// beat.js 词表的「知道/明白/清楚/疑惑」太泛不搬——叙述层正常使用率高，PV2 词表收窄到
// 「内心活动标记」高置信形态。
// POV_PSYCH_RE / POV_FREE_INDIRECT_RE 已置于主循环前（与 SENSORY_REPEAT_PATTERNS 同区，避免 TDZ）。

// 从受检文件向上（≤4 层）定位 大纲/批次公约.md（与 locateAnchorRegistry 同构，路径不同）。
function locateBatchPact(file) {
  let cur = path.dirname(path.resolve(file));
  for (let depth = 0; depth < 4; depth += 1) {
    const candidate = path.join(cur, '大纲', '批次公约.md');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return null;
}

// 从受检文件向上（≤4 层）定位 追踪/_tracking-state.json（同上）。
function locateTrackingState(file) {
  let cur = path.dirname(path.resolve(file));
  for (let depth = 0; depth < 4; depth += 1) {
    const candidate = path.join(cur, '追踪', '_tracking-state.json');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return null;
}

// Fw-02：从受检正文文件名（第N章…）向上（≤4 层）定位 大纲/细纲_第NNN章.md。
// 章号三种写法都试（三位补零为模板规范，原始号/去零兼容存量）。找不到返回 null（fail-open）。
function locateChapterOutline(file) {
  const base = path.basename(file);
  const m = /第0*(\d+)章/.exec(base);
  if (!m) return null;
  const padded = m[1].padStart(3, '0');
  const names = [`细纲_第${padded}章.md`, `细纲_第${m[1]}章.md`];
  let cur = path.dirname(path.resolve(file));
  for (let depth = 0; depth < 4; depth += 1) {
    for (const name of names) {
      const candidate = path.join(cur, '大纲', name);
      if (fs.existsSync(candidate)) return candidate;
    }
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return null;
}

// Fw-02：细纲声明「碎化豁免」→ prose-fragment-ratio 的 blocking 降 advisory。
// 细纲缺失/不可读 → false（按正常阈值判；豁免是显式声明，不搞隐式放行）。
function hasFragmentExemption(file) {
  const outlinePath = locateChapterOutline(file);
  if (!outlinePath) return false;
  try {
    return fs.readFileSync(outlinePath, 'utf8').includes('碎化豁免');
  } catch (error) {
    return false;
  }
}

// 读批次公约的 POV 规格：视角规格行 → POV={人名}。无该行／值「全知」／「多视角」
// → 静默（多视角书不受此检，同 consistency 对 _tracking-state 的 fail-open 约定）。
function loadPovFromPact(file) {
  const pactPath = locateBatchPact(file);
  if (!pactPath) return null;
  if (povPactCache.has(pactPath)) return povPactCache.get(pactPath);
  let text = '';
  try {
    text = fs.readFileSync(pactPath, 'utf8');
  } catch (error) {
    povPactCache.set(pactPath, null);
    return null;
  }
  const m = /视角规格[：:]\s*POV=([^\s（(，；;]+)/.exec(text);
  const result = (m && m[1] && m[1] !== '全知' && m[1] !== '多视角') ? m[1] : null;
  povPactCache.set(pactPath, result);
  return result;
}

// 读 _tracking-state.json 的 characters 全员名表（含 alias 别名）。fail-open：无
// 该文件／characters 键缺失 → 返回空数组（PV2 静默——人名表是显式人名判据的供给源）。
function loadCharacterNamesForPov(file) {
  const statePath = locateTrackingState(file);
  if (!statePath) return [];
  if (povStateCache.has(statePath)) return povStateCache.get(statePath);
  let names = [];
  try {
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    if (state && typeof state === 'object' && state.characters) {
      for (const [key, val] of Object.entries(state.characters)) {
        names.push(key);
        if (val && typeof val === 'object' && Array.isArray(val.aliases)) {
          names.push(...val.aliases);
        } else if (val && typeof val === 'object' && Array.isArray(val.alias)) {
          names.push(...val.alias);
        }
      }
    }
  } catch (error) { /* JSON 解析失败 → 空表，fail-open */ }
  // 按长度降序排（避免「燕」误匹配「燕衡」前缀），保留稳定性
  names = [...new Set(names)].filter((n) => n && n.length >= 2).sort((a, b) => b.length - a.length);
  povStateCache.set(statePath, names);
  return names;
}

// 句子切分（按 。！？\n 切，保留每句在原文的 offset）。切分用与 maskQuoted 不同的
// 原文切分路径：PV2 扫的是 stripQuoted 后的叙述层，但每句 offset 须映射回原文
// 用于 line/column 报告。stripQuoted 长度会缩短，故先在原文按句切分得到 offset，
// 再对每句单独 stripQuoted 扫描——句内对白剥除后心理动词只数叙述层。
function splitSentencesWithOffset(text) {
  const out = [];
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '。' || ch === '！' || ch === '？' || ch === '!' || ch === '?' || ch === '\n') {
      out.push({ text: text.slice(start, i + 1), offset: start });
      start = i + 1;
    }
  }
  if (start < text.length) out.push({ text: text.slice(start), offset: start });
  return out;
}

function findPovDrift(fullPath, input) {
  const findings = [];
  const pov = loadPovFromPact(fullPath);
  if (!pov) return findings; // 三静默态：无 POV 行／值「全知」／「多视角」
  const names = loadCharacterNamesForPov(fullPath);
  if (names.length === 0) return findings; // 人名表缺失 → 显式人名判据无供给源，fail-open
  // 兄弟章在 ai-patterns 里已有加载机制，但 PV2 只扫本章叙述层（无跨章比对需求）。
  const sentences = splitSentencesWithOffset(input);
  let prevSubject = null; // 上一叙述句的显式主语人名（一跳回指锚）
  const drifts = []; // { line, column, head10 }
  for (const { text: sentence, offset } of sentences) {
    const stripped = stripQuoted(sentence); // 剥对白，只扫叙述层（依赖 SP2 直引号迁移已天然生效）
    if (!stripped.trim()) continue;
    // 句内显式人名（取最后一个为 prevSubject 锚——中文常省略主语，最近显式主语承担回指）
    const sentenceNames = names.filter((n) => sentence.includes(n));
    if (sentenceNames.length > 0) prevSubject = sentenceNames[sentenceNames.length - 1];
    // 心理动词命中（带 g 标志需重置 lastIndex）
    let m;
    POV_PSYCH_RE.lastIndex = 0;
    while ((m = POV_PSYCH_RE.exec(stripped)) !== null) {
      const hitOffset = m.index;
      // 判主语：句内含非 POV 显式人名 → 该人名；否则句首「他/她」+ prevSubject 非 null 且 ≠ POV → 一跳回指
      const nonPovNames = sentenceNames.filter((n) => n !== pov);
      let subject;
      if (nonPovNames.length > 0) {
        subject = nonPovNames[nonPovNames.length - 1];
      } else if (stripped.length > 0 && /[他她]/.test(stripped[0]) && prevSubject !== null && prevSubject !== pov) {
        subject = prevSubject; // 一跳回指：句首「他/她」指上一叙述句的显式主语
      } else {
        continue; // POV 人物合法心理活动 / 无法判定主语 → 宁漏不拦错
      }
      if (subject !== pov) {
        const before = input.slice(0, offset + hitOffset);
        const firstLine = (before.match(/\n/g) || []).length + 1;
        const lastNewline = before.lastIndexOf('\n');
        const firstColumn = hitOffset + (offset - lastNewline);
        drifts.push({
          line: firstLine,
          column: firstColumn,
          head10: stripped.slice(0, 10).replace(/\s/g, ''),
          subject,
        });
        break; // 一句一报（防一句多动词重复报）
      }
    }
    // 弱信号：自由间接引语「他/她...哪是/哪要的是」（B1' L37 形态）
    const fiMatch = POV_FREE_INDIRECT_RE.exec(stripped);
    if (fiMatch) {
      const fiOffset = fiMatch.index;
      const nonPovNames = sentenceNames.filter((n) => n !== pov);
      let fiSubject = null;
      if (nonPovNames.length > 0) fiSubject = nonPovNames[nonPovNames.length - 1];
      else if (prevSubject !== null && prevSubject !== pov) fiSubject = prevSubject;
      if (fiSubject !== null && fiSubject !== pov) {
        const before = input.slice(0, offset + fiOffset);
        const firstLine = (before.match(/\n/g) || []).length + 1;
        const lastNewline = before.lastIndexOf('\n');
        const firstColumn = fiOffset + (offset - lastNewline);
        drifts.push({
          line: firstLine,
          column: firstColumn,
          head10: stripped.slice(0, 10).replace(/\s/g, ''),
          subject: fiSubject,
          isFreeIndirect: true,
        });
      }
    }
  }
  // 阈值：driftCount >= 2 → advisory（1 处静默——v7 判「书办心理是喜剧拍部分成立」，给合理技巧留空间）
  if (drifts.length < 2) return findings;
  const detail = drifts.slice(0, 4).map((d) => `[${d.subject}${d.isFreeIndirect ? '·FI' : ''} 行${d.line} 「${d.head10}」]`).join(' ');
  findings.push({
    line: drifts[0].line,
    column: drifts[0].column,
    type: 'pov-drift',
    severity: 'advisory',
    message: `对手/配角内心直写 ${drifts.length} 处（POV=${pov}）：${detail}——第三有限视角越界。处置：喜剧拍/合谋拍有意为之→豁免台账（五测试）；否则改外部可见动作（表情/小动作/语气）。机械判据覆盖显式人名与一跳回指形态；自由间接引语的深层形态归走查/review。`,
    excerpt: drifts[0].head10,
  });
  return findings;
}

// Fw-05 对话零信息启发式（仅 ch001-003，advisory）：追影开篇形态——主角全程不主动发问
// （只被问/只应答）且全体对白短促无信息增量。两个弱信号同时命中才报，启发式非精确，
// 误报走豁免；无批次公约/POV（含全角＝/无「视角规格」前缀，兼容写法宽于 PV2）→ fail-open。
function loadProtagonistName(file) {
  const pactPath = locateBatchPact(file);
  if (!pactPath) return null;
  let text = '';
  try {
    text = fs.readFileSync(pactPath, 'utf8');
  } catch (error) {
    return null;
  }
  const m = /POV\s*[=＝:：]\s*([^\s（(，；;。、]+)/.exec(text);
  if (!m) return null;
  const name = m[1].trim();
  if (!name || name === '全知' || name === '多视角') return null;
  return name;
}

// 收集全文所有成对引号片段（多引号源区间去重叠），保序。
function allQuotedSegments(text) {
  const ranges = [];
  for (const src of QUOTE_SOURCES) {
    const re = new RegExp(src, 'g');
    let m;
    while ((m = re.exec(text)) !== null) ranges.push([m.index, m.index + m[0].length]);
  }
  ranges.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const segments = [];
  let lastEnd = -1;
  for (const [s, e] of ranges) {
    if (s >= lastEnd) {
      segments.push(text.slice(s, e));
      lastEnd = e;
    }
  }
  return segments;
}

function findDialogueZeroInformation(fullPath, input) {
  // 仅黄金三章正文生效。
  const chapterMatch = /第0*(\d+)章/.exec(path.basename(fullPath));
  if (!chapterMatch) return [];
  const chapter = Number(chapterMatch[1]);
  if (chapter < 1 || chapter > 3) return [];

  const hero = loadProtagonistName(fullPath);
  if (!hero) return []; // 无批次公约/POV 不可解析 → fail-open

  const lines = input.split(/\r?\n/);

  // 信号 A：主角「邻近」发问计数——问号对白所在行或上下相邻行出现主角名即记一次。
  // 只认问号在引号内的片段（引号片段内含 ？/?）。
  let heroQuestions = 0;
  // 信号 B：全体对白可见长度中位数（剥去引号字符本身）。
  const dialogueLens = [];
  for (let i = 0; i < lines.length; i += 1) {
    for (const seg of allQuotedSegments(lines[i])) {
      if (!/[？?]/.test(seg)) continue;
      const near = [lines[i - 1], lines[i], lines[i + 1]].filter(Boolean).join('\n');
      if (near.includes(hero)) heroQuestions += 1;
    }
  }
  for (const seg of allQuotedSegments(input)) {
    const len = visibleLength(seg);
    if (len > 0) dialogueLens.push(len);
  }

  // 对白样本不足 → 启发式不成立（fail-open，宁漏不噪）。
  if (dialogueLens.length < 6) return [];
  const sorted = [...dialogueLens].sort((a, b) => a - b);
  const mid = sorted[Math.floor(sorted.length / 2)];

  if (heroQuestions > 0 || mid > 5) return [];

  return [{
    line: 1,
    column: 1,
    type: 'dialogue-zero-information',
    severity: 'advisory',
    message: `对话零信息嫌疑（ch1-3 启发式）：主角「${hero}」邻近的发问对白 0 句、全体对白长度中位仅 ${mid} 字——主角只被问/只短答，没有主动索取信息或抛出筹码；开篇需要主角主动发起的对话。启发式非精确，刻意沉默主角可走豁免（Fw-05）。`,
    excerpt: '',
  }];
}
