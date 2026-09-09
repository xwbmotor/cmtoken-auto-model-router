package gateway

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"github.com/xwbmotor/cmtoken-auto-model-router/go-core/internal/decision"
	"math"
	"strings"
)

type Session struct {
	Model, Task, Tier, SubTask string
	ExpiresAt                  float64
}

// SessionKey never stores raw credentials or public session IDs.
func SessionKey(sessionID, authorization, upstream string, secret []byte) string {
	if strings.TrimSpace(sessionID) == "" || len(sessionID) > 4096 {
		return ""
	}
	credential := authorization
	if len(credential) >= 7 && strings.EqualFold(credential[:7], "Bearer ") {
		credential = strings.TrimSpace(credential[7:])
	}
	if credential == "" {
		return ""
	}
	value, _ := json.Marshal([]string{upstream, credential, sessionID})
	mac := hmac.New(sha256.New, secret)
	mac.Write(value)
	return hex.EncodeToString(mac.Sum(nil))
}
func ChooseSession(current *Session, in decision.Input, d decision.Decision) string {
	if current == nil || current.ExpiresAt <= in.Runtime.NowMs || d.Shadow || d.RequestedModel != in.Policy.AutoModelID {
		return d.SelectedModel
	}
	if current.Task != in.Analysis.Task || current.Tier != in.Analysis.Tier || current.SubTask != in.Analysis.SubTask {
		return d.SelectedModel
	}
	eligible := false
	for _, id := range d.QualifiedModelIDs {
		if id == current.Model {
			eligible = true
		}
	}
	if !eligible {
		return d.SelectedModel
	}
	sticky, selected := math.NaN(), math.NaN()
	for _, c := range d.Candidates {
		if c.Model == current.Model {
			sticky = c.Score
		}
		if c.Model == d.SelectedModel {
			selected = c.Score
		}
	}
	gap := selected - sticky
	if !math.IsNaN(gap) && !math.IsInf(gap, 0) && gap <= in.Policy.SessionMaxGap+1e-9 {
		return current.Model
	}
	return d.SelectedModel
}
