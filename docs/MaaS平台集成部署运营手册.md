# MaaS 平台集成：把 auto 做成平台上的一个模型

> 目标形态：业务方在 MaaS 上多了一个 `auto` 模型——**同 URL、同 apikey**，调 auto 背后自动路由到各实际模型，实现成本/效率/效果最优。调用方零改造（仍是标准 OpenAI 协议）。
> 对应版本：v0.4.21+（`ROUTER_KEY_MODE=passthrough`）

## 一、架构与前提

```
业务系统 ──┐
          ├─→ MaaS 网关（统一入口，不动）
Agent/工具 ─┘      │
                   ├─ model=<具体模型名> → 原路直连（不经过路由器）
                   └─ model=auto         → 分流到 auto-router（本服务）
                                            │ 规则分类 →（可选）语义复核 → 评分选型
                                            ↓ 用调用方原 key 回调 MaaS
                                          实际模型（dsf/qwen/hy3/m25/m3…）
```

**关键设计**：路由器不接管所有流量，只接 `model=auto` 的分流。MaaS 平台侧只需要一个「按模型名分流」的能力。v0.4.21 起 `ROUTER_KEY_MODE=passthrough` 把客户端 apikey **原样透传回 MaaS**——租户计费、配额、审计都落在调用方头上，与直连完全一致，这才实现「共用同一 apikey」。

**部署前提**（Linux，2C4G 一台即可）：

1. Node.js ≥ 20（零 npm 依赖；用容器则无需本机 Node）
2. Docker 20+ / docker compose v2（推荐），或裸跑 Node + systemd
3. 与 MaaS 网关网络互通
4. MaaS 平台侧具备按 model 名分流的能力（见 §二「平台侧配置」）

## 二、怎么部署（交给平台/运维的标准动作）

### 方式 A：Docker Compose（推荐）

```bash
# 1. 拿代码（内网 git 或离线包）
git clone <内部仓库地址> auto-model-router && cd auto-model-router

# 2. 写 .env（关键变量就这几个）
cat > .env <<'EOF'
MAAS_BASE_URL=https://<maas-gateway>/v1     # MaaS 平台统一入口
ROUTER_KEY_MODE=passthrough                  # 同 URL 同 key 模式（核心开关）
HOST=0.0.0.0
PORT=8787
ADMIN_TOKEN=<管理端密码>                     # 管理页面用
# MAAS_API_KEY=<服务端兜底 key>              # 可选：客户端无 key 时的兜底
EOF

# 3. 一键起（router + 语义分类器双服务）
docker compose up -d
docker compose ps          # 两个容器 healthy
curl http://127.0.0.1:8787/health
```

### 方式 B：裸机 systemd（无 Docker 时）

```bash
git clone <内部仓库地址> /opt/auto-model-router && cd /opt/auto-model-router
# .env 同方式 A
cat > /etc/systemd/system/auto-router.service <<'EOF'
[Unit]
Description=Auto Model Router
After=network-online.target
[Service]
WorkingDirectory=/opt/auto-model-router
EnvironmentFile=/opt/auto-model-router/.env
ExecStart=/usr/bin/node src/server.mjs
Restart=always
RestartSec=3
User=nobody
[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload && systemctl enable --now auto-router
```

> 语义分类器（可选）裸跑：`scripts/serve_classifier.sh`。不跑也不影响主路由——shadow 模式错误自动吞掉，active 模式失败自动回退规则层。

### 平台侧配置（MaaS 网关分流）

实际落法取决于 MaaS 平台形态，二选一：

1. **平台有「模型注册/服务挂载」能力**（推荐）：注册一个名为 `auto` 的模型，后端地址指到 `auto-router:8787`。业务方 `/v1/models` 就能看到 auto，其余模型路由完全不动。
2. **平台没有该能力**：在网关（Nginx/APISIX/Higress）加一条按请求体 `model` 字段的分流规则——`model=auto` 转 `auto-router:8787`，其余原路直连。

两种方式都不改既有模型链路；分流规则与 TLS 终结参考 `docs/反代集成.md`。

## 三、怎么告诉别人用（业务方接入说明，可直接转发）

> **接入 auto 模型（零改造）**：你的 URL 和 apikey 都不用变，唯一区别是 `model` 填 `auto`。
>
> ```bash
> curl https://<maas-gateway>/v1/chat/completions \
>   -H "Authorization: Bearer <你的apikey>" \
>   -H "Content-Type: application/json" \
>   -d '{"model":"auto","messages":[{"role":"user","content":"你好"}]}'
> ```
>
> - 路由器读请求内容（文本特征、长度、多轮、工具/JSON 需求），自动选最合适的模型
> - 简单任务走低成本模型省钱，难任务走强模型保质量
> - 流式、工具调用、JSON 模式全兼容（OpenAI 协议全量）
> - 计费照旧：用的还是你的 key，账单落你的租户（路由器原样透传）
> - 想直连某个模型？照旧填具体模型名，互不影响

## 四、怎么实现成本/效率/效果最优（已具备的机制）

每次 `model=auto` 请求经过四段决策：

1. **规则分类**（<1ms）：正则+文本特征 → 任务类型（代码/推理/创意/抽取/通用）+ 三档难度（轻量/均衡/复杂）
2. **语义复核**（可选，~20ms）：自训练小模型（准确率 95.4%）二次确认；shadow 只观察，active 按置信度门槛采纳
3. **评分选型**：`score = 质量 − 0.22×成本 − 0.12×时延 − 不确定性 + 自建奖励 − 熔断惩罚`；质量底线（qualityFloor）拦截不达标模型
4. **故障转移**：首选模型失败按 fallbackOrder 自动换模型重试（最多 maxAttempts 次），熔断器隔离故障模型

**基线对照**（454 条 heldout 回放，管理端「调整影响预估」面板（基线对照折叠区）可实时复测）：

| 路由策略 | 质量 | 成本指数 | 结论 |
|---|---|---|---|
| Zero-Router（全走最便宜） | 0.893 | 0.113 | 质量下限参照 |
| **当前线上策略** | **0.898** | **0.161** | 比 Zero 质量高 0.005，成本多 42% |
| Oracle（事后最优） | 0.902 | 0.190 | 质量上限参照 |

当前策略距理论最优质量差距 <0.5%，属健康区间。日常调参前先在「切换影响预估」看量化影响。

## 五、怎么运营（日常 SOP）

### 每天 5 分钟（值班）

1. 打开管理端 `http://<router-host>:8787/`，填 ADMIN_TOKEN 连接
2. 看七个指标卡：错误率、Fallback 次数、语义复核分歧率——异常按 §处置预案
3. 看运行监控最近请求列表有无红条（失败）

### 每周/每月

1. 「调整影响预估」面板展开基线对照：当前质量应落在 Zero 与 Oracle 之间且贴近 Oracle
2. 调参前先跑「切换影响预估」：多少任务会换模型、质量/成本怎么变，确认后再发布
3. 「质量评估」面板：小模型 task 准确率 95.4%/tier 94.1%，低于 90% 触发重训
4. 下游模型更新（如 Qwen3.8-27B 替换 3.6、M2.5 退网）：录入基准 → eval gate 实测 → replay 预估 → 灰度
5. 计费口径以 MaaS 租户账单为准，管理端成本面板做交叉核对

### 运营红线与切换判据

- 语义复核 shadow→active 判据（已固化）：真实流量 ≥500 条、分歧率 ≤5%、错误率 ≤1%、观察 ≥7 天；切 active 后从 minConfidence=0.5 灰度一周再降
- 模型退网：管理端关该模型启用开关 → fallbackOrder 自动重排，无需重启
- 新模型上线四步：管理端录入（质量分/成本/时延/部署）→ eval gate 50 条实测 → replay 预估 → 小流量灰度

### 处置预案（异常 → 动作）

| 症状 | 先查 | 动作 |
|---|---|---|
| auto 请求全 5xx | /health、/health/ready | upstream 不可达 → 查 MaaS 网关连通性；配置错 → 恢复 config/history/ 自动备份 |
| 某模型熔断频发 | 管理端模型健康列 | MaaS 侧限流/故障 → fallback 自动扛；必要时临时禁用该模型 |
| 错误率 >1% | 最近请求失败项 | 上游故障为主 → 报 MaaS；路由器缺陷 → 回滚上个 git tag |
| 租户计费疑义 | decision log | 按 requestId 查决策日志，给出模型选择依据 |
| 管理端连不上 | ADMIN_TOKEN | 轮换后旧值立即失效（时序安全比较），填新值 |
| 分类器挂了 | classifier 容器 | shadow 无影响；active 自动回退规则层（级联方式先升大模型再判，两级都挂才回退），服务不中断 |
| 429 频出 | 限流计数 | 正常保护；单租户长期顶格 → 调 config.rateLimit |

### 扩容与回滚

- 多实例：见 docs/反代集成.md（Nginx upstream 多 server + 共享只读 config 卷）
- 配置回滚：管理端每次发布自动备份到 config/history/，恢复上一份即回滚
- 版本回滚：`git checkout v0.4.20 && 重启`（相邻版本配置兼容）

## 五点五、新增模型上线流程（同 URL 新模型 ID，页面化五步）

> 2026-08-19 已实测演练（Qwen3.8-27B）。核心原则：**先录入未启用 → 实测校准 → 预估影响 → 再启用**。

| 步 | 操作 | 在哪做 | 通过判据 |
|---|---|---|---|
| 1 录入 | 管理端「模型管理 → 新增模型」按钮，输 ID（MaaS 实际名，注意大小写）| 页面 | 出现在表格，默认未启用，安全发布 |
| 2 质量实测 | `npm run eval:gate -- --model <ID>`（50 条真实生成+裁判打分）| 脚本 | 总均分 ≥0.7；分 task 得分回填 quality |
| 3 定价校准 | 拿到 MaaS 结算价后填「输入/缓存/输出单价」，成本指数自动重算 | 页面 | costIndex 与真实价一致 |
| 4 影响预估 | 页面直接改参数 → 「调整影响预估」自动重算 12 条典型任务 | 页面 | changedRate 可接受、平均质量不降 |
| 5 启用观察 | enabled 勾选 → 安全发布（高风险自动二次确认）| 页面 | 一周后 mine-decisions.py 画像 ok率≥0.9 |

**演练实录（Qwen3.8-27B）**：
- 教训 1：模型 ID 大小写敏感。用户说 "Qwen3.8-27b"，MaaS 实际是 `Qwen3.8-27B`——第 2 步 eval gate 403 直接暴露（403「不在订阅套餐内」=ID 错或未订阅），`GET /v1/models` 一查便知。**录入前先查一遍。**
- 教训 2：`calibrationStatus` 枚举只有 `pilot/unverified/verified`（无 pending）——按钮模板已按此修正。



**测试方法学四坑（2026-08-19 Qwen3.8 案例实录：伪 0.774 → 真 0.921）**：
1. **裁判必须同一**：不同裁判宽严尺度不可比。基线谁裁的，对比就谁裁。外部强裁判用 `--judge "url=https://api.z.ai/api/coding/paas/v4|model=glm-5.3|key=GLMCODE_API_KEY"`（GLM Coding Plan key 走 coding 端点，通用 paas/v4 会报无资源包）。
2. **max_tokens 别太紧**：思考型模型 reasoning 烧额度，1024 会导致 content 为空记 0 分。生成 8192 / 裁判 2048。
3. **裁判失败≠模型 0 分**：裁判 JSON 解析失败要重试并记 null 剔除，不能记在被测模型头上。
4. **超时=0 分是最大伪影源**：慢模型串行单跑 + `EVAL_GATE_TIMEOUT_MS=300000`；5 路并行会互相挤带宽放大超时。**「某能力项明显退化」先查失败条目明细，再下结论**。

## 六、还剩什么要做（按优先级）

| 优先级 | 事项 | 说明 |
|---|---|---|
| **P0** | 平台侧分流配置 | 注册 auto 模型或网关规则——唯一硬依赖，需与 MaaS 平台方对齐 |
| **P0** | .env 三变量 | MAAS_BASE_URL / ROUTER_KEY_MODE=passthrough / ADMIN_TOKEN，1 分钟 |
| P1 | 语义分类器 | compose up 自带；不跑也可用（自动回退规则层） |
| P1 | shadow 流量累积后切 active | ≥500 条/分歧 ≤5%/错误 ≤1%/观察 ≥7 天，从 minConfidence=0.5 起步 |
| P2 | Prometheus 接 /metrics | 设 METRICS_TOKEN；对接内网监控时做 |
| P2 | 反代 TLS | docs/反代集成.md 有现成 Nginx 配置 |
| P3 | eval gate 与模型演进同步 | Qwen3.8-27B 上线、M2.5 退网时按 SOP 更新 |
| P3 | 公开前脱敏 | router.json 内网端点等，公开仓库前必做 |

## 七、持续迭代飞轮（v0.4.22+）

路由效果不是一次调好的。三个质量信号源已就位，形成闭环：

```
真实流量 ──→ 决策日志 data/decisions/*.jsonl（每次路由的完整决策+usage+实际成本）
              │
              ├─ 周度：python scripts/mine-decisions.py
              │    ├─ 模型×任务×档位画像（ok率/P50延迟/成本合计）→ 调参建议
              │    ├─ 隐式负信号（同会话短间隔重试）→ 定位差模型
              │    └─ 高置信训练样本候选 → 人工审核并入 data/training/raw.jsonl
              │
              ├─ 业务方可选：POST /admin/api/feedback {requestId, rating: good|bad}
              │    └─ data/feedback/*.jsonl（显式质量评价，与决策日志按 requestId 关联）
              │
              └─ 训练管线（已有）：train_classifier.py → eval gate → replay 预估 → shadow → active
```

### 周度运营节奏（30 分钟）

1. `python scripts/mine-decisions.py --days 7` 看画像
2. 三个判断（对照脚本尾部的调参建议表）：
   - 某 ok 率 <0.9 且 n≥20 → 管理端下调该模型 quality 或调大 livePenalty
   - 某 task 的 tier 判定集中出错 → 第 3 部分候选样本审核后并入训练集
   - 重试集中某模型 → 查 /metrics 熔断记录
3. 变更走标准链：管理端改 → 切换影响预估 → 发布（自动备份）→ 观察一周
4. 训练集更新后：`train_classifier.py` 重训 → eval gate 过门槛 → replay 灰度预估 → shadow → active

### 为什么不用数据库

状态就两类：配置（config/router.json，发布自动备份）与日志（按天 JSONL，可 grep 可 scp）。
量级（日万条 ≈10MB）远未到需要数据库的程度；日志格式与训练管线同构，零转换。
将来日百万条或需在线 SQL 时，SQLite/ClickHouse 起步——schema 是超集，只换介质。

## 八、部署核对清单（交付另一台服务器前逐项打勾）

- [ ] `node --check src/server.mjs` 通过（语法）
- [ ] `npm test` 全绿（当前 80+ 用例）
- [ ] `.env` 不在包内（tarball 用 git archive 生成，天然排除）
- [ ] 内网端点/IP 已确认可保留（私有仓库交付）或已脱敏（公开交付）
- [ ] `config/router.json` 的 models 定价与 MaaS 实际结算价一致
- [ ] 首次部署机器：Node ≥20 / Docker 二选一；Python 3.10+（分类器，可选）
- [ ] `.env.example` 已按目标环境补全（ROUTER_KEY_MODE 按场景选 strict/passthrough）
- [ ] compose 部署：`docker compose up -d` 后 `curl :8787/health` 返回 ok
- [ ] 管理端首次登录：ADMIN_TOKEN 设置且非弱值
- [ ] 上线一周后：跑 mine-decisions.py 建立基线画像
