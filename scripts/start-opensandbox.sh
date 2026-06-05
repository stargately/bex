#!/usr/bin/env bash
# Start a host OpenSandbox server (Docker runtime) for bex on :8077.
# Pre-pulls the runtime images so the first sandbox create doesn't block/timeout.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "pre-pulling OpenSandbox runtime images (cached after first time)..."
docker pull -q opensandbox/execd:v1.0.16 || true
docker pull -q opensandbox/egress:v1.0.12 || true

echo "starting opensandbox-server on :8077 (insecure/local) ..."
export OPENSANDBOX_INSECURE_SERVER=YES
exec uvx --from opensandbox-server opensandbox-server --config deploy/opensandbox/sandbox.toml
