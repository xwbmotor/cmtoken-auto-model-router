# 离线轻量学习路由

`src/learned-routing.mjs` 实现可复算的按候选逻辑回归与费用估计，不新增依赖。它不接入线上服务、不调用上游、不改路由配置。所有模型和预测固定标记 `OFFLINE_ONLY`、`productionValidated=false`。合成测试只能验证机制，不能证明真实选模收益。

## 接口与数据边界

```javascript
import { fitLearningPolicy, predictLearnedPolicy, modelArtifactHash } from './src/learned-routing.mjs';

const artifact = fitLearningPolicy(fitData, {
  qualityFloor: 0.8,
  relQualityCap: 0.05,
  minTrainGroups: 20,
  minValidationGroups: 20
});
const result = predictLearnedPolicy(artifact, {
  features: requestFeatures,
  eligibleCandidateIds: ['model-a-off', 'model-b-high']
});
```

输入是 [业务任务矩阵](routing-matrix.md) 的非测试部分：`schemaVersion=1`，原 `dataset/candidates/observations` 契约不变；任务另有 `features`。`featureVersion` 必须等于 `routing-request-v1`，`featureNames` 必须与 `request-features.mjs` 的固定 24 维名称及顺序完全一致。仅接受有限数字数组，不能把结果或缺失值塞入特征。`policies`、`selections` 在拟合输入中均为 `[]`。

拟合拒绝任何 `test` 任务或观测，不能把完整测试矩阵直接交给拟合器再声称“没有用标签”。候选观测必须对应同一输入、相同候选版本及真实定义的成功标签。HTTP 200、分类正确、未经独立核验的 Judge 分数不能自动成为 success。元数据和证据引用是提供者声明；模块不替代来源核验。

`predictLearnedPolicy` 只接收特征与显式资格集合，不接受测试标签、真实费用或事后答案。未知候选或重复资格 ID 报错；空集合返回 `candidateId=null`。模块不自行判断租户、工具或视觉能力，调用方必须先生成正确的 `eligibleCandidateIds`。

## 拟合方法

1. **共同面板。** 只有某任务具备全部声明候选的结果，才能用于拟合与校准。清单里的缺失任务保留在覆盖分母及 `excluded` 中；覆盖不足时预测保守回退，不用各候选不同的可观测子集制造比较优势。
2. **按组等权。** 每个 group 总权重相同；同组每个任务权重为 `1 / (组数 × 该组任务数)`。标准化、分类损失、费用损失、校准和基线选择使用同一口径。同会话重复 30 次不会被当成 30 个独立组；前提是正确标记 groupId。
3. **训练专用标准化。** 均值、方差及特征范围只来自 train 共同面板。常量列尺度取 1；标准化向量截断至 ±6，防止极值主导数值计算。validation 不参与这些统计。
4. **每候选逻辑回归。** 全批次确定性梯度更新，L2 约束斜率，截距使用对称伪计数平滑。train 组不足、只有一类标签或某类组不足时，只保留平滑常数预测，禁止作为已学习策略进行动态选择。
5. **费用回归。** train 上以 `log1p(任务总费用)` 为目标做 L2 线性回归，用训练残差的 smearing 调整反变换偏差。小样本用按组加权平均费用。失败、重试与工具费用必须已经在任务费用里；输出是估计，不是承诺或已实现节省。
6. **验证校准。** validation 中落在 train 特征支持范围内的共同面板，用于正斜率 Platt 校准。组数/类别不足时不拟合。报告按组加权的 Brier、log loss 和分箱 ECE；这些数据同时用于拟合校准，因此是样本内诊断，`independentlyValidated=false`，不是独立校准验证。

默认 train 与 validation 各至少 20 组、每类至少 2 组。它们只是操作门槛，不是样本充分性证明。optimizer 参数、迭代次数、L2、伪计数及 OOD 参数均写入 artifact；没有随机采样、当前时间或隐式外部状态。

## 选择与保守回退

先在显式资格集合内预测候选成功概率及费用。仅当每个候选都有足够训练支持、可用的 validation 校准、共同面板覆盖完整且请求未触发 OOD 时，才进入学习选择：

```text
估计成功概率 >= qualityFloor
最优估计概率 - 该候选估计概率 <= relQualityCap
在满足上述条件的候选中选择估计费用最低者
```

同费用先取更高估计概率，再按候选 ID 稳定破同分。`qualityGateSatisfied=true` 仅表示估计值通过门槛，`probabilityFloorGuaranteed` 始终为 false。

OOD 检查使用 train 各列范围、扩展范围与标准化距离；训练时常量特征改变也触发回退。它只能发现部分边际漂移，不能检测所有联合分布变化或新语义。

小样本、单类、校准不足、面板缺失、OOD 或没有概率合格项时，在资格集合内选择保守固定基线。优先用足量 validation 共同面板，按组加权平滑成功率排序，再按费用排序；validation 不足时使用 train。`fallback=true`、原因、基线选择 split 和 `qualityGateSatisfied=false` 明确返回。基线同样没有成功率保证；缺少任何共同面板支持时返回 null，不强行挑一个未被观察过的候选。

## 产物与后续验证

artifact 包含固定模型版本、候选版本/推理参数、特征 schema、训练参数、标准化、模型系数、覆盖/回退信息、校准诊断、数据声明和限制。`trainInputHash` 仅绑定 train 输入；`validationInputHash` 单列，二者都不接触 test。`artifactHash` 是除自身字段之外的规范 JSON SHA-256；`modelArtifactHash` 可重算，预测前核对一致性。相同数据与参数可复现同一 hash，输入对象键顺序及行顺序不影响结果。

`readiness.learningReady` 是离线学习机制是否有足够输入的状态；`blockers` 另列合成/演示数据、估算费用及覆盖问题。它不是生产上线批准。即使所有操作门槛通过，`productionValidated` 仍为 false。

下一步应冻结 artifact，在独立、标签盲化的 test 请求上生成选择，再用任务矩阵评估脚本比较当前策略、固定基线与 Oracle。validation 的拟合/选择诊断不能替代这一步；没有真实数据就不能报告业务成功率提升或实际净节省。
