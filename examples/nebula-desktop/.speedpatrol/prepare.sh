#!/usr/bin/env bash
# Once per checkout, not timed: deps, the Sentry profiler binary this box
# cannot build for Electron, and the shared packages.
set -euo pipefail
export PATH="$HOME/.bun/bin:$PATH"
cd "$SPEEDPATROL_SOURCE"
[ -d node_modules ] || bun install --frozen-lockfile --ignore-scripts >/dev/null
d=node_modules/.bun/@sentry+node-cpu-profiler@2.4.2/node_modules/@sentry/node-cpu-profiler/build/Release
mkdir -p "$d" && cp -n "$HOME/paf-evidence/sentry_cpu_profiler.node" "$d/" 2>/dev/null || true
bunx turbo run build --filter='./packages/*' >/dev/null
