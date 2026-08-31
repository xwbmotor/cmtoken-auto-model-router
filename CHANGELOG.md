# Changelog

本项目的显著变更记录。版本号遵循 [SemVer](https://semver.org/)：补丁版本=缺陷修复，次版本=功能新增。

## [0.11.8] - 2026-08-31

「从上游发现模型」改标准两步流水线向导（用户实测反馈：端点/key 应管理员自己填，注册应是分步流水线）：
- 第 1 步：两行输入框填上游端点 URL + API Key（密钥 password 框，只用于本次拉取——不落 config/git/日志）；可折叠「用服务端 .env 已配的上游」；
- 第 2 步：探测→勾选→「纳入所选（n）」（未勾选禁用+联动计数）；失败态「← 回上一步改端点/密钥」可返回重填；
- 后端新增 POST /admin/api/discover-probe：接受 {baseUrl, apiKey} 现场探测，key 一次性使用不落盘；错误信息区分 401（key 错）/网络不可达/URL 格式；
- 结构修复：discoverModal/evalModal 从 .tab-page 内挪到 main 末尾（body 级）——此前弹层挂在 tab 页内，tab 未激活时弹层 rect 全 0 不可见；
- 实测确认：移动 MaaS 端点确实只有 3 个模型（/models 200 全列、变体路径 403/412），发现功能无遗漏。

## [0.11.7] - 2026-08-31

「从上游发现模型」弹层交互重做（用户实测反馈：缺端点信息/无确认取消按钮/文案术语化）：
- 弹层头部显示上游端点 URL + 遮蔽密钥（key 只显前6后4，永不出明文）——一眼确认连的是哪个上游；
- 三态按钮齐备：加载中可「重试/关闭」；成功态「刷新列表 / 取消 / 注册所选（n）」（未勾选禁用，勾选联动计数）；失败态「重试 / 关闭」+ 配置指引（.env 变量名）；
- 失败文案带具体缺口：错误信息区分「端点未填 / 密钥未配」（原来只报笼统的 UPSTREAM_BASE_URL / MAAS_API_KEY）；
- 文案去术语：「新模型默认不启用、校准状态 pilot」→「新纳入的模型不会立即上线：先补归属、定价、质量分，确认后再手动启用」；
- 「已注册（不可重复注册）」→「已在列表中（无需重复添加）」。
- 实测：mock 上游全链路（勾选联动/禁用态/注册进列表/端点显示）+ 失败态（无上游时错误信息+重试+关闭）playwright 验证通过，零 pageerror。

## [0.11.6] - 2026-08-31

P1 管理台事件绑定全面失效（用户实测发现）：
- 根因：v0.5.0 删除「组件体检」面板时未同步删 app.js 的两个死绑定（#evalClassifier/#replaySwitch，元素已不存在）——模块在绑定处 TypeError 中断执行，其后所有事件绑定失效 8 天（从上游发现模型/交错评测/离线横幅/eval 取消按钮全部无响应）。API 级测试与 node --check 均无法覆盖此类「UI 绑定中断」问题。
- 修复：删除 38 行死代码（两个 onclick 块，后端 classifier/evaluate 与 /replay API 保留——测试与运维仍使用）。
- 新增 tests/admin-smoke.test.mjs：真实浏览器（playwright）冒烟——登录后断言零 pageerror + 发现按钮点击后弹层打开（绑定生效证明）。无 python3+playwright 环境自动 skip。
- 教训沉淀：删 HTML 面板必须 grep 对应 JS 绑定；UI 功能必须有浏览器级冒烟。

## [0.11.5] - 2026-08-31

二十四审收口（3×P1 + metrics 口径）：
- P1-2（方案升级）Judge Guard fail-closed 内收 `JudgeGuard.settle()`：tokens 非有限非负 number（含 `Number(null)/''/false→0` 隐式陷阱）一律按本 reservation estTokens 结算——六条调用路径统一覆盖（生产质量评审/task-check/交错评测/解析失败/异常/幂等），删除三处调用方 8000/2000 硬编码；
- P1-1 JSON 导入值类型化 schema：scores/evalGate=数值 [0,100]、subtasks={avg,n}、双 meta={at,judge,note} 限长；键白名单 + `__proto__/constructor/prototype` 保留名拒绝；非法项跳过并 issues 回显（top 20）；
- P1-3 交错评测题内模型循环每次 `callUpstreamChat` 前检查 cancelRequested——取消后不再为剩余模型付费；
- P2 metrics `judgeBump('tokens')` 只记真实报告值（缺失不记 0，防低估误导对账）；
- 新增 tests/import-schema.test.mjs：导入 e2e（合法入/恶意值拒/保留名拒/issues 回显/落盘校验）+ Guard 七形态单元测试（number/null/undefined/字符串/false/负数/合法0 + ok:false 无 tokens 预占 + estTokens 因路径而异）。

## [0.11.4] - 2026-08-31

二十三审收口（2×P1 + P2）：
- P1 生产 Judge settle fail-closed：异步质量评审（estTokens 8000）与 task-check（2000）两处 usage 缺失时按预占结算——不再只修交错评测路径（修 bug 修类不修点：全仓 `settle.*|| 0` 清零）；
- P1 回放 modelShifts 键 escHtml（同段 modelDist 已修，此为二十三审 git show v0.10.5 对照发现的同类漏点）；
- P2 JSON 导入键白名单：benchmarkScores 各层键须匹配 /^[a-zA-Z0-9_.-]{1,64}$/，非法键跳过并记录（bsImportIssues 回显）——任意 HTML 不再能经导入进前端 title/文本；
- 同类自查：settle `|| 0` 全查无残留；app.js `.map(([k,v]) => ${k})` 模式全查无候选裸拼。

## [0.11.3] - 2026-08-31

二十二审收口（2×P1 + P2 全修）：
- P1 XSS 真收口：基线 modelDistribution（v0.11.2 实际漏改处）、回放 modelDist 缩写链、benchmarkScores 键（title 属性+文本双处）、画像 meta.at/judge、4 处模板串裸 e.message——全部 escHtml；
- P1 Judge token fail-closed：settle 在 usage 缺失/非法时按预占 estTokens(8000) 结算（兼容端点不回 usage 也不能免费过 dailyMaxTokens 闸）；
- P2 cancelled 前端完整：轮询增加 cancelled 分支（停轮询+如实显示已完成/计划量）；评测弹层新增「取消任务」按钮；
- P2 significant 三态：null 显示「显著性不可判定」（区别于 false 不显著）；judgeReadyRate 分母改为全部非预热成功作答（含无 rubric——覆盖率不再虚高）；
- P2 classifier 门禁强绑定：OCI revision 必须等于 git tag v{classifierTag} 指向的 commit（rev-parse 'v0.9.7^{commit}'），任意历史 commit 不再通过；classifierTagCommit 入 release 报告；
- P2 测试精化：Judge 恰被调 1 次断言（首次 settle 8000 后超限）、脏分用非法值 'abc'（真过滤路径；实测确认 -5/100 是 clamp 语义会入分，只有非法值丢弃——语义如实入注释）。

## [0.11.2] - 2026-08-31

二十一审收口（3×P1 + P2 前端契约）：
- P1 XSS 剩余点收口：模拟 impact（before.model/row.model）、敏感度 nextFlip.from/to、基线 modelDistribution 模型名、Pareto 前沿、三处 e.message/j.error 进 innerHTML 全部 escHtml——发现→注册链在全页面不再可达；
- P1 Judge token 记账：交错评测 settle 带真实 usage.total_tokens（dailyMaxTokens 不再可被连续评测绕过）；
- P1 cancel 全类型生效：runEvalJob（checkup/full）执行循环补 cancelRequested 检查；
- P2 前端 pairwise 契约：读 qualityDiff.mean + p.significant + 显示配对题数（此前恒显示「样本不足」）；judgeReadyRate/judgeSkip{budget,error,noRubric} 渲染——覆盖率过低明示「质量结论不可采信」；
- P2 测试补强（eval-interleaved-3）：Judge 请求实际含原题正文与未截断全文答案（尾部标记断言）、越界分 100/verifiable:false 脏分过滤（judgeScore 恒 7）、低 dailyMaxTokens 预算真实耗尽进 judgeSkip.budget、checkup 运行中取消最终 cancelled。

## [0.11.1] - 2026-08-31

二十审收口（P1×5 + P2×6 全量修复）：
- P1 XSS 全页面收口：能力矩阵/画像/能力表/部署表/基线报告（displayName×5 + m.id×3）、任务榜 picks、市场信号模型名、基线 arm 名与 highlights 全部 escHtml——上游恶意模型 ID 经发现-注册链不再可注入；
- P1 交错评测 Judge 看得到原题：results 保存完整 prompt 与全文 answer（截断交给 buildJudgeMessages 的 12000 预算），c_prompt 含原题正文+rubric 附注；
- P1 评分规范化：Judge 维度统一过 normalizeDimension（[0,10] 归一、verifiable:false 置 null），与生产质量评审同规范；summary 新增 judgeReadyRate + judgeSkip{budget,error,noRubric}——缺失原因不再静默；
- P1 JudgeGuard 预算接入：交错评测 Judge 调用走 reserve/settle（dailyMaxCalls/Tokens/熔断与生产同一 Guard），超额即停并标注；新增任务取消端点 POST /admin/api/eval-jobs?action=cancel（执行与 Judge 循环均检查 cancelRequested）；
- P1 发布门禁绑真实 commit：classifier revision 除 40 位 SHA 格式外须 git cat-file -t 验证为仓库真实 commit（伪造全零不再通过）；
- P2 两两比较改配对 bootstrap：同 caseId 求 scoreA−scoreB 后重采样（保留题目难度协方差；恒定领先场景 CI 正确收窄）；pairwise 带 pairedN 与 significant；
- P2 交错顺序逐题轮换（Latin rotation）：第 k 题从 modelIds[k%N] 起始，消除「A 永远先答」的位置/负载偏差；预热改为每模型前 2 次「调用」（不再吞掉题库前 2 题）；
- P2 modelIds 去重（[A,A] 拒绝）；bootstrap 单样本 lo/hi=null 契约对齐；
- 测试：bootstrap 契约更新、interleaved 断言强化（轮换顺序/独立预热/配对显著/judgeReadyRate/全模型 config 不变）、新增 eval-interleaved-2（去重+取消端点）。

## [0.11.0] - 2026-08-31

交错评测（十六~十九审规划的能力正式落地）：
- 新增 src/bootstrap.mjs：无依赖 bootstrap 置信区间（bootstrap/bootstrapDiff，Mulberry32 固定 seed 可复现；同 seed 同区间，报告可复核）；
- 新增评测任务类型 interleaved：2-4 模型同窗口轮转执行 56 题（每模型前 2 题预热不计分），Judge 按 rubric 四维评分（复用 callJudgeModel/parseJudgeJson，rubric v2.1）；
- 汇总：每模型质量分 95% CI + 时延 95% CI + 两两质量差显著性（CI 不含 0 = 显著）；样本 <3 不出 CI（如实标注）；
- 仅建议值：不自动改质量分/时延参数——采纳需管理员在「模型参数」页确认后发布（与 v0.10.2 以来的口径一致）；
- Judge 通道支持 JUDGE_BASE_URL/JUDGE_API_KEY 独立配置（评审与业务上游分离）；Judge 未配置时如实降级（仅时延统计，质量列标不可用）；
- 管理页新增「交错评测」入口：模型汇总表（质量/时延 CI）+ 两两对比 + 显著性标注 + 建议值提示；
- 新增 tests/bootstrap.test.mjs（4 测试：可复现/边界/显著性/median）与 tests/eval-interleaved.test.mjs（黑盒：mock 上游+mock Judge 全链路，断言交错顺序/预热排除/CI 区分/仅建议值不改 config）。

## [0.10.5] - 2026-08-31

十九审收口（v0.10.4 收敛后封板版）：
- P1 XSS：最近请求面板 selected/requested/keyFingerprint（含调用方指纹下拉）与语义模型下拉 option 全部 escHtml——关闭客户端可控字段的存储型 XSS 链路；
- P1 EWMA 语义回归修复：updateHealthState 恢复与 server 原实现等价——成功与失败都更新 ewmaLatencyMs（失败/超时时延同样形成动态时延惩罚）；
- P1 classifier 证据链：门禁 classifierRevisionIsSha 要求 OCI revision 为 40 位 Git SHA（unlabeled/伪造串不再通过），release 报告新增 classifierRootfsLayers 层 digest 证据；
- P2 空响应记账：评测 failed 统一口径=!ok 或断言失败；errorType 统一分类（empty_response/timeout/http_401_403/http_429/http_5xx/http_4xx/invalid_payload/other），不再漏计空正文；
- P2 判定单一事实源：/admin/api/model-offline-alerts 端点改调 health.mjs 的 offlineAlertDue()（与单测共用，防测试与生产漂移）；新增「已开熔断但失败证据过期不告警」测试分支；
- P2 依赖锁定：新增 requirements-classifier.lock（sklearn 1.9.0/joblib 1.5.3/numpy 2.4.6/scipy 1.17.1 精确版本），Dockerfile.classifier 改用锁文件安装；
- P2 题库路径：loadEvalGateCases 支持 AMR_CONFIG_DIR 覆盖（与 router.json 同构，测试/多实例部署）；
- 新增 tests/eval-full.test.mjs：full 巡检黑盒测试（mock 上游覆盖正常/空正文/500/双 task，断言 readyRate/errorTypes/byTask/failed 全字段）。

## [0.10.4] - 2026-08-30

十八审收口（v0.10.3 错配与遗留问题）：
- P1 full summary 前端按 type 分支渲染：readyRate/byTask/errorTypes（56 题稳定性巡检不再显示 NaN% 与 —/—）；
- P2 XSS 全面关闭：模型主表 displayName/id、发现弹窗已注册列表全部 escHtml；
- P2 手工新增模型默认 ownership=unknown（与发现入口一致）；
- P2 候选池测试改读真实字段 candidate.model；rejected 断言强化（拒因必须含 ownership_unconfirmed）；
- P2 health 行为测试：src/health.mjs 抽出可单测模块，6 个测试覆盖 downSince 触发条件/恢复清零/下线判定（含“无流量≠宕机”）；
- P2 classifier 证据链：Dockerfile.classifier 加 ARG GIT_REVISION + LABEL org.opencontainers.image.revision；发布门禁增加 classifierRevisionLabeled 校验；
- 重建 .venv：删除损坏虚拟环境，按 requirements-classifier.txt 重建（Python 3.11.5），记录验证组合 sklearn 1.9.0 + numpy 2.4.6 + scipy 1.17.1 + joblib 1.5.3。

## [0.10.3] - 2026-08-30

十七审收口（v0.10.2 遗留问题全量落实）：
- P1 unknown fail-closed：config 校验拒绝 enabled=true && ownership=unknown；路由层 double-check（ownership_unconfirmed 拒因）；管理页归属列改下拉框（自建/生态/归属待定），选回 unknown 时自动取消启用勾选；
- P1 下线误报修正：downSince 只在熔断首次打开时设置（首失败≠宕机）；告警要求 circuitState≠closed 且 lastFailureAt 10 分钟内有失败证据（无流量不是故障证据）；横幅改读新字段（downMinutes/halfOpenFailStreak）并 escHtml 转义；
- P1 full 任务补 summary：就绪率/时延分布/分任务成功率(byTask)/错误类型分布(errorTypes)；
- P1 回归测试：unknown 启用保护（config 校验）+ 路由排除（ownership_unconfirmed 进 rejected）；
- P2 门禁增强：题库必须合法 JSON 且 56 题；classifier 镜像 tag 必须存在且本地有镜像证据（允许与 router 不同版本）；
- P2 体检 confirm 文案 8题→6题；自建加分换算 0 权重语义（“权重为 0，不影响对比”）+ 权重滑条变动联动刷新换算提示。

## [0.10.2] - 2026-08-30

十六审收口（外部评审意见全量落实）：
- P1 发布复现：docker-compose.prod.yml 镜像版本随发版更新（0.9.7→0.10.2）；发布门禁新增 composeVersionMatches + evalGateCasesPresent 两项校验；
- P1 语义纠偏：「完整评测」改名「稳定性巡检」（就绪率+时延分布，不含质量评分——质量分仍以带裁判的 eval:gate 为准）；删除「自动回填质量分」表述；
- P1 体检如实：6 题冒烟如实标注（非 8 题）；SQL 断言大小写无关（GROUP BY 不再误判）；结果只出断言通过 x/y + 建议平均时延（人工确认后手工采纳，不自动改 config）；去掉 6 样本伪 P95；
- P1 下线提醒重做：旧条件（失败≥20 次/熔断≥1h）在熔断机制（3 次失败隔离+30s 冷却）下不可达——改为独立 downSince 状态模型（持续不可用 ≥30min，或半开探针连败 ≥3 次且 ≥10min）；
- P2 归属安全：发现注册默认 ownership=unknown（不参与自建加分），发布前必须人工改为自建/生态；归属列显示「归属待定」；
- P2 XSS：发现列表模型 ID 经 escHtml 转义；
- P2 自建加分换算修正：按真实权重换算（加分 0.2 在成本权重 0.22 下≈可容忍 0.91 成本指数差），不再误导性等值表述。

## [0.10.0] - 2026-08-30

- 模型管理流水线（运营向）：
  - 上游模型发现：管理台「从上游发现模型」按钮，代理调 MaaS `GET /v1/models`（30s 缓存），勾选即注册——新模型默认不启用、校准状态 pilot，不进调度池；
  - 在线测评：每模型「体检」（8 题冒烟，~1-2 分钟，成功率/断言通过率/时延，自动回填 avgLatencyMs）与「完整评测」（56 题 eval-gate 题库，进度条实时可查，单任务串行防打爆上游）；
  - 下线提醒：熔断持续 ≥1h 或连续失败 ≥20 次的启用中模型在管理台横幅提示建议关闭（只提醒不自动关，管理员拍板）；
  - 自建加权直观化：selfHostedBonus 滑条移至 preferSelfHosted 开关旁，实时换算提示（加分值≈可容忍的质量分差/成本指数差）。
- 新端点：`GET /admin/api/discover-models`、`POST|GET /admin/api/eval-jobs`、`GET /admin/api/model-offline-alerts`（均需管理员鉴权）。

## [0.9.8] - 2026-08-30

- Judge rubric v2.1 头尾兼顾截断：评审输入预算内 70% 保末段（agent 长对话的任务上下文在末尾，原掐头截断导致 correctness/completeness 不可核验率 83%/71%）；
- 新增 `scripts/blind-review-export.sh` 盲审样本导出（judge 事件+决策日志原文关联 → xlsx，人工列黄色/judge 对照列灰色）。

## [0.9.7] - 2026-08-25

### 校准
- 模型质量分按十五审校准：全部对齐 eval-gate 2026-08-20 实测（GLM-5.3 judge）；qwen36 default 剔除 Token 歧义题（0.835→0.894）；Qwen3.8 coding 拆条件质量×可用性（0.955→0.930，历史空输出 bug 已修但未重测折让 1%）；新增 qualitySource 字段记录每格数据血缘。判据：三模型总分 95% 区间高度重叠（0.908/0.917/0.920 无显著差异），0.01 级差不作为选型依据

## [0.9.6] - 2026-08-25

### 功能
- 数据留存模式（训练数据采集期）：`decisionLog.redactMessages=false` 请求原文全量落盘；`decisionLog.logAnswerText=true` 回回答原文落 `outcome.answerText`（流式/非流式两条交付路径，256KB 上限）。两开关独立、热更新；管理页新增「请求原文留存/回答原文留存」；默认均关闭（保持脱敏）

## [0.9.5] - 2026-08-25

### 规范化
- 全库清理版本痕迹：代码注释（267 处）、管理页 tooltip 与标题、文档——历史演进记录统一归档至本文件，代码与界面只描述当前行为
- README 重写为标准开源项目结构（特性/快速开始/目录/测试/文档）
- Judge 抽样率默认提升路径：低流量期可调高（当前线上 50%），日常回 1%~10%

## [0.9.4] - 2026-08-25

### 安全
- 评审密钥文件 `data/judge-secret.json` 写入与启动时强制 `0600` 权限
- 外部评审端点强制 HTTPS（内网回环地址放行 HTTP）
- 管理会话 Cookie 在 HTTPS 下附加 `Secure`
- 管理页不再将 ADMIN_TOKEN 持久化到 sessionStorage

### 修复
- `server.mjs` 行尾归一化遗留的 1977 个重复空行（纯格式提交）

### 工程化
- 新增 `requirements-classifier.txt` 锁定分类器 Python 依赖

## [0.9.3] - 2026-08-25

### 安全
- 管理端登录页与会话门禁：`POST /admin/api/login` 验 ADMIN_TOKEN 换 HttpOnly+SameSite=Strict 会话 Cookie（2h 空闲 / 12h 绝对上限）；静态管理资源无会话回登录页；`/admin/api/*` 兼容 Bearer 或会话；登出端点与管理页登出按钮

## [0.9.2] - 2026-08-25

### 功能
- 评审模型调用通道管理端可配（端点+Key），与业务 MaaS 通道解耦；Key 不经管理 API 回显、不进策略配置、不入 git

## [0.9.1] - 2026-08-25

### 修复
- 「Oracle/基线」表述去歧义：静态任务质量先验的启发式参照，非逐请求 regret；heldout 准确率口径注明合成同分布
- 评审护栏持久化异步化：合并写+串行异步链，不再阻塞事件循环；关停时排空

## [0.9.0] - 2026-08-25

### 功能
- Auto 对外模型名可配置（生产 `cmtoken-auto`，硬切换：旧名 `auto` 返回 400）
- 模型发现默认只暴露 auto 入口（`exposeModelList`）
- 评审熔断状态指标恒输出（closed=0 不再缺失）

### 破坏性变更
- 客户端 `model` 必须填 `cmtoken-auto` 或留空；旧名 `auto` 立即 400

## [0.8.4] - 2026-08-25

### 修复
- 请求体解析错误类型分型：非法 JSON（400 invalid_request_error）与不支持的压缩编码（415 unsupported_content_encoding）不再互相误标

## [0.8.3] - 2026-08-25

### 修复
- 评审护栏半开探针状态机（预算前置、探针回滚、不变量校验）
- 护栏状态原子持久化与管理面/指标暴露（guard 快照、persistErrors、恒输出 gauge）

## [0.8.2] - 2026-08-25

### 修复
- 评审护栏与管理面若干正确性问题（详见 git log）

## [0.8.1] - 2026-08-24

### 功能
- 压缩请求体兼容（gzip/deflate/br/复合编码，防压缩炸弹）

## [0.8.0] - 2026-08-24

### 功能
- 异步质量评审器（Judge）：HMAC 稳定抽样、rubric 版本化、四维评分、每日预算、熔断、独立事件流 `judge-reviews-*.jsonl`；默认关闭

## [0.7.0] ~ [0.7.4] - 2026-08-22 ~ 2026-08-25

### 功能与加固
- 三层分类级联（规则置信度→小模型→大模型）与灰度分桶（HMAC secret）
- 语义复核事件流 `semantic-reviews-*.jsonl`、决策日志请求级幂等
- 成本分账五元组恒等式、会话指纹脱敏（sidfp）、SIGTERM 排空、发布门禁（test:release）

## [0.5.x] ~ [0.6.1] - 2026-08-19 ~ 2026-08-23

### 早期版本
- 路由核心（规则分类、评分选型、fallback、预算预占-结算）
- 管理端 Web UI、Prometheus 指标、passthrough 模式
- 详见 git log
