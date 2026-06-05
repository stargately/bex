#!/usr/bin/env bash
# Deploy the Go sample app: create a local git repo from examples/hello-go and
# apply a Service CR. Requires `scripts/up.sh` + a running control plane.
set -euo pipefail
cd "$(dirname "$0")/.."
export GIT_AUTHOR_NAME=bex GIT_AUTHOR_EMAIL=demo@bex.local \
       GIT_COMMITTER_NAME=bex GIT_COMMITTER_EMAIL=demo@bex.local

REPO="$(pwd)/data/repos/hello-go"
rm -rf "$REPO"; mkdir -p "$REPO"
cp examples/hello-go/main.go examples/hello-go/go.mod examples/hello-go/Dockerfile "$REPO/"
git -C "$REPO" init -q -b main
git -C "$REPO" add -A
git -C "$REPO" commit -q -m "hello-go"

kubectl apply -f - <<YAML
apiVersion: app.bex.co/v1alpha1
kind: Service
metadata:
  name: hello-go
  namespace: default
spec:
  repo: "$REPO"
  branch: main
  builder: auto
  port: 3000
  healthCheckPath: /
  autoDeploy: true
YAML

echo "applied Service hello-go (repo $REPO)"
echo "watch:  kubectl get services.app.bex.co -w"
echo "serve:  curl \$(kubectl get service.app.bex.co hello-go -o jsonpath='{.status.url}')/"
