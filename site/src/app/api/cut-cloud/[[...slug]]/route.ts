import type { NextRequest } from "next/server";
import { isVercelCron, withDonkeyAuth } from "@/lib/donkey-api-auth";
import { runGc } from "@/cut/server/cloud/gc";
import { cutCloudCatchAll } from "@/cut/server/cloud/routes";

// The hosted Cut backend: every /api/cut-cloud/* request authenticates via the
// session cookie (withDonkeyAuth) and dispatches through the cloud route table
// (src/cut/server/cloud/routes.ts). The client's cloud driver rewrites the
// engine's /api/cut/* paths to this prefix.
export const runtime = "nodejs";

// The Cut API surface takes machine callers: a `dk_live_` bearer key acts as
// its user across the same routes the page uses, and the Cut runner calls
// back here with its grant while executing a queued turn.
const handle = withDonkeyAuth((request) => cutCloudCatchAll(request), {
  allowApiKey: true,
  allowRunner: true,
});

// The daily GC cron has no session; Vercel authenticates its invocations with
// the CRON_SECRET bearer token. Everything else goes through auth (a superuser
// can also GET /gc directly).
export const GET = (request: NextRequest) =>
  new URL(request.url).pathname === "/api/cut-cloud/gc" && isVercelCron(request)
    ? runGc()
    : handle(request);
export const POST = handle;
export const PUT = handle;
export const DELETE = handle;
export const HEAD = handle;
