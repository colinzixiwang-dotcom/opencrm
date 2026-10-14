#!/bin/sh
set -eu
task_root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
task_go=${HARBOR_GO:-go}
if ! command -v "$task_go" >/dev/null 2>&1; then
  task_go="$task_root/../../work/toolchain/go/bin/go"
fi
if [ ! -x "$task_go" ] && ! command -v "$task_go" >/dev/null 2>&1; then
  printf '%s\n' 'Install Go 1.25+ or set HARBOR_GO to its executable.' >&2
  exit 1
fi
cd "$task_root/backend"
exec "$task_go" "$@"
