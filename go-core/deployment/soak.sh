#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
compose=(docker compose -f go-core/compose.soak.yml)
mkdir -p data/go-soak/evidence
"${compose[@]}" config --quiet
"${compose[@]}" up -d --build --wait
gateway=$("${compose[@]}" ps -q gateway)
test "$(docker inspect --format '{{.HostConfig.NetworkMode}}' "$gateway")" = none
test "$(docker inspect --format '{{len .HostConfig.PortBindings}}' "$gateway")" = 0
docker inspect --format '{"id":"{{.Id}}","image":"{{.Image}}","memoryBytes":{{.HostConfig.Memory}},"nanoCPUs":{{.HostConfig.NanoCpus}}}' "$gateway" > data/go-soak/evidence/container.json
(
 while true; do
  stamp=$(date -u +%s)
  sample=$(docker stats --no-stream --format '{{json .}}' "$gateway") || break
  printf '{"at":%s,"stats":%s}\n' "$stamp" "$sample" >> data/go-soak/evidence/container-stats.jsonl
  sleep 30
 done
) &
stats_pid=$!
trap 'kill "$stats_pid" 2>/dev/null || true' EXIT
"${compose[@]}" exec -T controller node go-core/deployment/soak.mjs run | tee data/go-soak/evidence/progress.log
kill "$stats_pid" 2>/dev/null || true
wait "$stats_pid" 2>/dev/null || true
# A real five-second stream must finish while SIGTERM drains the Go process.
"${compose[@]}" exec -T controller node go-core/deployment/soak.mjs drain > data/go-soak/evidence/drain.log 2>&1 &
drain_pid=$!
for i in $(seq 1 100); do
 test -f data/go-soak/evidence/drain-ready.json && break
 sleep 0.1
done
test -f data/go-soak/evidence/drain-ready.json
"${compose[@]}" stop gateway
wait "$drain_pid"
test "$(docker inspect --format '{{.State.ExitCode}}' "$gateway")" = 0
"${compose[@]}" exec -T controller node go-core/deployment/soak.mjs audit
"${compose[@]}" rm -sf controller
"${compose[@]}" start gateway
"${compose[@]}" up -d --wait
"${compose[@]}" exec -T controller node go-core/deployment/soak.mjs snapshot > data/go-soak/evidence/after-restart.json
node --input-type=module -e 'import fs from "node:fs";import assert from "node:assert/strict";assert.deepEqual(JSON.parse(fs.readFileSync("data/go-soak/evidence/after-restart.json")),JSON.parse(fs.readFileSync("data/go-soak/evidence/expected-after-drain.json")));'
"${compose[@]}" rm -sf controller
"${compose[@]}" kill -s SIGKILL gateway
"${compose[@]}" up -d --wait
"${compose[@]}" exec -T controller node go-core/deployment/soak.mjs snapshot > data/go-soak/evidence/after-kill.json
node --input-type=module -e 'import fs from "node:fs";import assert from "node:assert/strict";assert.deepEqual(JSON.parse(fs.readFileSync("data/go-soak/evidence/after-kill.json")),JSON.parse(fs.readFileSync("data/go-soak/evidence/expected-after-drain.json")));'
printf '%s\n' '{"gracefulActiveStreamCompleted":true,"restartLedgerEqual":true,"killSettledLedgerEqual":true,"network":"none","portBindings":0,"productionReady":false}' > data/go-soak/evidence/restart-result.json
