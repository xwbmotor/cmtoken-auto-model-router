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
	"syscall"
	"time"

	"github.com/xwbmotor/cmtoken-auto-model-router/go-core/internal/decision"
	"github.com/xwbmotor/cmtoken-auto-model-router/go-core/internal/gateway"
)

func main() {
	if len(os.Args) == 2 && os.Args[1] == "replay" {
		if err := replay(os.Stdin, os.Stdout); err != nil {
			fmt.Fprintln(os.Stderr, "replay failed:", err)
			os.Exit(1)
		}
		return
	}
	flags := flag.NewFlagSet("amr-core", flag.ExitOnError)
	lab := flags.Bool("lab", false, "acknowledge experimental loopback-only milestone")
	listen := flags.String("listen", "127.0.0.1:8791", "loopback listen address")
	assessor := flags.String("assessor", "http://127.0.0.1:8789/assess", "private laboratory feature adapter")
	upstream := flags.String("upstream", "http://127.0.0.1:8790/v1/chat/completions", "local mock upstream")
	timeout := flags.Duration("timeout", 30*time.Second, "laboratory request total deadline")
	_ = flags.Parse(os.Args[1:])
	if !*lab {
		fmt.Fprintln(os.Stderr, "Requires --lab; this milestone is not production-ready")
		os.Exit(2)
	}
	host, _, err := net.SplitHostPort(*listen)
	if err != nil || net.ParseIP(host) == nil || !net.ParseIP(host).IsLoopback() {
		fmt.Fprintln(os.Stderr, "listen must be a literal loopback address")
		os.Exit(2)
	}
	g, err := gateway.New(gateway.Options{AssessorURL: *assessor, UpstreamURL: *upstream,
		AccessToken: os.Getenv("AMR_GO_ACCESS_TOKEN"), AssessorToken: os.Getenv("AMR_GO_ASSESSOR_TOKEN"), UpstreamToken: os.Getenv("AMR_GO_UPSTREAM_TOKEN"),
		AssessmentTimeout: 3 * time.Second, RequestTimeout: *timeout, MaxRequests: 256})
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
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go func() {
		<-ctx.Done()
		drain, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if server.Shutdown(drain) != nil {
			_ = server.Close()
		}
	}()
	_ = json.NewEncoder(os.Stdout).Encode(map[string]any{"listen": listener.Addr().String(), "milestone": "m1", "productionReady": false})
	if err = server.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
		fmt.Fprintln(os.Stderr, "laboratory server failed")
		os.Exit(1)
	}
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
