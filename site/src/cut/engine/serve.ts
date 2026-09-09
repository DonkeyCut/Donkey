import { allowedOrigin, corsHeaders, preflightHeaders } from "../server/cors";
import { matchCutRoute, runCutRoute } from "../server/http/routes";
import { flattenCutUsers, migrateCutDataDir } from "../server/migrateDataDir";
import { reconcileProjectDirs } from "../server/projects";
import { ensureToolPath, resolveOnPath } from "../server/tool-path";
import { enginePort } from "./config";

// Throws (and exits with a clear message) on a bad DONKEY_CUT_PORT rather than
// binding a random port the client would never find.
const PORT = enginePort();

// The engine's native HTTP boundary preserves Request.signal and stream cancellation.
// The hosted site's TypeScript build has DOM types; this is the Bun API the binary uses.
const native = (globalThis as unknown as { Bun: { serve(options: {
  hostname: string;
  port: number;
  idleTimeout: number;
  maxRequestBodySize: number;
  fetch: (request: Request) => Promise<Response>;
}): unknown } }).Bun;

/** The engine never outlives the app that spawned it: a survivor would keep
 * the port and serve a stale build after an app update. The app passes its
 * pid; when that process is gone, exit so the new app's spawn takes over. */
function exitWithParent() {
  const parent = Number(process.env.DONKEY_CUT_PARENT_PID);
  if (!Number.isInteger(parent) || parent <= 1) return;
  setInterval(() => {
    try {
      process.kill(parent, 0);
    } catch {
      console.log(`parent process ${parent} exited; shutting down`);
      process.exit(0);
    }
  }, 2000);
}

async function start() {
  exitWithParent();
  migrateCutDataDir();
  flattenCutUsers();
  reconcileProjectDirs();
  await ensureToolPath();

  // The Agent SDK can't resolve its built-in CLI from inside a compiled
  // binary; point it at the user's own Claude Code install (their login is
  // the whole point). Missing is fine — the models probe reports it.
  if (!process.env.DONKEY_CUT_CLAUDE) {
    const claude = await resolveOnPath("claude");
    if (claude) process.env.DONKEY_CUT_CLAUDE = claude;
  }

  native.serve({
    hostname: "127.0.0.1",
    port: PORT,
    idleTimeout: 0,
    // Project media streams to disk and can exceed Bun's default body limit.
    maxRequestBodySize: Number.MAX_SAFE_INTEGER,
    async fetch(req) {
      const origin = req.headers.get("origin") ?? "";
      const cors = allowedOrigin(origin);
      if (origin && !cors) return new Response("Cross-origin request refused.", { status: 403 });
      if (req.method === "OPTIONS") return new Response(null, {
        status: 204,
        headers: cors ? preflightHeaders(cors, req.headers.get("access-control-request-headers")) : {},
      });
      const headers = cors ? corsHeaders(cors) : {};
      const match = matchCutRoute(req.method, new URL(req.url).pathname);
      if (!match) return new Response("Not found.", { status: 404, headers });
      if ("methodNotAllowed" in match) return new Response("Method not allowed.", {
        status: 405, headers: { ...headers, Allow: match.methodNotAllowed.join(", ") },
      });
      try {
        const response = await runCutRoute(req, match);
        const merged = new Headers(response.headers);
        for (const [key, value] of Object.entries(headers)) merged.set(key, value);
        if (match.head) await response.body?.cancel();
        return new Response(match.head ? null : response.body, {
          status: response.status, statusText: response.statusText, headers: merged,
        });
      } catch (error) {
        return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500, headers });
      }
    },
  });
  console.log(`donkey-cut-engine listening on http://127.0.0.1:${PORT}`);
}

void start().catch((error) => {
  console.error(`donkey-cut-engine could not start: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
