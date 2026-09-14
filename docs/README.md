# 文档目录

第一次使用从接入说明开始；维护服务从部署说明开始。当前架构以 v0.14.8 已验收部署为基础，运行状态仍需查看实际服务。

## 使用和运营

- [空机安装](../deployment/README.md)：交付包、镜像导入、配置初始化与请求验收。

- [使用说明](使用说明.md)：客户端示例、模型与策略管理、日志和常见问题。
- [MaaS 平台集成](MaaS平台集成部署运营手册.md)：按模型分流、凭证、上线与运营。
- [Ubuntu 部署](Ubuntu生产部署.md)：三服务结构、安装条件、重启、升级与回滚。
- [反向代理](反代集成.md)：TLS 和 SSE 转发示例。

## 开发和实现

- [开发交接](智能体交接说明.md)：代码入口、维护约束和测试注意事项。
- [路由设计](路由设计说明.md) · [执行约束](router-foundations.md) · [负载与评分](model-load-and-scoring.md)。
- [Go 开发说明](../go-core/README.md)：构建、兼容验证和实验模式。
- [时延观测](latency-observability.md) · [运行证据](operations-evidence.md)。
- [LiteLLM 接入](litellm.md)：可选集成，不是当前生产的必选组件。

## 评测与学习

- [评测完整性](evaluation-integrity.md)：输入、评分覆盖和结果来源。
- [受控比较](controlled-comparison.md) · [真实任务矩阵](routing-matrix.md)。
- [反馈样本](feedback-learning.md) · [学习数据准备](routing-learning-data.md) · [离线学习流程](routing-learning-workflow.md)。
- [学习路由设计](learned-routing.md) · [验证路线图](benchmark-roadmap.md)：设计和后续计划，不能当作已实现的生产收益。

## 发布与历史证据

- [版本记录](../CHANGELOG.md)：按版本查看变化。
- [v0.14.8 生产验收](go-core-production-v0.14.8.md)：实际切换、重启、镜像及回滚依据。
- [Go 切换过程](go-core-edge.md)：候选比较、失败修复和历史实验。
- [迁移计划](go-core-migration.md)、`go-core-m4-*.md`、`go-core-*-results.md`：各阶段的原始结果，保留当时条件与限制。文中的“尚未切换”是当时状态。
- [发布效率记录](release-efficiency.md)：发布工具及历史耗时。

历史性能记录只适用于文中指定的二进制、资源和负载。不要将不同版本或模拟上游的结果拼成当前生产的容量、质量或时延保证。旧版 [架构图](router-architecture.html)已标明历史用途，当前服务职责见项目 README。
