# -*- coding: utf-8 -*-
# 一次性生成器：30 官方小类用例集（已有 4 类 32 条 + 新增 26 类 52 条）
# 输出：config/subtask-eval.json（全量 84）+ config/subtask-eval-extra.json（新 52，本次实际要跑的）
import json, io, os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

E = []  # (id, sub, prompt, rubric)
def add(i, s, p, r): E.append({"id": i, "sub": s, "prompt": p, "rubric": r})

# —— CODE（已有4类外的5类）——
add("fe-01","frontend-ui",
"用原生 HTML+CSS 实现一个响应式三栏卡片布局：桌面三栏、平板两栏（第三张独占一行）、手机单栏。卡片含标题/图片占位/正文/按钮。不使用框架。",
"CSS grid 或 flex 均可；media query 断点合理；三档布局都正确；代码完整可渲染")
add("fe-02","frontend-ui",
"实现一个 Vue 3 组合式 API 的 useDebounce composable：导出 debouncedRef(value, delay)，值变更延迟生效，组件卸载时清理定时器。附使用示例。",
"用 customRef 或 watch+timer 实现；卸载清理（onScopeDispose 或 onUnmounted）；示例正确")
add("devops-01","devops-config",
"写一个 GitHub Actions workflow：main 分支 push 时跑 lint+test（Node 20，pnpm），测试通过后构建 Docker 镜像推到 ghcr.io/org/app:sha。要求有缓存。",
"触发条件正确；pnpm store 缓存；步骤顺序合理；镜像 tag 用 commit sha；secrets 引用规范")
add("devops-02","devops-config",
"写一份 K8s Deployment+Service YAML：3 副本、镜像 app:1.4.2、就绪探针 /healthz、资源请求/限制（cpu 250m/500m，mem 256Mi/512Mi）、滚动更新策略 maxUnavailable=0。",
"YAML 结构合法；探针与资源字段正确；策略字段正确；Service 选择器匹配")
add("shell-01","shell-execution",
"写一段 bash：把目录下所有 *.log 按日期归档到 archive/YYYY-MM/ 子目录（按文件修改时间），同名冲突加时间戳后缀，输出归档清单。要求处理文件名含空格。",
"find -print0/while read -r 处理空格；date -r 取修改时间；mkdir -p；冲突处理；清单输出")
add("shell-02","shell-execution",
"写一个 PowerShell 脚本：遍历 D:\\logs 下所有 .txt，找出含关键字 ERROR 的行，输出 文件名:行号:内容 到 result.csv（UTF-8 BOM）。",
"Get-ChildItem -Recurse；Select-String 带行号；Export-Csv -Encoding UTF8；处理中文路径")
add("fio-01","file-io",
"写 Python：读取一个 3GB 的 JSONL 文件（每行一个 JSON 对象），过滤出 status='error' 的行，输出到 errors.jsonl，并统计各 error_code 出现次数。要求内存占用恒定。",
"逐行流式读取；json.loads 异常行处理；Counter 统计；内存恒定（不全量读入）")
add("fio-02","file-io",
"写 Python：把目录下所有 .xlsx 的第一个 sheet 读出来合并成一个 CSV（文件名列作为首列）。用 openpyxl，处理空单元格与日期类型。",
"openpyxl read_only 模式；空值处理；日期转字符串；csv 写入编码 utf-8-sig")
add("repo-01","repo-scanning",
"接手一个 40 万行的 Java 单体仓库，需要梳理出所有对外 HTTP 接口清单。给出你的扫描方案（工具/命令/脚本思路），不要求贴完整代码。",
"多手段组合（grep 路由注解、静态分析、OpenAPI 生成）；思路分层；可落地")
add("repo-02","repo-scanning",
"仓库里有约 200 处 new Date() 的使用，要迁移到 java.time。设计一个渐进式迁移方案：如何找出全部使用点、如何分批改、如何防回归。",
"找出手段（IDE 结构搜索/grep/检查工具）；分批策略；回归防护（单测/契约/灰度）；考虑序列化兼容")

# —— AGENTS（6类）——
add("plan-01","multi-step-planning",
"一家省级运营商要对齐 21 个地市营业厅的工单口径，设计分层审核流程，说明每层职责、准入退出条件与回滚机制。",
"分层清晰（初审/复核/终审）；每层职责/准入/退出/回滚齐全；考虑地市差异；可执行")
add("plan-02","multi-step-planning",
"把一个手工报表流程（人工导 Excel→清洗→邮件发送）改造成自动化平台，工期 6 周、3 人。给出周粒度计划、里程碑、风险与应对。",
"周计划具体到交付物；里程碑可验收；风险识别合理；应对措施具体")
add("tool-01","tool-dispatch",
"一个客服 Agent 有 4 个工具：query_order(order_id)、query_logistics(order_id)、refund(order_id, amount)、escalate(ticket_id, reason)。用户说「我上周的订单还没到，而且扣了两次钱」。给出你的工具调用序列与理由。",
"先 query_order 查订单与扣款记录；据结果决定 query_logistics 或 refund；refund 前确认金额；escalate 仅在前者无法解决时；顺序有理由")
add("tool-02","tool-dispatch",
"你可用工具：sql_query(db, q)、read_file(path)、http_get(url)。任务：验证「2026 年 7 月某地市流量环比下降 20%」这个说法是否成立。写出你的工具调用序列（每步用什么工具、传什么参数），不要求真执行。",
"先明确口径（哪月/哪地市/什么流量）；sql_query 查两月数据；必要时 read_file 查口径文档；结论分情况；步骤有依赖关系")
add("wf-01","workflow-execution",
"设计一个内容发布工作流引擎的执行语义：步骤包括「AI 生成初稿 → 人工审核（可打回）→ 敏感词检查 → 定时发布」。给出状态机定义（状态/事件/转移/守卫条件）。",
"状态完整（草稿/待审/打回/检查中/待发布/已发布/失败）；事件与转移成对；打回可循环；守卫条件明确；无死状态")
add("wf-02","workflow-execution",
"自动化场景：每天 8 点拉取监控告警 API，把 P0/P1 告警按归属团队路由到不同飞书群，周末只发 P0。用文字描述节点编排与每个节点的配置要点。",
"cron 触发；API 拉取；过滤（级别+周末条件用表达式）；按 team 路由分支；飞书节点配置要点；异常兜底")
add("ws-01","web-search",
"你要调研「2026 年国内大模型 API 价格趋势」。没有真实搜索工具时，请先给出你的检索策略（查什么站点/关键词/时间过滤），再基于你已有知识给出已知事实，并明确标注哪些结论需要搜索验证。",
"检索策略具体（官方定价页/新闻/行业报告；关键词组合；时间过滤）；已有知识不编造；需验证结论明确标注；分清事实与推断")
add("ws-02","web-search",
"用户问「Python 3.13 相比 3.12 有什么重要变化？」你没有实时搜索工具。给出：你会搜索什么（具体 query）、你会优先信任哪些来源、以及基于已有知识的预填答案与置信度标注。",
"query 具体多组；来源优先级合理（官方 release notes > PEP > 媒体）；预填答案基于已知事实；置信度标注")
add("mem-01","memory-extraction",
"从下面这段对话中提取值得长期记忆的事实（用户画像/偏好/项目事实），输出为 JSON 数组，每条含 type/predicate/object/confidence：\n\n用户：我们生产环境是 K8s 1.28，别给我虚拟机的方案。\n助手：好的，按 K8s 给方案。\n用户：还有我们不用 Helm，都是裸 YAML。\n助手：明白。\n用户：对了周五要评审，PPT 帮我留到周四晚上。",
"提取出 K8s 1.28、不用 Helm、周五评审+周四要 PPT；类型标注合理；confidence 合理；JSON 格式正确")
add("mem-02","memory-extraction",
"设计一个 Agent 的记忆系统分层：工作记忆/情景记忆/语义记忆。说明每层存什么、何时写入、如何淘汰、如何检索（关键词/向量/混合），并给出检索的优先级顺序。",
"三层职责清晰不重叠；写入时机明确；淘汰策略（TTL/频率/重要性）；检索混合策略与优先级；考虑一致性")
add("agent-devops-01","devops-agent",
"设计一个 DevOps Agent 的安全边界：它可以读日志、执行只读 kubectl、但禁止 delete/apply。给出工具白名单设计、危险命令拦截规则、审计日志字段、以及误操作后的回滚预案。",
"白名单具体（get/describe/logs/top）；拦截规则（动词黑名单+资源级联）；审计字段（who/when/what/why/approved_by）；回滚预案")
add("agent-devops-02","devops-agent",
"线上服务 5xx 突增，你是一个被授予只读权限的 SRE Agent。列出你的排查动作序列（每步：看什么、预期、异常时的分支），直到定位或升级人工。",
"顺序合理（告警确认→大盘→依赖→日志→trace→资源）；每步有预期与分支；有升级人工的明确条件；不做写操作")

# —— DATA（已有 CODE 4 类外：data-extraction/data-transformation/classification/summarization/translation/math）——
add("dxt-01","data-extraction",
"从下面文本提取结构化 JSON：\n\n「会议时间：8 月 28 日下午 2 点，地点 3 楼会议室 A，参会：张三（市场部）、李四（技术部）；议题：Q3 预算与系统上线排期。」\n\n输出 schema：{\"meeting_date\":\"\",\"time\":\"\",\"location\":\"\",\"attendees\":[{\"name\":\"\",\"dept\":\"\"}],\"topics\":[]}",
"日期/时间/地点字段正确；attendees 数组结构与部门映射正确；topics 拆分合理；严格符合 schema")
add("dxt-02","data-extraction",
"从这段客服对话提取工单字段：\n\n客户：我 8 月 15 号买的路由器（订单号 SO-88231）到昨天就不通电了，指示灯全灭。\n客服：帮您登记换货。\n\n输出：{\"order_id\":\"\",\"product\":\"\",\"issue\":\"\",\"severity\":\"\",\"expected_action\":\"\"}",
"order_id SO-88231；product 路由器；issue 不通电指示灯全灭；severity 合理；expected_action 换货")
add("dtf-01","data-transformation",
"给定源数据格式（[{\"name\":\"张三\",\"age\":35,\"dept\":\"市场部\",\"hire_date\":\"2021-03-15\"}]），转换为目标格式：{\"market\":{\"zhangsan\":{\"age\":35,\"joined\":\"2021 年 3 月\"}}}（键为拼音、部门英文映射、日期中文化）。写出转换函数与映射表。",
"函数可运行；拼音转换处理（内置表或库均可，需说明）；部门映射表；日期格式化；健壮性（未知部门）")
add("dtf-02","data-transformation",
"设计一条 ETL 清洗规则集，处理运营商工单数据中的脏数据：手机号缺失/加密格式不一（含脱敏星号）、地址不规范（省市区层级混乱）、工单状态枚举漂移（完成/已完成/已办结）。输出规则表（字段/规则/动作/异常处理）。",
"规则覆盖三类问题；每条规则有明确动作（修复/标记/丢弃）；异常处理有兜底（人工队列）；考虑幂等")
add("cls-01","classification",
"给下列 10 条工单文本分类到（网络故障/终端故障/费用争议/服务态度/其他），只输出编号+类别：\n1. 宽带每天晚上 8 点掉线\n2. 手机充了 100 块话费第二天少了 30\n3. 营业厅排队一小时没人叫号\n4. 机顶盒开机黑屏\n5. 5G 信号满格但打不通电话\n6. 套餐莫名被改成 198 元档\n7. 光猫指示灯红灯闪\n8. 客服电话打不通\n9. 手机摔了屏幕碎想换机\n10. 宽带测速只有签约速率三分之一",
"1 网络故障；2 费用争议；3 服务态度；4 终端故障；5 网络故障；6 费用争议；7 终端故障或网络故障（需一致）；8 服务态度；9 其他；10 网络故障；只输出编号+类别")
add("cls-02","classification",
"设计一个三级客服工单分类体系（大类/小类/紧急度），覆盖网络/终端/费用/服务四类业务。说明每级的判定规则（可正则+关键词）与置信度不足时的兜底（转人工）。",
"体系覆盖四类；判定规则具体可执行；紧急度规则（影响面/时长/客户等级）；兜底机制明确")
add("sum-01","summarization",
"把下面 300 字需求压缩成 3 句话以内的摘要，保留数字与责任方：\n\n「市场部提出，为配合 9 月开学季促销，需要在 8 月 25 日前完成会员系统改造：积分翻倍规则上线（涉及 21 个地市）、老用户回流礼包推送（约 120 万用户）、以及与财务对账接口联调。技术侧由平台组承接，接口开发 5 人天，联调 3 人天，财务接口需财务部配合，预计 8 月 20 日提测。风险：财务接口文档未定稿，可能影响联调。」",
"3 句以内；保留关键数字（8/25、21 地市、120 万、5+3 人天、8/20 提测）；责任方（平台组/财务部）；风险点保留")
add("sum-02","summarization",
"这是一份 40 页故障复盘报告的目录级摘要需求：给出「一页纸」结构（发生了什么/影响/根因/修复/预防五段式），每段 2 句话模板。请按该模板输出示例（内容可虚构但需合理）。",
"五段结构完整；每段 ≤2 句；模板可复用（含占位符更佳）；示例合理")
add("trl-01","translation",
"翻译成英文（技术文档风格，保留代码术语不译）：\n\n「当代理收到客户端请求后，先经鉴权中间件校验令牌，再由路由器按请求特征选择上游模型。若思考型模型被选中且客户端预算低于安全阈值，系统将强制关闭思考模式以保障正文输出。」",
"忠实原意；术语准确（middleware/token/upstream/threshold）；句子通顺专业；代码术语保留")
add("trl-02","translation",
"翻译成中文（公告风格，避免翻译腔）：\n\n\"We will perform scheduled maintenance on the inference cluster this Saturday from 02:00 to 06:00 (UTC+8). During this window, API requests may experience elevated latency or brief failures. We recommend retrying with exponential backoff. No action is required on your side.\"",
"中文自然无翻译腔；时间与时区保留；专业词汇准确（推理集群/指数退避）；公告语气")
add("math-01","math",
"某省移动用户数 1.2 亿，其中 5G 套餐用户占 55%，5G 用户中月流量超过 60GB 的占 30%。问：月流量超 60GB 的 5G 用户约多少万户？请列式计算并说明每步。",
"1.2 亿 × 55% × 30% = 0.198 亿 = 1980 万；步骤清晰；单位换算正确")
add("math-02","math",
"证明：任意奇数的平方除以 8 余 1。要求写出完整证明过程。",
"设奇数 2k+1；(2k+1)² = 4k(k+1)+1；k(k+1) 必为偶数所以 4k(k+1) 是 8 的倍数；结论成立；证明完整")

# —— WRITING & CHAT（新 8 类）——
add("cw-01","content-writing",
"为内网「智能模型路由服务」写一段 120 字以内的上线公告：说明它是什么、带来什么好处、怎么接入。受众是各系统负责人。语气：平实专业，不用感叹号。",
"≤120 字；三要素齐全（是什么/好处/怎么接入）；平实无夸张；面向负责人视角")
add("cw-02","content-writing",
"写 5 条「模型路由服务」的内部推广标语，每条 ≤15 字，风格务实不浮夸，突出省钱/省心/自动三个卖点中至少两个。",
"5 条每条 ≤15 字；不浮夸（无「最强」「颠覆」类词）；覆盖至少两个卖点；中文通顺")
add("rr-01","research-reports",
"写一份《大模型路由技术选型报告》提纲（不写正文），受众为技术委员会。要求包含：背景、候选方案对比（规则/语义/学习型）、评估维度与量化指标、推荐结论、风险。提纲到二级标题，每节一句话说明写什么。",
"结构完整覆盖五部分；二级标题粒度合适；每节说明到位；评估维度量化（成本/质量/时延）")
add("rr-02","research-reports",
"基于以下要点写一段 200 字的趋势判断（研究简报风格）：内网可用模型增多（3→10 个）、请求量月增 40%、人工选模型成本高。结论方向：引入自动化路由的必要性。需标注哪些是事实哪些是推断。",
"200 字左右；事实/推断分明；逻辑链完整；简报风格")
add("qa-01","qa-knowledge",
"解释什么是「模型蒸馏」，面向非算法背景的系统工程师，用类比+一段正式定义，200 字以内。",
"类比恰当；定义准确（大模型教小模型）；≤200 字；无术语堆砌")
add("qa-02","qa-knowledge",
"同事问：「KV cache 为什么能让大模型推理变快？」用 300 字以内讲清机制：是什么、为什么省、代价是什么。",
"机制讲对（注意力键值缓存避免重复计算）；为什么省；代价（显存占用）；≤300 字")
add("conv-01","conversation",
"用户说：「这个模型路由听起来不错，但我们系统刚稳定，不想折腾。」作为服务提供方，给出得体的回应：承认顾虑、给出低风险试用路径、不贬低对方保守。100 字以内。",
"先共情不反驳；给出灰度/旁路试用等低风险路径；无推销感；≤100 字")
add("conv-02","conversation",
"用户连续问了三个问题你都已回答，用户说「明白了，谢谢」。得体收尾：确认理解正确+告知后续求助渠道，不强行延展话题。50 字以内。",
"简洁收尾；不过度延展；留求助渠道；≤50 字")
add("cs-01","customer-support",
"客户投诉：「宽带装了一周就断网三次，你们到底行不行！」写一条回复：先安抚，再给出具体的排查与解决承诺（上门时限、临时补偿口径），不推诿。120 字以内。",
"先道歉安抚；具体行动（上门检测时限）；补偿口径；不推诿不敷衍；≤120 字")
add("cs-02","customer-support",
"客户要求退还重复扣除的 30 元话费，经查系统确实重复扣了。写处理回复：确认问题、说明退款流程与时限、致歉。100 字以内。",
"确认事实不狡辩；退款流程具体（原路退回/时限）；致歉诚恳；≤100 字")
add("rp-01","roleplay-fiction",
"以第一人称写一个 150 字的微小说开头：一位夜班运维工程师发现监控大盘上所有曲线同时归零。要求有悬念，不解释原因。",
"第一人称；150 字左右；有悬念；不解释原因；文学性")
add("rp-02","roleplay-fiction",
"扮演一位严格的代码评审官，评审下面的代码并保持角色人设（挑剔但专业，不人身攻击）：\n\nfunction add(a, b) { return a + b + Math.random() * 0.1 }",
"保持挑剔专业人设；指出 randomness 注入业务逻辑的严重问题；无侮辱性语言；有建设性修改意见")
add("fin-01","finance-trading",
"解释「滑点」对量化执行的影响，以及 VWAP/TWAP 算法如何降低冲击成本。300 字以内，面向刚入职的风控分析师。",
"滑点定义准确；对执行成本量化；VWAP/TWAP 机制讲对；≤300 字")
add("fin-02","finance-trading",
"用户问：「我在招行买的 R3 级理财最近亏了 2%，要不要赎回？」给出框架性回答：需要哪些信息才能判断、一般性考虑维度，不给具体投资建议。",
"不给具体建议（合规）；列出判断框架（期限/仓位/风险匹配度/资金用途）；提示关注产品说明书与自身风险承受力")
add("sec-01","security-audit",
"审计这段登录接口代码的安全问题，按严重程度排序：\n\n@app.post('/login')\nasync def login(user: str, pwd: str):\n    row = await db.fetchrow('SELECT * FROM users WHERE name=$1', user)\n    if row and row['pwd'] == pwd:\n        return {'token': make_token(row['id']), 'role': row['role']}\n    return {'error': 'wrong'}, 401",
"明文密码存储/比较；无速率限制可爆破；token 无过期机制；错误信息可枚举用户名（可选）；按严重度排序")
add("sec-02","security-audit",
"设计一份内网 API 网关的安全检查清单（15 条以内），覆盖认证、授权、传输、审计、限流五个域。每条一句话。",
"五域均衡覆盖；条目具体可检查；≤15 条")
add("oth-01","other",
"内网要办一场 30 人的技术分享会，给一份物料清单与时间线（会前一周/前一天/当天/会后），简明扼要。",
"物料清单具体；时间线四阶段齐全；可执行")
add("oth-02","other",
"同事离职交接，你接手他的 3 个定时任务脚本。列出你的接收检查清单（怎么确认能跑、怎么防断档、怎么找到文档）。",
"检查清单覆盖运行验证/依赖环境/告警日志/文档；防断档（双跑/回滚）；可操作")

def main():
    old_path = os.path.join(ROOT, "config", "subtask-eval.json")
    with io.open(old_path, "r", encoding="utf-8") as f:
        old = json.load(f)
    old_cases = old["cases"]
    old_ids = {c["id"] for c in old_cases}
    old_subs = {c["sub"] for c in old_cases}
    dup = [c["id"] for c in E if c["id"] in old_ids]
    assert not dup, "id 冲突: %s" % dup
    new_subs = {c["sub"] for c in E}
    overlap = old_subs & new_subs
    assert not overlap, "小类重叠（旧文件应只含 4 个 CODE 小类）: %s" % overlap

    merged = old_cases + E
    all_subs = {}
    for c in merged:
        all_subs[c["sub"]] = all_subs.get(c["sub"], 0) + 1
    assert len(all_subs) == 30, "应覆盖 30 小类，实际 %d: %s" % (len(all_subs), sorted(all_subs))
    assert all(n >= 2 for n in all_subs.values()), "每小类至少 2 条"

    old["cases"] = merged
    old["note"] = "30 官方小类粒度评测集（84 条 = CODE 32 + 新增 52）。裁判 glm-5.3（外部，方案变更须经用户确认）。agent 类小类以单轮可评形态覆盖。生成 max_tokens 需 ≥32768（思考型模型与正文共享预算）。"
    with io.open(old_path, "w", encoding="utf-8") as f:
        json.dump(old, f, ensure_ascii=False, indent=2)

    extra_path = os.path.join(ROOT, "config", "subtask-eval-extra.json")
    with io.open(extra_path, "w", encoding="utf-8") as f:
        json.dump({"note": "30 小类扩充批次（52 条新增，旧 4 类已有数据在 data/subtask-eval/ 主跑报告）", "cases": E}, f, ensure_ascii=False, indent=2)

    print("全量:", len(merged), "条 /", len(all_subs), "小类；新增文件:", extra_path)
    for s in sorted(all_subs):
        print("  %-22s %d 条" % (s, all_subs[s]))

if __name__ == "__main__":
    main()
