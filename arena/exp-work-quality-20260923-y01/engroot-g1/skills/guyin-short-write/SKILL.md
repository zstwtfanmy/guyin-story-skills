---
name: guyin-short-write
version: 1.0.0
description: "隐笔短篇写作：当前会话单模型自主执笔。与 guyin-write 同一创作权、默认文风 profile、隔离候选、中断恢复与 publish 唯一通道，骨架为情节节点+情绪曲线+反转表，固定单元 1。触发：/guyin-short-write、「写短篇」「写一篇」「盐言故事」「番茄短篇」「追妻」「重生复仇」。"
---
# guyin-short-write：短篇单模型自主执笔

> 创作主体、授权分层、默认文风、候选隔离与恢复纪律全同 [../guyin-write/SKILL.md](../guyin-write/SKILL.md)——本文件只写差异，未写的按长篇。

## 继承 / 不继承

- **继承**：连续场景执笔（beat 仅节奏）、完整篇审读、默认 profile（按短篇回报选）、候选隔离与 publish 唯一通道、版本化中断恢复、默认单稿。
- **不继承**：卷纲、黄金三章/第 4 章试读门（trial-gate 不跑）、卷末作者性事项、章号/细纲槽位检查（opening-retention/hook-rotation/outline-slots）。**input 锁不豁免**：forbidden 走 authority-leak，exact/semantic 走 outline-deliver 锁模式（只给 `--boundary`；无锁无骨架＝not_applicable）——废槽位不废权限边界。
- 篇幅：字数与回报位置由情节节点定（wordcount `--min/--max`，不套 3000 下限）；**保留短篇自身的篇幅与回报期限**，情绪曲线只作全篇参照，不做机械升降。

## 单元号映射（固定整数单元号 1）

- 首发 `mode=append, chapter=1`；修订重发 `mode=revision, chapter=1`；清单 target.chapter=1、`destination=正文/{篇名}.md`；发布器与手动复读都显式 `--unit 1`，**不从文件名反解章号**。
- **同项目多篇不支持自动映射**：开第二篇先另定稳定单元映射与状态隔离（默认另建目录）。

## 入口与停止点

| 意图 | 动作 | 停止点 |
|------|------|--------|
| 只开书/只出纲/先要骨架 | 部署（/guyin-setup 选短篇）→ 题材方向＋一句话故事核＋profile → 骨架三件（情节节点/情绪曲线/反转表） | 交骨架即停，不写正文 |
| 写短篇/写一篇（明确写作） | 骨架可先给；**无完整骨架也可起笔**，锁与事实从用户原话提取 → 走写篇流程 | 无发布授权停 ready（与长篇同） |
| 继续写 | 先恢复未完成 run，再按情节节点连续场景推进 | 到授权终点/阻断即停 |
| 改这篇/重写/去味 | revision 候选（单元 1），明确修订目标与硬锁，不把去味扩成剧情重写 | 未获发布授权停 ready |

裸调用只诊断列选项。

## 写篇流程（差异版，其余同长篇阶段门）

1. **prepared**：查在途发布/未完成 run/pending；读已有骨架三件（缺件不拦）、涉角色与追踪、上一场全文；冻结 input（profile＋篇幅上下界）。
2. **drafting→drafted**：连续写完整篇，候选只落 `R/drafts/`；中断按自然段存盘 checkpoint。完整篇审读：先初读再对骨架（反转铺垫、回报给够、信息差），结论绑候选哈希。
3. **ready**：篇检对子显式候选（`--project --chapter 1`，篇名加 `--unit 1`）：tracking-commit check → strip、beat、integrity、degeneration、ai-patterns、`repetition --unit 1`（库空＝首篇）、outline-copy（有骨架才查）、outline-deliver（只核 input 锁：exact 逐字/semantic 待人工；无锁无骨架 not_applicable）、authority-leak（含 forbidden）、wordcount、foreshadow-id。hard/verify 登待审；改候选重跑、证据重绑哈希。
4. **published**：清单 `target={mode,chapter:1,title:篇名}`、`destination=正文/{篇名}.md`，candidate/transaction/证据/baseline 四件齐；preview→publish；非 complete（任何退出码）先查 journal 只走 recover，账本损坏停人工核查。

## 短篇军规（差异全在这里）

1. **开头定处境**：前 300 字出钩子＋具体人物处境——能整体换到任意同题材文＝重写；不强制首场多版、不固定丢弃前两版。
2. **拉扯看整体**：蓄力段可以平，判据是读者获得不是曲线形状；全篇核「该压的压了、回报给够了」。
3. **反转必登记**：每条有铺垫/揭示/信息差来源/兑现状态；无铺垫不许写，末场后逐项核。
4. **伏笔不过夜**：当篇回收，不留「下篇再说」。

## 验收检查点（短篇形态）

无第 4 章门；检查点＝**全文交付后**（或含起因-兑现-余波的连续段），登 `追踪/读者信号.md·验收检查点`（单元 1＋版本哈希）。来源限用户验收/独立读者，模型审读不顶替；缺件/空答/未处置均拦；可「延期@时点」登记；旧反馈不冒充当前版本。

## 文件契约

- 读：`大纲/{情节节点,情绪曲线,反转表}.md`（有才读）、`设定/角色/*.md`、追踪、作者性素材（可选）。
- 写：`.guyin/work/{run_id}/`（publish 前不写正文）、`正文/{篇名}.md`（仅 publish，单元=1）、`追踪/*`（经 tracking-commit，chapter=1）。
- 豁免同长篇五终态，须用户授权，登 `追踪/豁免台账.md`；每篇 ≤1 处只计 hard/verify 授权豁免，editorial 观察不占配额。
