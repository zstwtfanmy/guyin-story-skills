---
name: guyin-setup
version: 0.7.0
description: "隐笔项目脚手架部署。把长篇/短篇项目模板（三端执行层部署件 + 硬护栏 hook + 双台账 + 作者性）部署到当前目录；模板随本技能分发，无需克隆仓库。触发方式：/guyin-setup、$guyin-setup、「准备写书」「搭环境」「建项目」「初始化写作项目」。"
---
# guyin-setup：隐笔项目部署器

> 模板住在技能里：skills 装到哪，模板跟到哪。本技能只管部署，不管写作——写书进 guyin-write。

**铁律：不覆盖用户已有内容。部署件才 replace，用户内容一律 create-if-absent。**

## Phase 0：自检模板完整性（先于一切）

以正在执行的本 `SKILL.md` 所在目录为锚，核对同级 `templates/`：

1. `templates/long/`：`AGENTS.md`、`README.md`、`.claude/settings.json`、`.claude/hooks/guyin-hook.js`、`.claude/agents/guyin-beat-writer.md`、`.claude/agents/guyin-checker.md`、`.codex/agents/guyin-beat-writer.toml`、`.codex/agents/guyin-checker.toml`、`.opencode/agents/guyin-beat-writer.md`、`.opencode/agents/guyin-checker.md`、`.opencode/commands/guyin.md`、`作者性/` 七件、`大纲/README.md`、`大纲/魂谱对表.md`、`追踪/_tracking-state.json`
2. `templates/short/大纲/`：情节节点 / 情绪曲线 / 反转表 三件

任一缺失 → **立即停止，不写任何部署文件**，报告缺哪些（区分「缺文件」与「目录为空」），给修复指令：「guyin-setup 模板包不完整，缺 {文件}。按你的安装方式重装 guyin-story-skills（skills CLI 装的重跑 `npx skills add https://github.com/zstwtfanmy/guyin-story-skills -g`；手动复制的重新复制 skills/ 目录），再执行 /guyin-setup。」

## Phase 1：检测项目状态

1. 当前目录存在 `.guyin-deployed` → AskUserQuestion 是否重新部署（说明：重新部署只刷新部署件，create-if-absent 的用户内容不会被覆盖）
2. 无标记但已有写作结构（`作者性/`、`追踪/`、`大纲/` 任一存在）→ AskUserQuestion：补部署（缺啥补啥）/ 跳过
3. 空目录或无写作结构 → 直接进入选择
4. AskUserQuestion：**长篇 / 短篇（长篇+delta 叠加）/ 双线都要**，以及**书名**（未给则用当前目录名）

## Phase 2：幂等部署

| 类别 | 源（templates/long/ 下） | 目标（项目根） | 策略 |
|------|------|------|------|
| 执行层部署件 | `.claude/agents/`、`.claude/hooks/`、`.codex/`、`.opencode/` | 同名路径 | **replace**（可安全覆盖） |
| hook 注册 | `.claude/settings.json` | `.claude/settings.json` | 缺失→直接复制；已存在→`node {本技能目录}/scripts/merge-claude-settings.js --template {源} --target {目标}` 确定性合并 |
| 路由表 | `AGENTS.md` | `AGENTS.md` | **create-if-absent**；写入前把首行 `{书名}` 占位符替换为实际书名；重部署不覆盖 |
| 用户内容 | `作者性/`、`追踪/`、`大纲/`、`正文/`、`设定/`、`灵感池/`、`README.md` | 同名路径 | **create-if-absent**（已存在跳过，报告中列出） |
| 短篇 delta | `templates/short/大纲/` 三件 | `大纲/` | 选短篇时叠加，create-if-absent |
| 部署标记 | — | `.guyin-deployed` | replace，写：`deployed_at`（UTC ISO）/ `guyin_version` / `form`（long 或 long+short） |

- 复制用宿主原生能力（PowerShell `Copy-Item -Recurse -Force` / bash `cp -r`）；create-if-absent 逐项判断，目标存在即跳过；
- **短篇 = 长篇打底 + delta 叠加**：文件状态分层、双台账、方向层全沿用长篇；短篇豁免限额每篇 ≤1 处（见 guyin-short-write）；
- 中途因权限/工具失败 → 直接从头重跑本 Phase，策略保证幂等。

## Phase 3：验证与报告

1. 核对落位：Phase 0 清单在目标目录全部存在（create-if-absent 跳过项除外）；
2. 报告输出：
   - 已部署 / 已跳过（用户内容）文件清单；
   - **执行层低模型配置**（编排/执行分离的关键，部署件已就位，按所用端改 model 字段）：

   | 端 | 部署件 | model 写法 |
   |----|--------|-----------|
   | OpenCode | `.opencode/agents/guyin-{beat-writer,checker}.md` | `model: deepseek/deepseek-chat`（provider/model-id） |
   | Claude Code | `.claude/agents/guyin-{beat-writer,checker}.md` | `model: <低模型>` |
   | Codex | `.codex/agents/guyin-{beat-writer,checker}.toml` | 视版本支持 `model =`；不支持则 solo 降级（AGENTS.md 已约定） |

   - Claude Code 端 hook 已随 settings.json 注册，**新开会话生效**；Codex custom agent 亦须新开会话；
   - 下一步：说「开书」进 guyin-write（停在细纲交付），或「写短篇」进 guyin-short-write（停在骨架交付）。

## 边界

- 只部署不动笔：作者性四件的逐件口述引导在 guyin-write 开书流程，不在本技能；
- 不做：扫榜/封面/逆向导入（预留方向）；ZCode / OpenClaw 等其他端适配；
- Web AI / 无 subagent 宿主：部署同样成立，写作时自动降级 solo（AGENTS.md 已约定 fallback）。
