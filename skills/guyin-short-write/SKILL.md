---
name: guyin-short-write
version: 0.5.0
description: "隐笔短篇写作（编排层）。与 guyin-write 同一四卡体系与 beat 循环，骨架换成情节节点+情绪曲线+反转表（内涵）配时间线/伏笔（方向）。触发方式：/guyin-short-write、/隐笔短篇、「写短篇」「写一篇」「盐言故事」「番茄短篇」「追妻」「重生复仇」。"
---
# guyin-short-write：隐笔短篇（你是编排层）

> 四卡、执行层协议、铁律与 guyin-write 全同——本文件只写差异，未写的一律按 [../guyin-write/SKILL.md](../guyin-write/SKILL.md)。

## 不变式（承 guyin-write，一条不少）

1. 对话要么推进事件，要么揭示人物；两者都不占的删掉。
2. 一次只向执行层下发一张卡；执行层永不见全局。
3. 每步产出落盘，下一步读盘。
4. 检查脚本报警**永不自动删**，一律拦为待审（改写卡或豁免）。
5. 宁留三分糙，不磨十分滑；lint 只清确定性错误。

## 场景路由

| 场景 | 触发 | 动作 |
|------|------|------|
| 开写 | 「写短篇/写一篇」 | Phase A 建（/guyin-setup 选短篇）→ B 定（题材/对标 + 作者性四件，按 [../guyin-write/references/作者性引导.md](../guyin-write/references/作者性引导.md) 逐件口述；不在场则默认档落盘、篇尾报告提示；**进 C 前机械检查气卡「气句」：仍为 {{...}} 占位 → 按谱系就近取默认落盘标「默认档·未口述」，不许占位符进 C**）+ **一句话故事核**）→ C 骨架三件（情节节点+情绪曲线+反转表），**停在骨架交付** |
| 续写 | 「继续写/写下一段」 | 按情节节点状态推进写篇循环 |
| 大修 | 「改这篇/重写」 | 同 guyin-write：L1 段改/L2 beat 改/L3 全篇重写须确认；guyin-review 输出按 level 直接进入 |

**停靠纪律**：裸调用只诊断列选项；骨架交付后不自动写正文；正文必须显式点名。

## 写篇循环（每篇必走）

1. **读盘**：情节节点+情绪曲线+反转表 + 涉角色卡 + 追踪（伏笔/时间线/上下文）+ 作者性五件（编排层读，**气卡永不下发**）+ 上一段结尾 300 字（声线锚，开篇免）。
2. **切 beat**：按节点切 500-1200 字 beat；全篇 6-15 个（粒度按 `作者性/粒度配置.md`），标情绪目标。
3. **逐 beat**：判 Craft/Muse → 组写作卡 → 执行层 → 自检卡 → 改写卡分级 → 下一 beat。卡片与组装协议见 [../guyin-write/cards/README.md](../guyin-write/cards/README.md)。
4. **拼接成篇**：检查拼接点衔接；落盘 `正文/{篇名}.md`。
5. **追踪提交**：`../guyin-write/scripts/guyin-tracking-commit.py`。
6. **篇检**：跑 `../guyin-write/scripts/` 下四个 guyin-check 脚本 + `guyin-check-authority-leak.js`（作者性字面，短篇同样守 H1 隔离——wordcount 以 `--min/--max` 依情节节点的字数目标定界）；报警一律**待审**：blocking 改写或豁免（五测试，**短篇每篇 ≤1 处**）二选一不得自判保留；advisory 保留/分诊卡。
7. **灵感登记**：骨架外新元素登 `追踪/灵感台账.md`，下篇开写时决定转正。

## 短篇军规（与长篇的差异全在这里）

1. **开头定生死**：首 beat 必多采样 3-5 版外选；前 300 字必须出钩子 + 具体人物处境——能整体换到任意同题材文 = 不合格，重抽。
2. **拉扯是发动机**：逐 beat 对照情绪曲线，该压压、该给给；连续 2 个 beat 情绪强度无变化，编排层自行报警调 beat。
3. **反转必登记**：反转表每条须有 铺垫位置/揭示方式/信息差来源/兑现状态；**无铺垫的反转不许写**（那是机械降神）；末 beat 完成后逐项核对兑现。
4. **伏笔不过夜**：短篇伏笔当篇回收，`追踪/伏笔.md` 不留「下卷再说」。

## Craft / Muse（判据同 guyin-write，短篇追加两条升档）

- 反转 beat（反转表登记位置）；情绪曲线峰值 beat。
- 发散卡与多采样外选协议同 guyin-write（判词不写入卡片；外选问「哪版更接近气句」，候选含精神件字面直接出局 H1）；连续 Muse ≤3 beat 自动回落 Craft。

## 执行层调用协议

与 guyin-write 全同：`guyin-beat-writer`（[../guyin-write/agents/guyin-beat-writer.md](../guyin-write/agents/guyin-beat-writer.md)）；无 subagent 降级 solo 须先声明；多采样 3-5 版外选，气卡只在编排层在场。

## 文件契约

```
读：大纲/{情节节点,情绪曲线,反转表}.md、设定/角色/*.md、追踪/{伏笔,上下文}.md、追踪/时间线/*、
    追踪/{灵感,豁免}台账.md、作者性/五件、references/exemplars/{题材}.md（随用随补）
写：正文/{篇名}.md、追踪/*（经 tracking-commit）、双台账
新项目：/guyin-setup 选短篇；手动：复制 templates/long/ 后叠加 templates/short/。
方法按需查 references/consult/INDEX.md（永不下发）。
```

## 豁免五测试

与 guyin-write 文末同制（五测试），限额**每篇 ≤1 处**，登 `追踪/豁免台账.md`。
