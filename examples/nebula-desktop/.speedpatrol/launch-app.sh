#!/usr/bin/env bash
# (Re)launches the desktop app for identity a through the e2e harness, so a
# code change in the checkout is picked up (dev runs are frozen: no HMR).
set -euo pipefail
export PATH="$HOME/.bun/bin:$PATH" DISPLAY="${DISPLAY:-:99}"
cd "$SPEEDPATROL_SOURCE"
# Another checkout (an A/B side) shares the harness run: identities, app state.
if [ "$SPEEDPATROL_SOURCE" != "$DESKTOP_PRIMARY" ] && [ ! -e test-results ]; then ln -s "$DESKTOP_PRIMARY/test-results" test-results; fi
# The repo ignores `test-results/`, a directory pattern a symlink does not match, so the
# link would be the optimizer's whole commit after it reverts a change. Every worktree
# reads the common exclude file.
exclude="$(git rev-parse --git-common-dir)/info/exclude"
grep -qx /test-results "$exclude" 2>/dev/null || { mkdir -p "$(dirname "$exclude")"; echo /test-results >>"$exclude"; }
bun run e2e app quit --identity a >/dev/null 2>&1 || true
rm -f "test-results/agent-e2e/$E2E_RUN_ID/apps/a/home/desktop-active-workspace.json"
NEBULA_SKIP_PACKAGE_BUILD=1 bun run e2e app launch --identity a 2>&1 | tail -1
