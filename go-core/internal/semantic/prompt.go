// Prompt text ported verbatim from src/semantic-router.mjs.
package semantic

import (
	"encoding/json"
	"github.com/xwbmotor/cmtoken-auto-model-router/go-core/internal/analysis"
)

func classificationPrompt(text string, prior *Assessment) string {
	hint := ""
	if prior != nil {
		value := struct {
			Task       string  `json:"task"`
			Tier       string  `json:"tier"`
			Confidence float64 `json:"confidence"`
			Reason     string  `json:"reason"`
		}{prior.Task, prior.Tier, prior.Confidence, analysis.HeadText(prior.Reason, 80)}
		b, _ := json.Marshal(value)
		hint = "\n\n小模型初判（仅参考，可同意可推翻）：" + string(b)
	}
	return "你是模型路由分类器，只判断任务，不回答用户问题。\n\n任务类型只能是：default、coding、reasoning、creative、extraction。任务类型 task 含义：default=通用问答；coding=要求产出/修改/调试代码；reasoning=多步推理、方案权衡、根因分析；creative=创作文案故事；extraction=结构化提取转换。\n难度只能是：simple、balanced、complex。complexity 是 0 到 1；confidence 是你对分类的置信度。\n复杂架构、多目标权衡、长链条推理应提高难度；寒暄、直接事实、简单格式转换应降低难度。\n复杂任务低估的风险高于简单任务高估，证据不足时适度向上取整。\n注意：用户说「不要代码」时不是 coding；「什么是 X」概念解释、对已有材料的总结/翻译是 default 或 extraction，不是材料所属领域任务的请求。\n" + hint + "\n\n严格只输出 JSON：{\"task\":\"...\",\"tier\":\"...\",\"complexity\":0.0,\"confidence\":0.0,\"reason\":\"不超过80字\"}\n\n用户请求：\n" + text
}
