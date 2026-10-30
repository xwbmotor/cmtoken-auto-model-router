# 独立分析服务

`src/analysis-server.mjs` 是单独的进程入口，不导入正常网关的 `server.mjs`。只计算规则路由建议，不启动聊天转发、语义模型、Judge、模型探测、训练、原文日志或转发对账存储。正常转发仍使用原来的启动方式和配置。

## 启动与配置

设置独立的 `ANALYSIS_ACCESS_KEY`（至少32字符，不含空白）以及经核准的 `CONFIG_PATH`，执行 `npm run start:analysis`。不要把生产 `.env`、模型密钥或对账数据目录挂载到分析实例。配置文件以只读方式加载，修改后重启；没有配置发布或管理API。

| 环境变量 | 默认值或要求 |
| --- | --- |
| `ANALYSIS_HOST` / `ANALYSIS_PORT` | `127.0.0.1` / `8792`，与现有Node端口分开 |
| `ANALYSIS_ACCESS_KEY` | 必填，独立于业务和管理凭据 |
| `ANALYSIS_ALLOWED_MODEL_IDS` | 逗号分隔的批准候选；未指定时使用配置中已启用、归属明确的模型。部署模板强制显式指定 |
| `ANALYSIS_ALLOW_HISTORY` | `false`；批准后可设 `true`，允许有界的user/assistant历史，末条必须是user |
| `ANALYSIS_MAX_MESSAGES` / `ANALYSIS_MAX_MESSAGE_CHARS` | 最多32条 / 每条65536字符；默认单条请求仍限制为1条 |
| `ANALYSIS_MAX_BODY_BYTES` / `ANALYSIS_TIMEOUT_MS` | 最大2MiB / 最长5000ms，包含读体和计算；不接受压缩请求 |
| `ANALYSIS_MAX_CONCURRENT` / `ANALYSIS_RPM` / `ANALYSIS_BURST` | 8 / 120 / 30，均是单实例额度 |

部署可使用独立的 `docker-compose.analysis.yml`。该模板以非root、只读根文件系统运行，不挂载业务数据，使用独立内部网络，仅发布宿主机回环端口。宿主机TLS代理、来源白名单、4A及日志集中采集由工程团队配置。模板不会修改或启动现有生产转发Compose。

## 接口

`POST /v1/decide`，要求 `Authorization: Bearer <独立分析凭据>` 和 `Content-Type: application/json`。

```json
{"messages":[{"role":"user","content":"请解释二分查找的原理"}]}
```

只接受 `messages` 和可选 `model`、`availableModelIds`。拒绝未知字段、系统提示、工具、多模态及调用者提供的配置；模型集合只能缩小服务端批准范围，空交集拒绝。指定具体模型时，仍在批准范围内进行资格与质量检查。`GET /health`、`GET /health/ready` 提供存活信息；没有聊天、管理、文件、训练、反馈或原文导出入口。

成功返回 `requestId`、`policyRevision`、`suggestedModel`、`fallbackOrder`、`modelScope`，以及任务特征、候选评分和 `observation`。`requestId` 由服务端随机生成，中台保存业务关联。响应不包含输入文本、命中片段或模型自由解释。失败响应只包含固定错误代码，不回显原文或凭据。

`observation.classifier=rules` 明确当前为规则分析；这不是完整线上语义路由效果的复现。历史、工具、多模态、输出预算和实时健康/负载缺失会影响建议，不能把此采样结果当成全业务效果。保持现有语义分类和训练能力的方式，见[数据飞轮配合清单](security-analysis-integration.md)。

## 审计与异常

每次请求输出一条固定结构的JSON审计事件到stdout，包含服务端ID、时间、结果码、策略版本、分析结果和本进程收到请求的计数，不包含正文或客户端自填的未知模型ID。读取或计算超时会取消Worker；拥塞直接拒绝，不建立无界队列，也不写正文重试文件。

审计同步交付失败或stdout积压超过1MiB时返回 `503 audit_unavailable`；健康信息包含累计 `auditErrors`。stdout接收成功不是大数据持久化确认，进程崩溃仍可能损失尚未采集的事件。中台应保存成功响应的事件ID和结果、记录未成功样本，并由采集器监测缺失。六个月留存、防改删及跨重启汇总由平台实现；Compose本地轮转不是长期审计方案。

## 正常网关的兼容变化

- 不更改模型转发、SSE、费用计算、反馈和对账链路，不删除历史日志。
- `redactMessages=true` 不再保存前160字；默认管理查询不返回历史正文及回答。
- 显式 `redactMessages=false`、`logAnswerText=true` 仍分别控制请求和回答采集；具备管理权限的 `fullText=1` 导出保留全文能力，凭据始终过滤。新增 `textAvailable` 和缺正文标记，避免把空标注样本误作完整输入。
- loopback下未配置管理凭据时，管理API拒绝访问；native前置代理模式缺少管理凭据直接拒绝启动。已配置凭据的生产转发无需更换鉴权方式。

正文采样是否启用、可采集范围及保留期限仍按批准方案配置，本次没有自动开启采集或将现有正常转发切换为纯分析模式。
