package gateway

import (
	"bytes"
	"encoding/json"
	"reflect"
	"strings"
	"testing"
)

func TestValidatedObjectPreservesJSONMeaning(t *testing.T) {
	inputs := []string{
		`{}`, `{"a":null,"b":true,"c":1.234567890123456789e+23}`,
		`{"messages":[{"role":"user","content":"中文 <>& \\ \" \n \u2028 \ud800 \ud83d\ude00"}],"tools":{"nested":[1,false,null]}}`,
		`{"x":1,"x":2,"__amr_edge":{},"quote\"\\\n":"value"}`,
		"{\"messages\":[{\"content\":\"invalid\xffutf8\"}]}",
		`{"messages":[{"content":"` + strings.Repeat("项目需求与记录。", 1000) + `"}]}`,
	}
	decode := func(data []byte) any {
		var value any
		d := json.NewDecoder(bytes.NewReader(data))
		d.UseNumber()
		if err := d.Decode(&value); err != nil {
			t.Fatal(err)
		}
		return value
	}
	for _, input := range inputs {
		var fields map[string]json.RawMessage
		if err := json.Unmarshal([]byte(input), &fields); err != nil {
			t.Fatal(err)
		}
		// Exercise the same replacement and opaque-field removal as forwarding.
		delete(fields, "__amr_edge")
		fields["model"], _ = json.Marshal("fixture<model>\"中文")
		fields["empty"] = nil
		want, err := json.Marshal(fields)
		if err != nil {
			t.Fatal(err)
		}
		got, err := marshalValidatedObject(fields)
		if err != nil {
			t.Fatal(err)
		}
		if !json.Valid(got) || !reflect.DeepEqual(decode(got), decode(want)) {
			t.Fatalf("encoded meaning differs for %q", input[:min(len(input), 100)])
		}
		edge := &edgeContext{ID: `id"\\`, ConfigRevision: "fixture", native: &nativeRequest{
			Metadata: nativeMetadata{RequestID: "quote\"\n"}, Body: fields, Events: []edgeEvent{}}}
		result := map[string]any{"answerText": "\"},\"request\":false<>&", "ok": true}
		got, err = nativeCompletionPayload(edge, result)
		if err != nil {
			t.Fatal(err)
		}
		want, err = json.Marshal(map[string]any{"kind": "native_complete", "id": edge.ID,
			"configRevision": edge.ConfigRevision, "request": edge.native, "result": result})
		if err != nil {
			t.Fatal(err)
		}
		if !json.Valid(got) || !reflect.DeepEqual(decode(got), decode(want)) {
			t.Fatalf("native event meaning differs for %q", input[:min(len(input), 100)])
		}
	}
	got, err := marshalValidatedObject(nil)
	if err != nil || string(got) != "null" {
		t.Fatal("nil object mismatch")
	}
}

func BenchmarkValidatedHistoryObject(b *testing.B) {
	var fields map[string]json.RawMessage
	_ = json.Unmarshal([]byte(`{"model":"auto","messages":[{"role":"user","content":"`+strings.Repeat("项目需求与记录。", 3000)+`"}],"stream":true}`), &fields)
	for _, fast := range []bool{false, true} {
		name := "standard"
		if fast {
			name = "validated"
		}
		b.Run(name, func(b *testing.B) {
			b.ReportAllocs()
			for b.Loop() {
				if fast {
					_, _ = marshalValidatedObject(fields)
				} else {
					_, _ = json.Marshal(fields)
				}
			}
		})
	}
}
