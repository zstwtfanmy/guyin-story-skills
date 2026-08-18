---
name: guyin-review
version: 0.1.0
description: "隐笔对抗式审查。只诊断不动刀：多视角找问题 + 合问收尾（这章更合还是只是更合格），输出按 L1/L2/L3 分级直接对接 guyin-write 大修。触发方式：/guyin-review、/隐笔审查、「审查」「帮我审一下」「这章怎么样」。"
---
# guyin-review：隐笔审查（只诊断，不动刀）

> 显：见者惊犹鬼神之前，先有人替读者敲一遍门。审查是找问题，不是验证正确；诊断书不是处方——本技能一字不改正文/设定/追踪。

## 铁律

1. 永不修改正文/设定/大纲/追踪；唯一可写：对话报告 + 分批审查时的 `.guyin-review/state.md`。
2. 每个 finding 必须有句位证据，无证据不报。
3. 疑似神来之笔**不报问题**，标「豁免候选」交五测试（见 guyin-write 文末）——合规系统不消灭变异。
4. 确定性预检只读：`node ../guyin-write/scripts/guyin-check-ai-patterns.js` 等三脚本，结果只作 finding 证据。

## 模式与降级

- **full（默认）**：四视角 subagent 并行（架构/角色对话/文字/一致性）；无 subagent 能力或 spawn 失败 → 自动 solo；
- **lean**：架构 + 一致性两视角；
- **solo**：主会话串行执行四视角。

降级时报告开头声明 `Fallback: ... -> solo`。报告必须逐字保留五个 key：`Requested Mode` / `Effective Mode` / `Fallback` / `Rubric` / `Rubric Source`。

## 流程

**P1 收集**：定范围（指定章/文件；未指定审最新正文）→ 读支撑材料（相关设定/角色卡/追踪/伏笔；编排层另读 `作者性/气卡.md` + `魂档案.md` 备合问，**不下发任何审查 prompt**）→ 跑确定性预检（铁律 4）→ 定 rubric：按目标平台读 `references/rubrics/{fanqie,qidian,zhihu}.md`，通用读 `references/quality-rubric.md`；不可读用内置基准包（文末），注明 Rubric Source。

**P2 四视角**（full 并行 spawn，prompt 自包含：项目路径/范围/摘录/rubric 摘要/Schema；solo 串行自问）：

| 视角 | 检查项 |
|------|--------|
| 架构 | 推进主题？钩子/反转质量？情绪节奏？范围膨胀？开头同质化（仅开篇：能整体换到同类书即撞模板）？章尾落动作还是总结腔？ |
| 角色对话 | 声线一致？潜台词与信息控制？行为合动机？关系尺度匹配当前阶段？ |
| 文字 | AI 味分级+证据/套路句/句长节奏（碎句电报体与 AI 腔同级）/标点节奏/格式可读性 |
| 一致性 | 属性/规则/伏笔状态/时间线/术语前后矛盾——只报事实冲突，fix 只写统一方向，不写创作建议 |

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

输出三桶：① **修改清单**（按 level 分组 → guyin-write / guyin-short-write 大修场景直接执行）② **豁免候选**（→ 五测试）③ **AI 味集中区**（→ guyin-deslop）。

## 内置基准包（rubric 不可读时必用）

- 无明确卖点/只解释无冲突/无钩无期待 ≥S2；情绪平直 ≥S2
- 行为不合动机 S1/S2；设定事实冲突 S1；关系越界无铺垫 S1/S2
- 说明书式对话 ≥S2；AI 腔/陈词/章尾总结体 S2/S3；碎句电报体与 AI 腔同级
- 开篇撞题材模板 ≥S3（整体可换 S2）；卡点删掉无损 ≥S3

## 分批审查（整卷/多篇）

维护 `.guyin-review/state.md`（完整范围/已完/下一批/未解决 findings 摘要）；下批开头读回注入 prompt；非分批不创建。该目录只是审查状态，不是小说事实。

## 衔接

| 时机 | 去向 |
|------|------|
| 修查出的问题 | guyin-write / guyin-short-write 大修（level 已对齐 L1/L2/L3） |
| 清 AI 味 | guyin-deslop |
| 重新拆对标 | guyin-analyze / guyin-short-analyze |
