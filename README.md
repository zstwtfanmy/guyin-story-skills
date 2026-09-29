# 隐笔（guyin-skills）

> 笔不造文，隐术显天。
> 作品不是造出来的，是合出来的——作者之天合万物之天，框架的职责不是造文，是**不挡光**。

隐笔是网文写作技能包，全部技能以 **guyin-** 前缀命名。2026-09-28 起写作流程与声线来源以《质量极简流与隐杀声线锚技术规格》为准：**示范 > 规则**——删掉与质量无关的工程机器（检查链/gate/发布机/候选隔离），用《隐杀》原文锚包做声线示范，写作流收为五步：读 → 直接写正文 → 持锚自审改一轮 → 顺手记 markdown 账 → 交用户。用户是唯一验收者。

## 技能清单

| 技能 | 触发 | 职责 |
|------|------|------|
| **guyin-story** | `/guyin`、`/隐笔`、「我想写小说」 | 主入口：路由 + 项目状态诊断 |
| **guyin-write** | `/guyin-write`、「开书」「写第X章」「日更」「回炉」 | 长篇写作：五步极简流 + 隐杀声线锚（写作知识六条、持锚三问自审） |
| **guyin-short-write** | `/guyin-short-write`、「写短篇」「盐言故事」 | 短篇写作：同一五步流；骨架三件（情节节点/情绪曲线/反转表）是设想不是考卷 |
| **guyin-pitch** | `/guyin-pitch`、「起书名」「写简介」「章节标题」 | 开书文案包：书名多采样外选+十年测试，简介从已写成正文反向提炼 |
| **guyin-analyze** | `/guyin-analyze`、「拆这本书」 | 长篇拆文管道 |
| **guyin-short-analyze** | `/guyin-short-analyze`、「拆短篇」 | 短篇拆文全量管道 |
| **guyin-review** | `/guyin-review`、「审查」「这章怎么样」 | 对抗式审查：只诊断不动刀，输出「哪里想停读＋持锚三问」，不盖章不发 pass |
| **guyin-deslop** | `/guyin-deslop`、「去AI味」 | 去AI味：原地两步（读审→陌生化改写），宁留三分糙不磨十分滑 |
| **guyin-setup** | `/guyin-setup`、「准备写书」「搭环境」「建项目」 | 项目脚手架部署：模板随技能走，无 hook、无台账机器 |

## 安装（Codex / OpenCode / Claude Code 三端兼容）

> 一等公民：**Codex** 与 **OpenCode**；Claude Code 同样可用。项目模板随 **guyin-setup** 技能分发——skills 装到哪，模板跟到哪，无需克隆仓库。

### 方式一：skills CLI 一键装（推荐）

```powershell
# OpenCode（全局 ~/.config/opencode/skills/，一次装处处用；去掉 -g 则装进项目 .agents/skills/）
npx skills add https://github.com/zstwtfanmy/guyin-story-skills -a opencode -g
# Claude Code（全局 ~/.claude/skills/）
npx skills add https://github.com/zstwtfanmy/guyin-story-skills -a claude-code -g
# Codex（项目级）
npx skills add https://github.com/zstwtfanmy/guyin-story-skills -a codex
```

交互式选择时全选 9 个 guyin-* 技能（含 guyin-setup 与其项目模板）。然后每本书：

```powershell
mkdir D:\books\我的书; cd D:\books\我的书
opencode    # 或 claude / codex
```

> 说「准备写书」（或 /guyin-setup）→ 部署项目模板（设定/大纲/正文/追踪/可选作者性；无 hook、无检查门、无待审/豁免台账；幂等，不覆盖已有内容）→ 新开会话 → 说「开书」。

> **OpenCode 本体与两个坑**：未装时 `npm install -g opencode-ai`（或 `scoop install opencode`），首次用 `opencode auth login` 配你自己要用的 provider/模型（框架不替你选模型）。坑 1：npm 全局装完命令不识别，用 `npm config get prefix` 查路径并确认其在 PATH；坑 2：进项目后**不要跑 `/init`**——模板已自带路由版 AGENTS.md，`/init` 会覆盖它。

### 方式二：克隆手动装

```powershell
git clone git@github.com:zstwtfanmy/guyin-story-skills.git D:\guyin-skills
mkdir D:\books\我的书; cd D:\books\我的书
Copy-Item -Recurse D:\guyin-skills\skills\guyin-setup\templates\long\* .    # 写短篇再叠加 templates\short\大纲\ 三件
Copy-Item -Recurse D:\guyin-skills\skills\guyin-* .\.opencode\skills\       # OpenCode；Codex 改 .\.codex\skills\，Claude Code 改 $HOME\.claude\skills\
```

### 开书（单模型自由执笔）

新分发**不含** writer/checker 执行层 agent，不需要配置任何低模型字段：读前文、定走向、写完整章、全文回看都由当前会话一个创作主体完成。

新开会话后，在项目根对 AI 说「开书」（或 `$guyin-write` / `/guyin-write`）→ 无完整细纲也可直接写（细纲是设想不是考卷）→ 正文直写 `正文/第NNN章_标题.md`，写完交用户，没有候选区、没有发布动作。写短篇同理，直写 `正文/{篇名}.md`。

**声线锚包**（写前读、写后持锚自审）：从用户合法持有的《隐杀》原文提取的 5 段锚文，存于仓库外本地目录 `D:/readbook-workspace/声线锚/隐杀/`（不入 git、不分发）。锚包目录不存在时向用户索要，不空跑声线。书积累出 ≥3 章用户认可的正文后，锚包降级为"声音漂移时回炉"用——这就是出帖。

### 升级旧项目（技能更新 ≠ 旧项目生效）

框架更新后，对已部署的书重跑一次 `/guyin-setup`：

1. **先出差异再动手**——guyin-deploy.js 只刷新部署件（OpenCode command），来源不明文件不盲目 replace；
2. **旧机器报停用清单**——旧版部署的 `.claude/hooks/guyin-hook.js` 与 `.claude/settings.json` 注册、`.guyin/work/` run 目录、`追踪/_tracking-state.json`／`追踪/_publication.json`、待审/豁免台账：新流程不读不写，处置（删除或归档）由用户决定，不自动删用户文件；
3. 报告写明**实际加载路径**（全局 skills / 项目 `.agents`·`.claude` / 手动复制）与未测宿主。

> 仓库根的 `.agents/`、`.claude/`（安装器在本仓误跑的产物，已 gitignore）不是分发渠道；以 `skills/` 与 setup 模板为准，镜像目录不保证最新。

## 仓库结构

```
skills/          九个 guyin- 技能（references/ 含 consult 方法论库与 exemplars 范文库；scripts/ 保留的
                 advisory 小工具；scripts/_disabled/ 为退役机器留档，仅存 git 仓库不随包分发）
                 guyin-setup/templates/ 持有项目模板：long/ 长篇脚手架 + short/ 短篇 delta（骨架三件）
arena/           擂台：固定基准场景 + 对战记录（框架变更的唯一验收门——盲验，见 docs/ 规格 §6）
docs/            设计文档（含 质量极简流与隐杀声线锚技术规格_20260928.md：现行写作流程与声线来源的生效规格）
```

## 框架之魂 · 以天合天

> 作品不是造出来的，是合出来的。
> 一个天，是**作者之天**——活过的生命、一生之问、他的真；
> 另一个天，是**万物之天**——类型的永恒渴望、世界自生长的天性、人人心里的常情。
> 作品只存在于两天相合之处。框架的职责不是造文，是**不挡光**。

两千年前，木匠梓庆做完的乐器架，人人惊为鬼神。问他何术，他说：斋心三日，忘了庆赏爵禄；五日，忘了非誉巧拙；七日，忘了自己有手艺这回事。而后入山林，看见那棵树里本来就长着一只成器——"然后加手焉，不然则已。**以天合天**。"

隐笔就是把这套工序造进系统：**模型是那只不变的手，框架负责斋与观，作者带来自己的天。**同一句话，西方在另一条路上也抵达过——poiesis 是"让显现"而非制造（海德格尔）；天才的规则不可言明、不可传授（康德）。可显式化的交给框架，不可显式化的，交还给选择。

### 四工序 · 四层架构

| 工序 | 阶段 | 一句话 |
|---|---|---|
| **斋** | 守（L0） | 删掉一切毁真之物——合规工厂、负面清单、表演动机 |
| **观** | 工（L1） | 入传统之山林，观其天性——范文、质感、声线锚 |
| **合** | 灵（L2） | 以天合天——合魂、养气、灵感装置 |
| **显** | 神（L3） | 加手焉——选择显影、豁免、指纹，真动于外 |

完整哲学条款见 [docs/01-需求框架.md](docs/01-需求框架.md) §4。

## 设计一页看懂

- **单模型自由执笔**：读前文、定走向、写完整章、全文回看都由当前会话一个创作主体完成，无执行层下发、无逐 beat 验收；
- **示范 > 规则**：声线学《隐杀》锚包原文（节奏、气口、叙述距离、心理密度），不背风格参数卡；
- **写作知识只六条**：先给人再给事 / 事件服务人的选择 / 叙述者在场 / 心理直接写 / 配角各带算盘 / 结尾不收判词；
- **工程零门**：无检查链、无发布机、无候选隔离、无字数硬门——CI 只测纯工程事项（文件存在、部署成功）；
- **唯一验收门**：用户直读。框架规则变更一律盲写对照后交用户盲验，未盲验不合入。

## 文档索引

| 文档 | 内容 |
|---|---|
| [docs/质量极简流与隐杀声线锚技术规格_20260928.md](docs/质量极简流与隐杀声线锚技术规格_20260928.md) | **现行生效规格**：五步极简流、隐杀声线锚协议、六条写作知识、删除/停用清单、盲验纪律（与此前规格冲突处以本文为准） |
| [docs/01-需求框架.md](docs/01-需求框架.md) | 魂与哲学总纲（§4）、诊断、架构、核心机制 |
| [docs/02-落地计划.md](docs/02-落地计划.md) | 四阶段任务与验收、Arena 协议、风险清单 |
| [docs/03-资产盘点.md](docs/03-资产盘点.md) | 上游资产继承清单与重铸状态 |
| docs/04–12 | 历史整改计划与复盘（留痕；与新规格冲突处以极简流规格为准） |

## 路线图（守 → 工 → 灵 → 显）

| 阶段 | 目标 | 状态 |
|------|------|------|
| 一 · 守（斋） | 底线保全 + 换地基：瘦身 SKILL.md、检查脚本迁移、基准场景 | ✅ |
| 二 · 工（观） | 产出不生硬：范文教学、声线锚、五步极简流 | ✅ 2026-09-28 |
| 三 · 灵（合） | 有灵气：灵感装置、质感拆解、类型魂谱 | 🔜 接口已预留 |
| 四 · 显（神） | 有人味有辨识度：多源质感合成、口述采集、十年测试 | 规划中 |

每阶段一场 Arena 擂台（[arena/](arena/)），胜者成为新基线。

## 致谢与许可

上游方法论资产来自 [worldwonderer/oh-story-claudecode](https://github.com/worldwonderer/oh-story-claudecode)（随其原许可分发）；隐笔新增文档与机制为本项目原创。`references/exemplars/` 内范文切片与声线锚包（仓库外）仅供私用模仿节奏，请勿公开分发。

---

*修订术语或哲学条款请同步 docs/01-需求框架.md · 哲学条款与操作化身成对出生（见 docs/01 §4.4）*
