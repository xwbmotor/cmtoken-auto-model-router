# 请求级路由学习：离线执行流程

本流程把数据准备、模型拟合、盲化预测和结果比较放在独立命令中。模型使用固定的请求特征，预测各候选完成任务的概率与费用；没有在线训练、自动改配置或自动发布。方法与限制见[学习模型](learned-routing.md)，输入协议见[数据准备](routing-learning-data.md)。

## 1. 准备完整任务证据

需要两份文件：

- `business-matrix.json`：按[任务矩阵协议](routing-matrix.md)提供冻结任务、候选版本及结果。先确定成功标准，再给出成功标签；失败尝试产生的费用同样保留。train、validation 和 test 按会话、来源或模板分组隔离。
- `business-requests.json`：每条任务的完整原始请求。使用数据准备模块的 `routingInputHash(request)` 生成输入摘要，并与矩阵清单保持一致。推理参数与模型版本在候选表中冻结，不放入共同请求。

历史分类标签、HTTP `ok` 和原始 Judge 分数不能直接转换为 success。题库中的文字 rubric 可以作为待审材料；是否代表真实业务、怎样执行验收、哪些题属于相同模板，都需要有明确依据。现有旧协议评分不能借文件转换自动升级为新证据。

可以先没有 test 结果，提前完成盲化预测；train/validation 必须已有完整候选面板。候选资格须由调用方按容量、能力、租户等约束确认后填写 `eligibleCandidateIds`。显式空数组保留为无合格选择的任务；未声明资格不自动解释为全部模型线上可用。

## 2. 分离拟合与测试输入

```powershell
npm run learning:prepare -- --matrix data/business-matrix.json --requests data/business-requests.json --out-dir data/prepared-business-v1
```

输出目录的父目录须已存在，目标目录须不存在。三个产物是：

| 文件 | 内容与用途 |
| --- | --- |
| `fit.json` | 仅 train/validation 特征和候选结果，交给拟合进程 |
| `blind.json` | 仅 test 输入摘要、特征和资格候选；不包含测试任务类别、答案、成功标签、费用或结果引用 |
| `preparation.json` | 输入文件摘要与完成记录；不交给拟合器作为特征 |

原始请求不复制进这两个算法输入。改变 test 结果或其事后类别不会改变 fit 或 blind；完整源矩阵的哈希仅在准备记录中保存。SHA256 用于一致性核对，不能证明人工填写的来源真实。

## 3. 拟合并冻结策略

```powershell
npm run learning:train -- --input data/prepared-business-v1/fit.json --out data/business-policy-v1.json
```

输出包含 `model`、`modelHash` 和来源摘要。24 维固定特征只来自请求；标准化和模型系数仅使用 train；validation 用于校准和保守基线选择。组内任务按组等权，避免重复会话放大权重。

默认 train/validation 各至少 20 个独立组，每类至少 2 组。这些只是操作门槛。validation 校准诊断属于样本内结果，不能宣称成功概率已经在独立数据或线上校准。

演示或合成数据默认拒绝，需要显式 `--allow-demo` 才能检查程序。此时即使模型可以拟合，也返回退出码 2，并保持 `productionValidated=false`。不要为了绕过限制把 `evidenceKind` 改成 observed。

## 4. 单独运行盲化预测

```powershell
npm run learning:predict -- --policy data/business-policy-v1.json --input data/prepared-business-v1/blind.json --out data/business-selections-v1.json --router-cost 0 --cost-basis estimated
```

命令中的 `0/estimated` 仅演示如何显式声明尚未核实的路由费用，不能用它证明实际净节省。正式比较时，费用需包含实际测量或估算的特征提取、预测和相关调用开销，且使用与矩阵相同的币种。

预测进程只读取冻结模型和 blind 文件；不会读取完整结果矩阵。资格未确认时默认拒绝，仅可显式 `--allow-unconfirmed-eligibility` 做面板实验，限制会写入结果。小样本、单类、无法校准、分布外或预测概率门为空时，在资格集合内使用保守基线，返回明确原因。没有合格候选时保留 `unselected`，不伪造模型结果。

输出中的本地时延只计已加载模型后的预测调用，尚不包含特征提取与完整服务路径。因此保留 `PARTIAL_ROUTING_LATENCY` 阻断项，不能据此宣称端到端时延不退化。后续真实试验需补全该路径的测量。

## 5. 预测冻结后再关联测试结果

```powershell
npm run eval:matrix -- --input data/business-matrix.json --selections data/business-selections-v1.json --out data/business-comparison-v1.json
```

分析阶段才会读取 test 结果，并验证数据集声明、候选版本、非测试拟合证据和测试任务清单与预测文件一致。已有 predicted 策略不会被静默覆盖。通过校验后，在共同完整面板上比较固定模型、按任务基线、学习策略和事后上界；矩阵有 current 选择记录时，同时比较当前策略。没有 current 时会明确报告缺口，不能把固定模型对照说成优于当前 Auto。

`learningExperiment.heldOutDiagnostics` 另给出 test 上按组等权的 Brier、log loss、10 档可靠性统计和 ECE，以及任务费用预测 MAE、回退原因及预测门达标率。概率/费用缺失分别报告，费用误差包含失败任务，并分开实际与估算费用目标。各候选资格或覆盖不同，诊断可能来自不同子集，不能仅凭一个分数跨候选判优。错误的绝对确信概率会产生无限 log loss，以 `null` 加 `logLossStatus=infinite` 表示。该阶段不拟合参数、不选择阈值，描述性诊断也不等于已证明校准或生产收益。

变更测试结果会改变最终评测指标，但不能反向改变已冻结模型或选择。拟合/预测输出默认不覆盖已有文件，调整参数应另存版本，保留对照证据。

## 完成状态

数据准备完成不等于数据可用；模型拟合完成不等于学习收益成立；校准诊断不等于独立验证。train/predict 的退出码 0 只表示相应离线步骤满足自身条件，2 表示仍生成了可检查产物但有演示、覆盖、资格或测量限制，1 表示输入或执行错误。prepare 的退出码见其独立协议文档。

所有结果固定保留 `OFFLINE_ONLY` 或 `productionValidated=false`，矩阵报告也不会自动给出生产优越性声明。当前服务没有加载这些模型。接入前需要真实业务结果、独立测试收益、完整费用/时延测量和上线回退验证。
