/**
 * Donkey Cut engine entry — the binary the Donkey Mac app spawns.
 *
 * Primes the engine environment BEFORE any server module loads (data roots
 * are computed at module load time), then dispatches:
 *
 *   donkey-cut-engine                          serve the Cut API on 127.0.0.1
 *   donkey-cut-engine mcp-proxy <base> <key>   stdio MCP proxy (spawned by the
 *                                              engine itself for AI chats)
 */
process.env.DONKEY_CUT_ENGINE ??= "1";

const [, , cmd, ...rest] = process.argv;

void (async () => {
  if (cmd === "mcp-proxy") {
    const { engineBaseUrl } = await import("./config");
    const { runMcpProxy } = await import("../server/ai/mcp-proxy-core.mjs");
    runMcpProxy(rest[0] ?? engineBaseUrl(), rest[1] ?? "");
    return;
  }
  await import("./serve");
})();
