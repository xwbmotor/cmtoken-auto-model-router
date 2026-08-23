# 生产部署指引（Ubuntu + Docker Compose）

> 目标：把 auto-model-router 部署为内网一个独立 URL（如 `http://<内网IP>:8787/v1`），
> 在 MaaS 平台/客户端把它注册为一个模型（`model: auto`），即可试用路由能力。
> 本文档面向 Linux（Ubuntu 20.04+）宿主机，全程无需在本机装 Node。

## 0. 前置条件

| 项 | 要求 |
|---|---|
| OS | Ubuntu 20.04 / 22.04 / 24.04（glibc） |
| Docker | ≥ 20.10（含 compose v2 插件） |
| 网络 | 宿主机可访问上游 MaaS 平台（`MAAS_BASE_URL`） |
| 端口 | 8787（或自定），仅内网放行 |

```bash
docker --version && docker compose version   # 两个都有输出即可
```

## 1. 传输镜像与文件

构建机（Windows，已装 Docker Desktop）导出镜像 tar，拷到 Ubuntu 宿主机：

```bash
# Windows 构建机
docker build -t cmt-auto-model-router:<版本号> .   # <版本号> 填当前发布版本，如 0.5.0
docker save cmt-auto-model-router:<版本号> | gzip > amr-image-<版本号>.tar.gz
```

```bash
# Ubuntu 宿主机
sudo mkdir -p /opt/amr/{config,data}
docker load -i amr-image-<版本号>.tar.gz
# 拷贝仓库里这三个文件到 /opt/amr/（scp/U盘均可）：
#   docker-compose.prod.yml  → /opt/amr/
#   config/router.json       → /opt/amr/config/router.json
#   .env.example             → /opt/amr/.env（下一步填凭证）
```

## 2. 准备配置与凭证（宿主机）

编辑 `/opt/amr/.env`（即 `.env.example` 精简为 passthrough 所需）：

```bash
# key 模式已固定为 passthrough（compose 里已设）：客户端直接用平台 MaaS key，
# 路由器原样透传，计费/配额落到调用方租户——所以不需要 MAAS_API_KEY / ROUTER_ACCESS_KEY
ADMIN_TOKEN=<管理页 token，自拟强随机串>
MAAS_BASE_URL=<上游 MaaS 平台地址>
METRICS_TOKEN=<metrics 抓取 token，自拟，可选>
TZ=Asia/Shanghai
```

`/opt/amr/config/router.json` 用仓库默认即可启动（镜像内自带兜底配置，卷覆盖后以卷为准）。
要接入哪些模型、定价多少，上线后在管理页调（见 §5）。

权限收敛（凭证文件仅 root 可读）：

```bash
sudo chmod 600 /opt/amr/.env
sudo chown -R 1000:1000 /opt/amr/data /opt/amr/config   # 容器内 node 用户 uid=1000
```

## 3. 启动与验证

```bash
cd /opt/amr
docker compose -f docker-compose.prod.yml --env-file .env up -d
docker compose -f docker-compose.prod.yml ps          # STATUS 应为 Up (healthy)
curl http://127.0.0.1:8787/health                     # {"status":"ok",...}
```

## 4. 注册为 auto 模型给客户端试用

服务是标准 OpenAI 兼容接口，任何 OpenAI 客户端/平台按下面配即可：

- **Base URL**： `http://<宿主机内网IP>:8787/v1`
- **API Key**： 平台 MaaS key（passthrough 模式原样透传，真伪由上游判定，计费落租户）
- **Model**： `auto`（路由器自选；也可显式 `deepseekv4-flash` 等模型 id）

curl 冒烟：

```bash
curl http://<内网IP>:8787/v1/chat/completions \
  -H "Authorization: Bearer $MAAS_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"auto","messages":[{"role":"user","content":"你好，自我介绍一下"}]}'
```

> “注册为 auto 的模型”在支持自定义接入点的平台（如 LibreChat/one-api/New API）：
> 添加渠道 → Base URL 填上面地址、Key 填 `ROUTER_ACCESS_KEY`、模型名填 `auto`。

## 4.1 对接本平台 MaaS「custom」入口（用户当前目标）

在 MaaS 平台「custom / 自定义模型」配置页填：

| 字段 | 值 |
|---|---|
| API 地址 | `http://<宿主机内网IP>:8787/v1`（或加 `/chat/completions`，按平台表单而定） |
| API Key | 平台 MaaS key（passthrough 透传，与现有 key 一致） |
| 模型名 | `auto`（或同时注册 `deepseekv4-flash` / `qwen36-35b` / `Qwen3.8-27B`） |

Key 与现有平台 key 体系一致：路由器 passthrough 原样转发，客户端无感切换。

## 5. 日常运维

```bash
cd /opt/amr
docker compose -f docker-compose.prod.yml logs -f --tail 100   # 看日志
docker compose -f docker-compose.prod.yml restart              # 重启
docker compose -f docker-compose.prod.yml down                 # 停止
```

管理页：浏览器开 `http://<内网IP>:8787/`，输入 `ADMIN_TOKEN` 连接，即可调档位/权重/模型定价，
「安全发布」即时生效（写回挂载的 router.json，无需重启）「重新加载」重读磁盘配置。

## 6. 运行数据在哪（迭代依据）

| 数据 | 路径（宿主机视角） | 用途 |
|------|--------------------|------|
| 决策日志（每请求：任务分类/候选评分/选中模型/成本/时延） | `/opt/amr/data/decisions/decisions-YYYYMMDD.jsonl` | 路由行为审计、复盘“为什么选了它” |
| 预算台账 | `/opt/amr/data/budget-ledger.json` | 每日消耗统计 |
| 反馈数据（👍/👎） | `/opt/amr/data/feedback/` | 用户对答案质量的标注 |
| 配置发布历史 | `/opt/amr/config/history/` | 每次发布的配置快照，可回滚 |

**持续迭代闭环**：跑一段时间后把 `data/decisions/*.jsonl` 发我（或整个 `/opt/amr/data` 打包），
我可以做：流量构成分析（输入/输出比、任务类型分布）→ 校正 pricingMix/成本指数；失败/降级分析 →
调熔断与 fallback；配合 feedback 做质量校准。`redactMessages: true` 已默认开启，日志不含用户
消息原文，只有 token 数和分类标签，脱敏安全。

## 7. 升级

```bash
# 构建机出新版镜像 tar → 宿主机
docker load -i amr-image-<new-ver>.tar.gz
cd /opt/amr
sed -i "s/cmt-auto-model-router:<版本号>/cmt-auto-model-router:<new-ver>/" docker-compose.prod.yml
docker compose -f docker-compose.prod.yml --env-file .env up -d
```

配置与数据在卷上，升级不丢。
