# 离线业务任务矩阵：比较质量、费用与路由空间

这个工具分析已经采集的业务任务结果，回答：在相同任务、相同候选面板上，当前路由、新策略、固定模型、按任务固定模型分别取得多少成功，付出多少费用，距离事后可观察上界还有多少空间。

它不调用模型、不读 `.env`、不访问生产服务、不训练分类器，也不把 HTTP 200、任务分类命中或原始 Judge 分数当作业务成功。现在交付的是可运行的测量工具；仓库中的单元测试和下面的演示不能证明实际模型质量或生产节省。

## 执行

在仓库根目录运行，Node.js 20+，无需额外依赖：

```powershell
node scripts/analyze-routing-matrix.mjs --input data/business-matrix.json --out data/business-matrix-report.json
node scripts/analyze-routing-matrix.mjs --input data/business-matrix.json --selection-split train --bootstrap 1000 --seed 42
node --test tests/routing-matrix.test.mjs
```

默认用 `validation` 选择固定／按任务基线，使用 `test` 报告结果。可以预先指定 `train`，不能使用 `test` 选择基线。`--min-test-groups` 默认 30，`--bootstrap` 默认 1000、设 0 关闭；`--seed` 固定重采样结果。最低组数是探索性报告的操作门槛，不是统计充分性或优越性保证。

CLI 将完整 JSON 报告输出到标准输出；`--out` 同时保存文件。报告记录输入路径与文件 SHA-256，保留输入与报告即可重算。输出不得覆盖输入。

| 退出码 | 含义 |
| --- | --- |
| 0 | 结构完整且通过有限范围离线比较的前置检查；不是生产优越性结论 |
| 2 | 仍输出报告，但存在演示／合成数据、小样本、覆盖不足、估算费用等阻断项 |
| 1 | 文件、命令或数据契约错误；不得用该输入比较 |

所有报告都固定输出 `productionSuperiorityEstablished: false`。只有独立核验结果证据，并在代表性实际流量上验证后，才可进一步形成生产效果结论。

## 输入契约

输入为一个 UTF-8 JSON 对象（兼容 BOM），`schemaVersion: 1`。采用任务清单、候选表、观测表和选择表，避免反复保存原始提示词。**任务清单必须在看测试结果前确定**；不能从仅有成功返回的日志反推清单，否则完全丢失的任务会消失在覆盖分母中。

### dataset

| 字段 | 要求 |
| --- | --- |
| `id` | 数据集／采集批次标识 |
| `evidenceKind` | `observed`、`demo` 或 `synthetic`。后两者一律不能支持真实效果结论 |
| `currency` | 全表统一三位币种，例如 `CNY`；不自动换汇 |
| `costScope` | 固定为 `task_total` |
| `successBasis` | `business_outcome`、`task_check` 或 `human_review` |
| `successDefinition` | 预先定义的任务成功标准；多任务标准可在引用文档中逐类列明 |
| `collectionProtocolRef` | 采集规程／实验记录引用，说明模型版本、任务执行环境、费用和时延口径 |
| `splitProtocolRef` | 冻结清单及划分规程引用，说明去重、会话／模板分组与测试隔离 |

`observed` 表示数据提供者声明是真实观测，不是工具自动鉴定结果。工具校验结构、共同面板和显式泄漏；不会打开 `evidenceRef`、核验供应商账单或判断人为填写是否真实。

### candidates

至少两个候选。每个对象包含 `id`、`model`、`modelVersion`、`inference`；`provider` 可选。`inference` 为实际使用的 JSON 推理参数，包括思考档位、输出预算、temperature 等。相同模型的不同思考档位应使用不同候选 ID。实际默认值也应在采集规程中冻结，避免同一个 `latest` 别名的不同快照混在一起。

模型、版本、供应商和推理参数完全相同的两个候选会被拒绝。不同候选的任务输入、工具与验收标准相同；候选之间刻意改变的推理预算要体现在候选定义里，并按实际费用比较。

### tasks：预先确定的任务清单

| 字段 | 要求 |
| --- | --- |
| `taskId` | 一次完整业务任务的唯一 ID，不是一次 HTTP 请求 ID |
| `groupId` | 相关任务共同的独立分组：同会话、同模板或同原题变体必须放同组 |
| `split` | `train`、`validation` 或 `test` |
| `task` | 业务任务类别，例如 `coding`、`support`；用于按任务固定基线 |
| `inputHash` | 完整任务输入的 SHA-256，包括需要固定的 messages、tools、附件标识等；不含候选特有的模型与推理配置 |

同一 `groupId` 不能跨 split。同一个 `inputHash` 不能跨 split 或被拆成不同独立组。重复执行同一题时可以用不同 `taskId`，但保留共同 `groupId`，避免把重复试验当作独立样本。没有关联任务时可用独立任务 ID 作为组；不能因此把同会话的各轮随意拆组。

摘要检查只能发现完全相同的输入。语义改写、共享来源或相似模板仍需在划分规程里分组和审阅。

### observations：任务 × 候选的实际结果

每个 `taskId + candidateId` 最多一条；完整面板需要清单中每个任务都有所有候选的结果。

| 字段 | 要求 |
| --- | --- |
| `taskId`、`candidateId` | 引用清单与候选表，不接受未知 ID |
| `success` | 严格布尔值，按既定标准检查完整任务后的结果 |
| `cost` | 该候选完成／尝试该任务的总费用，有限非负数；包括失败尝试、重试及工具费用 |
| `costBasis` | `actual` 或 `estimated`；估算会阻断“实际净节省”结论 |
| `latencyMs` | 完整任务的执行时延，包含该任务内部重试／工具等待；不是首 token 时延 |
| `observedAt` | 该结果形成的带时区 ISO 时间 |
| `evidenceRef` | 对应结果、验收记录与费用依据的本地文件／记录引用，不能填密钥 |

观测行可重复携带 `groupId`、`split`、`task`、`inputHash`、`model`、`modelVersion`、`provider`、`inference`，但重复字段必须与清单和候选声明完全一致；也可以只通过 ID 引用。

失败任务仍须记录已产生的费用。费用未知不能填 `null`、空字符串或编造 0；可明确估算并接受报告阻断，或缺省该观测并显示覆盖缺口。标签缺失、Judge 不可用也不能随意写成 `success: false`。`false` 表示已确认任务未达到标准。

`task_check` 应检查任务输出，例如代码执行与断言、结构化输出的业务规则及事实核对。仅检查 HTTP 状态、JSON 可解析、模型名字或分类标签不够。原始 LLM Judge 分数不是本工具的成功标签；若经人工复核转成任务验收结果，应保留完整的复核标准与证据。

### policies 与 selections

`policies` 最多声明一个 `current` 和一个 `predicted`。可以暂时使用空数组分析候选面板，但会明确阻断“相对当前／新策略收益”的结论。

每个策略需要 `id`、`kind`（`current`／`predicted`）、冻结 `version`、`fitSplits`、`selectionMode`、`testLabelsUsed: false`、`selectionEvidenceRef`。

- `fitSplits` 只允许 `train`／`validation`，包括调参所用的数据；外部已冻结策略使用 `[]` 并在证据中记录训练来源。禁止测试集调参。
- `before_outcome`：每条选择须带 `selectedAt`，时间不能晚于该任务任一候选的结果形成时间。
- `label_blind_replay`：可离线调用已冻结选择器产生选择，但不能把任何测试答案、成功标签、成本结果等后见信息交给选择器。引用代码版本、盲化输入及选择表证据；工具不能独立证明该声明。

每条 `selections` 包含 `policyId`、`taskId`、`candidateId`、`routerCost`、`routerLatencyMs`、`costBasis`；事前选择再带 `selectedAt`。对每个测试任务，两条策略选择都必须明确给出。无路由开销时显式写 0；不能省略后默认当作免费。

`routerCost` 包含做出选择的分类／预测调用费用，`routerLatencyMs` 是执行任务前额外等待的路由决策时间。工具将它们加到所选候选的完整任务成本与时延。若线上路由开销已包含在候选 `cost` 中，应先按采集规程拆分，避免双计。

当前工具评价**每任务选择一个候选**的策略。串行级联、多模型讨论或跨模型回退不能只记最后一个模型的费用；应把完整工作流作为一个候选，在全部任务上测量它的完整成本与结果，或使用另外的工作流评测。

## 指标与比较方法

所有策略都在同一个完整测试子集上比较：缺少任一候选结果，或缺少任一声明策略的选择，该任务从所有策略同时排除。报告保留原任务清单作为分母，并列出缺失的候选／策略；有排除就阻断向全部流量外推。训练／验证集同样报告完整面板覆盖。

- `fixed:<id>`：各候选始终固定使用的结果。
- `selected_fixed`：只在指定 train／validation 面板上选一个固定模型；先比成功率，再比平均任务费用和时延，最后按候选 ID 破同分。
- `task_fixed`：同样只在非 test 数据里，为每类任务选固定模型。测试出现未见类别时用全局 `selected_fixed` 回退，并报告阻断项，不查看测试答案挑模型。
- `router:<id>`：按提供的 current／predicted 选择查表，并加上各自路由开销。
- `oracle`：事后查看全部候选结果，优先挑成功者，再选最低费用者；若全部失败仍计最低费用失败的成本。它不可能在线预知结果，是观测面板的理想参照，可能比当前路径更贵。

关键口径：

```text
任务成功率 = 成功任务数 / 所有评估任务数
每成功任务成本 = 所有评估任务总费用 / 成功任务数
策略总费用 = 所选候选的完整任务费用 + 该策略的路由费用
费用节省率 = (当前策略总费用 - 比较策略总费用) / 当前策略总费用
```

分母为 0 时输出 `null`，不伪造百分比。每成功任务成本的分子包含失败任务费用，不是“只对成功回答求均价”。报告包括整体与分任务类别的成功率、平均费用、每成功任务成本、平均／p50／p95 时延，以及配对成功／失败计数。费用差为“比较策略减参照策略”；正的成功率百分点差表示比较策略更好，正的费用差表示更贵。

有 current 时所有差值以它为参照；缺少 current 时可以展示相对非 test 选择的固定基线，但仍阻断新策略收益结论。predicted 对 current 的区间按完整 `groupId` 配对重采样，保留会话内依赖；组少于 2 或关闭 bootstrap 时区间为 `null`。这些区间不涵盖标签误差、模型漂移、未观测流量或选择偏差。

`headroom` 给出完全没有候选成功的任务数、只有某个候选成功的任务数，以及 Oracle 相对当前的质量／费用差。它用于判断是否有值得研究的模型互补空间，不能当作已实现收益。

## 最小演示输入

以下 JSON 可保存为 `data/routing-matrix-demo.json` 运行。**模型、费用、成功标签和哈希都是演示占位**；仅有一个测试组，预期退出码为 2。真实数据应从冻结任务清单及验收记录生成，不要把下面改成 `observed` 当作真实证据。

```json
{
  "schemaVersion": 1,
  "dataset": {
    "id": "demo-only",
    "evidenceKind": "demo",
    "currency": "CNY",
    "costScope": "task_total",
    "successBasis": "task_check",
    "successDefinition": "演示检查，无真实业务结果",
    "collectionProtocolRef": "demo:collection",
    "splitProtocolRef": "demo:split"
  },
  "candidates": [
    { "id": "a", "model": "demo-a", "modelVersion": "demo-v1", "inference": { "reasoning_effort": "off", "max_tokens": 1000 } },
    { "id": "b", "model": "demo-b", "modelVersion": "demo-v1", "inference": { "reasoning_effort": "high", "max_tokens": 2000 } }
  ],
  "tasks": [
    { "taskId": "v1", "groupId": "g-v1", "split": "validation", "task": "coding", "inputHash": "1111111111111111111111111111111111111111111111111111111111111111" },
    { "taskId": "t1", "groupId": "g-t1", "split": "test", "task": "coding", "inputHash": "2222222222222222222222222222222222222222222222222222222222222222" }
  ],
  "observations": [
    { "taskId": "v1", "candidateId": "a", "success": true, "cost": 1, "costBasis": "actual", "latencyMs": 100, "observedAt": "2026-09-01T01:00:00Z", "evidenceRef": "demo:v1:a" },
    { "taskId": "v1", "candidateId": "b", "success": true, "cost": 3, "costBasis": "actual", "latencyMs": 300, "observedAt": "2026-09-01T01:00:00Z", "evidenceRef": "demo:v1:b" },
    { "taskId": "t1", "candidateId": "a", "success": false, "cost": 1, "costBasis": "actual", "latencyMs": 100, "observedAt": "2026-09-02T01:00:00Z", "evidenceRef": "demo:t1:a" },
    { "taskId": "t1", "candidateId": "b", "success": true, "cost": 3, "costBasis": "actual", "latencyMs": 300, "observedAt": "2026-09-02T01:00:00Z", "evidenceRef": "demo:t1:b" }
  ],
  "policies": [
    { "id": "current", "kind": "current", "version": "demo-v1", "fitSplits": [], "selectionMode": "before_outcome", "testLabelsUsed": false, "selectionEvidenceRef": "demo:current-freeze" },
    { "id": "predicted", "kind": "predicted", "version": "demo-v2", "fitSplits": ["validation"], "selectionMode": "before_outcome", "testLabelsUsed": false, "selectionEvidenceRef": "demo:predicted-freeze" }
  ],
  "selections": [
    { "policyId": "current", "taskId": "t1", "candidateId": "a", "routerCost": 0, "routerLatencyMs": 0, "costBasis": "actual", "selectedAt": "2026-09-02T00:00:00Z" },
    { "policyId": "predicted", "taskId": "t1", "candidateId": "b", "routerCost": 0.1, "routerLatencyMs": 10, "costBasis": "actual", "selectedAt": "2026-09-02T00:00:00Z" }
  ]
}
```

后续接入真实数据时，先冻结任务清单和成功标准，再采集各候选结果、形成盲化的策略选择，最后分析。分类训练数据和原始请求日志可以帮助构造抽样任务，但不能替代这个任务结果矩阵。
