# framework-c1 候选台账（W2/W3/W4 + 接口勘误，未合入）

> 建立：2026-09-23。依据规格 §6.1、§7.1。本目录是 live `skills/` 的**候选副本快照**，C1/C2 实验只从这里加载；live 仓库一字未动（git status 可核，本批改动全部位于 `arena/`）。
> 合入（W6）前置：该路线 W5 经用户明确验收通过 + 另行获得改码/加载授权；届时连同版本清单重建一起做。**当前状态：整改已实施于候选，未经试写验证，不代表有效，不得部署。**

## 变更文件（hash16，完整 sha256 可随时重算）

| 文件 | live before | candidate after（2026-09-23 压缩后） | 对应 §6.1 |
|---|---|---|---|
| `guyin-write/references/consult/writing-craft.md` | `d038cd3f5b5f61c2` | `cba7391a7861b845` | 行1/2＋§10 幽默与时代质感（冷路径，无预算约束） |
| `guyin-write/references/consult/character-design-methods.md` | `04cfb6a745d344ca` | `7c4d43af78097ced` | 行3（冷路径） |
| `guyin-write/references/consult/character-relations.md` | `05c354cad2c048c1` | `18afdea9f5a6f61d` | 行4（冷路径；含决策路由入口改名） |
| `guyin-write/references/consult/INDEX.md` | `06b3e14397f04fae` | `596c597bcba557ef` | 行5（冷路径） |
| `guyin-write/references/exemplars/README.md` | `fca1725b59ea41aa` | `3ab8839c5996fafa` | 行5（冷路径） |
| `guyin-write/SKILL.md` | `1ea354e1970c2af3` | `ccdc493ce05dd130` | 行6/7；预算 5294/5300 |
| `guyin-write/references/默认叙事风格.md` | `b2af86428a0357ba` | `fc58b4b12400d86e` | 行6＋幽默口径（2026-09-23 用户校准：叙述者舌头不封年代）；预算 7688/7700 |
| `guyin-review/SKILL.md` | `f8823fe472c73f7f` | `e28b4dd524e7e74a` | 行8；预算 2669/2670 |
| `guyin-review/references/quality-rubric.md` | `7a60a49eb898a046` | `39644c939a20eea5` | 行8（冷路径） |
| `guyin-deslop/SKILL.md` | `60c7d6c36443ced5` | `10b969a69b61e0c5` | 行9；预算 1535/1540 |
| `guyin-write/references/consult/tracking-transaction.md` | `4e2888b26aa966b7` | `bc26e2cc6315d8f2` | 行10（接口勘误，冷路径） |
| `guyin-write/scripts/guyin-author-session.py` | `b5f4c8830309b1cb` | `6c6341c6e55c4e53` | 行11（仅 docstring，py_compile 通过） |

热路径 PATH（write SKILL＋profile）：12982/13000（幽默校准后）。预算口径与 `scripts/doc-budget.json` 一致（去空白字符数）；候选在 arena，未调高任何 budget。

其余复制文件（dialogue-mastery/hooks-chapter 等 consult、全部 scripts、cards、模板）与 live 逐字节一致，未改。

## 文学处理改了什么（要点）

1. **writing-craft**：情绪"关键节点禁止直写、必须身体外化"→ 直陈/转述/自由间接体/动作按体验选用；删除每节一动一静配额、百字三事件、每子事件三维度 ≥100–150 字、三指遮盖法、输出前固定段落重排、"叙述默认逗号长句"及其对已降级 anti-ai-writing 的引用；深度限知由"默认锁死"改为书级 POV 决定；道具三次、省略号/破折号禁令改为条件性工具；疏密改为按阅读价值（日常可详写，不固定低于高潮）；新增"细节必须有去向（悬空细节＝装饰）"——直接对应 Y02 用户病句反馈。
2. **character-design-methods**："反差=立体感/每个重要角色至少一层反差"→ 特定场景工具；高情商桥段不强制每段反转；角色池不强制每人一标签；同步尾部检查项。
3. **character-relations**：配角态度≠攻略进度条；删除亲情按性别分派资源/安慰；好感度四阶段表降为强恋爱品类诊断工具、不入状态账；同步检查项。
4. **INDEX/exemplars**：方法定位改为条件性；exemplars 好坏例改为比较阅读损失，不建"直接情绪坏、身体动作好"等级。
5. **write SKILL/profile（暂存）**：人面＝"人物体验是否成立"，事件内外均可，不要求非任务时刻配额；去掉自由间接体优于其他心理形式的导向；prepared 补完整快照/旧正文召回顺序；drafting 补"先判断本段什么值得停留"；drafted 补正面语言收益指认；reviewed 分清常规一轮/结构回炉/revision 三笔预算；新增阶段回看消费。
6. **review/rubric/deslop**：一致性＝脚本＋语义复核；语言既查损失也查正面收益；高潮模板只评适用片段、稳定相处可有回报、黄金三问允许"无变化但值得停留"；R4 不等于四轮润色；"解释充分"不单独定罪；视角按书级权限；报警多不自动触发结构重写。
7. **幽默与时代质感（Y04/Y05 后用户校准追加）**：writing-craft §10＋profile 一句——幽默来源放开（立场错位/促狭比喻/书内梗/跨时代与影视致敬/适度擦边）；边界是场景内物件合时代、叙述者舌头不封年代、梗有归属不堆砌；修正了"封 2000 后语料/笑点只走主轴"的过度限制。

## 接口勘误（与文学处理分账）

- `tracking-transaction.md` 示例：user source 与 exact 锁配套（锁词"声益听力"为真实术语而非普通意图）；file source sha256 标注必填（缺哈希 v2 preview/publish 拒绝）；checkpoint 示例指针改为相对书根 B 的完整 R 前缀，并明确先登记稿件、另次登记证据；阶段机说明改为按目标阶段产物校验。
- `guyin-author-session.py` docstring：status 帮助删 `[--json]`（argparse 本无该参数）；`python -m py_compile` 通过。

## 工程结果（2026-09-23，live F 下实跑）

- `node scripts/check-skill-contracts.js` → exit 0
- `node scripts/check-doc-budget.js` → exit 0
- `node tests/run-tests.js` → **738 pass / 1 fail**
- 唯一失败 F.3.1/F.3.4 源树 verify：6 个 live 文件相对 2026-09-22 清单哈希漂移（INDEX.md、guyin-author-session.py、guyin-short-write/SKILL.md、guyin-review/SKILL.md、guyin-deslop/SKILL.md、guyin-check-package.js）。经 `git status` 核实 **skills/ 目录本会话零改动**，漂移为 P3.2 §八历史编辑后未重建版本清单的既有状态，与本候选无关。重建清单按规格 §7.4 属有意源码改动审差异＋工程通过后的发布流程动作，留 W6 随合入一并处理，本批不擅自重建。
- 候选 profile 净增约 150 字：live profile 已处文档预算 7700/7700 顶格，W6 落库时必须以替换压缩方式保持预算不调高（规格 §7.4：不得为塞规格/候选改预算）。

## 待办（不在本批）

- [ ] C1 经 y03 对标试写检验，无效差异不进 W6
- [ ] W6：用户验收＋改码授权后，逐文件合入 live、同步版本/清单声明、重建 package-manifest、重跑全绿
- [ ] 合入时处理 doc-budget 顶格（净增必须用等量删减对冲）
