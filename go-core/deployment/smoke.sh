#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
compose=(docker compose -f go-core/compose.lab.yml)
mkdir -p data/go-deployment/evidence
"${compose[@]}" config --quiet
"${compose[@]}" up -d --build --wait
gateway=$("${compose[@]}" ps -q gateway)
test "$(docker inspect --format '{{.HostConfig.NetworkMode}}' "$gateway")" = none
test "$(docker inspect --format '{{len .HostConfig.PortBindings}}' "$gateway")" = 0
"${compose[@]}" exec -T mock node /lab/container.mjs check | tee data/go-deployment/evidence/http.json
"${compose[@]}" exec -T mock node /lab/container.mjs snapshot > data/go-deployment/evidence/before.json
# Stop must finish as a normal process exit, not a SIGKILL timeout.
"${compose[@]}" rm -sf mock
"${compose[@]}" stop gateway
test "$(docker inspect --format '{{.State.ExitCode}}' "$gateway")" = 0
"${compose[@]}" start gateway
"${compose[@]}" up -d --wait
"${compose[@]}" exec -T mock node /lab/container.mjs snapshot > data/go-deployment/evidence/after-stop.json
cmp data/go-deployment/evidence/before.json data/go-deployment/evidence/after-stop.json
# Kill exercises WAL reopening after an unclean process death.
"${compose[@]}" rm -sf mock
"${compose[@]}" kill -s SIGKILL gateway
"${compose[@]}" up -d --wait
"${compose[@]}" exec -T mock node /lab/container.mjs snapshot > data/go-deployment/evidence/after-kill.json
cmp data/go-deployment/evidence/before.json data/go-deployment/evidence/after-kill.json
"${compose[@]}" exec -T mock node /lab/container.mjs check | tee data/go-deployment/evidence/after-restart-http.json
"${compose[@]}" stop gateway
"${compose[@]}" exec -T mock node /lab/container.mjs audit > data/go-deployment/evidence/audit.json
printf '%s\n' '{"network":"none","portBindings":0,"gracefulExit":true,"restartPreservesLedger":true,"killPreservesSettledLedger":true,"productionReady":false}' > data/go-deployment/evidence/result.json
