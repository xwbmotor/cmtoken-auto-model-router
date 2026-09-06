# 决策日志、反馈与待审样本

`scripts/mine-decisions.py` 只读关联决策、显式反馈和 Judge 日志。默认打印报告；只有显式指定 `--out` 才写人工待审候选。它不调用模型、不训练、不调整配置。

```powershell
.venv/Scripts/python.exe scripts/mine-decisions.py --days 14
.venv/Scripts/python.exe scripts/mine-decisions.py --days 14 --json
.venv/Scripts/python.exe scripts/mine-decisions.py --days 14 --out data/training/mined-review.jsonl
```

目录可通过 `--decisions-dir`、`--feedback-dir`、`--judge-dir` 指定；Judge 默认与决策日志同目录。保留 `--retry-gap-sec` 参数。输出不能覆盖原始输入日志或 `data/training/raw.jsonl`。

## 三类证据分别解释

| 字段 | 含义与限制 |
|---|---|
| `transportOutcome.ok` | 请求传输结果，优先使用 `transportOk`，兼容旧 `ok`；缺失为 null。HTTP 成功不代表任务完成，不能据此下调或抬高 `quality`。 |
| `humanFeedback` / `humanRating` | 反馈流最后一条合法 good/bad 评价及其来源。仅 manual/human/user/admin 来源填入 `humanRating`；来源是调用方声明，`sourceVerified=false`，仍需核验。合成/测试反馈不计为人工评价。 |
| `judgeReview` | 独立保留评审模型、rubric 版本/hash、每个维度分数及可验证性。不可验证/缺失维度为 null。回答模型不匹配时不计入该模型分数。不同 Judge/rubric 混用或缺评审来源标识时不输出合并均分。 |
| `taskSuccess` | 始终为 null。脚本不把任何一种代理信号自动转换为任务成功或金标准。 |

`requestId` 是三条事件流的关联键。决策和反馈按带时区时间戳取最新记录；同一时间用排序后的文件名与行号打破并列。重复行数量可见，不重复计费或计入请求数。Judge 同时保留最新事件状态与最新 quality 事件；后续 skipped/error 不会假装新评分，也不抹去有时间戳的旧评分。无 requestId 的记录单独展示，无法关联评价；孤立反馈/Judge 请求、坏行、无效时间、无评价记录均有计数。

`dataSource` 保留日志声明。synthetic/test/eval/benchmark/probe 等来源单列；未记录来源时为 unknown，不能默认解释成真实业务流量。画像按来源拆开，仍不能据其直接推导生产收益。脚本只识别明确来源标记，不能识别没有标记的测试流量。

实际成本与估算成本分列，实际金额 0 保留为 0，不回退到估算金额。新 `completionLatencyMs` 与旧 `latencyMs` 分开统计，防止混合时延口径。缺成本或无时延不填零。同会话近邻请求仅是核查线索，可能是正常追问、并行请求或工具循环；不自动解释为用户不满意。

## 候选必须经过人工复核

导出的 JSONL 使用 `source=mined-review-v2`、`labelStatus=needs_human_review`、`trainingEligible=false`。路由自身标签位于 `labelsSuggested`；不输出训练脚本要求的顶层 `text/task/tier/complexity`，不能原样拼入现有训练集。

`inputEvidence` 只提供最近三条用户消息的已留存文本，避免把第一条 system 消息当作问题。`head_only` 明确表示截断片段；`sourceContextComplete` 只说明原始日志是否保存完整文本，导出片段不等于完整上下文。复核需通过 `evidence.file/line` 回查原请求、回答及完整来源；缺原题、缺回答或来源不明时保留待审状态。

人工确认任务标签和业务验收结果后，另行制作带标注者、标注规则、来源和时间记录的训练/验证数据，并按会话、来源或模板隔离。不要把模型选中的次数、路由置信度、HTTP 200、Judge 建议或合成样本冒充独立金标准。该脚本不代替标注，也不自动把“已看过”改为“已验证”。
