# Cut chat eval

One command measures the chat assistant's behavior and speed together:

```
npm run eval:cut-chat -- [--runs N] [--only <case>] [--bucket chat|single-tool|multi-tool]
                         [--model <id>] [--simple-model <id>] [--complex-model <id>]
                         [--gate-model <id>] [--matrix] [--enforce-budgets] [--out <path>]
```

It replays real composer turns against the live chat model through the dev
server's hosted Responses route. Start `next dev` on :3000 first. Auth is the
dev bypass header, so runs spend no credits. The spoken fixture is synthesized
with macOS `say`, so runs need a Mac.

Every case asserts behavior (the reply, the tools called, the gate verdict,
forbidden tools) and records timing: the gate's classify time, time-to-first-
token (rounds stream, as production does), per-round wall time, tool-serve
time, and round count. The default single run per case is the quick regression
check; `--runs 3` gives real p50/p95s. Latency aggregates count passing runs
only — a wrong answer's speed means nothing — and pass rate is reported
alongside so a fast-but-wrong config stays visible.

Every case carries a bucket: `chat` turns (greetings, questions — the gated
fast path), `single-tool` edits (one decisive call), and `multi-tool` edits
(composed cuts). The eval runs the gate before round 1; production overlaps it
with input assembly, which is negligible, so this is the same critical path
the user perceives.

The default config is production's: the gate's three-way verdict (chat /
simple / complex) withholds tools on chat turns and routes simple turns to the
light chat model. `--model` pins both roles to one model for an unrouted
comparison; each run's report records the model every turn actually ran on
(`roundModel`). `--matrix` runs every row of `CANDIDATES` in
`eval-cut-chat.ts` and prints a comparison table. Model flags and candidate
rows resolve through the registry in `src/lib/inference/gemini-models.ts`; raw
model ids pass through.

Per-case `budget` values in `cases.ts` are checked against passing-run p50s.
They report by default; `--enforce-budgets` turns a breach into exit 1. The run
always exits 1 when a case has zero passing runs.

## The report

A full run writes `evals/cut-chat.latest-report.json` (schema
`cut-chat-eval/v1`, types in `report.ts`): per config → per bucket and per
case → pass rate, latency aggregates, budget breaches, and every run's full
timings and tool trace. A run narrowed by `--only` or `--bucket` writes only
when `--out` names a destination, so iterating never clobbers the baseline.
The committed copy is the baseline; `git diff` on it shows what a change did
to speed and correctness.

## Improving latency (the loop)

1. Make one change: bump a role in `src/lib/inference/gemini-models.ts`, edit
   the system prompt or a tool description in the catalog, or add a
   `CANDIDATES` row for a new model id.
2. Run `npm run eval:cut-chat -- --matrix --runs 3` (narrow with `--bucket`
   or `--only` while iterating).
3. Compare against the baseline: `git diff evals/cut-chat.latest-report.json`.
4. Keep the change only if pass rate holds and the p50s improve.
5. Commit the new report with the change, so the baseline tracks what ships.

What to look at per bucket: `chat` turns live and die on gate p50 + TTFT;
`single-tool` on total p50 and whether rounds stays near 2; `multi-tool` on
round count — every extra round is a full round-trip carrying the whole
conversation and all ~75 tool declarations.

Adding a case: append to `cases.ts` with a `bucket`, stub any mutating tool it
should call, and use `simulate` to assert on arguments. Run it alone with
`--only <name>` and `--runs 5` to check it's stable before relying on it.
