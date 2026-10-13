#!/bin/sh
set -eu
cd "$(dirname "$0")"
task_node_bin="${HARBOR_NODE:-node}"
supported_node() {
  "$1" -e 'const [major,minor]=process.versions.node.split(".").map(Number);process.exit((major===24&&minor>=15)||major>=26?0:1)' >/dev/null 2>&1
}
if ! supported_node "$task_node_bin"; then
  task_bundled_node="$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"
  if [ -x "$task_bundled_node" ] && supported_node "$task_bundled_node"; then
    task_node_bin="$task_bundled_node"
  else
    printf '%s\n' 'Harbor ERP needs Node.js 24.15+ (24.x) or 26+.' 'Install a supported Node version, or set HARBOR_NODE to its executable path.' >&2
    exit 1
  fi
fi
exec "$task_node_bin" server.mjs
