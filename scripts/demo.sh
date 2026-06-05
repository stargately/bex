#!/usr/bin/env bash
#
# End-to-end demo of the bex webhook -> build -> deploy -> serve cycle, plus the
# "sleep = free" hibernate/wake lifecycle. Self-contained: it starts its own
# gateway, runs the whole flow against OrbStack, then tears the service down.
#
#   bash scripts/demo.sh
#
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"

# ---- demo-friendly config (short idle TTL so hibernation is quick to watch) ----
export BEX_API_PORT="${BEX_API_PORT:-8090}"
export BEX_EDGE_PORT="${BEX_EDGE_PORT:-8091}"
export BEX_SERVE_DOMAIN="${BEX_SERVE_DOMAIN:-localhost}"
export BEX_IDLE_TTL_MS="${BEX_IDLE_TTL_MS:-12000}"
export BEX_IDLE_CHECK_MS="${BEX_IDLE_CHECK_MS:-3000}"
export BEX_RUNTIME="${BEX_RUNTIME:-docker}"
export BEX_OPENSANDBOX_URL="${BEX_OPENSANDBOX_URL:-http://127.0.0.1:8077}"
API="http://127.0.0.1:${BEX_API_PORT}"
EDGE="http://127.0.0.1:${BEX_EDGE_PORT}"

GIT="git -c user.email=demo@bex.local -c user.name=bex"
mkdir -p data/repos

section() { printf '\n\033[1;36m== %s ==\033[0m\n' "$*"; }
note()    { printf '   %s\n' "$*"; }
# Extract a field from JSON on stdin, e.g.  field "['webhook']['secret']"
field()   { python3 -c "import sys,json;print(json.load(sys.stdin)$1)"; }

GATEWAY_PID=""
SVC_ID=""
cleanup() {
  [ -n "$SVC_ID" ] && curl -s -X DELETE "$API/v1/services/$SVC_ID" >/dev/null 2>&1 || true
  [ -n "$GATEWAY_PID" ] && kill "$GATEWAY_PID" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
note "runtime: $BEX_RUNTIME"
if [ "$BEX_RUNTIME" = opensandbox ]; then
  if ! curl -sf -m 2 "$BEX_OPENSANDBOX_URL/health" >/dev/null 2>&1; then
    note "OpenSandbox server not up at $BEX_OPENSANDBOX_URL — starting it..."
    nohup bash scripts/start-opensandbox.sh > data/opensandbox.log 2>&1 &
    for i in $(seq 1 90); do curl -sf -m2 "$BEX_OPENSANDBOX_URL/health" >/dev/null 2>&1 && break; sleep 1; done
  fi
  curl -sf -m2 "$BEX_OPENSANDBOX_URL/health" >/dev/null 2>&1 \
    && note "OpenSandbox server healthy at $BEX_OPENSANDBOX_URL" \
    || { echo "OpenSandbox server not reachable; see data/opensandbox.log"; exit 1; }
fi

# ---------------------------------------------------------------------------
section "0. Start the bex gateway (control plane :$BEX_API_PORT, edge :$BEX_EDGE_PORT, runtime=$BEX_RUNTIME)"
node src/server.js > data/gateway.log 2>&1 &
GATEWAY_PID=$!
for i in $(seq 1 50); do
  if curl -sf "$API/healthz" >/dev/null 2>&1; then break; fi
  sleep 0.2
  if [ "$i" = 50 ]; then echo "gateway did not come up; see data/gateway.log"; tail -20 data/gateway.log; exit 1; fi
done
note "gateway up (pid $GATEWAY_PID); logs -> data/gateway.log"

# ---------------------------------------------------------------------------
section "1. Prepare a git repo (the 'agent') from examples/hello-node"
REPO_DIR="$ROOT/data/repos/hello-node"
rm -rf "$REPO_DIR"; mkdir -p "$REPO_DIR"
cp examples/hello-node/server.js examples/hello-node/package.json "$REPO_DIR/"
$GIT -C "$REPO_DIR" init -q -b main
$GIT -C "$REPO_DIR" add -A
$GIT -C "$REPO_DIR" commit -q -m "initial: hello-node responds OK"
note "repo at $REPO_DIR @ $($GIT -C "$REPO_DIR" rev-parse --short HEAD)"

# ---------------------------------------------------------------------------
section "2. POST /v1/services  (registers webhook, auto-kicks first deploy)"
CREATE=$(curl -sS -X POST "$API/v1/services" -H 'content-type: application/json' -d "{
  \"name\": \"hello-node\",
  \"repo\": \"$REPO_DIR\",
  \"branch\": \"main\",
  \"build\": { \"builder\": \"buildpack\" },
  \"run\":   { \"port\": 3000, \"healthCheckPath\": \"/\" },
  \"autoDeploy\": true
}")
echo "$CREATE" | python3 -m json.tool
SVC_ID=$(echo "$CREATE"   | field "['id']")
DEPLOY1=$(echo "$CREATE"  | field "['deploy']['id']")
SECRET=$(echo "$CREATE"   | field "['webhook']['secret']")
WEBHOOK_URL=$(echo "$CREATE" | field "['webhook']['url']")
HOST="hello-node-$SVC_ID"

wait_deploy() {
  local id="$1" last="" s
  for i in $(seq 1 300); do
    s=$(curl -sS "$API/v1/deploys/$id" | field "['status']")
    [ "$s" != "$last" ] && { note "deploy $id: $s"; last="$s"; }
    [ "$s" = live ] && return 0
    [ "$s" = failed ] && { note "FAILED: $(curl -sS "$API/v1/deploys/$id" | field "['error']")"; return 1; }
    sleep 1
  done
  return 1
}

# ---------------------------------------------------------------------------
section "3+4. Build & deploy the first revision (poll until live)"
wait_deploy "$DEPLOY1" || { echo "first deploy failed"; tail -40 data/gateway.log; exit 1; }
BUILD1=$(curl -sS "$API/v1/deploys/$DEPLOY1" | field "['buildId']")
note "build $BUILD1 image: $(curl -sS "$API/v1/builds/$BUILD1" | field "['image']")"

# ---------------------------------------------------------------------------
section "5. Serve — GET through the edge (Host: $HOST.$BEX_SERVE_DOMAIN)"
R1=$(curl -sS -H "Host: $HOST.$BEX_SERVE_DOMAIN" "$EDGE/")
note "response body: '$R1'   (expected: OK)"
[ "$R1" = "OK" ] || { echo "unexpected first response"; exit 1; }

# ---------------------------------------------------------------------------
section "6. git push -> webhook (HMAC-signed) triggers a rebuild & redeploy"
python3 - "$REPO_DIR/server.js" <<'PY'
import sys
p = sys.argv[1]
s = open(p).read().replace("|| 'OK'", "|| 'OK v2 (shipped by webhook)'")
open(p, 'w').write(s)
PY
$GIT -C "$REPO_DIR" commit -q -am "v2: change response message"
SHA=$($GIT -C "$REPO_DIR" rev-parse HEAD)
PAYLOAD="$ROOT/data/push.json"
printf '{"ref":"refs/heads/main","after":"%s","repository":{"full_name":"acme/hello-node"}}' "$SHA" > "$PAYLOAD"
SIG=$(openssl dgst -sha256 -hmac "$SECRET" "$PAYLOAD" | awk '{print $NF}')

note "first, prove signature verification rejects a bad signature:"
BAD=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$WEBHOOK_URL" \
  -H "X-Hub-Signature-256: sha256=deadbeef" --data-binary @"$PAYLOAD")
note "  bad-signature POST -> HTTP $BAD (expected 401)"

note "now send the correctly-signed push:"
WH=$(curl -sS -X POST "$WEBHOOK_URL" \
  -H "X-Hub-Signature-256: sha256=$SIG" -H 'content-type: application/json' \
  --data-binary @"$PAYLOAD")
echo "$WH" | python3 -m json.tool
DEPLOY2=$(echo "$WH" | field "['deploy']['id']")
wait_deploy "$DEPLOY2" || { echo "webhook deploy failed"; tail -40 data/gateway.log; exit 1; }

R2=$(curl -sS -H "Host: $HOST.$BEX_SERVE_DOMAIN" "$EDGE/")
note "response body: '$R2'   (expected: OK v2 (shipped by webhook))"
[ "$R2" = "OK v2 (shipped by webhook)" ] || { echo "redeploy did not take effect"; exit 1; }

# ---------------------------------------------------------------------------
section "7. 'sleep = free' — idle past TTL hibernates the container"
note "waiting for idle TTL (${BEX_IDLE_TTL_MS}ms) to hibernate the service..."
HIB=""
for i in $(seq 1 40); do
  st=$(curl -sS "$API/v1/services/$SVC_ID" | field "['state']")
  if [ "$st" = hibernated ]; then HIB=1; note "service state -> hibernated (container stopped, CPU/RAM freed)"; break; fi
  sleep 1
done
[ -n "$HIB" ] || { echo "service did not hibernate"; exit 1; }
if [ "$BEX_RUNTIME" = opensandbox ]; then
  note "(opensandbox) hibernate = real pause/resume snapshot via the Lifecycle API"
else
  note "(docker) container stopped:"; docker ps --filter "label=bex.service=$SVC_ID" --format '   running: {{.Names}} ({{.Status}})' || true
fi

# ---------------------------------------------------------------------------
section "8. Wake-on-request — a GET transparently wakes the hibernated service"
now_ms() { python3 -c 'import time;print(int(time.time()*1000))'; }
START=$(now_ms)
R3=$(curl -sS -H "Host: $HOST.$BEX_SERVE_DOMAIN" "$EDGE/")
END=$(now_ms)
note "response body: '$R3'  (woke + served in ~$((END-START)) ms)"
[ "$R3" = "OK v2 (shipped by webhook)" ] || { echo "wake-on-request did not serve correctly"; exit 1; }
note "service state now: $(curl -sS "$API/v1/services/$SVC_ID" | field "['state']")"

# ---------------------------------------------------------------------------
section "DONE — full webhook -> build -> deploy -> serve -> hibernate -> wake cycle verified"
note "(cleaning up: deleting service + stopping demo gateway)"
