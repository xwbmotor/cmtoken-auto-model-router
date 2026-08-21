# 给 openclaw 的部署任务交代（auto-model-router v0.4.25）

> 你（openclaw）的任务：在一台 Ubuntu 云主机上把 auto-model-router 用 Docker 跑起来，
> 变成一个内网 URL，供平台 custom 入口对接试用。照下面做即可，不需要额外上下文。

## 目标

- 服务地址：`http://<本机内网IP>:8787/v1`（OpenAI 兼容接口，模型名 `auto`）
- 运行方式：Docker Compose（镜像已打好，无需构建、无需 Node/Python 环境）
- 资源需求（已实测）：容器稳态 ~25MiB 内存 / CPU 接近 0；加 Docker 引擎自身，
  **整机 ≥1.5GB 内存、≥5GB 空余磁盘即可从容运行**

## 素材（一个 zip，四样东西）

部署包 `amr-ubuntu-deploy-0.4.25.zip`（76MB，由用户提供，scp/网盘均可）：

| 文件 | 用途 |
|---|---|
| `amr-image-0.4.25.tar.gz` | Docker 镜像（node 22-slim 底座，应用+依赖全在内） |
| `docker-compose.prod.yml` | 生产编排（自启/健康检查/日志轮转/config+data 卷） |
| `router.json` | 初始路由配置（三模型评分/定价/双成本指标） |
| `Ubuntu生产部署.md` | 完整部署文档（本文件的详版，遇到问题先查它） |

## 执行步骤

```bash
# 0. 前置检查（缺 docker 就先装：sudo apt-get install -y docker.io docker-compose-v2）
docker --version && docker compose version

# 1. 落位
sudo mkdir -p /opt/amr/{config,data}
# 解压 zip 后（假设解到 ~/amr-ubuntu-deploy-0.4.25/）：
sudo cp ~/amr-ubuntu-deploy-0.4.25/router.json /opt/amr/config/
sudo cp ~/amr-ubuntu-deploy-0.4.25/docker-compose.prod.yml /opt/amr/

# 2. 导入镜像
docker load -i ~/amr-ubuntu-deploy-0.4.25/amr-image-0.4.25.tar.gz

# 3. 写凭证 /opt/amr/.env（两行，值向用户索取）：
#    ADMIN_TOKEN=<管理页token，用户给定>
#    MAAS_BASE_URL=<上游MaaS平台地址，用户给定>
#    passthrough 模式下不需要其他任何 key
sudo chmod 600 /opt/amr/.env

# 4. 起服务
cd /opt/amr && sudo docker compose -f docker-compose.prod.yml --env-file .env up -d

# 5. 权限（容器内 uid=1000 写决策日志/台账）
sudo chown -R 1000:1000 /opt/amr/data /opt/amr/config
```

## 验收（三条全过才算完成）

```bash
docker compose -f /opt/amr/docker-compose.prod.yml ps   # STATUS = Up (healthy)
curl -s http://127.0.0.1:8787/health                     # {"status":"ok","configVersion":"0.4.25",...}
curl -s http://127.0.0.1:8787/v1/models                 # 列表含 "auto"
# 端到端（需平台 MaaS key，向用户索取；passthrough 透传上游）：
curl -s http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer <MaaS_KEY>" -H "Content-Type: application/json" \
  -d '{"model":"auto","messages":[{"role":"user","content":"回复ok"}]}'
```

## 回报格式（完成后发给用户）

1. 服务 URL：`http://<IP>:8787/v1`
2. `/health` 原文输出
3. 端到端调用是否 200、选中了哪个模型
4. `docker stats --no-stream` 一行（内存实况）

## 平台侧对接（用户自己做，你只需保证 URL 可达）

custom 入口填：API 地址 `http://<IP>:8787/v1`、Key 填平台现有 MaaS key（路由器 passthrough
原样透传，计费落租户）、模型名 `auto`。

## 运行数据位置（用户迭代要用，别动它们）

- `/opt/amr/data/decisions/decisions-YYYYMMDD.jsonl` —— 每请求路由决策（已脱敏，无消息原文）
- `/opt/amr/data/budget-ledger.json` —— 消耗台账
- `/opt/amr/data/feedback/` —— 用户 👍/👎
- 升级：用户给新镜像 tar → `docker load` → 改 compose 里镜像 tag → `up -d`（config/data 在卷上不丢）

## 如果 Docker 实在跑不了（内存 <1GB 的极端情况）

备选裸 Node：需要源码包（向用户索取 git 仓库访问或源码 tar），`apt install nodejs`（≥20）、
`npm ci --omit=dev`、`npm start`，用 systemd 或 pm2 守护。仅在 Docker 方案被否决时走这条路。
