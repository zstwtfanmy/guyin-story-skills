---
name: guyin-setup
version: 0.8.0
description: "隐笔项目脚手架部署。把长篇/短篇项目模板（三端执行层部署件 + 硬护栏 hook + 双台账 + 作者性）部署到当前目录；模板随本技能分发，无需克隆仓库。触发方式：/guyin-setup、$guyin-setup、「准备写书」「搭环境」「建项目」「初始化写作项目」。"
---
# guyin-setup：隐笔项目部署器

> 模板住在技能里：skills 装到哪，模板跟到哪。本技能只管部署，不管写作——写书进 guyin-write。

**铁律：不覆盖用户已有内容。部署件才 replace，用户内容一律 create-if-absent。**

## Phase 0：自检模板完整性（先于一切）

以正在执行的本 `SKILL.md` 所在目录为锚，核对同级 `templates/`：

1. `templates/long/`：`AGENTS.md`、`README.md`、`.claude/settings.json`、`.claude/hooks/guyin-hook.js`、`.claude/agents/guyin-beat-writer.md`、`.claude/agents/guyin-checker.md`、`.codex/agents/guyin-beat-writer.toml`、`.codex/agents/guyin-checker.toml`、`.opencode/agents/guyin-beat-writer.md`、`.opencode/agents/guyin-checker.md`、`.opencode/commands/guyin.md`、`作者性/` 九件（含可选骨架 语言纪律.md 与 纪律冲突台账.md，Fw-04）、`大纲/README.md`、`大纲/魂谱对表.md`、`大纲/执行层一页纸.md`（可选骨架，Fw-04）、`设定/题材定位.md`（书级题材/读者契约骨架，v3-A3）、`追踪/_tracking-state.json`、`追踪/读者信号.md`（E1 验收检查点门输入：检查点节＋14 列试读记录表）、`追踪/待审台账.md`（U1 待审阻断门）
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
| 执行层部署件 | `.claude/agents/`、`.claude/hooks/`、`.codex/`、`.opencode/` | 同名路径 | **replace**（可安全覆盖），但重部署必须先执行下方「重部署保护」——不得盲目覆盖 |
| hook 注册 | `.claude/settings.json` | `.claude/settings.json` | 缺失→直接复制；已存在→`node {本技能目录}/scripts/merge-claude-settings.js --template {源} --target {目标}` 确定性合并 |
| 路由表 | `AGENTS.md` | `AGENTS.md` | **create-if-absent**；写入前把首行 `{书名}` 占位符替换为实际书名；重部署不覆盖 |
| 用户内容 | `作者性/`、`追踪/`、`大纲/`、`正文/`、`设定/`、`灵感池/`、`README.md` | 同名路径 | **create-if-absent**（已存在跳过，报告中列出） |
| 短篇 delta | `templates/short/大纲/` 三件 | `大纲/` | 选短篇时叠加，create-if-absent |
| 部署标记 | — | `.guyin-deployed` | replace，写：`deployed_at`（UTC ISO）/ `guyin_version` / `form`（long 或 long+short） |

- 复制用宿主原生能力（PowerShell `Copy-Item -Recurse -Force` / bash `cp -r`）；create-if-absent 逐项判断，目标存在即跳过；
- **短篇 = 长篇打底 + delta 叠加**：文件状态分层、双台账、方向层全沿用长篇；短篇豁免限额每篇 ≤1 处（见 guyin-short-write）；
- 中途因权限/工具失败 → 直接从头重跑本 Phase，策略保证幂等。

### 重部署保护（v0.8.0：先出差异，保护 model / provider / 路由 / 自定义）

重新部署替换执行层文件**之前**，逐个读取项目里的旧部署件：

1. **提取并暂存用户配置**：非注释生效的 `model:` / `model =` 行（.claude/.opencode/.codex 三端分别提取，含 provider 前缀）；`.claude/settings.json` 里 guyin 之外的 hooks 与其他键；agents 文件里模板没有的自定义段（自定义工具、permission、steps、路由）。
2. **先出差异再动手**：报告列三栏——将刷新（模板新版本文件）/ 将保留（用户内容，create-if-absent 跳过项与 settings 自定义键）/ **检测到自定义需确认**（模板没有的部署件或大段自定义）；有来源不明的部署件**不盲目 replace**，AskUserQuestion 让用户选保留/替换/另存后替换。
3. **替换后回填**：把第 1 步暂存的 model/provider 行按原锚点注回新文件（追加在模板 model 注释样例旁，保持非注释生效）；settings 仍走 merge 脚本。
4. **备份**：被替换的旧部署件先复制到项目 `.guyin/upgrade-backup/{UTC日期}/`（含一份 `MANIFEST.txt`：原文件→新框架版本→回填项），再写入新件；原小说内容与 `作者性/`、`追踪/`、`大纲/`、`正文/` 一律不迁移、不改写。

### 旧项目升级（schema / 台账 / 框架维护段，不靠双套规则长期并存）

create-if-absent 不会更新已存在的追踪文件——重部署后必须做一次版本体检，按下列口径输出「待升级清单」，**只报告与给步骤，不自动重写用户台账**（用户确认后逐项手动升级，脚本对旧格式给 editorial 提示，不静默双轨）：

- `追踪/读者信号.md`：无「## 验收检查点」节或试读记录表为 13 列旧表 → 待升级（E1：旧行保留不冒充新验收，新表 14 列带来源列，操作以现行模板为准）；
- `追踪/待审台账.md` 缺失 → 待补（U1 门依赖）；
- `追踪/_tracking-state.json`：字段形状落后（无发布五阶段/revision 状态位）→ 待升级，先备份再用 `guyin-tracking-commit.py check` 按其现行迁移口径处理，报告实际状态机版本；
- `追踪/_publication.json`：存在但非 complete → 不属于升级，按在途发布走 `recover`；
- `AGENTS.md` / `README.md` 为 create-if-absent：旧项目不覆盖；框架维护段（不变式）更新只把新增条目（D2 隔离发布 / E1 验收检查点）作为**建议补丁**展示给用户，由用户确认后追加。

升级完成后在报告里写明：实际加载路径（全局 skills / 项目 `.agents`/`.claude` / 手动复制）、guyin_version、三端执行层各自的 model 实测值或「等同 solo」、未测宿主。

## Phase 3：验证与报告

1. 核对落位：Phase 0 清单在目标目录全部存在（create-if-absent 跳过项除外）；
2. **执行层就绪自检（Fw-03）**：机械扫描三端 agent 文件的 model 配置——`.claude/agents/guyin-*.md` 与 `.opencode/agents/guyin-*.md` 看非注释行的 `model:`、`.codex/agents/guyin-*.toml` 看非注释 `model =`：
   - 全部未配置（模板默认即如此：model 行已注释/不预置）→ 报告中必须明确写出：**「执行层当前等同 solo——guyin-write 写作时按『执行层调用协议』solo 三条走（允许直写卡可选/笔法只取规格行/逐章留痕）」**，不得让用户误以为编排/执行已分层；
   - 已配置 → 逐端列出实际 model 值，提示新开会话生效；
3. 报告输出：
   - 已部署 / 已跳过（用户内容）文件清单；重部署时另列：检测到的自定义项与用户处置、model/provider 回填结果、备份目录 `.guyin/upgrade-backup/{日期}/`、旧项目「待升级清单」；
   - **执行层低模型配置**（编排/执行分离的关键；model 写法见下表，改完重跑本自检确认非注释行生效）：

   | 端 | 部署件 | model 写法 |
   |----|--------|-----------|
   | OpenCode | `.opencode/agents/guyin-{beat-writer,checker}.md` | `model: provider/model-id`（模板内注释样例，取消注释改值） |
   | Claude Code | `.claude/agents/guyin-{beat-writer,checker}.md` | 加一行 `model: <低模型 ID>`（模板默认不预置） |
   | Codex | `.codex/agents/guyin-{beat-writer,checker}.toml` | 视版本支持取消注释 `model =`；不支持/未配即 solo（toml 注释列了三种确认征候） |

   - Claude Code 端 hook 已随 settings.json 注册，**新开会话生效**；Codex custom agent 亦须新开会话；
   - 下一步：说「开书」进 guyin-write（停在细纲交付），或「写短篇」进 guyin-short-write（停在骨架交付）。

## 边界

- 只部署不动笔：作者性四件的逐件口述引导在 guyin-write 开书流程，不在本技能；
- 不做：扫榜/封面/逆向导入（预留方向）；ZCode / OpenClaw 等其他端适配；
- Web AI / 无 subagent 宿主：部署同样成立，写作时自动降级 solo（AGENTS.md 已约定 fallback）。
