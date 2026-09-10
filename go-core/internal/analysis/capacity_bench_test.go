package analysis

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
)

// Same long-history shape as compare-capacity.mjs. This isolates analysis CPU;
// it does not measure HTTP, the Node adapter, ledger syncs, or capacity.
func BenchmarkCapacityAnalysis(b *testing.B) {
	raw, err := os.ReadFile("../../../config/router.json")
	if err != nil {
		b.Fatal(err)
	}
	var config Config
	if err = json.Unmarshal(raw, &config); err != nil {
		b.Fatal(err)
	}
	a, err := New(config)
	if err != nil {
		b.Fatal(err)
	}
	for _, shape := range []string{"short", "history"} {
		messages := []any{map[string]any{"role": "system", "content": "m4:profile"}}
		if shape == "history" {
			for i := 0; i < 16; i++ {
				role := "user"
				if i%2 != 0 {
					role = "assistant"
				}
				messages = append(messages, map[string]any{"role": role, "content": strings.Repeat("项目需求、约束条件和执行记录。", 64)})
			}
		}
		messages = append(messages, map[string]any{"role": "user", "content": "请提取并返回数字42。"})
		body, _ := json.Marshal(map[string]any{"stream": false, "max_tokens": 128, "messages": messages})
		b.Run(shape, func(b *testing.B) {
			b.ReportAllocs()
			b.SetBytes(int64(len(body)))
			for b.Loop() {
				if _, err := a.Analyze(body); err != nil {
					b.Fatal(err)
				}
			}
		})
	}
}
