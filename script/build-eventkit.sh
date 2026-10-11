#!/usr/bin/env bash
set -euo pipefail
TASK_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
mkdir -p "$TASK_ROOT/dist" "$TASK_ROOT/.cache/swift"
xcrun swiftc -swift-version 5 -target "$(uname -m)-apple-macosx14.0" -parse-as-library -O \
  -module-cache-path "$TASK_ROOT/.cache/swift" \
  "$TASK_ROOT/native/EventKitHelper.swift" \
  -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker "$TASK_ROOT/native/Info.plist" \
  -o "$TASK_ROOT/dist/eventkit-helper"
codesign --force --sign - --identifier io.apple-mcp.eventkit-helper "$TASK_ROOT/dist/eventkit-helper"
