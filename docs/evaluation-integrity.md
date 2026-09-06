# 离线评测与能力数据采纳

当前修复让评测输入、失败类型和采纳来源可核对。它没有重新调用模型验证历史成绩，也不代表 Judge 已经由人工校准。现有生产配置、历史结果文件和线上 full/interleaved 的无 Judge 降级行为均未由这些脚本自动修改。

## 报告的有效范围

`eval-gate.mjs`、`subtask-eval.mjs`、`subtask-regen.mjs` 共用 `evaluation-integrity.mjs`。报告 `integrity.schemaVersion=2`，协议为 `prompt-rubric-answer-v1`。每次 Judge 调用都包含完整原题、rubric 和完整回答；正文不再使用 160/200 字摘要代替。`outputHead` 仅用于兼容摘要展示，`output` 保留全文。

报告保存题库哈希、逐题哈希、Judge 身份、上游地址、token 预算、超时、被测模型配置哈希；路由核心模式额外保存完整路由配置哈希。实际生成的 `usage`、`finishReason`、时延及 Judge 调用尝试也会保存。这些字段是观察证据，不会在缺少计费单价时臆造真实人民币成本。

`--report` 只复用题库、协议、Judge、生成参数和模型配置均匹配的新报告。已评分行保留；Judge 故障行优先复用完整回答，只重试评分；生成失败行重新生成。先前失败保存在 `previousAttempts`，报告中的覆盖率按本次合并后的最终结果计算，不能冒充首次尝试成功率。

本地配置哈希不能证明同一上游模型别名背后的权重、推理引擎或部署版本未变化。需要严格比较时，应另行固定上游不可变版本/部署标识并完整重跑。当前 CLI 未强制 temperature 或 seed；不宣称跨运行结果完全可复现。

默认路由模式实际调用路由核心 `routeRequest`，将同一 `max_tokens` 同时用于选模容量判断与真实生成。它没有执行在线语义服务、动态健康、预算、回退、流式、推理控制链，因此报告明确称“路由核心模式”。整套线上 Auto 的收益仍需独立的真实请求对照实验。

## 失败和门禁

| `status` | 含义 | 分数 |
|---|---|---|
| `generation_failed` | HTTP/网络失败、空正文，或 `finish_reason=length/content_filter` | null |
| `judge_failed` | 生成完整，但 Judge 两次尝试仍失败、输出无效或不可核验 | null |
| `judge_skipped` | 显式不配置 Judge，或缺少 rubric | null |
| `scored` | 生成完整且收到合法的 0–1 数值评分 | 0–1 |

`null`、字符串、布尔值、越界分不能被转换成模型的 0 分；真实合法的 0 分仍计入。空正文和被截断正文不能成为“有效质量样本”。

`eval:gate` 默认同时要求：条件质量均分 ≥0.7、生成就绪率 ≥95%、对完整生成回答的 Judge 覆盖率 ≥95%、每任务的有效评分/计划用例数 ≥80%。因此大量失败后仅剩少数高分不会 PASS。可通过 `--min`、`--min-ready-rate`、`--min-judge-coverage`、`--min-task-coverage` 显式设置阈值；实际阈值会写入报告。

`--limit` 报告标记为局部试跑，不接受为模型能力档案的准入报告。基线必须具有相同题库、Judge、生成设置和模式；使用同题配对分差，覆盖不足或下降超过 0.05 会失败，不声称该固定阈值等于统计显著性。

显式 `--judge none` 可收集生成/可用性数据：`eval:subtask` 正常保存无分数报告；`eval:gate` 的质量值为 unavailable，退出码 1，不输出质量 PASS。质量门通过返回 0，质量/覆盖不达标返回 1，参数或证据协议错误返回 2。在线服务原有的无 Judge 巡检和交错评测降级不受影响。

## 导入与历史数据

旧报告缺少完整原题/协议证据，不能通过改标签、只补跑失败行或拼接旧均分升级成可靠新评分。旧报告不能参与默认导入、基线比较或增量复用，必须完整重新评测。**本次代码修复没有重新验证历史分数。**

导入必须显式给出输入路径，不再扫描“最新日期文件”，也不自动读取整个 eval-gate 目录。例如：

```powershell
node scripts/apply-eval-to-models.mjs --report data/subtask-eval/new-v2.json --dry
node scripts/apply-eval-to-models.mjs --report data/subtask-eval/part-a-v2.json --report data/subtask-eval/part-b-v2.json --dry
node scripts/apply-eval-to-models.mjs --gate-report data/eval-gate/new-model-v2.json --dry
```

去掉 `--dry` 才保存配置。多个显式报告按 `(model,id)` 合并；同一条目由命令行后列出的报告替换，包括失败条目，不会只挑好成绩。题面或生成/Judge 设置不同的报告拒绝混合。同一条目不能通过重复导入增加样本数。

默认 `--mode merge` 只更新输入覆盖的小类，保留其他小类。受影响小类的均值只由输入报告中的逐题结果重算，不把没有逐题来源的旧聚合分混入；样本量低于已有值时拒绝静默替换。每小类至少达到 `routing.subtaskMinSamples`（当前为 4），且生成/Judge 覆盖门禁通过。

`--mode replace` 明确重建受影响模型的指定数据层。预览会列出删除的小类、更新范围和保留但未重新验证的旧维度。该选项也不能绕过协议、样本量和覆盖检查。

`--gate-report` 只接受通过门禁的单模型完整报告，每任务也需达到最少有效样本量；路由选择形成的模型子集不能当作单模型准入集。默认 merge 保留未涉及的旧任务维度，新 `total` 的覆盖任务写入 `evalGateMeta.totalScope`，未重新验证的保留维度单列。

来源、报告哈希、题库版本、样本集合哈希和覆盖率写入 `benchmarkScores.subtasksMeta.bySubtask` / `evalGateMeta`。保留的历史小类标记为 `legacy-unverified`，不能因一次局部导入获得整模型已验证的标签。此脚本仍只更新能力证据档案，不自动覆盖 `models[].quality` 主档。

新增回归测试运行：`node --test tests/evaluation-integrity.test.mjs`。测试只使用本地 mock、隔离配置和临时报告，不调用付费上游。
