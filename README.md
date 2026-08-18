# 隐笔（guyin-skills）

> 笔不造文，隐术显天。
> 作品不是造出来的，是合出来的——作者之天合万物之天，框架的职责不是造文，是**不挡光**。

隐笔是基于 [oh-story-claudecode](https://github.com/worldwonderer/oh-story-claudecode) 资产重铸的网文写作技能包：换地基而非修补——编排/执行分离、任务卡驱动低模型、范文教学替代参数化文风卡、豁免机制保护神来之笔。所有技能以 **guyin-** 前缀命名，与原技能零重名。

## 技能清单

| 技能 | 触发 | 职责 |
|------|------|------|
| **guyin-story** | `/guyin`、`/隐笔`、「我想写小说」 | 主入口：路由 + 项目状态诊断 |
| **guyin-write** | `/guyin-write`、「开书」「写第X章」「日更」「回炉」 | 长篇写作编排层：beat 任务卡循环 + 检查 + 台账 |
| **guyin-short-write** | `/guyin-short-write`、「写短篇」「盐言故事」 | 短篇写作编排层：骨架三件（情节节点/情绪曲线/反转表） |
| **guyin-analyze** | `/guyin-analyze`、「拆这本书」 | 长篇拆文管道（质感拆解/类型魂谱接口已预留） |
| **guyin-short-analyze** | `/guyin-short-analyze`、「拆短篇」 | 短篇拆文全量管道：故事核/情感线/反转设计/共鸣 |
| **guyin-review** | `/guyin-review`、「审查」「这章怎么样」 | 对抗式审查：只诊断不动刀，输出 L1/L2/L3 接大修 |
| **guyin-deslop** | `/guyin-deslop`、「去AI味」 | lint 确定性错误 + 陌生化段落改写 |

## 安装（Codex / OpenCode / Claude Code 三端兼容）

> 一等公民：**Codex** 与 **OpenCode**；Claude Code 同样可用。三端的执行层部署件已内置在 [项目模板/](项目模板/)（AGENTS.md 路由 + `.claude/` `.codex/` `.opencode/` 三份 beat-writer），**复制模板即完成项目侧配置**。

### 第一步：克隆与建项目（PowerShell 示例，bash 同理）

```powershell
git clone git@github.com:zstwtfanmy/guyin-story-skills.git D:\guyin-skills
mkdir D:\books\我的书; cd D:\books\我的书
Copy-Item -Recurse D:\guyin-skills\项目模板\* .     # 写短篇再叠加 项目模板-短篇\
```

### 第二步：装技能（按 CLI 三选一，可多端并存）

**OpenCode**（项目内 `skills/`，原生发现）与 **Codex**（项目内 `.codex/skills/`）：

```powershell
Copy-Item -Recurse D:\guyin-skills\skills\guyin-story, D:\guyin-skills\skills\guyin-write, `
  D:\guyin-skills\skills\guyin-short-write, D:\guyin-skills\skills\guyin-analyze, `
  D:\guyin-skills\skills\guyin-short-analyze, D:\guyin-skills\skills\guyin-review, `
  D:\guyin-skills\skills\guyin-deslop .\skills\        # OpenCode
Copy-Item -Recurse D:\guyin-skills\skills\guyin-* .\.codex\skills\   # Codex
```

> **OpenCode 本体与两个坑**：未装时 `npm install -g opencode-ai`（或 `scoop install opencode`），首次用 `opencode auth login` 配 provider（编排层强模型 + 执行层 DeepSeek）。坑 1：npm 全局装完命令不识别，用 `npm config get prefix` 查路径并确认其在 PATH；坑 2：进项目后**不要跑 `/init`**——模板已自带路由版 AGENTS.md，`/init` 会覆盖它。

**Claude Code**（全局 `$HOME\.claude\skills\` 或项目 `.claude/skills/`）：

```powershell
Copy-Item -Recurse D:\guyin-skills\skills\guyin-* $HOME\.claude\skills\
```

### 第三步：执行层低模型（编排/执行分离的关键）

编辑项目内对应部署件的 model 字段（三份都已随模板就位）：

| 端 | 部署件 | model 写法 |
|----|--------|-----------|
| OpenCode | `.opencode/agents/guyin-beat-writer.md` | `model: deepseek/deepseek-chat`（provider/model-id） |
| Claude Code | `.claude/agents/guyin-beat-writer.md` | `model: <低模型>` |
| Codex | `.codex/agents/guyin-beat-writer.toml` | 视当前版本支持情况启用 `model =` 字段；不支持时执行层随主会话模型运行（solo 档），AGENTS.md 已内置降级约定 |

Codex 的 custom agent 新开会话后生效。无 subagent 环境自动降级 solo 模式（guyin-write 会先声明）。

### 第四步：开书

在项目根对 AI 说「开书」（或 `$guyin-write` / `/guyin-write`）→ Phase A/B/C **停在细纲交付**；Phase B 会按 [作者性引导协议](skills/guyin-write/references/作者性引导.md) 逐件口述定四件（不在场则默认档运行、写作中持续提示）→ 说「写第 1 章」进入写章循环。

## 仓库结构

```
skills/          七个 guyin- 技能（cards/ 四卡模板、exemplars/ 范文库 10+1 题材默认弹药、作者性引导协议、consult/ 咨询库、scripts/ 检查脚本）
arena/           擂台：3 个固定基准场景 + 对战记录
项目模板/        长篇脚手架：文件状态分层 + 双台账 + 灵感池 + 作者性五件 + AGENTS.md 路由 + .claude/.codex/.opencode 三端执行层部署件
项目模板-短篇/   短篇 delta：内涵三件（情节节点/情绪曲线/反转表）叠加项目模板
docs/            框架之魂与设计文档（README / 01-需求框架 / 02-落地计划 / 03-资产盘点）
```

## 设计一页看懂

- **编排/执行分离**：主会话（强模型）拆任务组装任务卡；低模型执行层只见一张卡，填空式写作，永不见全局；
- **四卡体系**：写作卡 / 自检卡 / 发散卡 / 改写卡——每卡 <500 token，内嵌约束与范文，卡尾复述禁令；
- **范文教学**：范文切片取代 32 张参数化腔调卡；上一章结尾 300 字原文贴卡保声线连续；
- **写-读-改回路**：beat 化写作 + 是非题自检 + 段落级定向改写（分级控成本），取代一次成稿；
- **豁免机制**：checker 报警永不自动删，五测试审判，每卷 ≤2 处——神来之笔是世界自生长的生殖道；
- **铁律**：气卡永不下发任务卡；哲学词汇零进卡片，只以卡片结构在场。

完整哲学（以天合天 / 合问 / 魂×皮 / 气的三栖息地）见 [docs/README.md](docs/README.md)。

## 路线图（守 → 工 → 灵 → 显）

| 阶段 | 目标 | 状态 |
|------|------|------|
| 一 · 守（斋） | 底线保全 + 换地基：瘦身 SKILL.md、四卡体系、检查脚本迁移、基准场景 | ✅ v0.1 |
| 二 · 工（观） | 产出不生硬：范文教学、声线连续、重写回路、两遍生成 | ✅ v0.1 |
| 三 · 灵（合） | 有灵气：六灵感装置、Craft/Muse 全量启用、质感拆解、类型魂谱、气卡全机制 | 🔜 接口已预留 |
| 四 · 显（神） | 有人味有辨识度：多源质感合成、口述采集、十年测试、封神测试 | 规划中 |

每阶段一场 Arena 擂台（[arena/](arena/)），胜者成为新基线。

## 致谢与许可

上游方法论资产来自 [worldwonderer/oh-story-claudecode](https://github.com/worldwonderer/oh-story-claudecode)（随其原许可分发）；隐笔新增文档与机制为本项目原创。`references/exemplars/` 内范文切片仅供私用模仿节奏，请勿公开分发。
