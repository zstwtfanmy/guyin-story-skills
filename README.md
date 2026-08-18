# 隐笔（guyin-skills）

> 笔不造文，隐术显天。
> 作品不是造出来的，是合出来的——作者之天合万物之天，框架的职责不是造文，是**不挡光**。

隐笔是基于 [oh-story-claudecode](https://github.com/worldwonderer/oh-story-claudecode) 资产重铸的网文写作技能包：换地基而非修补——编排/执行分离、任务卡驱动低模型、范文教学替代参数化文风卡、豁免机制保护神来之笔。所有技能以 **guyin-** 前缀命名，与原技能零重名。

## 技能清单

| 技能 | 触发 | 职责 |
|------|------|------|
| **guyin-story** | `/guyin`、`/隐笔`、「我想写小说」 | 主入口：路由 + 项目状态诊断 |
| **guyin-write** | `/guyin-write`、「开书」「写第X章」「日更」「回炉」 | 写作编排层：beat 任务卡循环 + 检查 + 台账 |
| **guyin-analyze** | `/guyin-analyze`、「拆这本书」 | 拆文管道（质感拆解/类型魂谱接口已预留） |
| **guyin-deslop** | `/guyin-deslop`、「去AI味」 | lint 确定性错误 + 陌生化段落改写 |

## 安装（Claude Code 兼容环境）

```bash
git clone <本仓库地址> ~/guyin-skills
# 方式一：软链（推荐，随仓库更新）
ln -s ~/guyin-skills/skills/guyin-story   ~/.claude/skills/guyin-story
ln -s ~/guyin-skills/skills/guyin-write   ~/.claude/skills/guyin-write
ln -s ~/guyin-skills/skills/guyin-analyze ~/.claude/skills/guyin-analyze
ln -s ~/guyin-skills/skills/guyin-deslop  ~/.claude/skills/guyin-deslop
# 方式二：直接复制四个技能目录到 ~/.claude/skills/
```

**执行层配置**（编排/执行分离的关键）：把 [skills/guyin-write/agents/guyin-beat-writer.md](skills/guyin-write/agents/guyin-beat-writer.md) 复制到项目 `.claude/agents/` 并把 `model` 指向低模型（如 deepseek-flash）。无 subagent 环境自动降级 solo 模式（guyin-write 会声明）。

**开书第一步**：把 [项目模板/](项目模板/) 复制到你的写作项目根目录，然后对 AI 说「开书」。

## 仓库结构

```
skills/          四个 guyin- 技能（含 cards/ 四卡模板、exemplars/ 范文库、consult/ 方法论咨询库、scripts/ 检查脚本）
arena/           擂台：3 个固定基准场景 + 对战记录
项目模板/        写作项目脚手架（文件状态分层 + 双台账 + 灵感池 + 作者性五件）
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
