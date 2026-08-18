import { isHostedRuntime } from "@/cut/server/local-only";

// The whole Cut API lives under /api/cut/* and routes through the shared table
// (src/cut/server/http/routes.ts) — the same one the packaged engine mounts.
//
// Cut is local-only: on a hosted deploy every Cut API 404s. The 404 is returned
// here, before the dynamic import that pulls the router, so the engine never
// runs on hosted. Turbopack still *traces* that import, though, and the engine's
// module graph reaches cwd-rooted file operations it can't statically scope — so
// on hosted builds next.config aliases "@/cut/server/http/next" to a 404 stub,
// keeping the engine (and the ~220MB SDK CLI binary it would otherwise sweep in)
// out of the deployed function so it fits Vercel's size limit.

async function handle(req: Request): Promise<Response> {
  if (isHostedRuntime()) return new Response(null, { status: 404 });
  const { cutCatchAll } = await import("@/cut/server/http/next");
  return cutCatchAll(req);
}

export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const DELETE = handle;
