# M2b 语义复核与租户实验接口

Go 使用现有 Node 的默认值解析和 Python 分类合同，模型配置继续由固定的 Node 适配器提供；本阶段没有生产请求、付费 L3 调用、训练或线上状态写入。

## 启动与配置边界

配置适配器使用 `--lab --native-semantics --config <实验配置> --port <端口>`；Go 使用 `--lab --native-analysis --native-semantics`，并显式指定 `--semantic-small`、`--semantic-large`、`--assessor`、`--upstream`。所有目标必须是有端口的字面量 loopback URL，禁用环境代理和重定向。自动演示见 README，无须手动准备凭据。

Go 启动读取 `/analysis-config` 与 `/semantic-config`。后者只包含解析后的数值、模式和分类模型 ID，不包含 URL 或 token。启用主动语义配置但未启用 Go 语义实现会拒绝启动或请求，不能静默按规则执行。私有请求标记由 Go 生成，不转发客户端同名头。

| 环境变量 | 用途 |
|---|---|
| `AMR_GO_ACCESS_TOKEN` | 实验管理/默认调用凭据，至少 16 字符 |
| `AMR_GO_ASSESSOR_TOKEN` | Node 配置适配器私有凭据 |
| `AMR_GO_UPSTREAM_TOKEN` | 默认回答模型的上游凭据 |
| `AMR_GO_SEMANTIC_SMALL_TOKEN` | 可选的小模型端点凭据 |
| `AMR_GO_SEMANTIC_LARGE_TOKEN` | 独立 L3 模拟端点凭据；启用 L3 时至少 16 字符 |
| `AMR_GO_SEMANTIC_BUCKET_SECRET` | 主动模式必填，至少 32 字节，保持重启前后一致 |
| `AMR_GO_TENANTS_JSON` | 实验数组，每项含 `accessToken` 与 `upstreamToken`；最多 256 项，凭据至少 16 字符且调用 token 不重复 |

租户映射由服务端环境提供，不从客户端正文接受。调用 token 只用于网关鉴权，上游 token 只发往明确配置的本地 `/models` 与回答端点；分类器使用独立凭据。该映射不等价于现有生产 `strict`/`passthrough` 或管理端账户系统的完整迁移。

## 复核与额度

- `http-json` 发送 `{text}`，接收 `{task,tier,complexity,confidence,reason}`，不包含 system/assistant 历史。
- `cascade` 在小模型失败或低于 `smallAcceptThreshold` 时升级 L3；L3 失败且小模型有结果时退为 `small-degraded`，双失败回规则。
- `finalAdoptionThreshold` 独立控制最终采纳；任务改变后重新推导子任务，工具请求保留 agent，容量与能力要求不被语义结果覆盖。
- 语义采用独立 HMAC 分桶，沿用 Node 的 session/fingerprint/internal 来源规则。重分类选模保留最初的路由桶、租户集合与运行快照。
- shadow 和未放量请求只后台观察，不阻塞主回答、不向回答上游发送第二次请求；后台任务有数量与总时长上限，关闭服务会取消并等待退出。
- 总请求截止在复核阶段到达时返回 504，不返回空的成功响应，也不预占回答并发。

`--semantic-max-large-calls` 默认 500 次、`--semantic-max-large-tokens` 默认 1000000，均为**当前进程整个生命周期**的实验限额，不是生产日账本。并发预留与结算只执行一次；正常 usage 记真实 token，缺失 usage（包括未知传输结果）保留保守估算。解析分类结果失败也不能抹掉已返回的 usage。调用次数不因失败退还，金额账本、日切和崩溃恢复仍属 M3。

## 模型资格与观测

`--scope-url` 启用模型列表查询。缓存以完整 HMAC 绑定端点与有效上游凭据，默认 TTL 60 秒、请求超时 3 秒；首次未命中等待一次合并查询，过期命中返回旧值并进行一次后台刷新，最多 10000 项。

兼容 Node：查询失败、无法解析、空列表、与启用模型无交集时回退全量；因此缓存是选模提示，**不是最终授权边界**。已有明确资格集合不会被扩宽，实际授权仍由上游验证。显式调用也受有效集合限制，这是 M2a 已有的保守检查。

响应头 `X-AMR-Semantic-Status` 表示当前复核状态。`GET /internal/v1/runtime` 只允许默认实验管理 token，返回进程内额度、在途数量与最近 100 条复核记录；不含正文、分类理由、原始会话 ID、URL 或凭据。记录尚未持久化，不替代生产审计日志。

## 验证边界

852 条纯合同对照与端到端模拟覆盖标准合同输入；L3 正常文本请求与 Node 请求体一致，对包含特殊字符的小模型理由使用合法 JSON 转义。Go RE2 自定义规则限制继续适用。实际 Python 检查只验证接口与选模等价，不声称分类准确率提升。L3 未调用真实外部模型。

剩余工作：生产鉴权衔接、统一配置 revision/热发布、健康状态与回退、回答费用预留结算、日志持久化、恢复及多副本策略，随后才能进行容量/业务灰度验证。
