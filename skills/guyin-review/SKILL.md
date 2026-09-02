---
name: guyin-review
version: 0.7.0
description: "隐笔对抗式审查。只诊断不动刀：多视角找问题 + 合问收尾（这章更合还是只是更合格），输出按 L1/L2/L3 分级直接对接 guyin-write 大修。触发方式：/guyin-review、/隐笔审查、「审查」「帮我审一下」「这章怎么样」。"
---
# guyin-review：隐笔审查（只诊断，不动刀）

> 显：见者惊犹鬼神之前，先有人替读者敲一遍门。审查是找问题，不是验证正确；诊断书不是处方——本技能一字不改正文/设定/追踪。

## 铁律

1. 永不修改正文/设定/大纲/追踪；唯一可写：对话报告 + 分批审查时的 `.guyin-review/state.md`。
2. 每个 finding 必须有句位证据，无证据不报。
3. 疑似神来之笔**不报问题**，标「豁免候选」交五测试（见 guyin-write 文末）——合规系统不消灭变异。
4. 确定性预检只读：章检脚本全扫（ai-patterns / integrity / consistency / narrative-asset / degeneration / wordcount / outline-copy / **authority-leak**——存量章与外部修订稿进 review 的作者性泄漏兑底门），结果只作 finding 证据。文字视角报警段进[分诊卡](../guyin-write/cards/分诊卡.md)三选一+中温3票制，只看报警段 ±2 行不读全文。

## 模式与降级

- **full（默认）**：四视角 subagent 并行（架构/角色对话/文字/一致性）；无 subagent 能力或 spawn 失败 → 自动 solo；
- **lean**：架构 + 一致性两视角；
- **solo**：主会话串行执行四视角；底线=文字+一致性两视角必做，架构/角色可简（架构缺口由 G3 机械契约对照补位）。

降级时报告开头声明 `Fallback: ... -> solo`。报告必须逐字保留五个 key：`Requested Mode` / `Effective Mode` / `Fallback` / `Rubric` / `Rubric Source`。

## 流程

**P1 收集**：定范围（指定章/文件；未指定审最新正文）→ 读支撑材料（相关设定/角色卡/追踪/伏笔；编排层另读 `作者性/气卡.md` + `魂档案.md` 备合问，**不下发任何审查 prompt**）→ 跑确定性预检（铁律 4）→ 定 rubric：按目标平台读 `references/rubrics/{fanqie,qidian,zhihu}.md`，通用读 `references/quality-rubric.md`；不可读用内置基准包（文末），注明 Rubric Source。

**P2 四视角**（full 并行 spawn；solo 串行自问）——**P1 漏斗化**：各视角按「是否真需要全文」分级：

| 视角 | 执行形态 | 检查项 |
|------|---------|--------|
| 文字 | **漏斗式**：ai-patterns 全扫 → 报警段 ±2 行进[分诊卡](../guyin-write/cards/分诊卡.md)（三选一+中温3票制）→ 只对判为真问题的段做深度检查 | 分诊分歧升级作者 |
| 一致性 | **纯脚本**：consistency + narrative-asset + tracking-state 比对 | 状态断言 vs 正文（实体/数字/时间点冲突），伏笔矛盾按 F 编号精确召回 |
| 架构 | **本地算法 + 作者抽检**：钩子强度/主线推进间隔/章尾类型分布本地可算 → 信号表生成后作者判读 | flash 不做架构语义判断 |
| 角色对话 | 低模型单章输入 | 声线一致？潜台词？行为合动机？关系尺度匹配当前阶段？ |

**P3 综合**：合并去重 → severity 排序（S1 主线崩/读者信任崩；S2 明显影响效果；S3 局部；S4 建议）→ 分歧如实呈现，不自动妥协。

**P4 合问收尾（隐笔独有）**：对照气句与一生之问逐条判 S1/S2——这处是「**不够合**」还是「**不够合格**」？修合格是打磨，修合才是显魂；同时判定哪些是豁免候选。

## 统一 Findings Schema（所有模式必用）

```yaml
- severity: S1 | S2 | S3 | S4
  category: structure | character | prose | consistency | format
  location: 文件:行号 或 章节/段落
  evidence: "原文证据"
  issue: "问题描述"
  fix: "可执行方向"
  level: L1 段改 | L2 beat 改 | L3 章改   # 对接大修分级
```

输出三桶：① **修改清单**（按 level 分组 → guyin-write / guyin-short-write 大修场景直接执行）② **豁免候选**（→ 五测试）③ **AI 味集中区**（→ guyin-deslop）。**findings 由编排层转入 `追踪/待审台账.md`（U1）——review 依然只诊断不动刀，产出不再无声消失（未终态行阻塞写新章）**。

## 内置基准包（rubric 不可读时必用）

- 无明确卖点/只解释无冲突/无钩无期待 ≥S2；情绪平直 ≥S2
- 行为不合动机 S1/S2；设定事实冲突 S1；关系越界无铺垫 S1/S2
- 说明书式对话 ≥S2；AI 腔/陈词/章尾总结体 S2/S3；碎句电报体与 AI 腔同级
- 开篇撞题材模板 ≥S3（整体可换 S2）；卡点删掉无损 ≥S3

## 分批审查（整卷/多篇）

维护 `.guyin-review/state.md`（完整范围/已完/下一批/未解决 findings 摘要/每轮 S1、S2 计数）；下批开头读回注入 prompt；非分批不创建。该目录只是审查状态，不是小说事实。

**收敛协议（C1）**：可停判据——S1=0 且 S2 连续两轮零新增，报告附「建议收敛」交作者决断；轮次上限——同一章审查-修复循环默认 R4 停靠，第 4 轮后不再自动开新轮，待作者显式续期（过限停靠，不禁止续）。

## 衔接

| 时机 | 去向 |
|------|------|
| 修查出的问题 | guyin-write / guyin-short-write 大修（level 已对齐 L1/L2/L3）；S1 全部与影响追踪的 S2（事件定性/伏笔/角色状态/时间线）落盘后必 tracking-commit 重提交（G5：S 级修复唯一合法通道，禁止会话裸改正文） |
| 清 AI 味 | guyin-deslop |
| 重新拆对标 | guyin-analyze / guyin-short-analyze |
