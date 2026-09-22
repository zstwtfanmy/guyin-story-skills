---
name: guyin-setup
version: 0.9.0
description: "隐笔项目脚手架部署。把长篇/短篇项目模板（硬护栏 hook + 双台账 + 作者性可选素材）部署到当前目录；模板随本技能分发，无需克隆仓库。单模型自由执笔版：不分发 writer/checker 执行层 agent，不问内部模型。触发方式：/guyin-setup、$guyin-setup、「准备写书」「搭环境」「建项目」「初始化写作项目」。"
---
# guyin-setup：隐笔项目部署器

> 模板住在技能里：skills 装到哪，模板跟到哪。本技能只管部署，不管写作——写书进 guyin-write。

**铁律：不覆盖用户已有内容。部署件才 replace，用户内容一律 create-if-absent；不修改宿主全局设置。**

机械部署/退役一律走 `scripts/guyin-deploy.js`（非交互、JSON 输出、退出码语义），SKILL.md 只负责判断与报告，不手拼复制。

## Phase 0：自检模板完整性（先于一切）

以正在执行的本 `SKILL.md` 所在目录为锚，核对同级：

1. `scripts/guyin-deploy.js`、`scripts/merge-claude-settings.js` 存在；
2. `templates/long/`：`AGENTS.md`、`README.md`、`.claude/settings.json`、`.claude/hooks/guyin-hook.js`、`.opencode/commands/guyin.md`、`作者性/`、`大纲/README.md`、`大纲/魂谱对表.md`、`设定/题材定位.md`、`追踪/_tracking-state.json`、`追踪/读者信号.md`（验收检查点节＋14 列试读记录表）、`追踪/待审台账.md`；
3. `templates/short/大纲/`：情节节点 / 情绪曲线 / 反转表 三件；
4. `legacy/agents-v0.8/` 退役归档存在（旧项目受管 agent 识别的唯一字节依据）；
5. **反向检查：`templates/` 树内不得存在任何 `agents/guyin-beat-writer.*`、`agents/guyin-checker.*`**——新分发已无执行层 agent，发现即模板被污染，停止部署。

任一缺失/污染 → **立即停止，不写任何部署文件**，报告缺哪些（区分「缺文件」与「目录为空」），给修复指令：「guyin-setup 模板包不完整，缺 {文件}。按你的安装方式重装 guyin-story-skills（skills CLI 装的重跑 `npx skills add https://github.com/zstwtfanmy/guyin-story-skills -g`；手动复制的重新复制 skills/ 目录），再执行 /guyin-setup。」安装来源以 README 与本机锁记录共同确认的 `zstwtfanmy/guyin-story-skills` 为准，不运行来源不明的第三方安装代码。

## Phase 0.5：技能包完整性预检（F.3，安装/开写前）

模板自检只覆盖 setup 自身；写作链依赖的脚本、lib、运行参考与默认 profile 在 **guyin-write 技能包**里。安装后、首次开写前（或怀疑安装残缺/混版时）跑：

```
node {本技能目录}/scripts/guyin-check-package.js verify [--root {skills 根}]
```

- 以**真实加载的 SKILL.md realpath**锚定技能根，显式 `--root` 优先；不回退混找全局/旧项目目录（F.3.2）。
- 按固定版本清单 `scripts/package-manifest.json` 逐项核对相对路径与 sha256：缺件、损坏、混版分别报告实际路径并 exit 1；不报「29 个脚本」这种写死数，也不因锁最新就判完整。
- 同时检查 Node/Python 解释器真实路径与版本，并对全部 .js 做语法加载、对 .py 做编译加载；脚本不可加载同样 exit 1。
- 隔离夹具真实链路（长短篇起草→preview→发布/修订/恢复）是分层验收的下一层，在 R7 安装恢复时从**实际加载根**跑；本预检只证明文件完整与可加载，不冒充写作链路验收。

## Phase 1：检测项目状态

1. 当前目录存在 `.guyin-deployed` → AskUserQuestion 是否重新部署（重新部署只刷新部署件，create-if-absent 的用户内容不会被覆盖）；
2. 无标记但已有写作结构（`作者性/`、`追踪/`、`大纲/` 任一存在）→ AskUserQuestion：补部署（缺啥补啥）/ 跳过；
3. 空目录或无写作结构 → 直接进入选择；
4. AskUserQuestion：**长篇 / 长篇+短篇 delta / 双线都要**，以及**书名**（未给则用当前目录名）。

全程不问内部模型、不扫 model/provider、不要求填写任何执行层配置。

## Phase 2：幂等部署（install）

执行：

```
node {本技能目录}/scripts/guyin-deploy.js install --dest {书根} --kind long|long+short --title {书名}
```

脚本策略（与旧版一致，但分发清单中不再有 agents）：

| 类别 | 内容 | 策略 |
|------|------|------|
| 部署件（replace） | `.claude/hooks/guyin-hook.js`、`.opencode/commands/guyin.md` | 可安全刷新；重跑幂等 |
| hook 注册 | `.claude/settings.json` | 缺失直接复制；已存在走 `merge-claude-settings.js` 确定性合并，保留用户其他 hooks/键 |
| 路由表 | `AGENTS.md` | create-if-absent；首行 `{书名}` 占位符替换为实际书名 |
| 用户内容 | `作者性/`、`追踪/`、`大纲/`、`正文/`、`设定/`、`灵感池/`、`README.md` | create-if-absent（已存在跳过，报告列出） |
| 短篇 delta | `templates/short/大纲/` 三件 | 选 long+short 时叠加，create-if-absent |
| 部署标记 | `.guyin-deployed` | 写 deployed_at / guyin_version=0.9.0 / form / distribution=single-model-free-write |

- **短篇 = 长篇打底 + delta 叠加**：文件状态分层、双台账、方向层全沿用长篇；短篇豁免限额每篇 ≤1 处（见 guyin-short-write）；
- 中途因权限/工具失败 → 直接重跑同一命令，策略保证幂等。

### 重部署保护（v0.9.0：不探测模型配置，只刷新部署件，保护自定义）

v0.8.0 的「提取 model/provider 行→替换→再注回」流程**已删除**：新框架不分发执行层 agent，也不选择模型。重部署时：

1. 刷新只动脚本内 REPLACE 清单（hook / opencode command）与 settings 合并；用户 agents（含自定义 subagent）、作者性/追踪/大纲/正文一律不碰；
2. 不再扫描、暂存、注回任何 `model:` / `model =` 行——用户自配 agent 的模型设置原样留在用户文件里；
3. 不盲目 replace 任何来源不明文件（脚本白名单之外的路径根本不进 replace 集）。

### 旧项目升级：受管 agent 退役（预览 → 批准 → 备份 → 删）

v0.8 及更早部署过三端受管 agent（`.claude/.opencode/.codex` 下的 guyin-beat-writer / guyin-checker）。v0.9 起职责已被当前会话吸收，**新分发不含它们；旧项目不自动删**，按下列流程：

1. **出预览**（只读，绝不改文件）：
   ```
   node {本技能目录}/scripts/guyin-deploy.js preview --dest {书根}
   ```
   输出三类：`managed_retire`（字节与 `legacy/agents-v0.8/` 归档一致＝受管）、`custom_same_name`（同名但字节不符＝用户改过/来源不明）、`unknown_agents`（agents 目录里的其他文件）。
2. **向用户呈报预览**：路径 / 归类 / 建议（受管→备份后退役；自定义与未知→保留）。只处理用户**明确批准**的受管路径：
   ```
   node {本技能目录}/scripts/guyin-deploy.js retire --dest {书根} --approve {rel,rel,...}
   ```
   每个文件先复制到 `.guyin/upgrade-backup/{UTC日期}/`（附 `MANIFEST.txt`：原路径＋sha256），再删除；空 agents 目录一并清掉，不留空壳。
3. **自定义/来源不明永不自动删**：批准清单里混入 custom_same_name 时脚本直接拒绝（exit 2），须人工核对来源后由用户自行处置。
4. **重复迁移无额外损失**：retire 幂等——已退役项跳过且不重复备份；`.guyin/upgrade-progress.json` 记录已退役清单，可随时 `status` 对账。
5. **中断与源码更新（哈希重核）**：进度账本分 `source_hash`（受管归档字节指纹）。实施中断后若技能已更新、归档字节与账本不符，retire 拒绝照旧账本续跑（exit 4）——必须重新跑 preview 看实际现场，再带本次输出的 `--confirm-source {hash}` 续跑；账本损坏同样处理。**禁止凭旧账本声称「已全部退役」**，一切以实际文件扫描为准。

### 旧项目升级（schema / 台账）

create-if-absent 不会更新已存在的追踪文件——重部署后做一次版本体检，按下列口径输出「待升级清单」，**只报告与给步骤，不自动重写用户台账**：

- `追踪/读者信号.md`：无「## 验收检查点」节或试读记录表为 13 列旧表 → 待升级（旧行保留不冒充新验收，新表 14 列带来源列）；
- `追踪/待审台账.md` 缺失 → 待补（U1 门依赖）；
- `追踪/_tracking-state.json`：字段形状落后（无发布五阶段/revision 状态位）→ 待升级，先备份再用 `guyin-tracking-commit.py check` 按其现行迁移口径处理，报告实际状态机版本；
- `追踪/_publication.json`：存在但非 complete → 不属于升级，按在途发布走 `recover`（恢复顺序：先 recover 清在途发布，再体检台账，最后才考虑 agent 退役）；
- `AGENTS.md` / `README.md` 为 create-if-absent：旧项目不覆盖；框架维护段（不变式）更新只把新增条目（D2 隔离发布 / E1 验收检查点 / 单模型自由执笔）作为**建议补丁**展示，由用户确认后追加。

升级完成后报告：实际加载路径（全局 skills / 项目 `.agents`·`.claude` / 手动复制）、guyin_version、受管 agent 预览与退役结果、待升级清单；不报告各端执行层模型配置（框架不管理模型）。书级文风 profile 路由见 guyin-write：开书 input 冻结 profile ID/版本，库升级不换声线。

## Phase 3：验证与报告

1. 跑 `node {本技能目录}/scripts/guyin-deploy.js status --dest {书根}`：确认部署标记、managed_remaining 与退役账本一致（无 drift_returns、无 ledger_stale）；
2. 核对落位：Phase 0 清单在目标目录全部存在（create-if-absent 跳过项除外），且书根三端均无**新分发的**受管 agent；
3. Claude Code 端 hook 已随 settings.json 注册，**新开会话生效**；Codex / OpenCode 读 `AGENTS.md` 路由；Web AI / 无 hook 宿主纪律照样成立（fail-open）；
4. 报告输出：已部署 / 已跳过（用户内容）/ 已刷新部署件清单；旧项目另列：受管 agent 预览与用户处置、备份目录、待升级清单；
5. 下一步：说「开书」进 guyin-write（无完整细纲也可先试写，试写停 ready），或「写短篇」进 guyin-short-write（停在骨架交付）。

## 边界

- 只部署不动笔：作者性素材的逐件口述引导在 guyin-write 开书流程，不在本技能；
- `guyin-deploy.js` 的 preview/retire 只管**受管 agent**，不是全技能包差异预览，也不是安装修复器：包缺件/混版以 Phase 0.5 的 package-manifest 核对为准；install 会刷新 hook/command 并合并 settings，对活书部署要先列差异、获用户授权再动；
- 不做：扫榜/封面/逆向导入（预留方向）；ZCode / OpenClaw 等其他端适配；探测或注回模型配置；删除用户自定义 agent；修改宿主全局设置；
- Web AI / 无 subagent 宿主：部署同样成立，当前会话直接按单模型自由执笔工作。
