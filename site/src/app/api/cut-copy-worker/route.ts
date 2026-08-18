import { timingSafeEqual } from "node:crypto";
import { executeCopyJob } from "@/cut/server/cloud/copyQueue";

// Execution callback for queued share-copies: the Cut worker's Cloudflare
// Queue consumer POSTs one job id at a time (see cut/server/cloud/copyQueue.ts).
// Deliberately not wrapped in withDonkeyAuth — the caller is a machine, not a
// session — and gated by the shared secret instead, like the render worker's
// wake in the other direction.
// A big project copies many R2 objects; give the function room to finish.
export const maxDuration = 300;

/** Constant-time bearer check: a byte-by-byte `!==` would leak the secret's
 * length and prefix through timing. */
function authorized(header: string, secret: string): boolean {
  const expected = Buffer.from(`Bearer ${secret}`);
  const got = Buffer.from(header);
  return got.length === expected.length && timingSafeEqual(got, expected);
}

export async function POST(request: Request) {
  const secret = process.env.CUT_COPY_EXECUTE_SECRET;
  const authz = request.headers.get("authorization") ?? "";
  if (!secret || !authorized(authz, secret)) {
    return new Response("Unauthorized", { status: 401 });
  }
  const body = (await request.json().catch(() => null)) as { jobId?: unknown } | null;
  if (typeof body?.jobId !== "string" || !body.jobId) {
    return new Response("Bad request", { status: 400 });
  }
  return executeCopyJob(body.jobId);
}
