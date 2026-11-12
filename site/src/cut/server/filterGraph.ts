/**
 * ffmpeg's graph parser splits chains on `,` and graphs on `;` wherever they
 * appear — it ignores parentheses. An expression like `min(iw,330)` written
 * bare into a filter option therefore cuts the graph mid-call, and the run
 * dies with `No such filter: '330):min(ih'`. Two rules keep that impossible:
 * every expression that can carry a comma goes through `fexpr`, and every
 * assembled graph goes through `assertGraphSafe` on its way to ffmpeg.
 */

/** An input file's stream named as a graph input: `[0:v]`, `[2:a]`, `[1:a:0]`. */
const STREAM_PAD = /\[(\d+:[av](?::\d+)?)\]/g;

/** The stream a pad names: `[0:a:0]` and `[0:a]` are both `0:a`. */
const streamOf = (spec: string) => spec.replace(/:0$/, "");

/** `f` with `fn` applied to each stream pad outside its quoted option values. */
const mapPads = (f: string, fn: (pad: string, stream: string) => string) =>
  f
    .split("'")
    .map((part, i) => (i % 2 === 0 ? part.replace(STREAM_PAD, (pad, spec: string) => fn(pad, streamOf(spec))) : part))
    .join("'");

/**
 * The graph with every input stream it reads more than once fanned out by one
 * split. ffmpeg feeds each mention of `[0:v]` as a graph input of its own and
 * prepares every frame for each one: a phone clip's rotation runs once per
 * mention on every frame, trimmed away or not, so 60 cuts off one recording
 * rotated each frame 60 times. ffmpeg 8 added a cost per mention on the sound
 * side too. One split per stream prepares each frame once.
 */
export function fanOutInputs(filters: string[]): string[] {
  // How many times the graph reads each stream.
  const reads = new Map<string, number>();
  for (const f of filters) {
    mapPads(f, (pad, stream) => {
      reads.set(stream, (reads.get(stream) ?? 0) + 1);
      return pad;
    });
  }
  const shared = [...reads].filter(([, n]) => n > 1);
  if (shared.length === 0) {
    return filters;
  }

  // Each mention, in graph order, takes the next branch: `[0:v]` read three
  // times becomes `[fan0_v_0]`, `[fan0_v_1]`, `[fan0_v_2]`.
  const branch = (stream: string, k: number) => `fan${stream.replace(/:/g, "_")}_${k}`;
  const taken = new Map<string, number>();
  const body = filters.map((f) =>
    mapPads(f, (pad, stream) => {
      if (reads.get(stream)! < 2) {
        return pad;
      }
      const k = taken.get(stream) ?? 0;
      taken.set(stream, k + 1);
      return `[${branch(stream, k)}]`;
    })
  );

  // The splits lead the graph, one per shared stream.
  const splits = shared.map(([stream, n]) => {
    const split = stream.split(":")[1] === "a" ? "asplit" : "split";
    return `[${stream}]${split}=${n}${Array.from({ length: n }, (_, k) => `[${branch(stream, k)}]`).join("")}`;
  });
  return [...splits, ...body];
}

/** The graph's chains one per entry: an entry may join several with `;`,
 * which splits them wherever it stands outside a quoted value. */
function chainsOf(filters: string[]): string[] {
  return filters.flatMap((f) => {
    const parts = f.split("'");
    const chains = [""];
    parts.forEach((part, i) => {
      const pieces = i % 2 === 0 ? part.split(";") : [part];
      chains[chains.length - 1] += (i > 0 ? "'" : "") + pieces[0];
      chains.push(...pieces.slice(1));
    });
    return chains;
  });
}

/** The labels a chain reads, from its front, and writes, at its end. */
const LEAD_PADS = /^(?:\[[^\]]+\])*/;
const TRAIL_PADS = /(?:\[[^\]]+\])*$/;
const labelsOf = (pads: string) => [...pads.matchAll(/\[([^\]]+)\]/g)].map((m) => m[1]);

/**
 * The chains `outs` are built from, in graph order: one output's part of a
 * graph that renders several, as a run of its own takes it.
 */
export function chainsFeeding(filters: string[], outs: string[]): string[] {
  const chains = chainsOf(filters);

  // Which chain writes each label.
  const writer = new Map<string, number>();
  chains.forEach((c, i) => {
    for (const label of labelsOf(c.match(TRAIL_PADS)![0])) {
      writer.set(label, i);
    }
  });

  // Walk back from the outputs through every label read; an input stream
  // such as `0:v` has no writer and ends the walk.
  const kept = new Set<number>();
  const wanted = [...outs];
  while (wanted.length > 0) {
    const at = writer.get(wanted.pop()!);
    if (at === undefined || kept.has(at)) {
      continue;
    }
    kept.add(at);
    wanted.push(...labelsOf(chains[at].match(LEAD_PADS)![0]));
  }
  return chains.filter((_, i) => kept.has(i));
}

/**
 * The graph's chains ordered so each comes before the chains it reads. On a
 * tie ffmpeg runs the filter created first, and a graph listed source-first
 * sends each request up through every split twice, once per branch: a chain
 * of diamonds costs twice as much per diamond, and a cut with seven glitches
 * stalled. Listed this way, a filter's requests gather before it runs.
 */
export function downstreamFirst(filters: string[]): string[] {
  const chains = chainsOf(filters);

  // Which chain writes each label, and how many chains read each chain.
  const writer = new Map<string, number>();
  chains.forEach((c, i) => {
    for (const label of labelsOf(c.match(TRAIL_PADS)![0])) {
      writer.set(label, i);
    }
  });
  const reads = chains.map((c) => labelsOf(c.match(LEAD_PADS)![0]).flatMap((l) => writer.get(l) ?? []));
  const readers = chains.map(() => 0);
  for (const from of reads) {
    for (const j of from) {
      readers[j]++;
    }
  }

  // Emit a chain once every chain reading it is out, the latest listed
  // first, so a graph already listed sources-first comes out reversed; any
  // chain left in a cycle keeps its place at the end.
  const ready = chains.flatMap((_, i) => (readers[i] === 0 ? [i] : []));
  const order: number[] = [];
  while (ready.length > 0) {
    const i = ready.pop()!;
    order.push(i);
    for (const j of reads[i]) {
      readers[j]--;
      if (readers[j] !== 0) {
        continue;
      }
      const at = ready.findIndex((k) => k > j);
      ready.splice(at < 0 ? ready.length : at, 0, j);
    }
  }
  const placed = new Set(order);
  const left = [...chains.keys()].filter((i) => !placed.has(i));
  return [...order, ...left].map((i) => chains[i]);
}

/**
 * The inputs `chains` read, out of a run's `inputs` args, and the chains
 * with their stream pads renumbered to match: `[3:a]` reading the second
 * input kept becomes `[1:a]`. An input's flags travel with it.
 */
export function inputsRead(inputs: string[], chains: string[]): { inputs: string[]; chains: string[] } {
  // Each input is its flags through `-i <path>`.
  const groups: string[][] = [];
  let open: string[] = [];
  for (let i = 0; i < inputs.length; i++) {
    open.push(inputs[i]);
    if (inputs[i] === "-i") {
      open.push(inputs[++i]);
      groups.push(open);
      open = [];
    }
  }

  // The inputs read, in their order, and where each lands.
  const indexOf = (stream: string) => Number(stream.split(":")[0]);
  const read = new Set<number>();
  for (const c of chains) {
    mapPads(c, (pad, stream) => {
      read.add(indexOf(stream));
      return pad;
    });
  }
  const order = [...read].sort((a, b) => a - b);
  const moved = new Map(order.map((n, k) => [n, k]));
  return {
    inputs: order.flatMap((n) => groups[n]),
    chains: chains.map((c) => mapPads(c, (pad, stream) => pad.replace(/^\[\d+/, `[${moved.get(indexOf(stream))}`))),
  };
}

/** A filter option value single-quoted so the graph parser carries it whole. */
export function fexpr(expr: string): string {
  if (expr.includes("'")) {
    throw new Error(`filter expression carries a single quote: ${expr}`);
  }
  return `'${expr}'`;
}

/**
 * The assembled graph, checked: a bare `,` or `;` inside parentheses would
 * split a filter mid-expression, so it throws here — at build, with the
 * offending stretch named — before ffmpeg turns it into a cryptic parse error.
 */
export function assertGraphSafe(graph: string): string {
  let depth = 0;
  let quoted = false;
  for (let i = 0; i < graph.length; i++) {
    const ch = graph[i];
    if (quoted) {
      if (ch === "'") quoted = false;
      continue;
    }
    if (ch === "\\") {
      i++;
      continue;
    }
    if (ch === "'") {
      quoted = true;
    } else if (ch === "(") {
      depth++;
    } else if (ch === ")") {
      depth = Math.max(0, depth - 1);
    } else if ((ch === "," || ch === ";") && depth > 0) {
      const from = Math.max(0, i - 40);
      throw new Error(
        `filter graph splits inside an expression near "…${graph.slice(from, i + 20)}…" — ` +
          `quote the expression with fexpr()`
      );
    }
  }
  return graph;
}
