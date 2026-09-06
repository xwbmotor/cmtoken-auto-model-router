# Auto Model Router

面向 MaaS 平台的智能模型路由网关。客户端只需将 `model` 填为 `cmtoken-auto`（或留空），路由器根据请求内容自动选择最合适的模型——简单任务走低成本模型，复杂任务走强模型，在质量与成本之间逐请求寻优。

## 特性

- **OpenAI Chat Completions 兼容接口**：`/v1/chat/completions`、`/v1/models`，支持流式、工具调用与 JSON 模式；具体能力受上游模型支持范围约束
- **三层任务分类**：规则层（<1ms）→ 语义小模型复核（~20ms）→ 大模型升级，任务类型 + 三档难度
- **评分选型**：`score = 质量 − 成本权重×用户成本指数 − 算力权重×算力消耗指数 − 时延权重×时延 − 不确定性 + 自建奖励 − 熔断惩罚`，权重管理端可调
- **故障安全**：预算预占-结算-冲正、fallback 链、熔断器、优雅关停排空、决策/复核/评审三路独立事件流
- **异步质量评审（Judge）**：按比例抽样已完成请求，交由独立评审模型（GLM-5.3）打分与路由核对，结果只进离线报表，不影响在线决策
- **运营控制面**：Web 管理端（登录会话保护）、参数热更新、影响模拟、Prometheus 指标、发布门禁

## 快速开始

### 运行

```bash
# 零依赖 Node ≥ 24，克隆后直接启动
node src/server.mjs
# 默认监听 127.0.0.1:8787；生产配置见 docs/Ubuntu生产部署.md
```

生产环境通过环境变量提供凭证（`.env`，参考 `.env.example`）：

| 变量 | 用途 |
|---|---|
| `ADMIN_TOKEN` | 管理端登录与 `/admin/api/*` |
| `METRICS_TOKEN` | `/metrics` Prometheus 抓取 |
| `ROUTER_ACCESS_KEY` | 业务调用鉴权（strict 模式） |
| `ROUTER_KEY_MODE` | `passthrough`（客户端 key 透传，默认）或 `strict` |
| `SEMANTIC_BUCKET_SECRET` | 语义灰度分桶 HMAC secret（active 模式必填） |

### 客户端接入

```bash
curl http://<服务地址>:8787/v1/chat/completions \
  -H "Authorization: Bearer <你的key>" \
  -H "Content-Type: application/json" \
  -d '{"model":"cmtoken-auto","messages":[{"role":"user","content":"你好"}]}'
```

`/v1/models` 只暴露 `cmtoken-auto` 入口；点名单个模型仍可用原模型名（需 `allowExplicitModel`）。

## 目录结构

```
src/                  服务端（零依赖 Node ESM）
  server.mjs          HTTP 入口、协议层、管理 API、Judge 调度
  router.mjs          路由决策核心（分类、评分、fallback、基线）
  judge.mjs           异步评审器（抽样、预算、熔断、rubric）
  semantic-router.mjs L2/L3 语义复核
  config.mjs          配置加载与校验
  ...
public/               管理端 Web UI（登录页 + 控制台）
config/router.json    运行时配置（模型池、权重、预算）
docs/                 使用说明、MaaS 集成手册、部署指南
tests/                node:test 全量测试（实际数量以测试报告为准，发布门禁 0-skip）
scripts/              分类器训练/评测、发布测试脚本
```

## 测试与发布

```bash
npm test              # 全量测试
npm run test:release  # 发布门禁：clean HEAD + tag 校验 + 0-skip，报告落 reports/
npm run eval:matrix -- --input data/business-matrix.json --out data/business-matrix-report.json
```

版本号唯一口径为 `package.json` semver + git tag；发布流程与镜像部署见 `docs/智能体交接说明.md`。

## 文档

- [路由约束与评测基础](docs/router-foundations.md) —— 执行约束、指标变更及真实数据阶段边界
- [评测完整性](docs/evaluation-integrity.md) —— Judge 输入、覆盖门禁和显式评分导入
- [真实任务矩阵](docs/routing-matrix.md) —— 公平比较固定模型、当前路由、新策略与理想上界
- [反馈关联与待审样本](docs/feedback-learning.md) —— 传输结果、人工评价和 Judge 分开使用
- [使用说明](docs/使用说明.md) —— 功能导览与参数口径
- [MaaS平台集成部署运营手册](docs/MaaS平台集成部署运营手册.md) —— 平台侧集成与运营
- [路由设计说明](docs/路由设计说明.md) —— 路由算法设计细节
- [Ubuntu生产部署](docs/Ubuntu生产部署.md) · [反代集成](docs/反代集成.md)
- [CHANGELOG](CHANGELOG.md) —— 版本历史

## License

MIT
