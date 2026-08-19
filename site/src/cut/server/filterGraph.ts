/**
 * ffmpeg's graph parser splits chains on `,` and graphs on `;` wherever they
 * appear — it ignores parentheses. An expression like `min(iw,330)` written
 * bare into a filter option therefore cuts the graph mid-call, and the run
 * dies with `No such filter: '330):min(ih'`. Two rules keep that impossible:
 * every expression that can carry a comma goes through `fexpr`, and every
 * assembled graph goes through `assertGraphSafe` on its way to ffmpeg.
 */

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
