package labnet

import "testing"

func TestCandidateEndpointBoundary(t *testing.T) {
	for _, raw := range []string{"https://maas.example/v1/chat/completions", "https://maas.example:8443/v1/models", "http://127.0.0.1:8788/classify"} {
		if _, err := Endpoint(raw, true); err != nil {
			t.Errorf("candidate endpoint rejected: %s", raw)
		}
	}
	for _, raw := range []string{"http://maas.example/v1/chat/completions", "https://user:secret@maas.example/v1", "https://maas.example/v1?key=secret", "https://maas.example/v1#fragment", "https:///v1", "file:///tmp/model"} {
		if _, err := Endpoint(raw, true); err == nil {
			t.Errorf("unsafe endpoint accepted: %s", raw)
		}
	}
	if _, err := Endpoint("https://maas.example/v1", false); err == nil {
		t.Fatal("lab external boundary weakened")
	}
}
