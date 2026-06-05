#!/usr/bin/env bash
# Start the bex gateway (control plane :8080 + edge :8081 + idle loop).
# Env knobs (see src/config.js): BEX_API_PORT, BEX_EDGE_PORT, BEX_IDLE_TTL_MS, ...
set -euo pipefail
cd "$(dirname "$0")/.."
exec node src/server.js
