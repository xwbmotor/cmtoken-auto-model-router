package gateway

import (
	"encoding/json"
	"sort"
	"unicode/utf8"
)

// marshalValidatedObject joins values already produced by json.Unmarshal into
// RawMessage or by json.Marshal. It must not receive arbitrary unparsed bytes.
// These objects are HTTP JSON payloads, never HTML/script fragments: preserving
// valid raw string escapes avoids walking and rewriting long histories again.
// Keep the standard encoder's UTF-8 repair for legacy accepted invalid input.
func marshalValidatedObject(fields map[string]json.RawMessage) ([]byte, error) {
	if fields == nil {
		return []byte("null"), nil
	}
	keys := make([]string, 0, len(fields))
	size := 2
	for key, value := range fields {
		if !utf8.Valid(value) {
			return json.Marshal(fields)
		}
		keys = append(keys, key)
		size += len(key) + len(value) + 4
	}
	sort.Strings(keys)
	out := make([]byte, 0, size)
	out = append(out, '{')
	for i, key := range keys {
		if i > 0 {
			out = append(out, ',')
		}
		encoded, err := json.Marshal(key)
		if err != nil {
			return nil, err
		}
		out = append(out, encoded...)
		out = append(out, ':')
		if len(fields[key]) == 0 {
			out = append(out, "null"...)
		} else {
			out = append(out, fields[key]...)
		}
	}
	return append(out, '}'), nil
}
