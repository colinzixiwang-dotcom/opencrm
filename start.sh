#!/bin/sh
set -eu
cd "$(dirname "$0")"
supported_node() {
 "$1" -e 'const [m,n]=process.versions.node.split(".").map(Number);process.exit((m===22&&n>=19)||(m===24&&n>=11)||m>=26?0:1)' >/dev/null 2>&1
}
task_node=${HARBOR_NODE:-node}
if ! supported_node "$task_node"; then
 task_node="$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"
 if ! supported_node "$task_node"; then
  printf '%s\n' 'Install Node 22.19+, 24.11+, or 26+, or set HARBOR_NODE to its executable.' >&2
  exit 1
 fi
fi
if [ ! -d node_modules ]; then
 task_node_dir=$(dirname "$task_node")
 PATH="$task_node_dir:$PATH" npm ci
fi
"$task_node" node_modules/vite/bin/vite.js build --config frontend/vite.config.js
mkdir -p .bin
./scripts/go.sh build -o ../.bin/harbor ./cmd/harbor
exec ./.bin/harbor
