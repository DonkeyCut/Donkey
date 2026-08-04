import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Readable } from "node:stream";

import { allowedOrigin, corsHeaders, preflightHeaders } from "../server/cors";
import { matchCutRoute, runCutRoute } from "../server/http/routes";
import { migrateCutDataDir } from "../server/migrateDataDir";
import { ensureToolPath, resolveOnPath } from "../server/tool-path";
import { enginePort } from "./config";

// Throws (and exits with a clear message) on a bad DONKEY_CUT_PORT rather than
// binding a random port the client would never find.
const PORT = enginePort();

function toWebRequest(req: IncomingMessage, signal: AbortSignal): Request {
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (Array.isArray(v)) for (const x of v) headers.append(k, x);
    else if (typeof v === "string") headers.set(k, v);
  }
  const method = req.method ?? "GET";
  const hasBody = method !== "GET" && method !== "HEAD";
  const init: RequestInit = {
    method,
    headers,
    signal,
    ...(hasBody ? { body: Readable.toWeb(req) as unknown as BodyInit, duplex: "half" } : {}),
  } as RequestInit;
  return new Request(`http://127.0.0.1:${PORT}${req.url ?? "/"}`, init);
}

async function writeResponse(
  res: Response,
  out: ServerResponse,
  cors: string | null,
  headOnly: boolean
) {
  if (cors) for (const [k, v] of Object.entries(corsHeaders(cors))) out.setHeader(k, v);
  out.statusCode = res.status;
  res.headers.forEach((v, k) => out.setHeader(k, v));
  // A HEAD reply carries the GET headers but no body.
  if (headOnly || !res.body) {
    void res.body?.cancel();
    out.end();
    return;
  }
  await new Promise<void>((resolve) => {
    const stream = Readable.fromWeb(res.body as never);
    stream.on("error", () => out.destroy());
    out.on("close", () => {
      // Client hung up mid-response: tear down the source so its file
      // descriptor / handle is released instead of reading on to nowhere.
      if (!out.writableFinished) stream.destroy();
      resolve();
    });
    stream.pipe(out);
  });
}

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
  await ensureToolPath();

  // The Agent SDK can't resolve its built-in CLI from inside a compiled
  // binary; point it at the user's own Claude Code install (their login is
  // the whole point). Missing is fine — the models probe reports it.
  if (!process.env.DONKEY_CUT_CLAUDE) {
    const claude = await resolveOnPath("claude");
    if (claude) process.env.DONKEY_CUT_CLAUDE = claude;
  }

  const server = createServer((req, res) => {
    const origin = req.headers.origin ?? "";
    const cors = allowedOrigin(origin);

    // A present-but-unlisted Origin is a foreign site's browser tab; refuse it
    // before any handler runs so a malicious page can't drive the local engine.
    // No Origin header means a same-machine / non-browser caller — allowed.
    if (origin && !cors) {
      res.writeHead(403);
      res.end("Cross-origin request refused.");
      return;
    }

    if (req.method === "OPTIONS") {
      if (cors) {
        const requested = req.headers["access-control-request-headers"];
        res.writeHead(204, preflightHeaders(cors, typeof requested === "string" ? requested : null));
      } else {
        res.writeHead(204);
      }
      res.end();
      return;
    }

    const method = req.method ?? "GET";
    const pathname = (req.url ?? "/").split("?")[0];
    const match = matchCutRoute(method, pathname);
    if (!match) {
      res.writeHead(404, cors ? corsHeaders(cors) : {});
      res.end("Not found.");
      return;
    }
    if ("methodNotAllowed" in match) {
      res.writeHead(405, { Allow: match.methodNotAllowed.join(", "), ...(cors ? corsHeaders(cors) : {}) });
      res.end("Method not allowed.");
      return;
    }

    // Abort only on a real client disconnect. On node:http, req 'close' fires
    // once the request body is fully read — not on hang-up — so keying the
    // abort off req would cancel every turn the instant its body arrived.
    const aborter = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) aborter.abort();
    });

    void (async () => {
      try {
        const webReq = toWebRequest(req, aborter.signal);
        const webRes = await runCutRoute(webReq, match);
        await writeResponse(webRes, res, cors, match.head);
      } catch (err) {
        if (!res.headersSent) {
          res.writeHead(500, {
            "Content-Type": "application/json",
            ...(cors ? corsHeaders(cors) : {}),
          });
        }
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
      }
    })();
  });

  // Exit on a failed bind (typically EADDRINUSE while another session still
  // holds the port) so the supervisor's backoff drives the retry.
  server.on("error", (err) => {
    console.error(`donkey-cut-engine could not listen on 127.0.0.1:${PORT}: ${err.message}`);
    process.exit(1);
  });
  server.listen(PORT, "127.0.0.1", () => {
    console.log(`donkey-cut-engine listening on http://127.0.0.1:${PORT}`);
  });
}

void start();
