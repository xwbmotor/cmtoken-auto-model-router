package semantic

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"regexp"
	"strings"
)

var bearerPrefix = regexp.MustCompile(`(?i)^Bearer\s+`)

type Rollout struct {
	Bucket    int    `json:"bucket"`
	BucketKey string `json:"bucketKey"`
	Source    string `json:"bucketKeySource"`
}

func Bucket(secret []byte, sessionID, authorization, requestID string) Rollout {
	source, key := "internal", "rid:"+requestID
	if raw := strings.TrimSpace(bearerPrefix.ReplaceAllString(authorization, "")); raw != "" {
		digest := sha256.Sum256([]byte(raw))
		source = "fingerprint"
		key = "fp:" + hex.EncodeToString(digest[:4])
	}
	if sessionID != "" {
		source = "session"
		key = "sid:" + sessionID
	}
	mac := hmac.New(sha256.New, secret)
	mac.Write([]byte("semantic-rollout:" + key))
	bucket := int(binary.BigEndian.Uint32(mac.Sum(nil)[:4]) % 100)
	mac = hmac.New(sha256.New, secret)
	mac.Write([]byte("bucket-key-fp:" + key))
	logged := strings.SplitN(key, ":", 2)[0] + ":" + hex.EncodeToString(mac.Sum(nil)[:8])
	return Rollout{Bucket: bucket, BucketKey: logged, Source: source}
}
