package main

import (
	"bufio"
	"encoding/json"
	"io"

	"github.com/xwbmotor/cmtoken-auto-model-router/go-core/internal/analysis"
	"github.com/xwbmotor/cmtoken-auto-model-router/go-core/internal/features"
	"github.com/xwbmotor/cmtoken-auto-model-router/go-core/internal/gateway"
)

// Feature replay is an offline oracle boundary. It never reads local config,
// environment credentials, the clock or a network endpoint.
func featuresReplay(reader io.Reader, writer io.Writer) error {
	scanner := bufio.NewScanner(reader)
	scanner.Buffer(make([]byte, 65536), gateway.MaxBodyBytes)
	encoder := json.NewEncoder(writer)
	for scanner.Scan() {
		var item struct {
			Config   features.Config `json:"config"`
			Body     json.RawMessage `json:"body"`
			Analysis analysis.Result `json:"analysis"`
			Now      float64         `json:"now"`
			Bucket   float64         `json:"bucket"`
		}
		var result any
		if err := json.Unmarshal(scanner.Bytes(), &item); err != nil {
			result = map[string]string{"error": "invalid_feature_replay"}
		} else if builder, err := features.New(item.Config); err != nil {
			result = map[string]string{"error": err.Error()}
		} else if input, err := builder.Input(item.Body, item.Analysis, item.Now, item.Bucket); err != nil {
			result = map[string]string{"error": err.Error()}
		} else {
			result = input
		}
		if err := encoder.Encode(result); err != nil {
			return err
		}
	}
	return scanner.Err()
}
