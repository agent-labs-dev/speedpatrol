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

Web throttling (`cpuThrottle`, `network: 4g | fast-3g | slow-3g`) uses the Chrome DevTools presets.

## Profiles

After the timed iterations, Speedpatrol runs one more iteration with a profiler on. So the profiler never slows a timed sample.

- `web` and `electron` get a CDP CPU profile.
- `command`, `startup`, and `custom` get a V8 `--cpu-prof` of each Node process. A server that a signal stops still writes its profile.
- `profile.mode: command` wraps a different profiler, for example `py-spy record -o {out} -- {cmd}`.

Speedpatrol makes a summary of each profile as hotspots: the self time and the total time of each function. The analyst and the optimizer read the diff of two profiles.
