# 写作项目模板

> 本目录由 guyin-setup 技能持有——skills 装到哪，模板跟到哪。部署双路径：①对 AI 说「准备写书」或 /guyin-setup（推荐，幂等、不覆盖已有内容）；②手动把本目录（skills/guyin-setup/templates/long/）整体复制到新项目根，写短篇再叠加 templates/short/ 的内涵三件。文件状态分层是低模型的生命线——每步落盘，下一步读盘。部署模板即同时得到 Codex / OpenCode / Claude Code 三端部署件，不用哪端删哪端，互不影响。

## 目录结构与职责

```
AGENTS.md          Codex / OpenCode 读根路由表 + 五条项目不变式
.claude/agents/    guyin-beat-writer 执行层部署件（Claude Code 用）
.claude/hooks/     隐笔硬护栏 hook 核（guyin-hook.js，node 单文件，跨平台）
.claude/settings.json  Claude Code hook 注册（写前守卫 / 写后兜底 / 会话恢复）
.codex/agents/     guyin-beat-writer 执行层部署件（Codex 用，TOML）
.opencode/agents/  guyin-beat-writer 执行层部署件（OpenCode 用）
设定/世界观/      世界规则（一次写成，长期只读）
设定/角色/        每角色一卡：身份/行当/目标/关系/知识边界/自我叙事/行为铁律/说话习惯
大纲/             卷纲_第X卷.md + 细纲_第XXX章.md（beat 的事件来源）+ 魂谱对表.md（开书 Phase B 选题）
正文/             第XXX章_标题.md（beat 拼接产物，落盘即提交追踪）
追踪/             状态权威层：伏笔.md / 上下文.md / 契约对账矩阵.md / 读者信号.md / _tracking-state.json / 时间线/ / 角色状态/
                  隐笔双台账：灵感台账.md / 豁免台账.md；短语黑名单.md（tic 词表，ai-patterns 章检读）
灵感池/           口述采集落点（作者私货；只注入不强插）
作者性/           指纹.md / 偏执点.md / 魂档案.md / 气卡.md / 粒度配置.md / 参考-气质谱系.md / 口述定稿单.md
```

## 谁读什么（关键边界）

| 文件 | 读者 | 说明 |
|------|------|------|
| 作者性/ 全部 | **仅编排层** | 气卡永不下发任务卡；指纹/偏执点以"抄录进卡片"的方式在场 |
| 追踪/ | 编排层 + 检查脚本 | 状态一切：每步落盘 |
| 灵感池/ | 编排层按需取 | 口述真经验自带不规则性，是人味指纹 |

## 命名约定

- 正文：`正文/第001章_标题.md`（三位章号补零，与检查脚本兼容）；
- 细纲：`大纲/细纲_第001章.md`；
- 角色卡：`设定/角色/{角色名}.md`。

## CLI 三端部署（复制模板即得）

执行层 subagent `guyin-beat-writer` 内置三份部署件，格式各自不同：

| 端 | 部署件 | 低模型改法 |
|----|--------|-----------|
| Claude Code | `.claude/agents/guyin-beat-writer.md` | 头注 `model:` 字段直接指定 |
| OpenCode | `.opencode/agents/guyin-beat-writer.md` | 头注 `model: provider/model-id` |
| Codex | `.codex/agents/guyin-beat-writer.toml` | TOML 内 `model` 为注释可选字段，不支持时与主会话同模型（AGENTS.md 已约定 solo 降级兜底） |

- Codex / OpenCode 启动时读根 `AGENTS.md` 获得技能路由表与不变式；Claude Code 无此约定也能照常工作；
- 装技能（skills/ 目录复制）见仓库根 `README.md` 安装节；模板只负责项目侧这一半。

## 硬护栏 hook（Claude Code 端）

部署模板即注册（`.claude/settings.json` + `.claude/hooks/guyin-hook.js`，node 调用，无需 bash）。项目里已有 `settings.json` 时，/guyin-setup 会用其 `scripts/merge-claude-settings.js` 把 hooks 节确定性合并进去（用户配置保留）；手动部署则把 hooks 节合并进去即可。

| 子命令 | 挂点 | 行为 |
|--------|------|------|
| `guard` | PreToolUse(Write\|Edit\|MultiEdit) | 阻断守卫（exit 2）：首建第 N 章缺细纲 / 追踪 state 缺失或落后 / 短篇骨架缺失，拦下并给补纲引导 |
| `post-write` | PostToolUse(Write\|Edit\|MultiEdit) | 兜底网（永不阻断）：落盘极短 / 章字数低于下限时注入提醒，防低模型漏跑章检 |
| `session` | SessionStart(startup\|resume\|compact) | 恢复注入：追踪/上下文.md 头部 + 提交进度；compact 后自动回到状态，无信息时完全静默 |

三条纪律（也是 hook 的设计红线，改 hook 前先读 `guyin-hook.js` 头注）：

1. **兜底不是替代**：hook 只做确定性信号（存在性 / schema / 字数 / 极短），毒句式等规则权威在 skills 的 guyin-check 系脚本；章检照跑。
2. **fail-open**：非隐笔项目、解析失败、任何不确定一律放行——宁可漏拦不可误伤；hook 是增强层，Codex / OpenCode / Web AI 宿主无 hook 时靠 `AGENTS.md` 与 SKILL.md 纪律照样成立。
3. **豁免权在台账**：细纲/骨架缺失没有豁免通道，只能补；章检报警的豁免一律走 `追踪/豁免台账.md`（五测试），hook 不认正文内标记。

## 短篇 delta（写短篇时叠加 templates/short/）

- 叠加内涵三件到 `大纲/`：`情节节点.md`（钩压给转收）、`情绪曲线.md`（强度 1-10 / 压给交替 / 峰值 / 落点）、`反转表.md`（位置/铺垫/揭示方式/信息差/兑现状态）——节点是骨头，曲线是血，反转是雷，三件交付 = 短篇的停靠点；
- 方向层沿用本模板轻量维护：`追踪/时间线/`（插叙/倒叙更需登记故事内时间）、`追踪/伏笔.md`（当篇回收，不留「下卷再说」）、双台账照旧（豁免限额每篇 ≤1 处）、`设定/角色/` 1-3 卡即可；
- 可留空的长篇件：`大纲/卷纲_*.md`、`追踪/角色状态/`（弧光单篇完成时角色卡内记一节足矣）。
