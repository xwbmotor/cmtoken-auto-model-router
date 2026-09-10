# M3：鉴权、耐久计费、重试与配置热更新

M3 已接入真实 Go HTTP 链路，可在受限环境验证生产运行合同。沿用本次迁移约定：独立分支、不切换线上，监听与出站仍强制 loopback，`productionReady` 保持 `false`。管理台、生产部署和业务容量验收仍按 M4/M5 推进。

## 运行入口

后续已加入[原生决策输入与本地配置快照](NATIVE_FEATURES.md)：新运行模式请求不再调用 Node `/assess`；使用 `--runtime-config` 可同时移除启动/热更新对适配器进程的依赖。以下旧适配器入口仍用于协议对照，鉴权、计费、重试和完整配置代的约束继续适用。

原有 M1/M2 对照命令保留。完整运行模式新增 `--runtime`，必须指定独立的 `--ledger`；原生 L1 自动启用，语义复核仍须显式 `--native-semantics` 和本地分类器端点。

```powershell
./data/go-migration/amr-core.exe --lab --runtime `
  --auth-config ./data/go-migration/auth.local.json `
  --ledger ./data/go-migration/runtime.wal `
  --assessor http://127.0.0.1:8789/assess `
  --upstream http://127.0.0.1:8790/v1/chat/completions
```

`auth.local.json` 是受保护的本地凭据文件，字段为 `mode`、`accessToken`、`upstreamToken`、`adminToken` 和可选 `tenants`。每个 tenant 包含 `accessToken`、`upstreamToken`。不要提交文件或将实际凭据粘贴到聊天、命令行参数、日志。

未指定文件时，启动读取 `ROUTER_KEY_MODE`、`ROUTER_ACCESS_KEY`、`UPSTREAM_API_KEY`（备选 `MAAS_API_KEY`）、独立的 `AMR_GO_ADMIN_TOKEN`。指定文件则**完整替换**这些环境配置，省略字段不会继承旧凭据。文件轮换采用写临时文件后原子替换，再调用热更新；程序不自动读取 `.env`。

`AMR_GO_ASSESSOR_TOKEN` 仍是 Go 与 Node 适配器间的独立私有凭据。上游端点、适配器凭据和进程上限由启动参数固定，本轮不通过客户端请求改变。

## 鉴权边界

| 模式/接口 | 行为 |
|---|---|
| `strict` | 验证网关访问凭据，按服务端配置映射到上游凭据；错误或缺失凭据返回 401 |
| `passthrough` | 只接受合法、非空的 Bearer token，作为有效上游凭据；不降级使用服务端账户 |
| 管理接口 | 单独验证 `adminToken`，不因 passthrough 非空凭据而授权；未配置 admin 即关闭 |
| 管理凭据用于模型调用 | 拒绝，避免将管理凭据发往上游 |
| 模型资格 | 仍以有效上游凭据查询 `/models`，沿用 M2 的隔离缓存和上游最终授权 |

客户端 Cookie、内部 revision/语义标记和其他调用头不转发到上游。Go 只重建必要的 Content-Type 与 Authorization。与 Node 本机开发旁路不同，M3 数据面始终要求鉴权；管理员 API token 不等同于 Node 管理台登录会话。

## 计费与恢复

- 单位为整数微元（1 元 = 1,000,000 微元）。回答与分类器调用按 `answer` / `classifier` 分项；实际 usage 与估算费用分列。
- 每次上游尝试有独立随机请求 ID 与 attempt ID。发出请求前先将预占记录写入 WAL 并 `fsync`，成功后使用合法 usage 冲正一次；缺失或无效 usage 保留估算。失败尝试不会因随后回退成功而被抹掉。
- token 数须为有限、非负整数；缓存 token 不得超过输入 token。实际 completion 已包含 reasoning，不重复收费；预估 reasoning 与缓存比例沿用 Node 公式。
- L3 返回合法 usage 但分类 JSON 解析失败，仍计实际费用；分类器失败没有 usage 时保留估算。当前进程的 L3 调用/token 守卫跨热更新共享，金额账本跨重启恢复。
- `budget.enabled` 且 `dailyBudgetYuan > 0` 时，金额闸门在锁内同时检查已结算＋在途＋新增预占；未定价调用被拒绝。实际 token 可能超过启发式估算，因此闸门不是外部供应商账单的绝对封顶保证。未启用金额闸门时，未定价请求单独计数。
- 启动按顺序和 SHA256 校验重放。未写完的最后一行截断恢复；完整损坏记录拒绝启动。崩溃留下的预占继续占用额度，不能自动当作“未调用”释放。
- 账期按配置时区，每日已结算归属结算日，跨日未结算预占持续保留。热更新不允许改时区。
- 写入或同步失败后停止新的上游调用，健康接口返回 503；已发出的响应无法撤回，不伪装成已经耐久结算。修复存储后受控重启并恢复 WAL。

WAL 使用 Windows/Linux 系统文件锁；第二个写入进程会拒绝启动，进程退出后锁自动释放。当前交付限定**一个权威运行进程、本地持久磁盘**，并发、健康、会话和分类 token 守卫不是跨副本状态；不同目录的独立账本也不会自动合并。WAL 尚不压缩，应按磁盘容量安排受控归档。

旁路 `<ledger>.events.jsonl` 保存每次尝试的模型、配置 revision、状态、耗时、响应头/首字节时延、估算与实际金额；不记录正文、分类理由或凭据。WAL 是余额权威来源，崩溃时可能存在已预占但尚无最终审计行的尝试。

账本与审计分别由单个写入协程处理：每个队列最多 256 个待处理操作，每批最多合并 64 个已经排队的操作，不定时等待凑批。写入调用仍需等待所属批次的 `fsync` 成功才返回成功；校验、计费精度、逐行格式和恢复规则不变。任何写入/同步错误均使对应写入器停止继续写入，并让运行时拒绝后续新调用；关闭时排空已接收操作再关文件。这不是跨 WAL/审计文件的原子事务，也不改变已发出响应无法撤回的约束。

### 旧 Node 账本离线导入

导入是切流准备工具，本次没有读取或导入生产账本。必须先停止 Node 写入并冻结源文件，在同一账期核对摘要后导入到新的 Go WAL：

```powershell
./data/go-migration/amr-core.exe ledger-import --source-frozen `
  --source ./data/go-migration/node-ledger.frozen.json `
  --source-sha256 <已核对的文件SHA256> `
  --target ./data/go-migration/runtime.wal --time-zone Asia/Shanghai
```

导入当前 Node 的 `date`、`settledActualSpendYuan`、`settledEstimatedSpendYuan`、`estimatedSpendYuan`。旧 pending 合入 `legacy` 估算余额，不能默认为零；源文件保持不变。仅空 WAL 可首次导入，相同摘要与金额重复执行幂等；不兼容格式、旧账期、摘要变化和冲突均拒绝。正式切流仍需对账和回滚方案，不能让 Node 与 Go 同时接管同一份业务额度。

## 重试、熔断与流式传输

首选与回退模型来自同一次请求的合格集合；每次尝试前再核验资格、健康和当前并发额度，不扩宽租户、能力或质量边界。显式点名只尝试一个模型。

- 408、5xx、传输失败可在尚未输出时尝试下一个合格模型；最大次数来自 `routing.maxAttempts`，上限 16。
- 401/402/403/429、其他客户端错误、客户端取消不重试，也不污染共享模型健康。重定向被拒绝。
- 达到失败阈值后熔断，冷却后只允许一个真实请求作半开探针。没有额外后台付费探测；旧在途请求不能释放新探针。
- 每次尝试独立计时。非流式使用整次尝试超时；SSE 使用上游数据闲置超时。下游每批写入也有期限，慢读客户端不会永久占用额度。
- 已向客户端输出后，不进行模型回退、不追加错误 JSON、不伪造 `[DONE]`；中断连接并按已获取 usage 或估算结算。
- 会话粘性只在完整有效交付后建立。非流式响应有 2 MiB 上限，超大响应拒绝；SSE 持续转发，单条观察行超过 64 KiB 时保守地不认定完整交付。

CLI 收到退出信号后先停止接入、排空至 10 秒，必要时关闭连接，再等待结算和后台任务退出。金额账本连续；进程健康与会话在重启后重新建立。

## 配置热更新

Node 适配器从已验证的配置文件生成 `/runtime-config`：包含原始配置字节 SHA256 revision、L1、语义策略、价格、预算和重试参数；不含端点与凭据。Go 的整代 revision 同时绑定这个快照和本地鉴权配置。

1. 管理凭据调用 `GET /internal/v1/config`，读取 `ETag` / `revision`。
2. 原子更新本地鉴权文件和/或 Node 适配器使用的配置文件。
3. 调用 `POST /internal/v1/config/reload`，`If-Match` 携带读取的整代 revision。

缺少 revision 返回 428，过期返回 409，非法配置/RE2/凭据或构建失败返回 422，原代保持可用。完整验证、构建成功后一次切换；新请求获取新代，已有请求保留旧凭据、价格、分析器与重试策略。账本、并发计数、健康和 L3 守卫保持共享。

每次 Node 归一化调用携带固定的配置 revision，响应必须回显同一 revision；语义复核的再次归一化也不能切换版本。适配器最多保留 64 个配置快照，达到上限拒绝新快照而不驱逐在途版本；超过此范围需排空后受控重启适配器。

`GET /internal/v1/runtime` 返回账本、健康、预占与复核状态，仅管理员可读。管理台的草稿/影响预估/发布页面尚未改为调用 Go 接口；本轮验证的是文件发布与 API 的完整运行链路。

## 验证

`verify.ps1` 与 Linux CI 包含原有 5150 条 Node 差分、全部 Go 测试，以及新的 `demo-runtime.mjs` 真实进程演示。新测试覆盖鉴权隔离、逐尝试计费、失败 usage、半开并发、断流/取消/慢读、旧请求跨热更、非法配置、CAS、kill 后恢复和离线导入。Linux CI 额外运行 `go test -race`。

这些证据不代表真实模型效果、生产容量或完整管理台兼容性已验收；没有本次生产调用、部署或流量切换。
## M4 后续入口

管理台已增加可选 Go 配置状态与热更新面板，离线工具已增加 `ledger-export` 用于冻结后的 Node 账本回滚快照。操作方法、已验证范围及未满足的切换条件见 [M4](M4.md)。上文保留 M3 运行合同，管理台其余指标仍来自 Node。
