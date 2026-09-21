---
name: guyin-write
version: 1.0.0
description: "隐笔长篇写作：当前会话单模型自主执笔。事实/授权/默认文风有方向、剧情不写死；候选隔离、中断可恢复、publish 唯一通道。触发：/guyin-write、「开书」「写第X章」「日更」「续写」「回炉」「重写第X章」。"
---
# guyin-write：单模型自主执笔

只有一个创作主体——**当前会话**：你读前文、定走向、写完整章、全文回看、提事实、跑只读检查。框架不选 model/provider，不默认委派 writer/checker，不提供 full/lean/solo 菜单。脚本只管文件、哈希、输入校验与提交；情节、人物、语言、语义判断归你。方法论按需查 [references/consult/INDEX.md](references/consult/INDEX.md)，不照搬成逐条指令。

## 不变式（先于流程）

1. **授权分层**：用户当次授权与内容边界 ＞ 已发布事实与本候选已选事实 ＞ 用户锁定的原话/结果/视角 ＞ 已选阅读方向与书级文风 ＞ 你生成的未锁定细纲与建议（工作假说，落盘不升锁）。越界即停；推翻已发表事实只能走 revision，不静默改历史。
2. **三种授权分开记**：写作、选稿、发布。「试写」不含发布；「这个版本可以」不自动等于可覆盖正式正文；「继续」不补推发布授权。
3. **自由在未锁定处**：人物办法、行动、对白、心理、局部结果、场次、收尾都由你定；不要求先填因果链、终局升级表或作者性四件，不逐 beat 派卡打分。能力要有依据，配角有自身目的，不靠降智造爽感；吃食、旧物、安静相处可以本身有趣，不必每章反转高潮。
4. 产物落盘在本 run 工作区，下一步读盘；正式正文只由 publish 安装。**不自动 git commit/push**，不删未知来源文件。
5. 检查 finding **永不自动删**：hard/verify 逐条登 `追踪/待审台账.md`，终态五选一＋证据（修复=版本+复检／豁免=用户授权+豁免台账／契约修订=偏差区／顺延=伏笔+章号／不适用=位置+理由）；「升级作者」是等待态，只有用户能转结；editorial 留审读记录。
6. 宁留三分糙，不磨十分滑；lint 只清确定性错误；默认至多一轮有假说的实质修订，无净收益不覆盖旧稿。
7. **恢复先读后写**：在途发布、未完成 run、外部改动先按「中断恢复」核验；不靠记忆续写，不重写已发布章，不引用另一候选的状态。

## 默认文风（自动有方向，不套腔）

动笔前选定唯一一个 profile：规则与全部定义在 [references/默认叙事风格.md](references/默认叙事风格.md)（爽文/都市反差=relationship-payoff；历史穿越=historical-causal；其余按题材表；题材未知=character-causal；「穿越」只是装置，修仙/恋爱各归其类）。书级选择记 `设定/题材定位.md ## 叙事风格`，已填用户文风优先，缺省才用框架 profile。每次 run 把 profile ID/版本/实际特征冻结进 `input.json`，恢复不随库更新换声线。作者性素材（气卡/魂档案/偏执点/私人经历）始终可缺省——缺这些不代表没有文风，不拦写、不追讨。

## 入口路由

| 用户意图 | 动作 | 停止点 |
|---|---|---|
| 裸调用/问项目状态 | 查未完成 run 与 `追踪/_publication.json`，报告下一步 | 不生成正文 |
| 只开书/只出纲 | 准备必要设定与近期方向；细纲前三组是假说、可留发展空间 | 交规划即停，不写正文 |
| 明确写章/试写 | 走写章流程；**无完整细纲也可起笔**，锁与事实从用户原话和已发布文提取 | 无发布授权停 ready |
| 日更/续写 | 先恢复未完成 run，否则按同流程写下一章；批量不超授权章数 | 到读者验收检查点/授权终点/阻断即停 |
| 重写/回炉/去味 | 保留现稿，明确修订目标、硬锁、可重构范围，mode=revision | 不把「去味」扩成剧情重写 |
| review | 当前会话只诊不改，findings 带 severity/L1-L3 | 未获修订授权不动正文 |

关键事实矛盾、真正硬锁冲突、现实专业依据不足，任意阶段停下核实——不等写完再认前提错误。

## 写章流程（phase 单向过门）

`R=.guyin/work/{run_id}/`；进度由 `scripts/guyin-author-session.py` 原子记账（start/checkpoint/status）。合法前进：prepared→drafting→drafted→reviewed→ready→published；换稿退 drafting/drafted 并失效证据；任意非 published 阶段可 blocked。

| 阶段 | 做什么 | 过门条件 |
|---|---|---|
| prepared | 先查未完成 run、在途发布、`tracking-commit check`、pending、读者验收检查点；定向读前情与人物所知；冻结 `R/input.json`（目标、三类授权、事实来源、锁、profile、篇幅） | 状态可信、授权足、材料能写；作者性空缺不拦 |
| drafting | 连续写完整章；候选只含小说正文，新版本存 `R/drafts/vNNNN.md`；输出容量不足按自然段边界存盘并 checkpoint | 完成创作单元——输出停止≠成稿，complete=false 不能过门 |
| drafted | 全文回看：实际读到什么、最该留什么、主要阅读损失；核对语义锁与 profile | 主要问题有明确处置，不以符合设计自证好读 |
| reviewed | 默认至多一轮有假说的实质修订，初稿另存版本、比净收益；从选定稿提追踪事务 | 阅读失败未解决须明示，可不改、可用较好初稿；不假报质量通过 |
| ready | 对选定稿跑候选检查链并核对事务，机器证据绑同稿；`tracking-commit.py preview` 纯内存预演 | hard/verify 有合法处置、语义锁已核对；缺发布授权就停此等待 |
| published | `tracking-commit.py publish`；终验后归档证据、处置已授权规划补丁，再接下一章 | publish complete 且补丁处置完才开下一章 |

不在段落/场景后做审美验收；分段保存不等于重新组卡或派新任务。

## 稿件变化即失效

换不同哈希稿件，旧 review/transaction/check-evidence/plan-patch 指针立即清空（历史文件可留，不得为新稿背书）。局部修复至少复读改动区与承接；结构/视角/跨场因果变动重读整章；从新稿重新提事实，不只改事务哈希。input 的硬锁/profile/前情变更同样失效——不靠改输入把失败稿洗合格。

## 中断恢复（新会话与 compact 同流程）

1. 先读 `追踪/_publication.json`：在途/损坏只走 `tracking-commit.py recover` 或交用户裁决；**不**得改去工作区另写一稿绕过发布异常。
2. 再定位未完成 run：多个 run 让用户指定，不按 mtime 猜；`author-session.py status` 核 input/当前稿/证据/baseline。
3. 读正式上下文＋本 run input＋已存全文/必要上文再接写，不靠最后 300 字猜因果。半章从真实末尾续新版本，不重播开头、不补假事件；孤立新稿显式登记或弃用，不自动按新旧选稿；ready 等待时不把「继续」解释成发布授权；baseline 或已登记稿被外部改动→blocked 列具体差异。session 损坏只按可核验稿件/输入/发布账本重建，证据不齐不伪造 ready。

## 候选检查链（ready 阶段，对显式候选）

目标依赖检查一律显式传 `--project <B> --chapter <N>`；涉授权加 `--boundary <R/input.json>`；有真实细纲加 `--outline <细纲>`，缺细纲记「不适用」而不是造四组过门。解析统一走 `scripts/lib/guyin-candidate-context.js`：tracking-commit check → strip、beat、integrity、degeneration、ai-patterns（editorial 建议，不自动改写）、wordcount `--min/--max`、narrative-asset、consistency、outline-slots/opening-retention、outline-copy、outline-deliver（exact 锁逐字；allowed_reuse 不产生义务；语义锁只列待人工核对）、authority-leak（空作者性合法；工序指令与不入文文本仍拦）、foreshadow-id（扫显式候选＋`--transaction` 认本章新 ID）、repetition（显式章号，修旧章排除本章旧指纹）、rule-conflict。结果由汇总器写 `R/check-evidence.json`（扫描对象、脚本哈希、参数数组、退出码、候选哈希齐备；零扫描不是 pass）。`normalize-punctuation` 无参数只读，显式 `--write` 才改获准候选，改动即失效证据。

## 发布与规划承接

publish 清单 schema v2（新增 `author_input`、`candidate_checks`）；ready 先 `preview`（授权可 null，不写正式正文/追踪），正式发布时 prepared 仍完整重跑全部检查。中断 exit3 只 recover；exit2 按报注重建清单，不手改正文/状态。事务 schema v1：append 章号=last_committed+1，revision 以最新全局状态为基础、不倒退；快照 identity/location/goal/state 非空；怀疑不升级真相，承诺进 next_chapter_commitments，普通旧物/吃食不自动登记待回收。成稿使**未锁定**规划需改时生成 `R/plan-patch.json`，发布 complete 后凭独立改纲授权幂等回写——仅准写正文的话不构成改纲授权，也不篡改历史批准稿。协议字段见 [consult/tracking-transaction.md](references/consult/tracking-transaction.md)。

## 完书 / 大修 / 其他意图

- 完书：读 state 列未回收伏笔与承诺，逐项明收/暗收/放弃＋说明，再写尾声。
- 大修历史章：revision 候选+publish；检查对后续已发表章的影响，冲突登待审台账，不自动重写后续、不回退全局状态。
- 人物诊断/结构手术/读者信号：沿用 guyin-check-flesh、guyin-impact-map、guyin-check-reader-signal 等只读工具出观察，终判归用户；「采集/口述」素材落 `灵感池/`，只注入不强插。

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

模板 hook 保留状态/待审/发布/覆盖保护；候选不触发 guard，session hook 仍注入正式追踪——实验/恢复会话必须确认加载的是所选书根与分支，不被宿主自动注入的另一书状态带走。无 hook 宿主开写前手动跑 pending 并确认无在途发布。[cards/](cards/) 六张卡降为按需辅助：无 token 配额、无默认下发、无逐 beat 验收，需要时自取。
