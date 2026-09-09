/**
 * One CORS policy for Cut's engine, shared by the Next dev server (src/proxy.ts)
 * and the packaged engine's http server (src/cut/engine/serve.ts). The hosted
 * Cut page is the only browser origin allowed to reach the engine
 * cross-origin; every other origin is refused before any handler runs.
 */
export const CUT_CLIENT_ORIGINS = new Set(["https://donkeycut.com"]);

/** The echo-back origin for an allowed caller, else null. */
export function allowedOrigin(origin: string): string | null {
  return CUT_CLIENT_ORIGINS.has(origin) ? origin : null;
}

/** Preflight (OPTIONS) response headers for an allowed origin. */
export function preflightHeaders(
  origin: string,
  requestHeaders: string | null
): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": requestHeaders ?? "Content-Type",
    // Chrome preflights public-site → local-network requests.
    "Access-Control-Allow-Private-Network": "true",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

/** Response headers that expose an allowed origin on a normal response. */
export function corsHeaders(origin: string): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Expose-Headers": "x-cut-doc-version, x-cut-poll-after",
    Vary: "Origin",
  };
}
