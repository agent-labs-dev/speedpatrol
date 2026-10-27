# Data model

All data is plain JSON under `.speedpatrol/runs/` (git ignores it), so the dashboard, a person, a script and an agent can all read it. Writes go through a temp file and a rename. The types are in [`packages/core/src/types`](../packages/core/src/types).

| Path | Content |
| --- | --- |
| `runs/<id>.json` | A **Run**: source (dir, sha, branch, dirty), machine, benchmarks hash, and per benchmark every metric's samples and summary, the errors, the profile and its hotspots |
| `baselines.json` | The **baseline index**, append-only: `{sha, runId, machine, benchmarksHash, branch, subject, at}`. The newest entry for a sha and machine wins |
| `comparisons/<id>.json` | A **Comparison**: mode (`baseline` or `ab`), the run ids of each side, and per metric the summaries, the change, its 95% interval, p and the verdict |
| `regressions/<id>.json` | A **Regression**: benchmark, metric, good and bad sha, the confirming comparison, status (`open`, `filed`, `dismissed`, `fixed`), the analyst's title, analysis and suspects, the issue URL |
| `experiments/<id>.json` | An **Experiment**: target, branch, worktree, base and head sha, hypothesis, summary, the verifying comparison, the change, collateral regressions, status (`proposed`, `measuring`, `improved`, `rejected`, `failed`, `published`), the PR URL |
| `profiles/<run>/<benchmark>.cpuprofile` | The profile of the profiled iteration; open it in Chrome DevTools or speedscope |
| `sessions/<id>/events.jsonl` | Each agent step: thought, tool call, tool result, cost |
| `agents.json` | The current status of each role, with the writer's pid |
| `patrol.json` | The last measured sha and the cycle count |
| `checkouts/<sha>/` | Detached worktrees of measured commits |
| `worktrees/<id>/` | Experiment worktrees |

## A run, abridged

```json
{
  "id": "20261027T043100-3f9a",
  "purpose": "baseline",
  "source": { "dir": "/srv/app", "sha": "3f9a1c2e...", "branch": "main", "dirty": false },
  "machine": { "fingerprint": "a1b2c3d4e5", "cpuModel": "AMD EPYC 7B13", "cpus": 8, "memoryGb": 32, "node": "22.11.0" },
  "benchmarksHash": "9c1d0e2f3a4b",
  "results": [
    {
      "benchmark": "api.orders",
      "kind": "http",
      "primary": "total_ms",
      "critical": true,
      "iterations": 15,
      "errors": [],
      "metrics": {
        "total_ms": {
          "unit": "ms",
          "better": "lower",
          "values": [41.2, 40.8, 42.0],
          "summary": { "n": 15, "median": 41.2, "p95": 44.9, "mad": 0.9, "cv": 0.03 }
        }
      },
      "profile": { "path": "profiles/20261027T043100-3f9a/api.orders.cpuprofile", "kind": "cpuprofile", "hotspots": [] }
    }
  ]
}
```

## Exporting

Every file is JSON, so a history can go anywhere: `jq` over `runs/*.json` gives a CSV of medians per commit, and a nightly job can copy `runs/` to object storage.
