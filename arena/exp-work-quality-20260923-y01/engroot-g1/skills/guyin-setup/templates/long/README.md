# 写作项目模板

> 本目录由 guyin-setup 技能持有——skills 装到哪，模板跟到哪。部署双路径：①对 AI 说「准备写书」或 /guyin-setup（推荐，幂等、不覆盖已有内容；机械部署走 `scripts/guyin-deploy.js install`，全程非交互、不问模型）；②手动把本目录（skills/guyin-setup/templates/long/）整体复制到新项目根，写短篇再叠加 templates/short/ 的内涵三件。文件状态分层是创作连续性的生命线——每步落盘，下一步读盘。新分发不含 writer/checker 受管 agent：只有当前会话一个创作主体；hook 与设置随模板就位，不用的端放着互不影响。

## 目录结构与职责

```
AGENTS.md          Codex / OpenCode 读根路由表 + 项目不变式
.claude/hooks/     隐笔硬护栏 hook 核（guyin-hook.js，node 单文件，跨平台）
.claude/settings.json  Claude Code hook 注册（写前守卫 / 写后兜底 / 会话恢复）
.opencode/commands/ guyin 命令入口（OpenCode 用）
设定/世界观/      世界规则（一次写成，长期只读）
设定/角色/        每角色一卡：身份/行当/目标/关系/知识边界/自我叙事/行为铁律/说话习惯
大纲/             卷纲_第X卷.md + 细纲_第XXX章.md（前三组过门是工作假说，可被正文驱动修订）+ 魂谱对表.md（开书 Phase B 选题）
正文/             第XXX章_标题.md（完整章正文，经 publish 安装；大修现稿归档 _archive/）
.guyin/work/      隔离工作区：{run_id}/ 放候选正文＋发布事务/证据（非正式正文，D2）
追踪/             状态权威层：伏笔.md / 上下文.md / 契约对账矩阵.md / 读者信号.md / _tracking-state.json / 时间线/ / 角色状态/
                  台账：灵感台账.md / 豁免台账.md / 待审台账.md；短语黑名单.md（tic 词表，ai-patterns 章检读）
灵感池/           口述采集落点（作者私货；只注入不强插）
作者性/           指纹.md / 偏执点.md / 魂档案.md / 粒度配置.md / 参考-气质谱系.md / 口述定稿单.md（均可缺省）
```

## 谁读什么（关键边界）

| 文件 | 读者 | 说明 |
|------|------|------|
| 作者性/ 全部 | 当前会话按需读 | 可选素材，不提供不拦写；不用私人经历也能靠书级文风 profile 起笔 |
| 追踪/ | 当前会话 + 检查脚本 | 状态一切：每步落盘 |
| 灵感池/ | 当前会话按需取 | 口述真经验自带不规则性，是人味指纹 |

## 命名约定

- 正文：`正文/第001章_标题.md`（三位章号补零，与检查脚本兼容）；
- 细纲：`大纲/细纲_第001章.md`；
- 角色卡：`设定/角色/{角色名}.md`。

## 执行模型（单模型自由执笔）

- 不分发 `guyin-beat-writer` / `guyin-checker` 执行层 agent，框架也不选 model/provider：读前文、定走向、写完整章、全文回看都由当前会话完成；
- 写作卡（写作/改写/发散/自检/分诊/摘要）是按需辅助，没有默认下发与逐 beat 验收；
- 无完整细纲也可试写：试写只产隔离候选并停在 ready，进正式正文必须有显式发布授权；
- 旧项目里三端 agents/ 目录若有历史受管文件，guyin-setup 只出迁移预览，经确认后由 `guyin-deploy.js retire` 备份退役；同名自定义/来源不明文件一律保留，绝不自动删。
- Codex / OpenCode 启动时读根 `AGENTS.md` 获得技能路由表与不变式；装技能（skills/ 目录复制）见仓库根 `README.md` 安装节；模板只负责项目侧这一半。

## 硬护栏 hook（Claude Code 端）

部署模板即注册（`.claude/settings.json` + `.claude/hooks/guyin-hook.js`，node 调用，无需 bash）。项目里已有 `settings.json` 时，/guyin-setup 会用其 `scripts/merge-claude-settings.js` 把 hooks 节确定性合并进去（用户配置保留）；手动部署则把 hooks 节合并进去即可。

| 子命令 | 挂点 | 行为 |
|--------|------|------|
| `guard` | PreToolUse(Write\|Edit\|MultiEdit) | 阻断守卫（exit 2）：追踪 state 缺失或落后 / 短篇骨架缺失 / `追踪/_publication.json` 在途或损坏（D2 发布门：先 recover 再写）/ 覆盖保护，拦下并给引导；`.guyin/work/` 候选不触发守卫 |
| `post-write` | PostToolUse(Write\|Edit\|MultiEdit) | 兜底网（永不阻断）：落盘极短 / 章字数低于下限时注入提醒，防漏跑章检 |
| `session` | SessionStart(startup\|resume\|compact) | 恢复注入：追踪/上下文.md 头部 + 提交进度；compact 后自动回到状态，无信息时完全静默 |

三条纪律（也是 hook 的设计红线，改 hook 前先读 `guyin-hook.js` 头注）：

1. **兜底不是替代**：hook 只做确定性信号（存在性 / schema / 字数 / 极短），毒句式等规则权威在 skills 的 guyin-check 系检查脚本；章检照跑。
2. **fail-open**：非隐笔项目、解析失败、任何不确定一律放行——宁可漏拦不可误伤；hook 是增强层，Codex / OpenCode / Web AI 宿主无 hook 时靠 `AGENTS.md` 与 SKILL.md 纪律照样成立。
3. **豁免权在台账**：章检报警的豁免一律走 `追踪/豁免台账.md`（五测试），hook 不认正文内标记。

## 隔离发布与验收检查点（D2 / E1）

- **候选隔离**：写章（日更/大修/去味修订同）产物只落 `.guyin/work/{run_id}/` 下候选（drafts/vXXXX.md，旧称 candidate.md）＋发布事务与证据；章检对候选跑，修复改候选重跑。`guyin-tracking-commit.py publish` 是正式化唯一通道（安装正文→追踪事务→指纹持锁 `--commit --under-lock`→终验，机械串行）；中断只走 `recover`，不手改事务。
- **验收检查点**：新书默认前三章后停（ch004 起到点）；续写在 `追踪/读者信号.md` 的「验收检查点」表登记本次连续段；来源限用户验收/独立读者（模型审读不顶替人）；可「延期@第K章」顺延，但必须登记下一检查点，不静默豁免。

## 短篇 delta（写短篇时叠加 templates/short/）

- 叠加内涵三件到 `大纲/`：`情节节点.md`（钩压给转收）、`情绪曲线.md`（强度 1-10 / 压给交替 / 峰值 / 落点）、`反转表.md`（位置/铺垫/揭示方式/信息差/兑现状态）——节点是骨头，曲线是血，反转是雷，三件交付 = 短篇的停靠点；
- 方向层沿用本模板轻量维护：`追踪/时间线/`（插叙/倒叙更需登记故事内时间）、`追踪/伏笔.md`（当篇回收，不留「下卷再说」）、双台账照旧（豁免限额每篇 ≤1 处）、`设定/角色/` 1-3 卡即可；
- 可留空的长篇件：`大纲/卷纲_*.md`、`追踪/角色状态/`（弧光单篇完成时角色卡内记一节足矣）。
