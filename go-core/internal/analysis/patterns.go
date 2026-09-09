// Built-in rule literals ported from src/router.mjs; changes are checked by semantic parity tests.
package analysis

var taskPatterns = []struct{ name, source string }{
	{"coding", "代码|编程|程序|函数|接口|报错|异常|debug|bug|review|评审|前端|vue|react|css|组件|docker|k8s|kubernetes|ci/cd|nginx|yaml|部署配置|shell|bash|命令行|解析.{0,4}文件|csv|python|java|javascript|typescript|golang|rust|sql|regex|算法|并发安全|重构|单元测试"},
	{"reasoning", "推理|证明|分析原因|根因|权衡|取舍|对比|评估|规划|方案|设计|架构|分层|框架|路由|综合选择|怎么做|如何实现|分布式事务|数学|逻辑|为什么|比较.*优缺点|研究报告|调研报告|行业趋势|reason|prove|analy[sz]e|architecture"},
	{"creative", "创作|文案|故事|诗|广告|宣传语|口号|营销|改写.*风格|脑暴|起名|剧本|扮演|角色扮演|slogan|creative|story|poem|copywriting|roleplay|写.{0,4}(故事|小说)"},
	{"extraction", "提取|抽取|分类|归类|标签|结构化|转换为|转换|映射|清洗|格式化|只返回|识别字段|extract|classify|parse|json"},
}
var subPatterns = map[string][]Rule{
	"coding": {
		{"debugging", mustRegex("(?i)报错|异常|bug|debug|错误|排查|修复|stack ?trace|为什么.*不(工作|生效)")},
		{"code-review", mustRegex("(?i)评审|review|code review|看看.{0,8}代码|检查.{0,8}(代码|实现)")},
		{"sql-database", mustRegex("(?i)sql|查询.*表|select |join |数据库查询|索引优化")},
		{"frontend-ui", mustRegex("(?i)前端|vue|react|css|页面|组件|界面|ui ?(设计|稿|还原)")},
		{"devops-config", mustRegex("(?i)部署|docker|k8s|kubernetes|ci/cd|jenkins|nginx|yaml|helm|配置文件|环境变量")},
		{"shell-execution", mustRegex("(?i)shell|bash|命令行|执行命令|脚本执行|powershell|终端命令")},
		{"file-io", mustRegex("(?i)(读|写|解析|打开|生成).{0,6}(文件|csv|excel|日志文件)|file ?i/o")},
		{"repo-scanning", mustRegex("(?i)仓库扫描|全库|整个代码库|repo scan|代码库分析|扫描.{0,4}仓库")},
	},
	"reasoning": {
		{"security-audit", mustRegex("(?i)漏洞|渗透|安全审计|攻击面|安全扫描")},
		{"finance-trading", mustRegex("(?i)金融|交易|股票|风控|行情|投资")},
		{"customer-support", mustRegex("(?i)客服|售后|客户咨询|工单回复|投诉处理")},
		{"translation", mustRegex("(?i)翻译|translate|中译英|英译中")},
		{"summarization", mustRegex("(?i)摘要|总结|压缩|提炼|summar")},
		{"multi-step-planning", mustRegex("(?i)规划|排期|路线图|分几期|怎么做|分步|步骤")},
		{"research-reports", mustRegex("(?i)调研|报告|研究|综述|白皮书|架构|方案|系统设计|技术选型")},
		{"math", mustRegex("(?i)数学|证明|方程|概率|微积分|求解|计算")},
	},
	"creative": {
		{"roleplay-fiction", mustRegex("(?i)扮演|角色扮演|roleplay|写.{0,4}(故事|小说|剧本)")},
		{"content-writing", mustRegex("(?i)文案|宣传|营销|slogan|口号|起名|标题|内容写作")},
	},
	"extraction": {
		{"classification", mustRegex("(?i)分类|标签|归类|打标|classify")},
		{"data-transformation", mustRegex("(?i)转换|清洗|映射|格式化|transform")},
		{"summarization", mustRegex("(?i)摘要|总结|压缩|提炼|summar")},
		{"translation", mustRegex("(?i)翻译|translate|中译英|英译中")},
		{"data-extraction", mustRegex("(?i)提取|抽取|结构化|抽取字段|extract|json")},
	},
	"default": {
		{"customer-support", mustRegex("(?i)客服|售后|客户咨询|工单回复|投诉处理")},
		{"finance-trading", mustRegex("(?i)金融|交易|股票|风控|行情|投资")},
		{"security-audit", mustRegex("(?i)漏洞|渗透|安全审计|攻击面|安全扫描")},
		{"translation", mustRegex("(?i)翻译|translate|中译英|英译中")},
		{"summarization", mustRegex("(?i)摘要|总结|压缩|提炼|summar")},
		{"conversation", mustRegex("(?i)你好|嗨|hello|hi\\b|在吗|聊天")},
	},
}
