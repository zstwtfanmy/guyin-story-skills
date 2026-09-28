# framework-c2 候选台账（framework-c1 ＋ G1 最小修正，未合入）

> 建立：2026-09-23。谱系：本目录复制自历史候选 `framework-c1/`（按落地规格 §6.1 实际条件归类＝C2：含 profile 实质改动），再叠加 G1 最小修正；历史快照一字未改。
> 依据：`docs/作品级创作落地审计与生产化执行规格_20260923.md` §7 G1、§10、§11。本候选仍只在 `arena/`，live `skills/ scripts/ tests/` 相对 HEAD 零差异（git diff 可核）。
> **当前状态：确定工程补丁与文档补全已完成，全量 815/0/0，exit 0；G1 整体尚未结项，真实阅读及跨会话文学消费未验证。** 唯一当前摘要见 [README](../README.md#唯一当前状态2026-09-24)，完整结果及命令见 [执行报告 §8](../G1-execution-report.md#8-复核补全执行2026-09-24)。下方历史表格、预算及 743/744/745 结果不代表本轮版本。
> 修改前完整快照：`../g1-pre-f01-f09-20260924.zip`，336 文件，SHA-256 `597895830fe11e53dcc3221b10312394a7a750a6245f412e475cd4f023be0c21`；未解封旧包，它不能证明正式原创 W5 封题完成。

## 2026-09-24 复核补全版本

- 四脚本：POV 逐命中与完整来源绑定、有效双台账校验、首部标题仅遮章号、全文禁止项/占位保留；真实沙盒发布和完整快照回归已通过。
- 五文档：完整 profile 示例、完整角色现态、正常 rubric、craft/dialogue 形式开放、阶段回看和豁免附件操作说明；不宣称文学效果已验证。
- E 全量 **815 pass / 0 fail / 0 skip**；九技能契约、17 预算项、163 项实验包 verify 全部 exit 0。write **5249/5300**，PATH **12937/13000**；未调高预算。
- 四脚本与五文档在 C2/E 按 LF 归一后相同；E 制品为 LF，C2 原始行尾另记。两树 20 个工程文件的前后完整 SHA，以及 E/C2 共 331 文件当前完整 SHA，见 `../g1-f01-f09-evidence-20260924.json`（不含缓存及本可变台账）。该账包含 package-manifest 未覆盖的冷文件。
- 证据账 SHA-256：`25f3667b3235171fa454e2e2e2604a179b1b26a8dd1bdd98ffcf2f1e56b36cd6`；全量日志 `../g1-f01-f09-final-20260924.log`，SHA-256 `391b3c2616a195abec8b8fa1d15e2ad876dc2df32df58fecf07311de9409d2c3`。
- G2/G3 未启动：现有指定封存包不满足同路线两道独立原创题的前提。G4/G5 仍待质量与独立授权；正式源码、安装副本和既有作品未改。

## 历史变更文件（hash16；live → c2）

| 文件 | live | c2（G1 后） | G1 修了什么 |
|---|---|---|---|
| `guyin-write/references/consult/writing-craft.md` | `d038cd3f5b5f61c2` | `5ff336b21450a594` | 删"细节必须有去向/悬空删或兑现"普适义务（C01：断裂必修、余味细节不立兑现义务）；§3 字数指令标注仅限权力博弈模式；§10 两处具名作品原句改陌生化转述 |
| `guyin-write/references/consult/character-design-methods.md` | `04cfb6a745d344ca` | `7c4d43af78097ced` | 无（沿用 c1） |
| `guyin-write/references/consult/character-relations.md` | `05c35cad2c048c1` | `ba47ba267d09031a` | "两条线不应齐头并进"→错位是可选张力、同步合法；"关系必归四类之一"→允许交叠、不强归唯一类 |
| `guyin-write/references/consult/INDEX.md` | `06b3e14397f04fae` | `596c597bcba557ef` | 无（沿用 c1） |
| `guyin-write/references/exemplars/README.md` | `fca1725b59ea41aa` | `6662c42dd6d7bd3e` | "峰值时取体感库替代题材切片"与按需条冲突→统一为按需翻阅、非必取 |
| `guyin-write/SKILL.md` | `1ea354e1970c2af3` | `f96688fe32f37d3e` | prepared 补阶段回看消费者（读回看、核来源哈希与失效）；两处 preview "纯内存/不写盘"改"不写正式正文与追踪、首次可在 R 写证据"；删三处真冗余（人面定义重复、不拦写追讨重复、relationships 段重复） |
| `guyin-write/references/默认叙事风格.md` | `b2af86428a0357ba` | `fc58b4b12400d86e` | 无（沿用 c1；选中发布时再升版） |
| `guyin-review/SKILL.md` | `f8823fe472c73f7f` | `7975b7b608c7b75e` | 内置基准"只解释/情绪平直 ≥S2"与形式中立条冲突→按具体阅读损失定级、低压形式不自动 ≥S2 |
| `guyin-review/references/quality-rubric.md` | `7a60a49eb898a046` | `39644c939a20eea5` | 无（沿用 c1） |
| `guyin-deslop/SKILL.md` | `60c7d6c36443ced5` | `d809cd0ff05ba8af` | "零报警=过度打磨"→零报警既不证明好也不证明过磨，按具体收益损失判断 |
| `guyin-write/references/consult/tracking-transaction.md` | `4e2888b26aa966b7` | `eb229111a62247e0` | 删"不能跳级"措辞（统一为目标产物校验）；input 示例改首次试写默认 selection/publish=null（U2 只在来源登记后可用）；假 semantic/forbidden 锁清除；user-selected 改 framework-default；effective_features 改完整特征；补后补选定 JSON 示例 |
| `guyin-write/scripts/guyin-author-session.py` | `b5f4c8830309b1cb` | `6c6341c6e55c4e53` | 无（沿用 c1，仅 docstring 勘误） |
| `guyin-write/scripts/guyin-check-ai-patterns.js` | （与 live 同） | `301c1ffcad60a771` | §11.5 修复：pov-drift 仅在豁免绑定（待审行＋稿 hash12＋豁免台账#N＋章覆盖）成立时标 resolution=exempted；门不再计绑定项；台账异常 fail-closed |
| `guyin-write/scripts/lib/guyin-candidate-context.js` | （与 live 同） | `ec97cf4472e9c36f` | §11.5：证据消费豁免标记，entry.exemptions 逐条登记（type/条目/稿版本） |
| `guyin-write/scripts/guyin-check-beat.js` | （与 live 同） | `62bd530465edeb6e` | 同步修假阳性：纯文本章标题行「第一章」「第一章 守店」不再判 meta-leak-beat；无空格叙事句仍报 |
| `guyin-write/scripts/guyin-check-authority-leak.js` | （与 live 同） | `39309dfdf3c6c29b` | 同步：explicit 模式工序词检查排除纯文本章标题行 |

c2 其余复制文件与 live 逐字节一致（行尾同源工作区）。

## 预算实测（口径＝去空白字符，`scripts/doc-budget.json`）

| 项 | live | c2 | c2/上限 |
|---|---:|---:|---:|
| write SKILL | 5254 | 5298 | 5298/5300（余量 2） |
| review SKILL | 2668 | 2667 | 2667/2670（余量 3） |
| deslop SKILL | 1499 | 1540 | 1540/1540（余量 0） |
| profile 全文 | 7700 | 7688 | 7688/7700（余量 12） |
| **PATH** | **12954** | **12986** | 12986/13000（余量 14） |

**PATH 相对 live 净增 32**（c1 快照净增 28，G1 净增 4）。用户已裁决：放弃"净增为零"自加约束，不搞数字对冲。本轮真实删了 write SKILL 内三处重复（约 45 字），新增全部为必要授权与接口说明；未调高任何 budget。PATH 是登记字符近似，≠token，不含临时 consult/书内资料/全部 review 与研究成本；实际每章读入量随 G2 起逐轮登记。

## G1 工程结果（独立工程根 engroot-g1，Node v20.17.0 / Python 3.12.0）

- `check-skill-contracts.js` → exit 0
- `check-doc-budget.js` → exit 0
- `tests/run-tests.js` → 修复后总计 745 项：清单重建前 **744 pass / 1 fail**（唯一失败＝beat/authority-leak 脚本变更导致清单过期）；清单重建后该轮重跑由用户跳过，verify 已独立确认 exit 0
- `guyin-check-package.js verify` → exit 0：163 项，缺件 0、哈希不符 0、加载失败 0（清单为 E 内重建的**实验用清单**，非发布交付）。
- §11.5 处置消费缺口：2026-09-24 经用户授权**已修复**——"具体 POV finding→五测试豁免绑定→重跑标 resolution=exempted（绑稿 hash12）→候选链 pass"全程跑通；豁免随稿绑定，改稿 hash 变即失效（反例测试⑤）。修复过程另发现两处"第一章"标题假阳性（beat/authority-leak），一并修正。

## 待办（不在 G1）

- [x] 脚本修复：§11.5 处置消费缺口（2026-09-24 完成，豁免绑稿 hash12、不泛化）
- [ ] G0：调参前由用户/独立会话封存两题（G2/G3 前置）
- [ ] G2：定向研究与三类校准，冻结 X
- [ ] G3：正式 W5 留出四章，用户明确 L1 验收
- [ ] G4/G5：验收＋授权后接入 live、重建发布清单、安装部署
