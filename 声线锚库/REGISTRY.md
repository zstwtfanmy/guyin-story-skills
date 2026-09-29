# 声线锚库注册表（REGISTRY）

> 注册键是 profile（读者回报结构），不是"都市/历史"表面标签——同一题材不同回报机制的书写法相反，共用锚即污染。
> 一个 profile 可配多锚；默认读主锚（表中第一行）。

| profile ID | 锚书 | 覆盖场景 | 来源 sha 前缀 | 状态 |
|-----------|------|---------|--------------|------|
| relationship-payoff | 隐杀 | 开篇/共同生活/误认不纠正/踢馆/日常群戏 | 9c74d8a2 | 就位 |
| historical-causal | — | — | — | 待建 |
| character-causal | — | — | — | 待建 |
| resource-cultivation | — | — | — | 待建 |
| adventure-growth | — | — | — | 待建 |
| clue-revelation | — | — | — | 待建 |
| systems-scifi | — | — | — | 待建 |
| professional-ensemble | — | — | — | 待建 |
| relationship-society | — | — | — | 待建 |
| intimacy-choice | — | — | — | 待建 |
| pressure-team | — | — | — | 待建 |

## 行格式说明

`profile ID | 锚书 | 覆盖场景 | 来源 sha 前缀 | 状态（就位/待建）`

- 新增锚：在对应 profile 行填锚书/场景/来源，状态改「就位」；锚目录 `声线锚库/{profile}/{锚书}/` 同步建好。
- 换主锚：把新锚行插到该 profile 首行；旧锚保留为副锚。
