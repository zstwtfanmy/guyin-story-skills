# {书名} — 隐笔写作项目（Codex / OpenCode）

## Skill 路由表

Codex 优先 `$skill-name` 调用；OpenCode 优先 `/skill` 或自然语言触发。

| 命令 / 意图 | Skill | 说明 |
|------|-------|------|
| `$guyin-write`、「开书」「写第X章」「日更」「回炉」 | guyin-write | 长篇写作编排（beat 任务卡循环） |
| `$guyin-short-write`、「写短篇」「盐言故事」 | guyin-short-write | 短篇写作编排 |
| `$guyin-analyze`、「拆这本书」 | guyin-analyze | 长篇拆文管道 |
| `$guyin-short-analyze`、「拆短篇」 | guyin-short-analyze | 短篇拆文 |
| `$guyin-review`、「审查」「这章怎么样」 | guyin-review | 对抗式审查（只诊不改，输出 L1/L2/L3） |
| `$guyin-deslop`、「去AI味」 | guyin-deslop | lint 确定性错误 + 陌生化改写 |
| `$guyin`、「我想写小说」 | guyin-story | 主入口：路由 + 项目状态诊断 |

## 文件结构

- `设定/` — 世界观/ 与 角色/（每角色一卡）
- `大纲/` — 卷纲_第X卷.md + 细纲_第XXX章.md（beat 的事件来源）
- `正文/` — 第XXX章_标题.md（三位章号补零）；大修现稿先归档 `正文/_archive/`
- `追踪/` — 状态权威层：伏笔 / 上下文 / _tracking-state.json / 时间线 / 角色状态 / 读者信号 + 灵感台账 / 豁免台账 / 待审台账
- `.guyin/work/{run_id}/` — 隔离工作区：候选正文＋发布证据（publish 后才进 正文/）
- `灵感池/` — 口述采集落点（只注入不强插）
- `作者性/` — 指纹 / 偏执点 / 气卡 / 魂档案 / 粒度配置 + 参考-气质谱系（**仅编排层读**，气卡永不下发任务卡）

## 项目约定（不变式）

1. **编排/执行分离**：主会话是编排层，拆任务组卡；正文由 `guyin-beat-writer`（执行层 subagent，三端 agents/ 部署，model 指向低模型）逐 beat 填写。subagent 不可用（含 Codex 报 unknown agent_type）时降级 solo：主会话扮演执行层，须先声明「Fallback: solo 执行」。
2. **写正文前必须有细纲**；开书流程停在细纲交付，正文须作者显式点名。
3. **检查脚本报警永不自动删**，一律拦为待审（改写卡或豁免流程）。
4. 每步落盘、下一步读盘；compact / 新会话后先读 `追踪/上下文.md` 恢复状态。
5. 选题不走扫榜——开书 Phase B 走「魂谱对表」。
6. **大修动刀前现稿拷 `正文/_archive/`**（无存档不动刀）；落盘后 tracking-commit 重提交＋章检链同跑——大修不得绕开状态门与章检。
7. **隔离与发布（D2）**：写章产物（日更/大修/去味修订）先落隔离区 `.guyin/work/{run_id}/`，章检对候选跑、证据绑 hash12；`guyin-tracking-commit.py publish` 是正式发布唯一通道（安装正文→追踪事务→指纹持锁提交→终验）。`追踪/_publication.json` 非 complete（在途/损坏）→ 先 `recover`，不重开写、不手改事务。
8. **验收检查点（E1）**：新书默认 ch1-3 后停（ch004 起到点）；续写在 `追踪/读者信号.md·验收检查点` 登记连续段。来源限**用户验收/独立读者**（模型审读不顶替人）；到点缺件/空答/未处置均拦；可显式「延期@第K章」并登记下一检查点，不静默豁免；旧反馈不冒充当前版本验收。
