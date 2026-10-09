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
