# Configuration

`.speedpatrol/speedpatrol.yml`, validated when Speedpatrol starts. An unknown kind, a missing field or a duplicate benchmark id is a config error (exit code 2).

```yaml
version: 1
project:
  name: my-app
  source: .                 # the repo, relative to the folder that holds .speedpatrol/
app:
  instructions: instructions.md
  prepare:                  # once per checkout, not timed
    - run: pnpm install --frozen-lockfile && pnpm build
  setup:                    # before the benchmarks
    - run: pnpm start
      background: true
      readyUrl: http://127.0.0.1:${PORT}/health
      env: { NODE_ENV: production }
    - run: node scripts/seed.js
      capture:
        TOKEN: 'token=(\S+)'   # regex, first group; a captured value is a secret
  teardown: []
  env:
    PORT: "3000"
  secrets: [API_KEY]        # env var names that never reach a log or a model
defaults:
  iterations: 15
  warmup: 2
  timeoutMs: 60000
  rounds: 2                 # A/B rounds
benchmarks: []              # see below; the scout writes to benchmarks.json
thresholds:
  relative: 0.05            # changes under 5% are never a verdict
  absolute: 1               # nor changes under 1 (in the metric's unit)
  alpha: 0.01
  maxCv: 0.15
agents:
  scout: { use: claude, maxSteps: 60, timeoutMinutes: 30 }
  analyst: { use: claude }
  optimizer: { use: claude, enabled: false, maxPerCycle: 1, minImprovement: 0.05 }
  github: { enabled: false, pullRequests: draft, labels: [speedpatrol] }
  patrol: { intervalMinutes: 30, pull: origin/main, cycles: 0 }
```

`${NAME}` in commands, URLs, headers and bodies is replaced by an env var, an `app.env` value or a captured value.

## Benchmarks

Every benchmark has:

| Field | Default | |
| --- | --- | --- |
| `id` | | lowercase, digits, `.`, `-`, `_` |
| `kind` | | one of the kinds below |
| `title`, `description` | | for people and agents |
| `critical` | `false` | a user-critical path: guarded by every experiment, listed first |
| `tags` | `[]` | select with `speedpatrol run <tag>` |
| `iterations`, `warmup`, `timeoutMs` | `defaults` | |
| `primary` | the kind's | the metric that decides the verdict |
| `profile` | `{ enabled: true, mode: auto }` | `mode: node`, `command` (with `command: "py-spy record -o {out} -- {cmd}"`) or `off` |

### `http`

```yaml
- id: api.orders
  kind: http
  critical: true
  request:
    url: ${BASE_URL}/api/orders?limit=50
    method: GET
    headers: { authorization: Bearer ${TOKEN} }
  expectStatus: 200
  concurrency: 1            # above 1, also p95_ms and rps per batch
```

### `web`

```yaml
- id: web.inbox
  kind: web
  url: ${BASE_URL}/inbox
  setup:                    # before the timed load; not timed
    - { name: sign-in, goto: "${BASE_URL}/login" }
    - { name: email, fill: { selector: "#email", value: "${TEST_EMAIL}" } }
    - { name: submit, click: "button[type=submit]", waitFor: "#inbox" }
  steps:                    # timed one by one after the load
    - { name: open-thread, click: ".thread >> nth=0", waitFor: ".message" }
    - { name: back, press: "Escape", waitFor: "#inbox" }
  viewport: { width: 1280, height: 800 }
  cpuThrottle: 4
  network: 4g               # none | 4g | fast-3g | slow-3g
  warm: false               # true reuses the cache between iterations
```

Each step can `goto`, `click`, `fill`, `press`, then waits for `waitFor` (visible) and/or `waitForNetworkIdle`.

### `electron`

```yaml
- id: desktop.open
  kind: electron
  run: npx electron . --remote-debugging-port=9333
  cdpPort: 9333
  readySelector: "#app-shell"
  steps: [{ name: settings, click: "#settings", waitFor: ".settings" }]
```

### `startup`

```yaml
- id: startup.api
  kind: startup
  run: node dist/server.js
  env: { PORT: "4999" }
  ready: { url: http://127.0.0.1:4999/health }   # or { output: "listening on" }
```

### `command`

```yaml
- id: build
  kind: command
  run: pnpm build
  before: rm -rf dist       # each iteration, not timed
```

### `android`, `ios`, `maestro`

```yaml
- { id: android.open, kind: android, activity: com.example/.MainActivity, cold: true }
- { id: ios.open, kind: ios, bundleId: com.example.app, readyOutput: "FIRST_SCREEN_READY" }
- { id: mobile.checkout, kind: maestro, flow: .maestro/checkout.yaml }
```

### `custom`

```yaml
- id: render.list
  kind: custom
  run: node bench/render-list.js
  metrics:
    render_ms: { unit: ms, better: lower }
    fps: { unit: count, better: higher }
```

The command prints `{"metrics": {"render_ms": 12.3, "fps": 58}}` as a line of its output; the last such line counts.

## Agents

`use` is a preset (`claude`, `codex`, `opencode`), a command (`{ runtime: cli, command: "..." }` with `{prompt}`, `{mcp}`, `{mcpUrl}`, `{workdir}`), or a model (`{ runtime: model, via: openrouter | openai | anthropic | custom, model: "...", endpoint: "..." }`, keys from `OPENROUTER_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `SPEEDPATROL_MODEL_API_KEY`).
