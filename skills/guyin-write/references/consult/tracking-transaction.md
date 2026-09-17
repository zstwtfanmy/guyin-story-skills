# 追踪状态协议

`追踪/` 使用“一个结构化权威状态 + 多个确定性派生视图”。模型只提交一份语义 JSON，不分别 `Write/Edit/echo >>` 多个追踪文件。

## 权威层与派生层

| 层级 | 文件 | 语义 |
|---|---|---|
| 唯一权威 | `_tracking-state.json` | schema、最后提交章、导入截止章、状态修订号、上下文结构、全部当前角色/伏笔/时间线状态 |
| 章节记录 | `逐章记录/第NNN章.md` | 本章对未来连续性有用的紧凑变化；目标 ≤1536 字节，硬上限 3072 字节；导入范围内修订写成覆盖记录 |
| 运行记录 | `运行记录/第NNN章.md` | 编排层追加的审读全文、修订版本对照、调用与成本（D1：与速记分离）；**脚本永不写入/覆盖——修订重提交只重写 `逐章记录/`** |
| 派生视图 | `上下文.md`、`角色状态/{角色名}.md`、`伏笔.md`、`事件定性资产.md`、`物证台账.md`、`地理台账.md`、`场景台账.md`、`时间线/作者真相.md`、`时间线/读者已知.md` | 完全由 `_tracking-state.json` 生成；禁止手改，不作为程序输入 |

Markdown 只负责给作者和 Agent 阅读，工具不再反向解析 Markdown。`check` 直接从 `_tracking-state.json` 重渲染并逐文件比较。未来“第几章揭示”的计划写在卷纲/细纲，不写成时间线既成事实。
逐章记录只是便于人阅读的紧凑变化记录，不承诺单独无损重建全部当前状态；完整当前语义以 `_tracking-state.json` 为准。

## 运行工具

先按运行环境探测 Python 3 解释器（依次尝试 `python3`、`python`、`py -3`），再用当前 skill 根目录执行：

```text
{PYTHON} {当前 skill 根}/scripts/guyin-tracking-commit.py init    --project {书项目根} --input {初始化事务.json}
{PYTHON} {当前 skill 根}/scripts/guyin-tracking-commit.py commit  --project {书项目根} --input {逐章事务.json}
{PYTHON} {当前 skill 根}/scripts/guyin-tracking-commit.py check   --project {书项目根}
{PYTHON} {当前 skill 根}/scripts/guyin-tracking-commit.py backfill --project {书项目根} --input {verdicts.json}
{PYTHON} {当前 skill 根}/scripts/guyin-tracking-commit.py publish --project {书项目根} --input {发布清单.json}
{PYTHON} {当前 skill 根}/scripts/guyin-tracking-commit.py recover --project {书项目根}
```

- `init`：只在 `_tracking-state.json` 不存在时执行，绝不覆盖已初始化项目。/guyin-setup 部署的模板自带一份合法空态（v7、`book_title=未命名书稿`、无逐章记录）——书名定稿且尚无任何提交时，删掉模板占位 state 后用真实书名 init；已有提交后不再改名。
- `commit`：读取唯一权威状态，在内存中完成合并、引用检查、全部视图渲染和容量检查；随后写逐章记录与派生视图，最后原子替换 `_tracking-state.json` 作为唯一提交点。
- `check`：严格验证 state schema、逐章记录连续性/规范性/体积、固定 7 栏、角色快照硬上限、派生文件集合，以及所有派生视图与 state 的逐字一致性。
- `backfill`：存量迁移——把既往高潮章事件定性（G2 verdicts）/物证（T1 evidence）/地理断言（T2 geo）/场景锚点（P4 scenes）补录进现有 state（编排层列候选章清单、作者确认原句后产出 JSON，四个列表键均可选）；v4/v5/v6 存量 state 在此自动升级 v7（读入兼容、写盘归一），不新增逐章记录。

同一本书只允许工作流串行提交，不支持多个 Agent 或终端并发写。`expected_state_revision` 用于拒绝基于旧状态构造的顺序 stale transaction，不是并发锁。

事务 JSON 在成功前必须保留。若文件写入失败，`_tracking-state.json` 尚未推进；修正环境后直接重跑**同一份** `commit`。append 重跑只接受内容完全相同的既有逐章记录，不维护 `dirty/pending/repair` 状态机。

校验失败与写入失败处理方式不同：校验失败（字段非法、退役结构、容量超限）要按报错改事务本身，重跑同一份结果不变。派生视图被手改或外部改动导致 `check` 报 `derived view differs from _tracking-state.json` 时，重新提交**该章**的 `mode=revision` 事务让工具整份重建，`expected_state_revision` 取 `追踪/_tracking-state.json` 的 `state_revision` 字段——`check` 失败时只往 stderr 打 ERROR，不输出 JSON；不手改派生文件，也不删 `_tracking-state.json` 重来。手写出的逐章记录会让同章 `append` 永久报 `chapter delta N already exists with different content`——删掉那个手写文件后重跑原事务即可。

本工具不解析旧 `_tracking-meta.json`、`时间线/事件库.json` 或更早追踪结构，不提供语义兼容层。`init` 遇到这类旧文件时，先把它们按原样整体移入 `追踪/_旧追踪存档/`，再在原地建当前协议：旧内容留给作者查阅，不参与解析，当前状态完全以 init 输入为准。校验失败的 `init` 不移动任何文件。`commit` 与 `check` 仍直接拒绝旧结构——它们只在已建协议的项目上运行。

## 发布契约（publish / recover，D2：先隔离演练，再提交）

`publish` 是正式正文的唯一正式化入口。**单稿也先隔离**：候选正文、逐章事务、只读输入快照、审读与检查记录、run.json 只产生在项目隔离工作区 `.guyin/work/{run_id}/` 内，不进正式 `正文/` 扫描范围。日更/大修/去味的正式化全部共用这一条串行通道，不再手工「原子双命令」直接落正式盘。

发布清单 JSON 由编排层填写（`publish --input`），键：`schema_version=1`、`run_id`（1-80 位字母数字与 `._-`）、`target{chapter,title,mode}`、`candidate`、`destination`、`transaction`、`baseline[]`、`expected_state_revision`、`review{mode,conclusion,evidence[]}`、`check_evidence[]`、可选 `run_json`。规则：

- `candidate` 必须在 `.guyin/work/{run_id}/` 内；`destination` 必须落在 `正文/` 下。长篇：文件名 `第0*N章*.md` 且文件名章号等于 `target.chapter`。短篇（F1 最小映射）：文件名 `正文/{篇名}.md`（不带章号），仅允许 `target.chapter=1`——首发 append、重发 revision，单元号由清单显式给出，不从篇名反解；`chapter≥2` 的非章号目标一律拒（同项目多篇须先另定稳定映射与状态隔离）。append 目标不得存在；revision 目标必须存在，prepared 通过后旧稿先拷入 `正文/_archive/`（长篇 `第NNN章_发布前存档_时间戳.md`；短篇 `单元001_{篇名}_发布前存档_时间戳.md`）才允许覆盖。
- `baseline` 两种条目：文件 `{path,hash12}`（候选之外的正式输入，至少含 `追踪/_tracking-state.json`）、目录 `{dir,files[]}`（成员增删也算基线变化）。hash12 口径=文件字节 sha256 前 12 hex。
- 审读/检查证据文件必须真实存在且**内容逐字含候选 hash12**——改稿后旧证据自动失效。`review.conclusion` 非空；prepared 与 complete 前各跑一次待审台账未决阻断门（`guyin-check-pending.js`，exit 1 即拒）。
- `transaction` 在 prepared 做 dry-run 规范化（`expected_state_revision` 不符即拒），但不写入。

状态机（journal=`追踪/_publication.json`，每步落盘）：`prepared → prose_written → tracking_committed → fingerprint_committed → complete`。prepared 固化全部输入哈希，此后只做机械推进，不重新摘要、不做语义改写：原子安装正文 → 经现行唯一通道 `apply_transaction` 提交追踪 → 持锁调 `guyin-check-repetition.js --commit --under-lock --unit <target.chapter>` 固化本单元指纹（长篇单元=章号；短篇固定 1，篇名文件不靠文件名反解）→ 最终机械核验（正文/state/视图/指纹库哈希逐项对 journal）后写 complete。

- 退出码：0 成功；2 契约违约或执行错误（拒绝矩阵：基线变、候选被改、证据不绑候选 hash、审读缺失、台账有未决、revision/append 目标状态不符、候选越出隔离区、expected revision 不符）；**3 发布暂停**（演练钩子 `GUYIN_PUBLISH_PAUSE_AFTER=<stage>` 或进程中断，journal 已在盘）。
- 中断后用 `recover --project`：绑定同一 `run_id` 与已固化版本续跑，不重查未决阻断门、不越过已完成步骤；追踪已成功只核验不重复 append（崩溃在 commit 后不会长出重章）；指纹失败只补指纹。同 `run_id` 重跑 publish 等同 recover；complete 后同 run 重入幂等。无在途发布时 recover 输出 `{"recover":"no_open_publication"}`、exit 0。
- 指纹库损坏（无法解析/形状非法）：普通 `--commit` 与扫描一律报错不放行；recover 自动改走 `guyin-check-repetition.js --recover-library --under-lock 正文`（短篇 destination 为非章号篇名文件时改走 `--unit 1 正文/{篇名}.md` 单篇重放，不从目录猜收）——先把坏库隔离改名 `段落指纹库.corrupt-时间戳.json`，再从正式正文基线重放，最后只读复检；复检有阻断（exit 1）如实返回、绝不冒充恢复成功。超出基线的外部变化一律停下交用户裁决，禁止回滚覆盖。
- 互斥：`init/commit/backfill/publish/recover/指纹写入/指纹恢复`共享项目锁 `追踪/.track-lock/`（mkdir 原子锁 + `owner.json{pid,host,label,started_at}`；持锁 pid 确认死亡才改名挪走，无「跳过锁」开关；Python 与 Node 同协议两份实现，改协议两处必同步）。存在非 complete 的 `_publication.json`（含文件损坏）时，低层 `commit/backfill/check` 全部拒绝；setup 模板 hook 对 `正文/` 首建与覆盖写同样拦截（先 recover 再动笔）。

## 初始化事务

新书从第 0 章初始化。`story-import` 导入已有小说时把最后完整章写入 `last_chapter=N`；第 1..N 章不伪造日更记录，常规续写从 N+1 章开始。

```json
{
  "schema_version": 1,
  "book_title": "让你管账号，你高燃混剪炸全网",
  "last_chapter": 0,
  "context": {
    "position": {
      "volume": "第一卷·军宣整顿",
      "volume_start_chapter": 1,
      "story_time": "江晨到火箭军文工团报到前",
      "scene": "火箭军文工团"
    },
    "long_term_constraints": ["军宣爽点要用作品效果和围观反应链兑现，不能只靠系统播报"],
    "active_character_names": [],
    "continuity_risks": [],
    "recent_chapters": [],
    "next_chapter_commitments": ["让江晨报到，并落下五天百万粉的新手任务"]
  },
  "character_snapshots": {},
  "foreshadow": [],
  "timeline_events": [],
  "verdicts": [],
  "scenes": []
}
```

导入初始化时直接传入当前核心角色快照、伏笔当前行、时间线事件、事件定性（verdicts）、场景锚点（scenes）和固定 7 栏状态输入。阶段/卷级回看按需查询正文，不作为每章强一致追踪产物。

## 逐章事务

```json
{
  "schema_version": 1,
  "mode": "append",
  "chapter": 10,
  "chapter_title": "专业团队拍得还不如他拍的好？",
  "expected_state_revision": 9,
  "delta": {
    "result": "专业团队重拍的高清版在高层看片会上被判定缺了灵魂，张耀祖拍板继续采用江晨的手机原版。",
    "character_changes": [
      {"name": "江晨", "change": "作品价值获军内高层确认，从爆款新人升为不可替代的军宣创作者"}
    ],
    "foreshadow_changes": [
      {
        "action": "upsert",
        "id": "F027",
        "summary": "专业团队仍拍不出江晨原版的灵魂，继续验证其创作能力不可复制",
        "planted_chapter": 10,
        "planned_resolution_chapter": null,
        "status": "已埋",
        "importance": "中"
      }
    ],
    "timeline_events": [
      {
        "action": "upsert",
        "id": "E010",
        "story_time": "实弹训练两天后",
        "objective_fact": "文工团高层否决专业重拍版，决定沿用江晨手机拍摄的原版视频",
        "reader_knowledge": "读者已看到周薄森指出专业版缺了灵魂，张耀祖当场拍板用回原版",
        "reveal_status": "已揭示",
        "reveal_chapter": 10,
        "characters": ["江晨", "周薄森", "张耀祖"]
      }
    ],
    "verdict_changes": [
      {
        "action": "upsert",
        "id": "V010",
        "chapter": 10,
        "event": "原版胜出",
        "status": "active",
        "verdict": "专业团队重拍的高清版在高层看片会上被判定缺了灵魂，张耀祖拍板继续采用江晨的手机原版。",
        "keywords": ["原版", "重拍", "看片会"]
      }
    ],
    "constraints": ["后续继续用作品落地效果和围观反应放大江晨的高光，不能只写系统奖励数字"],
    "next_chapter_commitments": ["结算五天百万粉任务，并承接老兵主题的新任务"]
  },
  "context": {
    "position": {
      "volume": "第一卷·军宣整顿",
      "volume_start_chapter": 1,
      "story_time": "实弹训练两天后",
      "scene": "火箭军文工团高层看片会"
    },
    "long_term_constraints": ["军宣爽点要用作品效果和围观反应链兑现，不能只靠系统播报"],
    "active_character_names": ["江晨"],
    "continuity_risks": ["钟嘉嘉说江晨只猜对一半，未公开的培养安排不能被当成读者已知事实"]
  },
  "character_snapshots": {
    "江晨": {
      "identity": "火箭军文工团宣传兵；军宣爆款创作者",
      "location": "火箭军文工团高层看片会",
      "goal": "完成五天百万粉任务，持续做出真正能打的军宣内容",
      "state": "专业团队反向验证原版价值，军内认可继续抬升",
      "abilities_resources": ["前世MCN爆款运营经验", "《中国军魂》伴奏", "大师级导演能力"],
      "relationships": ["钟嘉嘉持续提供军报资源", "周薄森和张耀祖已明确认可其创作能力"],
      "knowledge": ["《军报》采访稿已经过审", "原版视频将继续作为正式军宣内容"],
      "open_threads": ["五天百万粉任务尚未结算", "钟嘉嘉所谓只猜对一半仍未解释"]
    }
  }
}
```

约束：

- 构造事务前运行 `check`，把当前 `state_revision` 原样写入 `expected_state_revision`；若状态已经变化，重新读取 state 并重构事务。
- `context` 的允许字段随子命令不同：`init` 收 `position`、`long_term_constraints`、`active_character_names`、`continuity_risks`、`recent_chapters`、`next_chapter_commitments` 六项；`commit` 只收前四项。`recent_chapters` 与 `next_chapter_commitments` 在 commit 时由工具从当前视图和本章 `delta` 派生，手填会在任何写入前被拒（`context contains unsupported fields: ...`，exit 2）。照 init 示例套 commit 事务是最容易踩的一处。
- `character_snapshots` 中出现的角色视为核心复用角色，必须同时出现在 `character_changes`；已经建立快照的核心角色再次变化时必须提交新快照。
- 角色快照的四个列表不限制条数，只限制单项长度和最终文件总字节：目标 ≤4096 字节，超过警告；硬上限 8192 字节，超过则在任何写入前拒绝。
- 没有快照的角色变化视为临时角色，不建立状态文件；`context.active_character_names` 最多 6 人且必须已有当前快照。
- `context.long_term_constraints` 和 `context.continuity_risks` 是整份提交的当前值。凡是上一版有、本次没有的条目，必须逐条列进 `delta.retired_context_items`，否则工具在任何写入前拒绝——漏写不会被当成删除。实际退役的条目由工具写进本章逐章记录的 `## 本章退役登记`，随后仍可回查。
- 不再复用的核心角色写进 `delta.retired_characters`：工具删除其当前快照与 `角色状态/{角色名}.md`，并在逐章记录留档。同一事务里不能既退役又提交快照，也不能退役仍列在 `context.active_character_names` 的角色。角色阵亡/退场这一章，把变化照写进 `character_changes` 即可，本章退役的角色不必再交一份马上要删的快照，逐章记录仍按核心角色标注。退役只表示不再进入热上下文，正文与逐章记录不受影响。
- 两类退役都只能在 `mode=append` 提交。退役表示「从此刻起离开当前状态」，而修订事务的逐章记录属于被改写的旧章，落在那里会谎报退役发生的章节；`mode=revision` 必须原样重交当前全部上下文条目，需要退役就放到下一次 append。
- `伏笔.md` 只呈现已经埋设过的当前状态。未来规划仍留在大纲。
- `timeline_events.action` 可为 `upsert/delete`。`未揭示` 的 `reveal_chapter` 必须为 `null`；部分/完全揭示只能填写已经发生的实际章节。
- `verdict_changes`（G2 事件定性实体，state schema v5）：Muse 判据章（章号 1-3/卷首/卷末/大高潮、细纲标签含高潮/反转/情绪峰值、关系节点）兑付给读者的叙事资产**必须当章登记**。`verdict` 存**从正文摘出的定性句原文，禁概括**；`keywords` 1-8 条（每条 ≥2 字符）供 `guyin-check-narrative-asset.js` 双层共现检测；`status`：`active` 已兑付 / `repriced` 已重估（档 1）/ `nullified` 已没收（档 2，须过 G1 档位仲裁与补偿声明）。存量书用 `backfill` 补录，v4 state 无需手工迁移。
- `evidence_changes`（T1 物证实体，state schema v6）：查案物证**首次登场或易主/销毁当章登记**。`anchor` 存物证登场/获得的**正文原句，禁概括**；`keywords` 1-8 条（每条 ≥2 字符）供 `guyin-check-consistency.js` 空降检测（未登记物证突然出现在结论里）；`status`：`held` 在案 / `transferred` 流转 / `destroyed` 销毁 / `archived` 归档；`holder` 当前持有人/所在（可空）。视图 `物证台账.md`，存量书用 `backfill` 补录。
- `geo_changes`（T2 地理实体，state schema v6）：地名**首次登场当章登记**，含相对方位断言的当章登记断言。`anchor` 存断言/首次提及的**正文原句，禁概括**；`ref`+`direction` 构成「本名 在 参照地 以方向」断言（方向限东南西北/东北/东南/西北/西南，`ref` 为 `null` 时仅做新地名登记）；`keywords` 供 `guyin-check-consistency.js` 方向冲突/行程连续性检测。视图 `地理台账.md`，存量书用 `backfill` 补录。
- `scene_changes`（P4 场景台账实体，state schema v7）：场景（反复出场且携带状态的地盘）**首次登场或状态变迁当章登记**。`anchor` 存五感锚点/布局事实的**正文原句，禁概括**——存「院里有棵歪脖枣树，树底下压着半扇磨盘」，不存「院子里有植物和农具」（低模型补全具体名词的能力远强于从抽象生成具体）；`current` 存变迁后现状（anchor+current 构成状态变迁链）；`status`：`active` 在场 / `changed` 已变迁 / `destroyed` 已毁；`keywords` 1-8 条（每条 ≥2 字符）供场景漂移检测（同场景再写时锚点物缺失即提示）。视图 `场景台账.md`，存量书用 `backfill` 补录。
- `mode=revision` 时，逐章记录必须重算为修订后该章仍然成立的完整连续性记录；当前角色、伏笔、时间线和上下文则提交受影响对象截至最新已写章的当前值——**先取最新正式现态，仅并入修订章实际改变的变化，其余原样携带**：重写第 3 章不得把第 10 章已提交的关系、目标或知识退回旧貌（工具侧强制：revision 必须原样重交当前全部上下文条目、退役只能走 append；快照内容以提交为准，编排层对「退回旧貌」负全责）。提交后核对受影响后续章正文与新现态，冲突登记待审台账（来源=修订冲突），不静默改写后续章。
- `delta.result` 是简短事实速记：≈300 字（≤900 UTF-8 字节，`context.recent_chapters[].summary` 与 `chapter_summaries` 同额）。完整审读报告、修订版本对照、调用与成本写 `追踪/运行记录/第NNN章.md`——不塞进 `delta.result`，也不追加到脚本生成的逐章记录（会撞 3072 字节硬上限，且修订重提交会覆盖手追加内容）。
- 修订导入截止章内的正文时，会新增或覆盖该章的逐章记录；`imported_through_chapter` 不变。

## 续写状态卡固定格式

`上下文.md` ≤12288 字节，由 state 整份生成，只含以下 7 个顶层区块：

1. `## 当前位置`
2. `## 长期约束`
3. `## 核心角色状态`
4. `## 活跃伏笔`
5. `## 近三章速记`
6. `## 下一章承诺`
7. `## 连贯性风险`

其中活跃角色最多 6 人、活跃伏笔确定性选取最多 8 条、近章只保留 3 章。这些是下一章热上下文容量，不是完整角色状态的容量限制。
