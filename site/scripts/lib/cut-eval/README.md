# Cut chat evals

Two entrypoints share the fixtures, cases, and runner in this folder:

- `npm run eval:cut-chat` — behavior: does the model do the right thing?
- `npm run eval:cut-latency` — speed: how fast does it get there?

Both replay real composer turns against the live chat model through the dev
server's hosted Responses route. Start `next dev` on :3000 first. Auth is the
dev bypass header, so runs spend no credits. The spoken fixture is synthesized
with macOS `say`, so runs need a Mac.

## Latency eval

```
npm run eval:cut-latency -- [--runs 3] [--only <case>] [--bucket chat|single-tool|multi-tool]
                            [--model flash|flashLite|<raw id>] [--gate-model ...]
                            [--matrix] [--enforce-budgets] [--out <path>]
```

Every case carries a bucket: `chat` turns (greetings, questions — the gated
fast path), `single-tool` edits (one decisive call), and `multi-tool` edits
(composed cuts). Each run records the gate's classify time, time-to-first-token
(rounds stream, as production does), per-round wall time, tool-serve time, and
round count. Latency aggregates (p50/p95/mean) count passing runs only — a
wrong answer's speed means nothing — and pass rate is reported alongside so a
fast-but-wrong config stays visible.

The eval runs the gate before round 1. Production overlaps it with input
assembly, which is negligible, so this is the same critical path the user
perceives.

`--matrix` runs every row of `CANDIDATES` in `eval-cut-latency.ts` and prints a
comparison table. Model flags and candidate rows resolve through the registry
in `src/lib/inference/gemini-models.ts`; raw model ids pass through.

Per-case `budget` values in `cases.ts` are checked against passing-run p50s.
They report by default; `--enforce-budgets` turns a breach into exit 1. The run
always exits 1 when a case has zero passing runs.

## The report

Each run writes `evals/cut-chat-latency.latest-report.json` (schema
`cut-chat-latency/v1`, types in `report.ts`): per config → per bucket and per
case → pass rate, latency aggregates, budget breaches, and every run's full
timings and tool trace. The committed copy is the baseline; `git diff` on it
shows what a change did to speed and correctness.

## Improving latency (the loop)

1. Make one change: bump a role in `src/lib/inference/gemini-models.ts`, edit
   the system prompt or a tool description in the catalog, or add a
   `CANDIDATES` row for a new model id.
2. Run `npm run eval:cut-latency -- --matrix --runs 3` (narrow with `--bucket`
   or `--only` while iterating).
3. Compare against the baseline: `git diff evals/cut-chat-latency.latest-report.json`.
4. Keep the change only if pass rate holds and the p50s improve.
5. Commit the new report with the change, so the baseline tracks what ships.

What to look at per bucket: `chat` turns live and die on gate p50 + TTFT;
`single-tool` on total p50 and whether rounds stays near 2; `multi-tool` on
round count — every extra round is a full round-trip carrying the whole
conversation and all ~75 tool declarations.

Adding a case: append to `cases.ts` with a `bucket`, stub any mutating tool it
should call, and use `simulate` to assert on arguments. Run it alone with
`--only <name>` and `--runs 5` to check it's stable before relying on it.

## Behavior eval

`npm run eval:cut-chat -- [--only <case>] [--runs N]` prints PASS/FAIL per case
and exits 1 on any failure. Same cases, no timing, no report file — use it as
the quick regression check while the latency eval is the measurement tool.
