# nebula-desktop

The config used to try Speedpatrol on a running nebula-desktop worktree
(2026-10-27). It drives the app through the repo's own e2e harness
(`tools/e2e`) against the dev backend.

- `desktop.navigate` attaches to the running app over CDP (an `electron`
  benchmark without `run`) and times Home -> Inbox -> Channel -> Home.
- `desktop.boot` wraps the harness's `e2e --json perf boot`, whose
  `{"metrics": [{name, value}]}` output a `custom` benchmark reads as is.
- `api.*` time the REST reads the rail makes, with the identity's token.
- `build.room` times the `@nebula/room` package build.
- `prepare.sh` installs and builds a checkout once; `launch-app.sh`
  relaunches the app from whichever checkout is measured, sharing the
  harness run, so `speedpatrol compare --head <worktree>` works.

```bash
export E2E_RUN_ID=<run from `bun run e2e env up --backend dev`>
export SP_TOKEN=$(cat test-results/agent-e2e/$E2E_RUN_ID/identities/a.token)
export NEBULA_DESKTOP_DIR=$PWD DISPLAY=:99
speedpatrol run
speedpatrol compare --base origin/main --head ../my-worktree desktop.navigate
```

The Channel `perf-room` comes from `bun run e2e fixture channel create perf-room --identity a`.
