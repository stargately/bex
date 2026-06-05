#!/usr/bin/env bash
# Start a host OpenSandbox server in KUBERNETES runtime mode on :8078, scheduling
# into the vcluster "acme". Requires: OrbStack k8s up, vcluster acme running, the
# opensandbox-controller installed in the vcluster, and the vcluster kubeconfig at
# deploy/opensandbox/vcluster-acme.kubeconfig (see README / scripts).
set -euo pipefail
cd "$(dirname "$0")/.."

echo "starting opensandbox-server (kubernetes runtime) on :8078 ..."
export OPENSANDBOX_INSECURE_SERVER=YES
exec uvx --from opensandbox-server opensandbox-server --config deploy/opensandbox/sandbox-k8s.toml
