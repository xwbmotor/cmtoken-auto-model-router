package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/signal"
	"runtime"
	"syscall"
	"time"

	"github.com/xwbmotor/cmtoken-auto-model-router/go-core/internal/analysis"
	"github.com/xwbmotor/cmtoken-auto-model-router/go-core/internal/auth"
	"github.com/xwbmotor/cmtoken-auto-model-router/go-core/internal/decision"
	"github.com/xwbmotor/cmtoken-auto-model-router/go-core/internal/gateway"
	"github.com/xwbmotor/cmtoken-auto-model-router/go-core/internal/semantic"
)

func main() {
	if len(os.Args) == 2 && os.Args[1] == "healthcheck" {
		client := &http.Client{Timeout: 2 * time.Second, Transport: &http.Transport{Proxy: nil}, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
		response, err := client.Get("http://127.0.0.1:8791/health")
		if err != nil {
			os.Exit(1)
		}
		defer response.Body.Close()
		if response.StatusCode != http.StatusOK {
			os.Exit(1)
		}
		return
	}
	if len(os.Args) == 2 && os.Args[1] == "features-replay" {
		if e := featuresReplay(os.Stdin, os.Stdout); e != nil {
			fmt.Fprintln(os.Stderr, "feature replay failed")
			os.Exit(1)
		}
		return
	}
	if len(os.Args) > 1 && os.Args[1] == "ledger-export" {
		if e := exportLedger(os.Args[2:], os.Stdout); e != nil {
			fmt.Fprintln(os.Stderr, e)
			os.Exit(2)
		}
		return
	}
	if len(os.Args) > 1 && os.Args[1] == "ledger-import" {
		if e := importLedger(os.Args[2:], os.Stdout); e != nil {
			fmt.Fprintln(os.Stderr, e)
			os.Exit(2)
		}
		return
	}
	if len(os.Args) == 2 && os.Args[1] == "semantic-replay" {
		if err := semanticReplay(os.Stdin, os.Stdout); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		return
	}
	if len(os.Args) == 2 && os.Args[1] == "analyze" {
		if err := analyzeReplay(os.Stdin, os.Stdout); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		return
	}
	if len(os.Args) == 2 && os.Args[1] == "replay" {
		if err := replay(os.Stdin, os.Stdout); err != nil {
			fmt.Fprintln(os.Stderr, "replay failed:", err)
			os.Exit(1)
		}
		return
	}
	flags := flag.NewFlagSet("amr-core", flag.ExitOnError)
	lab := flags.Bool("lab", false, "acknowledge experimental loopback-only milestone")
	candidate := flags.Bool("candidate", false, "explicit loopback-listening candidate with configured HTTPS upstreams")
	profileDir := flags.String("lab-profile-dir", "", "optional NEW directory for CPU, blocking and execution trace diagnostics")
	runtimeMode := flags.Bool("runtime", false, "enable M3 durable runtime with production auth contracts (still loopback only)")
	authFile := flags.String("auth-config", "", "optional protected local auth JSON, re-read on explicit hot reload")
	runtimeConfig := flags.String("runtime-config", "", "local exported runtime snapshot; no Node adapter required, re-read on explicit reload")
	ledgerPath := flags.String("ledger", "", "dedicated Go ledger path; never share a live Node ledger")
	auditMaxBytes := flags.Int64("audit-max-bytes", 16<<20, "maximum active audit segment bytes")
	auditArchives := flags.Int("audit-max-archives", 8, "maximum retained audit archive segments")
	auditAge := flags.Duration("audit-max-age", 7*24*time.Hour, "maximum local audit archive age; collect before expiration")
	nativeAnalysis := flags.Bool("native-analysis", false, "compute L1 and capacity in Go with a startup policy snapshot")
	nativeSemantics := flags.Bool("native-semantics", false, "enable native semantic review against explicit local endpoints")
	smallURL := flags.String("semantic-small", "", "local http-json classifier endpoint")
	largeURL := flags.String("semantic-large", "", "local mock chat-completions classifier endpoint")
	scopeURL := flags.String("scope-url", "", "optional local tenant model-list endpoint")
	largeCalls := flags.Int64("semantic-max-large-calls", 500, "process-local maximum large classifier attempts")
	largeTokens := flags.Float64("semantic-max-large-tokens", 1000000, "process-local large classifier token allowance")
	listen := flags.String("listen", "127.0.0.1:8791", "loopback listen address")
	nodeCostObservation := flags.Bool("node-cost-observation", false, "use trusted Node cost observations when budget protection is disabled")
	publicListen := flags.String("public-listen", "", "optional native completion front listen address")
	nodeOrigin := flags.String("node-origin", "", "fixed loopback Node management origin for native front")
	assessor := flags.String("assessor", "http://127.0.0.1:8789/assess", "private laboratory feature adapter")
	upstream := flags.String("upstream", "http://127.0.0.1:8790/v1/chat/completions", "local mock upstream")
	timeout := flags.Duration("timeout", 30*time.Second, "laboratory request total deadline")
	_ = flags.Parse(os.Args[1:])
	if *publicListen != "" && (!*runtimeMode || *runtimeConfig == "" || os.Getenv("AMR_GO_EDGE_URL") == "" || len(os.Getenv("AMR_GO_SEMANTIC_BUCKET_SECRET")) < 32) {
		fmt.Fprintln(os.Stderr, "native front requires managed snapshot, edge and stable semantic secret")
		os.Exit(2)
	}
	if *publicListen != "" {
		h, _, e := net.SplitHostPort(*publicListen)
		ip := net.ParseIP(h)
		if e != nil || ip == nil || (!*candidate && !ip.IsLoopback()) {
			fmt.Fprintln(os.Stderr, "public listen requires literal IP; non-loopback requires candidate mode")
			os.Exit(2)
		}
	}
	if *runtimeConfig != "" && !*runtimeMode {
		fmt.Fprintln(os.Stderr, "--runtime-config requires --runtime")
		os.Exit(2)
	}
	if *candidate && (*lab || !*runtimeMode || *runtimeConfig == "" || *authFile == "") {
		fmt.Fprintln(os.Stderr, "--candidate requires --runtime, --runtime-config and --auth-config; cannot combine with --lab")
		os.Exit(2)
	}
	if !*lab && !*candidate {
		fmt.Fprintln(os.Stderr, "Requires --lab; this milestone is not production-ready")
		os.Exit(2)
	}
	host, _, err := net.SplitHostPort(*listen)
	if err != nil || net.ParseIP(host) == nil || !net.ParseIP(host).IsLoopback() {
		fmt.Fprintln(os.Stderr, "listen must be a literal loopback address")
		os.Exit(2)
	}
	stopProfile, err := startLabProfile(*profileDir)
	if err != nil {
		fmt.Fprintln(os.Stderr, "unable to start laboratory profiling")
		os.Exit(2)
	}
	defer func() {
		if stopProfile() != nil {
			fmt.Fprintln(os.Stderr, "laboratory profiling incomplete")
		}
	}()
	var tenants []gateway.Tenant
	if raw := os.Getenv("AMR_GO_TENANTS_JSON"); raw != "" {
		if json.Unmarshal([]byte(raw), &tenants) != nil {
			fmt.Fprintln(os.Stderr, "invalid laboratory tenant mapping")
			os.Exit(2)
		}
	}
	options := gateway.Options{NodeCostObservation: *nodeCostObservation, Candidate: *candidate, NativeAnalysis: *nativeAnalysis, NativeSemantics: *nativeSemantics, AssessorURL: *assessor, UpstreamURL: *upstream,
		EdgeURL: os.Getenv("AMR_GO_EDGE_URL"), EdgeToken: os.Getenv("AMR_GO_EDGE_TOKEN"),
		Tenants: tenants, ScopeURL: *scopeURL, ScopeTTL: 60 * time.Second, ScopeTimeout: 3 * time.Second,
		SemanticBucketSecret: []byte(os.Getenv("AMR_GO_SEMANTIC_BUCKET_SECRET")),
		SemanticOptions:      semantic.Options{SmallURL: *smallURL, LargeURL: *largeURL, SmallToken: os.Getenv("AMR_GO_SEMANTIC_SMALL_TOKEN"), LargeToken: os.Getenv("AMR_GO_SEMANTIC_LARGE_TOKEN"), MaxConcurrent: 8, MaxLargeCalls: *largeCalls, MaxLargeTokens: *largeTokens},
		AccessToken:          os.Getenv("AMR_GO_ACCESS_TOKEN"), AssessorToken: os.Getenv("AMR_GO_ASSESSOR_TOKEN"), UpstreamToken: os.Getenv("AMR_GO_UPSTREAM_TOKEN"),
		AssessmentTimeout: 3 * time.Second, RequestTimeout: *timeout, MaxRequests: 256}
	var g interface {
		http.Handler
		Close()
	}
	if *runtimeMode {
		g, err = gateway.NewManaged(gateway.ManagedOptions{Gateway: options, AuthFile: *authFile, RuntimeConfigFile: *runtimeConfig, LedgerPath: *ledgerPath, Audit: gateway.AuditOptions{MaxBytes: *auditMaxBytes, MaxArchives: *auditArchives, MaxAge: *auditAge}, Auth: auth.Config{Mode: os.Getenv("ROUTER_KEY_MODE"), AccessToken: os.Getenv("ROUTER_ACCESS_KEY"), UpstreamToken: firstNonempty(os.Getenv("UPSTREAM_API_KEY"), os.Getenv("MAAS_API_KEY")), AdminToken: os.Getenv("AMR_GO_ADMIN_TOKEN")}})
	} else {
		g, err = gateway.New(options)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	defer g.Close()
	listener, err := net.Listen("tcp", *listen)
	if err != nil {
		fmt.Fprintln(os.Stderr, "unable to bind laboratory server")
		os.Exit(1)
	}
	server := &http.Server{Handler: g, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 10 * time.Second, IdleTimeout: 30 * time.Second, MaxHeaderBytes: 16384}
	var publicServer *http.Server
	if *publicListen != "" {
		front, e := gateway.NewNativeFront(g, *nodeOrigin, options.EdgeToken)
		if e != nil {
			fmt.Fprintln(os.Stderr, e)
			os.Exit(2)
		}
		defer front.Close()
		publicListener, e := net.Listen("tcp", *publicListen)
		if e != nil {
			fmt.Fprintln(os.Stderr, "unable to bind native front")
			os.Exit(2)
		}
		publicServer = &http.Server{Handler: front, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 10 * time.Second, IdleTimeout: gateway.NativeIdleTimeout, MaxHeaderBytes: 16384}
		go func() {
			if e := publicServer.Serve(publicListener); e != nil && !errors.Is(e, http.ErrServerClosed) {
				_ = server.Close()
			}
		}()
	}
	drained := make(chan struct{})
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go func() {
		<-ctx.Done()
		defer close(drained)
		drain, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if publicServer != nil {
			if publicServer.Shutdown(drain) != nil {
				_ = publicServer.Close()
			}
		}
		if server.Shutdown(drain) != nil {
			_ = server.Close()
		}
	}()
	milestone := "m2b"
	if *runtimeMode {
		milestone = "m3"
	}
	_ = json.NewEncoder(os.Stdout).Encode(map[string]any{"listen": listener.Addr().String(), "milestone": milestone, "productionReady": false, "candidate": *candidate, "gomaxprocs": runtime.GOMAXPROCS(0), "logicalCPUs": runtime.NumCPU(), "goVersion": runtime.Version(), "localRuntimeSnapshot": *runtimeConfig != ""})
	if err = server.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
		fmt.Fprintln(os.Stderr, "laboratory server failed")
		os.Exit(1)
	}
	if ctx.Err() != nil {
		<-drained
	}
}

func firstNonempty(values ...string) string {
	for _, v := range values {
		if v != "" {
			return v
		}
	}
	return ""
}

func semanticReplay(reader io.Reader, writer io.Writer) error {
	scanner := bufio.NewScanner(reader)
	scanner.Buffer(make([]byte, 65536), gateway.MaxBodyBytes)
	encoder := json.NewEncoder(writer)
	for scanner.Scan() {
		var item struct {
			Body          json.RawMessage `json:"body"`
			Config        analysis.Config `json:"config"`
			Policy        semantic.Policy `json:"policy"`
			Content       string          `json:"content"`
			Secret        string          `json:"secret"`
			SessionID     string          `json:"sessionId"`
			Authorization string          `json:"authorization"`
			RequestID     string          `json:"requestId"`
		}
		var out any = map[string]bool{"error": true}
		if json.Unmarshal(scanner.Bytes(), &item) == nil {
			a, e := analysis.New(item.Config)
			if e == nil {
				base, e := a.Analyze(item.Body)
				if e == nil {
					assessment, e := semantic.Parse(item.Content)
					if e == nil {
						reason := assessment.Reason
						if reason == "" {
							reason = assessment.Tier
						}
						merged := analysis.Reclassify(base, item.Body, assessment.Task, assessment.Tier, assessment.Complexity, assessment.Confidence, reason)
						out = map[string]any{"assessment": assessment, "merged": merged, "eligible": item.Policy.Eligible(base, item.Body), "rollout": semantic.Bucket([]byte(item.Secret), item.SessionID, item.Authorization, item.RequestID)}
					}
				}
			}
		}
		if e := encoder.Encode(out); e != nil {
			return e
		}
	}
	return scanner.Err()
}

func analyzeReplay(reader io.Reader, writer io.Writer) error {
	scanner := bufio.NewScanner(reader)
	scanner.Buffer(make([]byte, 65536), gateway.MaxBodyBytes)
	encoder := json.NewEncoder(writer)
	for scanner.Scan() {
		var item struct {
			Body   json.RawMessage `json:"body"`
			Config analysis.Config `json:"config"`
		}
		var result any
		if err := json.Unmarshal(scanner.Bytes(), &item); err != nil {
			result = map[string]string{"error": "invalid_json"}
		} else {
			a, err := analysis.New(item.Config)
			if err != nil {
				result = map[string]string{"error": err.Error()}
			} else {
				r, err := a.Analyze(item.Body)
				if err != nil {
					result = map[string]string{"error": err.Error()}
				} else {
					result = r
				}
			}
		}
		if err := encoder.Encode(result); err != nil {
			return err
		}
	}
	return scanner.Err()
}

func replay(reader io.Reader, writer io.Writer) error {
	scanner := bufio.NewScanner(reader)
	scanner.Buffer(make([]byte, 65536), gateway.MaxBodyBytes)
	out := bufio.NewWriter(writer)
	defer out.Flush()
	for scanner.Scan() {
		var input decision.Input
		decoder := json.NewDecoder(bytes.NewReader(scanner.Bytes()))
		decoder.DisallowUnknownFields()
		var result any
		if err := decoder.Decode(&input); err != nil {
			result = map[string]any{"error": &decision.Error{Code: "invalid_contract", Message: "invalid input JSON"}}
		} else if decoder.Decode(new(any)) != io.EOF {
			result = map[string]any{"error": &decision.Error{Code: "invalid_contract", Message: "trailing JSON"}}
		} else {
			d, err := decision.Decide(input)
			if err != nil {
				result = map[string]any{"error": err}
			} else {
				result = map[string]any{"decision": d}
			}
		}
		if err := json.NewEncoder(out).Encode(result); err != nil {
			return err
		}
		if err := out.Flush(); err != nil {
			return err
		}
	}
	return scanner.Err()
}
