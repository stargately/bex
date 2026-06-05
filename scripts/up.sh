#!/usr/bin/env bash
# Bring up the bex substrate locally: Zot registry + OpenSandbox server + the
# Service CRD. Idempotent. After this: `cd control-plane && make run`.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p data

# 1. Zot OCI registry on :5050 (127.0.0.1 — OpenSandbox/Docker resolve localhost to IPv6).
if ! curl -sf -m2 http://127.0.0.1:5050/v2/ >/dev/null 2>&1; then
  echo "starting Zot registry (bex-zot) on :5050..."
  docker rm -f bex-zot >/dev/null 2>&1 || true
  docker run -d --name bex-zot --restart unless-stopped -p 5050:5000 \
    ghcr.io/project-zot/zot-linux-arm64:latest >/dev/null \
    || docker run -d --name bex-zot --restart unless-stopped -p 5050:5000 \
      ghcr.io/project-zot/zot:latest >/dev/null
fi
echo "Zot: HTTP $(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:5050/v2/)"

# 2. OpenSandbox server (Docker runtime) on :8077.
if ! curl -sf -m2 http://127.0.0.1:8077/health >/dev/null 2>&1; then
  echo "starting OpenSandbox server on :8077..."
  nohup bash scripts/start-opensandbox.sh > data/opensandbox.log 2>&1 &
  for i in $(seq 1 90); do curl -sf -m2 http://127.0.0.1:8077/health >/dev/null 2>&1 && break; sleep 1; done
fi
echo "OpenSandbox: $(curl -s -m2 http://127.0.0.1:8077/health || echo DOWN)"

# 3. Service CRD into the cluster.
echo "installing Service CRD..."
( cd control-plane && make install >/dev/null 2>&1 )
kubectl get crd services.app.bex.co --no-headers 2>/dev/null | awk '{print "CRD:",$1}'

echo
echo "substrate up. Next:"
echo "  cd control-plane && make run        # run the Go control plane"
echo "  bash scripts/deploy-sample.sh       # deploy the Go sample app"
