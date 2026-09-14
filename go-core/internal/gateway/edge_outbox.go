package gateway

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"github.com/xwbmotor/cmtoken-auto-model-router/go-core/internal/labnet"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"
)

const edgeOutboxMaxBytes int64 = 256 << 20
const edgeOutboxMaxRecords = 4096

type edgeSubmission struct {
	done chan struct{}
	err  error
}

type edgeOutbox struct {
	writing                  map[string]*edgeSubmission
	writers                  sync.WaitGroup
	mu                       sync.Mutex
	dir, endpoint, token     string
	cipher                   cipher.AEAD
	client                   *http.Client
	pending                  map[string]int64
	bytes                    int64
	fatal, closed, saturated bool
	failures                 uint64
	ctx                      context.Context
	cancel                   context.CancelFunc
	wake, done               chan struct{}
}

func syncEdgeDirectory(dir string) error {
	if runtime.GOOS == "windows" {
		return nil
	}
	f, e := os.Open(dir)
	if e != nil {
		return e
	}
	defer f.Close()
	return f.Sync()
}

func openEdgeOutbox(dir, endpoint, token string) (*edgeOutbox, error) {
	if err := os.MkdirAll(dir, 0700); err != nil {
		return nil, err
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	key, err := os.ReadFile(filepath.Join(dir, "encryption.key"))
	if os.IsNotExist(err) {
		if len(entries) > 0 {
			return nil, errors.New("outbox key missing; preserve pending events")
		}
		key = make([]byte, 32)
		if _, err = rand.Read(key); err != nil {
			return nil, err
		}
		f, e := os.OpenFile(filepath.Join(dir, "encryption.key"), os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
		if e != nil {
			return nil, e
		}
		_, e = f.Write(key)
		if e == nil {
			e = f.Sync()
		}
		f.Close()
		if e != nil {
			return nil, e
		}
		if e = syncEdgeDirectory(dir); e != nil {
			return nil, e
		}
	} else if err != nil {
		return nil, err
	}
	if len(key) != 32 {
		return nil, errors.New("outbox key invalid")
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithCancel(context.Background())
	q := &edgeOutbox{dir: dir, endpoint: endpoint, token: token, cipher: aead, client: labnet.Client(2 * time.Second), pending: map[string]int64{}, writing: map[string]*edgeSubmission{}, ctx: ctx, cancel: cancel, wake: make(chan struct{}, 1), done: make(chan struct{})}
	fail := func(e error) (*edgeOutbox, error) { cancel(); return nil, e }
	for _, entry := range entries {
		name := entry.Name()
		if name == "encryption.key" {
			continue
		}
		if entry.Type()&os.ModeSymlink != 0 || entry.IsDir() || !(strings.HasSuffix(name, ".evt") || strings.HasSuffix(name, ".tmp")) {
			return fail(errors.New("unexpected outbox entry"))
		}
		id := strings.TrimSuffix(strings.TrimSuffix(name, ".evt"), ".tmp")
		if len(id) != 64 {
			return fail(errors.New("invalid outbox name"))
		}
		info, e := entry.Info()
		if e != nil || info.Size() > 16<<20 {
			return fail(errors.New("outbox event too large"))
		}
		raw, e := os.ReadFile(filepath.Join(dir, name))
		if e != nil {
			return fail(e)
		}
		plain, e := q.decode(raw)
		if e != nil {
			return fail(errors.New("outbox event corrupt"))
		}
		sum := sha256.Sum256(plain)
		if hex.EncodeToString(sum[:]) != id {
			return fail(errors.New("outbox event identity mismatch"))
		}
		if strings.HasSuffix(name, ".tmp") {
			target := filepath.Join(dir, id+".evt")
			if _, e = os.Stat(target); e == nil {
				if e = os.Remove(filepath.Join(dir, name)); e != nil {
					return fail(e)
				}
			} else if os.IsNotExist(e) {
				if e = os.Rename(filepath.Join(dir, name), target); e != nil {
					return fail(e)
				}
			} else {
				return fail(e)
			}
		}
		if _, exists := q.pending[id]; !exists {
			q.pending[id] = int64(len(raw))
			q.bytes += int64(len(raw))
		}
	}
	if q.bytes > edgeOutboxMaxBytes || len(q.pending) > edgeOutboxMaxRecords {
		return fail(errors.New("outbox capacity exceeded"))
	}
	if err = syncEdgeDirectory(dir); err != nil {
		return fail(err)
	}
	go q.loop()
	q.signal()
	return q, nil
}
func (q *edgeOutbox) decode(raw []byte) ([]byte, error) {
	n := q.cipher.NonceSize()
	if len(raw) < n {
		return nil, errors.New("short event")
	}
	return q.cipher.Open(nil, raw[:n], raw[n:], nil)
}
func (q *edgeOutbox) signal() {
	select {
	case q.wake <- struct{}{}:
	default:
	}
}
func (q *edgeOutbox) enqueue(payload []byte) error {
	sum := sha256.Sum256(payload)
	id := hex.EncodeToString(sum[:])
	nonce := make([]byte, q.cipher.NonceSize())
	if _, e := rand.Read(nonce); e != nil {
		return e
	}
	raw := q.cipher.Seal(nonce, nonce, payload, nil)
	q.mu.Lock()
	if q.closed || q.fatal {
		q.mu.Unlock()
		return errors.New("outbox unavailable")
	}
	if _, ok := q.pending[id]; ok {
		q.mu.Unlock()
		return nil
	}
	if prior, ok := q.writing[id]; ok {
		q.mu.Unlock()
		<-prior.done
		return prior.err
	}
	if len(payload) > 15<<20 || len(q.pending)+len(q.writing) >= edgeOutboxMaxRecords || q.bytes+int64(len(raw)) > edgeOutboxMaxBytes {
		q.saturated = true
		q.mu.Unlock()
		return errors.New("outbox full")
	}
	submission := &edgeSubmission{done: make(chan struct{})}
	q.writing[id] = submission
	q.bytes += int64(len(raw))
	q.writers.Add(1)
	q.mu.Unlock()
	// Independent records may synchronize concurrently. The shared queue lock
	// protects accounting only, never the storage latency of other requests.
	temporary := filepath.Join(q.dir, id+".tmp")
	f, e := os.OpenFile(temporary, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if e == nil {
		_, e = f.Write(raw)
		if e == nil {
			e = f.Sync()
		}
		f.Close()
	}
	if e == nil {
		e = os.Rename(temporary, filepath.Join(q.dir, id+".evt"))
	}
	if e == nil {
		e = syncEdgeDirectory(q.dir)
	}
	q.mu.Lock()
	delete(q.writing, id)
	if e != nil {
		q.fatal = true
		submission.err = errors.New("outbox persistence failed")
	} else {
		q.pending[id] = int64(len(raw))
	}
	close(submission.done)
	q.mu.Unlock()
	q.writers.Done()
	if e == nil {
		q.signal()
	}
	return submission.err
}
func (q *edgeOutbox) deliver() bool {
	q.mu.Lock()
	keys := make([]string, 0, len(q.pending))
	for id := range q.pending {
		keys = append(keys, id)
	}
	sort.Strings(keys)
	selected := make([]string, 0, 16)
	var total int64
	for _, id := range keys {
		size := q.pending[id]
		if len(selected) > 0 && total+size > 1<<20 {
			break
		}
		selected = append(selected, id)
		total += size
		if len(selected) == 16 {
			break
		}
	}
	q.mu.Unlock()
	if len(selected) == 0 {
		return false
	}
	payloads := make([][]byte, 0, len(selected))
	for _, id := range selected {
		raw, e := os.ReadFile(filepath.Join(q.dir, id+".evt"))
		if e != nil {
			q.mu.Lock()
			q.fatal = true
			q.mu.Unlock()
			return false
		}
		plain, e := q.decode(raw)
		if e != nil {
			q.mu.Lock()
			q.fatal = true
			q.mu.Unlock()
			return false
		}
		payloads = append(payloads, plain)
	}
	body := payloads[0]
	if len(payloads) > 1 {
		items := make([]string, len(payloads))
		for i, p := range payloads {
			items[i] = base64.StdEncoding.EncodeToString(p)
		}
		body, _ = json.Marshal(struct {
			Kind  string   `json:"kind"`
			Items []string `json:"items"`
		}{"native_batch", items})
	}
	req, e := http.NewRequestWithContext(q.ctx, http.MethodPost, q.endpoint, bytes.NewReader(body))
	if e != nil {
		return false
	}
	req.Header.Set("Authorization", "Bearer "+q.token)
	req.Header.Set("Content-Type", "application/json")
	res, e := q.client.Do(req)
	ok := false
	if e == nil {
		_, _ = io.Copy(io.Discard, io.LimitReader(res.Body, 4096))
		res.Body.Close()
		ok = res.StatusCode == 204
	}
	if !ok {
		q.mu.Lock()
		q.failures++
		q.mu.Unlock()
		return false
	}
	for _, id := range selected {
		if e = os.Remove(filepath.Join(q.dir, id+".evt")); e != nil {
			break
		}
	}
	if e == nil {
		e = syncEdgeDirectory(q.dir)
	}
	q.mu.Lock()
	defer q.mu.Unlock()
	if e != nil {
		q.fatal = true
		return false
	}
	for _, id := range selected {
		q.bytes -= q.pending[id]
		delete(q.pending, id)
	}
	if q.bytes < edgeOutboxMaxBytes-(16<<20) && len(q.pending)+len(q.writing) < edgeOutboxMaxRecords {
		q.saturated = false
	}
	return true
}
func (q *edgeOutbox) loop() {
	defer close(q.done)
	timer := time.NewTicker(time.Second)
	defer timer.Stop()
	for {
		select {
		case <-q.ctx.Done():
			return
		case <-q.wake:
		case <-timer.C:
		}
		for q.ctx.Err() == nil && q.deliver() {
		}
	}
}
func (q *edgeOutbox) status() (int, int64, uint64, bool) {
	q.mu.Lock()
	defer q.mu.Unlock()
	return len(q.pending) + len(q.writing), q.bytes, q.failures, q.fatal || q.saturated || q.bytes >= edgeOutboxMaxBytes || len(q.pending) >= edgeOutboxMaxRecords
}
func (q *edgeOutbox) drain(ctx context.Context) error {
	q.signal()
	timer := time.NewTicker(10 * time.Millisecond)
	defer timer.Stop()
	for {
		n, _, _, bad := q.status()
		if bad {
			return errors.New("outbox storage unavailable")
		}
		if n == 0 {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-timer.C:
		}
	}
}
func (q *edgeOutbox) close() {
	q.mu.Lock()
	q.closed = true
	q.mu.Unlock()
	q.writers.Wait()
	q.cancel()
	<-q.done
	q.client.CloseIdleConnections()
}
