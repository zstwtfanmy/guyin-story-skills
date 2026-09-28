---
name: guyin-write
version: 1.0.0
description: "隐笔长篇写作：当前会话单模型自主执笔。事实/授权/默认文风有方向、剧情不写死；候选隔离、中断可恢复、publish 唯一通道。触发：/guyin-write、「开书」「写第X章」「日更」「续写」「回炉」「重写第X章」。"
---
# guyin-write：单模型自主执笔

只有一个创作主体——**当前会话**：你读前文、定走向、写完整章、全文回看、提事实、跑只读检查。框架不选 model/provider，不默认委派 writer/checker，不提供 full/lean/solo 菜单。脚本只管文件、哈希、输入校验与提交；情节、人物、语言、语义判断归你。方法论按需查 [consult/INDEX.md](references/consult/INDEX.md)，不照搬成逐条指令。

## 不变式（先于流程）

1. **授权分层**：用户当次授权与内容边界 ＞ 已发布事实与本候选已选事实 ＞ 用户锁定的原话/结果/视角 ＞ 已选阅读方向与书级文风 ＞ 你生成的未锁定细纲与建议（工作假说，落盘不升锁）。越界即停；推翻已发表事实只能走 revision，不静默改历史。
2. **三种授权分开记**：写作、选稿、发布。「试写」不含发布；「这个版本可以」不自动等于可覆盖正式正文；「继续」不补推发布授权。
3. **自由在未锁定处**：办法、行动、对白、心理、局部结果、场次、收尾都由你定；不填因果链/升级表/作者性四件，不逐 beat 打分。能力有依据，配角有自身目的，不靠降智造爽；吃食、旧物、安静相处可本身有趣，不必每章反转。
4. 产物落盘在本 run 工作区，下一步读盘；正式正文只由 publish 安装。**不自动 git commit/push**，不删未知来源文件。
5. 检查 finding **永不自动删**：hard/verify 逐条登 `追踪/待审台账.md`，终态五选一（修复/豁免/契约修订/顺延/不适用）各带证据，细则见台账；「升级作者」是等待态，只有用户能转结；editorial 留审读记录。
6. 宁留三分糙，不磨十分滑；lint 只清确定性错误；默认至多一轮有假说的实质修订，无净收益不覆盖旧稿。
7. **恢复先读后写**：在途发布、未完成 run、外部改动先按「中断恢复」核验；不靠记忆续写，不重写已发布章，不引用另一候选的状态。

## 默认文风（自动有方向，不套腔）

动笔前选定唯一一个 profile，定义在 [references/默认叙事风格.md](references/默认叙事风格.md)（爽文/都市反差=relationship-payoff；历史穿越=historical-causal；余按题材表；未知=character-causal；「穿越」只是装置）。书级选择记 `设定/题材定位.md ## 叙事风格`，用户文风优先。每次 run 把 profile ID/版本/完整实际特征冻结进 `input.json`，**行动面与人面并取**：人面＝人物体验是否成立，事件内外皆可，无"非剧情时刻"配额；关系型不得只冻行动标签；库更新不换声线。作者性素材始终可缺省。

## 入口路由

| 用户意图 | 动作 | 停止点 |
|---|---|---|
| 裸调用/问项目状态 | 查未完成 run 与 `追踪/_publication.json`，报告下一步 | 不生成正文 |
| 只开书/只出纲 | 准备必要设定与近期方向；细纲前三组是假说、可留发展空间。开书或阶段陷入重复时，由执笔者写一小段书级设想：人物珍惜什么、习惯怎么应对、与什么愿望或关系相牵制、他人选择为何改变局面；缺内容先自己做创作判断，不追讨人物问卷 | 交规划即停；设想是假说不是事实锁，无授权只留工作判断 |
| 明确写章/试写 | 走写章流程；**无完整细纲也可起笔**，锁与事实从用户原话和已发布文提取 | 无发布授权停 ready |
| 日更/续写 | 先恢复未完成 run，否则按同流程写下一章；批量不超授权章数 | 到读者验收检查点/授权终点/阻断即停 |
| 重写/回炉/去味 | 保留现稿，明确修订目标、硬锁、可重构范围，mode=revision | 不把「去味」扩成剧情重写 |
| review | 当前会话只诊不改，findings 带 severity/L1-L3 | 未获修订授权不动正文 |

关键事实矛盾、真正硬锁冲突、现实专业依据不足，任意阶段停下核实——不等写完再认前提错误。

## 写章流程（phase 单向过门）

`R=.guyin/work/{run_id}/`；进度由 `scripts/guyin-author-session.py` 原子记账（start/checkpoint/status）。合法前进：prepared→drafting→drafted→reviewed→ready→published；换稿退 drafting/drafted 并失效证据；任意非 published 阶段可 blocked。

| 阶段 | 做什么 | 过门条件 |
|---|---|---|
| prepared | 查在途发布/未完成 run/pending/检查点；取材按序：上章必要全文（非结尾几百字）→ 本章人物**完整**快照，重点 relationships/knowledge/open_threads（六人是热卡上限非登场上限）→ 旧物/承诺/旧事沿逐章记录回查原正文 → 专业前提取可追溯材料 → 声线从**本书已认可正文**取证（不照搬参照书）；来源真实哈希落 sources，设想不写成事实 | 材料够支持本章即止，不凑数；作者性空缺不拦 |
| drafting | 先定**本段什么值得停留**再连续写完整章；人物所知与读者所知分开；新版本存 `R/drafts/vNNNN.md`；中断按自然段边界存盘 checkpoint | 输出停止≠成稿，complete=false 不能过门 |
| drafted | 先自由通读记真实反应，再对照目标材料。回看含：读到什么、**正面语言/叙述收益及句位**（观察、接话分寸、信息次序、节奏；没有就如实承认）、主要损失及证据、修与不修的理由；核人面（见默认风频段） | 先分清损失在故事选择、场景展开还是措辞；前两者不靠加心理/换词/补细节修饰；损失作答须具体，禁模板句 |
| reviewed | **常规＝至多一轮有假说的实质修订**，比净收益；结构/POV/跨场因果失败须另获目标、范围与追加预算才回炉（留原稿与成本，不改 run 名清零）；从选定稿提追踪事务 | 失败未解决须明示，可用较好初稿；不以"宁留糙"替坏结构开脱 |
| ready | 对选定稿跑候选检查链并核对事务，机器证据绑同稿；`tracking-commit.py preview` 不写正式正文/追踪（首次可在 R 写证据） | hard/verify 有合法处置、语义锁已核对；缺发布授权就停此等待 |
| published | `tracking-commit.py publish`；终验后归档证据、处置已授权规划补丁，再接下一章 | publish complete 且补丁处置完才开下一章 |

不在段落/场景后做审美验收。

## 稿件变化即失效

换不同哈希稿件，旧 review/transaction/check-evidence/plan-patch 指针立即清空（历史文件可留，不得为新稿背书）。局部修复至少复读改动区与承接；结构/视角/跨场因果变动重读整章；从新稿重新提事实，不只改事务哈希。input 的硬锁/profile/前情变更同样失效——不靠改输入把失败稿洗合格。

## 中断恢复（新会话与 compact 同流程）

1. 先读 `追踪/_publication.json`：在途/损坏只走 `tracking-commit.py recover` 或交用户裁决；**不**得改去工作区另写一稿绕过发布异常。
2. 再定位未完成 run：多个 run 让用户指定，不按 mtime 猜；`author-session.py status` 核 input/当前稿/证据/baseline。
3. 读正式上下文＋本 run input＋已存全文/必要上文再接写，不靠结尾几百字猜。半章从真实末尾续新版本，不重播开头、不补假事件；孤立稿登记或弃用，不自动选稿；ready 时「继续」≠发布授权；baseline 被外部改动→blocked 列差异；session 损坏只按可核验账本重建，证据不齐不伪造 ready。

## 候选检查链（ready 阶段，对显式候选）

显式传 `--project <B> --chapter <N>`；涉授权加 `--boundary <R/input.json>`；有真实细纲加 `--outline`，缺细纲记「不适用」不造过门。统一走 `scripts/lib/guyin-candidate-context.js` 汇总：check、strip、beat、integrity、degeneration、ai-patterns（editorial）、wordcount、narrative-asset、consistency、outline-* （exact 锁逐字、语义锁仅人工核对、白名单无义务）、authority-leak（空作者性合法）、foreshadow-id（配 `--transaction`）、repetition（显式章号）、rule-conflict。结果写 `R/check-evidence.json`（对象/脚本哈希/参数/退出码/候选哈希齐备；零扫描不是 pass）。`normalize-punctuation` 默认只读，`--write` 须显式授权且改动即失效证据。

## 发布与规划承接

publish 清单 schema v2；ready 先 `preview`（授权可 null：不写正式正文/追踪，首次可在 R 写证据），发布时 prepared 完整重跑检查。非 complete 只走 recover，账本损坏停人工。事务 schema v1：append 章号=last+1，revision 以最新全局状态为基、不倒退；快照 identity/location/goal/state 非空；怀疑不升级真相，承诺入 next_chapter_commitments，普通吃食旧物不自动登记回收。relationships 写了才提示、无配额：相处可只有阅读价值、变化数组允许为空。未锁定规划需改生成 `R/plan-patch.json`，complete 后凭独立改纲授权幂等回写；准写正文≠改纲授权。字段见 [consult/tracking-transaction.md](references/consult/tracking-transaction.md)。

## 完书 / 大修 / 其他意图

- 完书：读 state 列未回收伏笔与承诺，逐项明收/暗收/放弃＋说明，再写尾声。
- 大修历史章：revision 候选+publish；查对后续章影响，冲突登待审台账，不自动重写后续、不回退全局状态。三种预算分开：常规一轮／另获目标范围与追加预算的结构回炉（现 run 另存版本）／已发布章 revision run（跨章影响逐章授权），互不顶替。
- 阶段回看：获准连续段检查点、旧摘要不足或新会话承接时，按 [回看与消费闭环](references/consult/tracking-transaction.md#阶段回看与跨会话消费) 操作。
- 人物诊断/结构手术/读者信号：用 guyin-check-flesh/impact-map/reader-signal 等只读工具出观察，终判归用户；「采集/口述」素材落 `灵感池/`，只注不强插。

## 文件契约

```
读：设定/**、大纲/卷纲_*.md、大纲/细纲_第NNN章.md（有才读，不强制创建）、
    追踪/{伏笔,上下文,事件定性资产,时间线,角色状态,各台账}、references/默认叙事风格.md（只读所选 profile）、
    作者性/**（可选，存在才读）、references/exemplars/**（可选合法原文研究，未验证须标注）
写：.guyin/work/{run_id}/{input.json,author-session.json,drafts/vNNNN.md,review.md,transaction.json,
    check-evidence.json,plan-patch.json,publish.json,publication/}、
    正文/第NNN章_标题.md（仅 publish 安装）、追踪/*（经 tracking-commit）、追踪/{灵感,豁免,待审}台账.md
新项目先 /guyin-setup；项目结构按部署模板。
```

## 护栏

模板 hook 保留状态/待审/发布/覆盖保护；实验/恢复会话确认加载的是所选书根与分支，不被宿主注入的另一书状态带走；无 hook 宿主开写前手动跑 pending 并确认无在途发布。[cards/](cards/) 按需自取，无配额、不默认下发。
