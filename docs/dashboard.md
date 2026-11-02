# The dashboard

<img src="../assets/dashboard.png" alt="The Speedpatrol dashboard: the status band, the items that need attention, the benchmarks, the recent runs, and the agents." width="100%">

Start the dashboard in the repo that has `.speedpatrol/`:

```bash
npx speedpatrol dashboard              # http://127.0.0.1:4321
npx speedpatrol dashboard --port 5000  # use a different port
```

The dashboard reads the files in `.speedpatrol/` ([Data model](data-model.md)) every 3 seconds. So it works during a patrol and after it. It is read-only, and it listens on 127.0.0.1 only, because the data names hosts, commits, and code paths.

## Pages

Each page starts with its numbers, then its filters, then the details. The problems come first. A long list has groups with counts. Open a row to see its evidence.

| Page | What it shows |
| --- | --- |
| Overview | The status of the project: the verdict, the open regressions, the speed-ups to publish, the benchmarks measured, and the last baseline. Then the items that need attention, each with its next command. Then the benchmarks, the recent runs, and the agents |
| Benchmarks | Each benchmark with its newest median, its last step, and its history. The benchmarks with a problem come first: an open regression, errors, no baseline, or not in the last baseline. Open one to see its charts, its hotspots, its regressions, and its experiments |
| Regressions | Each regression, open first. Open one to see the change, the last good and first bad commits, the analysis, the suspects, and the issue |
| Experiments | Each speed-up of the optimizer. The verified ones that wait to be published come first |
| Runs | Each run, failed runs first, with the result of its comparison. Open a result to see each metric of the comparison, changed metrics first |
| Activity | Each agent session, running first, and what each agent does now. Open a session to see its timeline |

The server computes the numbers once, in `GET /api/summary`. Each page shows these numbers, so two pages cannot disagree.

The status band tells the truth about these cases:

- A failed last run shows as the last baseline, also when an older run worked.
- A benchmark of the config that has no baseline shows as a problem.
- A session with no finish event, whose agent is gone, shows as stopped, not running.
- One baseline shows as "First baseline recorded", because nothing was compared yet.

A page with no data says why it is empty now, and gives the next command with a Copy button.

## The top bar

The icons on the right show the patrol, the machine of the timings, and the live connection. Hold the pointer on an icon to see its details.

The theme follows the system setting. The theme button (a monitor, sun, or moon icon) changes it to Light, then Dark, then back to System. The browser keeps your choice.

## Demo data

`packages/dashboard/scripts/fixture.mjs` writes a demo `.speedpatrol/` tree in three shapes: `busy`, `one` (one baseline), and `empty`:

```bash
node packages/dashboard/scripts/fixture.mjs /tmp/demo busy
```
