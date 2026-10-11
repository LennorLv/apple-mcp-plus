#!/usr/bin/env bash
set -euo pipefail
TASK_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
"$TASK_ROOT/script/build-eventkit.sh"
case "${1:-run}" in
  --debug) exec lldb -- "$TASK_ROOT/dist/eventkit-helper" ;;
  --verify) exec "$TASK_ROOT/dist/eventkit-helper" --self-test ;;
  run) printf '%s\n' '{"requestId":"run-status","operation":"status"}' | "$TASK_ROOT/dist/eventkit-helper" ;;
  *) echo 'Usage: build_and_run.sh [--debug|--verify]' >&2; exit 2 ;;
esac
