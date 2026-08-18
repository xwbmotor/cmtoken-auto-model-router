# LiteLLM 可选网关集成

## 推荐生产拓扑

```text
应用（model=auto）
        │
        ▼
Auto Router
  - 多模型联合选择（质量/成本/时延评分）
  - 自建优先约束
  - Shadow / A-B / 会话粘性
        │ 选择实际模型名
        ▼
LiteLLM Proxy（可选）
  - OpenAI 协议适配
  - 预算、计费、限流、日志
  - 同模型多实例负载均衡和 fallback
        │
        ▼
中国移动 MaaS
```

Auto Router 负责"不同能力模型之间选谁"，LiteLLM 负责"怎样可靠、可观测地调用这个模型"。职责分开后，路由策略不会和网关升级强耦合。

启动可选 LiteLLM 拓扑：

```powershell
docker compose -f compose.litellm.yaml up --build -d
```

LiteLLM 只在 Compose 内网暴露，客户端仍调用 `http://127.0.0.1:8787/v1`。建议在正式环境固定已验证的 LiteLLM 镜像版本，不长期跟随可变标签。

## 方案对比

| 方案 | 多模型联合路由 | 自建优先硬约束 | 网关/计费 | 适合阶段 |
|---|---:|---:|---:|---|
| Auto Router 直连 MaaS | 支持 | 支持 | 需自建 | 轻量部署（当前默认） |
| LiteLLM 单独使用 | 需自定义 | 可写规则 | 强 | 网关底座 |
| Auto Router + LiteLLM | 支持 | 支持 | 强 | 需要网关能力时推荐 |
| vLLM Semantic Router + LiteLLM | 支持 | 可配置 | 强 | 更重型自建方案 |

**职责分工**：Auto Router = 选模型；LiteLLM = 协议适配、计费、限流、多实例负载均衡。两者不要同时承担模型选择，否则排障和效果归因困难。
