/**
 * Minimal stdio MCP server that proxies Cut's editor tools.
 *
 * Spawned by whichever model harness is chatting (Claude Agent SDK or the
 * Codex CLI). Speaks newline-delimited JSON-RPC on stdio and forwards
 * tools/list + tools/call to the local Cut server (Next dev server or the
 * engine binary), which routes execution into the user's open editor tab.
 *
 * Two launchers share this core: mcp-proxy.mjs (dev, spawned by file path
 * with node) and the engine binary's `mcp-proxy` subcommand.
 */
export function runMcpProxy(BASE = "http://localhost:3000", SESSION = "") {
  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line) void handle(line);
    }
  });
  process.stdin.on("end", () => process.exit(0));

  function send(msg) {
    process.stdout.write(JSON.stringify(msg) + "\n");
  }

  const log = (line) => process.stderr.write(`[cut-mcp] ${line}\n`);

  /**
   * Fetch that rides out a transient blip reaching the engine (a dev-server
   * recompile, an engine restart) instead of failing the whole call. Only for
   * idempotent requests: a retried tools/call could double-run a paid render,
   * so callers pass retry:true only for tools/list.
   */
  async function fetchEngine(url, init, label, retry) {
    const attempts = retry ? 3 : 1;
    let lastErr;
    for (let i = 1; i <= attempts; i++) {
      try {
        const res = await fetch(url, init);
        if (res.ok) return res;
        lastErr = new Error(`HTTP ${res.status}`);
      } catch (err) {
        lastErr = err instanceof Error ? err : new Error(String(err));
      }
      log(`${label} attempt ${i}/${attempts} failed: ${lastErr.message}`);
      if (i < attempts) await new Promise((r) => setTimeout(r, 150 * i));
    }
    throw lastErr;
  }

  async function handle(line) {
    let req;
    try {
      req = JSON.parse(line);
    } catch {
      return;
    }
    const { id, method, params } = req;
    const reply = (result) => id !== undefined && send({ jsonrpc: "2.0", id, result });
    const fail = (message) =>
      id !== undefined && send({ jsonrpc: "2.0", id, error: { code: -32000, message } });

    try {
      if (method === "initialize") {
        reply({
          protocolVersion: params?.protocolVersion ?? "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "cut", version: "1.0.0" },
        });
      } else if (method === "notifications/initialized" || method === "notifications/cancelled") {
        // notifications: no response
      } else if (method === "ping") {
        reply({});
      } else if (method === "tools/list") {
        // Idempotent: retry so a momentary hiccup can't leave the model with an
        // empty tool set (which reads to it as "editing tools aren't reachable").
        const res = await fetchEngine(`${BASE}/api/cut/ai/proxy?type=catalog`, undefined, "tools/list", true);
        const { tools } = await res.json();
        reply({ tools });
      } else if (method === "tools/call") {
        // No retry: the call may already have run on the editor by the time the
        // response is lost, and re-running a generation tool would double-charge.
        const res = await fetchEngine(
          `${BASE}/api/cut/ai/proxy`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              sessionKey: SESSION,
              name: params?.name,
              args: params?.arguments ?? {},
            }),
          },
          `tools/call ${params?.name}`,
          false
        );
        const body = await res.json();
        reply(body); // { content: [...], isError? } — already MCP-shaped
      } else if (id !== undefined) {
        send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Unknown method ${method}` } });
      }
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err));
    }
  }
}
