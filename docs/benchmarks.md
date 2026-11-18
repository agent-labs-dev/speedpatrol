# Benchmarks and metrics

A benchmark is one critical path and the method to measure it. Its `kind` selects the probe and the metrics. [Configuration](configuration.md#benchmarks) shows the fields of each kind.

| Kind | Critical path | Metrics |
| --- | --- | --- |
| `http` | An API endpoint, optionally under concurrency | `total_ms`, `ttfb_ms`, `bytes`, `p95_ms`, `rps` |
| `web` | A page load in Chromium, then screen navigation steps | `lcp_ms`, `fcp_ms`, `ttfb_ms`, `dcl_ms`, `load_ms`, `tbt_ms`, `cls`, `requests`, `transfer_kb`, `js_heap_mb`, `step.<name>_ms`, `flow_ms` |
| `electron` | Desktop app open to the first window and the first screen, then steps | `window_ms`, `ready_ms`, page metrics, steps |
| `startup` | Cold start of a server or worker until it prints a line or answers a URL | `ready_ms` |
| `android` | Cold app open (`am start -W`) | `total_time_ms`, `wait_time_ms` |
| `ios` | App open on a simulator, to a marker that the app prints | `launch_ms` |
| `maestro` | A mobile screen journey (a Maestro flow) | `flow_ms` |
| `command` | A build, a test run, a CLI command | `wall_ms`, `cpu_user_ms`, `cpu_sys_ms`, `max_rss_mb` |
| `custom` | Any script that prints `{"metrics": {...}}` (k6, hyperfine, your own) | the metrics that it declares |
| `pty` | A terminal app in a pseudo-terminal, to a marker that the app writes | `marker_ms`, `ready_ms` |

Web throttling (`cpuThrottle`, `network: 4g | fast-3g | slow-3g`) uses the Chrome DevTools presets.

Timed `web` and `electron` readiness waits check the first matching locator's visibility with a fixed 5 ms pause between checks. Playwright's general selector wait increases its retry interval up to 500 ms, which can overwhelm a small performance change. Checks still use Playwright's selector engines and visibility rules; their total interval also includes browser and scheduler time. A missing selector fails at the benchmark timeout.

Re-record web/Electron baselines after upgrading from the older selector waits. A lower measurement caused by a more precise harness is not an app speed-up. See the [mobile navigation measurement study](measurements/2026-11-04-mobile-navigation.md) for repeated unchanged-code runs and threshold guidance.

## Profiles

After the timed iterations, Speedpatrol runs one more iteration with a profiler on. So the profiler never slows a timed sample.

- `web` and `electron` get a CDP CPU profile.
- `command`, `startup`, and `custom` get a V8 `--cpu-prof` of each Node process. A server that a signal stops still writes its profile.
- `profile.mode: command` wraps a different profiler, for example `py-spy record -o {out} -- {cmd}`.

Speedpatrol makes a summary of each profile as hotspots: the self time and the total time of each function. The analyst and the optimizer read the diff of two profiles.

### Streamed agent turns

Use an HTTP benchmark against a local or development backend that emits SSE. Declare the exact event names supplied by that backend; Speedpatrol does not infer tokens or tool calls from payload text.

```yaml
- id: agent.turn
  kind: http
  primary: ttft_ms
  request:
    url: http://127.0.0.1:8000/dev/turn
    method: POST
    headers: { Content-Type: application/json }
    body: '{"prompt":"Read the local fixture"}'
  stream:
    events:
      ttft_ms: token
      first_tool_ms: tool_call
    endEvent: turn_complete
```

`ttfb_ms` measures response headers. `first_event_ms` measures the first complete SSE data event, excluding heartbeats and comments. Each declared metric measures the first complete event of that name. `total_ms` ends at `endEvent`, then the connection is cancelled; without `endEvent`, it ends at EOF. Missing declared events, a missing completion event, a non-SSE response or a timeout fail the sample. Keep the event contract explicit: a backend whose first token is a JSON field in a generic `message` event needs a custom benchmark script to interpret that protocol.

### Terminal first replies

A `pty` benchmark times a terminal app (a TUI or an interactive CLI) the way a person sees it: on a pseudo-terminal. The measurement is a contract between the app and the benchmark. The app writes an exact marker string when the moment being measured is on screen, for example right after it renders the first visible part of a reply, and Speedpatrol records the time to that marker's first appearance in the terminal output. Speedpatrol does not read the screen to guess when a reply has started.

```yaml
- id: tui.first-reply
  kind: pty
  run: node dist/cli.js chat
  env: { API_URL: http://127.0.0.1:8000, APP_BENCH_MARKERS: "1" }
  ready: SP_READY          # the app writes this when it accepts input
  input: "hello\r"         # typed when ready appears; \r presses Enter
  marker: SP_REPLY         # the app writes this when the first reply is visible
  iterations: 15
```

- The clock starts at the `ready` marker, or at the spawn when there is no `ready`. `ready_ms` is the time from the spawn to `ready`, and `marker_ms` (the primary metric) is the time from the start of the clock to `marker`.
- A marker matches as exact text, also when it arrives split across writes. The app must write it as one contiguous run of characters, with no styling or cursor movement inside it. It can be invisible to a person, for example inside an escape sequence the terminal ignores, as long as the bytes are contiguous.
- The terminal echoes typed input, so `marker` may not appear in `input` or its echo (a typed `\r` or `\n` echoes as `\r\n`), also after `${NAME}` values are filled in, and `ready` and `marker` must differ.
- Gate the markers behind a flag or environment variable of your own, so they appear only in benchmark runs.
- The app runs with `TERM=xterm-256color` (overridable in `env`) on a `cols` by `rows` terminal (default 120 by 40). Each iteration starts a fresh process and stops its process group after the marker.
- A failing `before` command, an app that exits before the marker, or a marker that does not appear within `timeoutMs` fails the sample.
- The terminal comes from `script` (util-linux on Linux, BSD on macOS), which `speedpatrol doctor` checks for. Windows is not supported.
- Run it against a local or development backend: every iteration is a real turn. Replies from a model vary, so expect a higher cv than a CPU benchmark and raise `iterations` until the primary metric stays under `maxCv`; a noisy run is not recorded as a baseline.
