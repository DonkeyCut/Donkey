import { CUT_HOSTED_ORIGIN } from "../lib/hosts";
import type { HeadlessSession } from "../lib/headless/bind";
import type { ClaimedJob } from "./db";

// How a worker speaks for the account whose job it claimed: the shared runner
// grant plus the job's user. Every hosted call a job makes rides this, so the
// work spends that user's credits and writes that user's project, exactly as
// the page would.

const CLIENT_ID = "donkey-cut-runner";

export function runnerSession(job: ClaimedJob): HeadlessSession {
  const secret = process.env.CUT_RUNNER_SECRET;
  if (secret)
    return {
      base: CUT_HOSTED_ORIGIN,
      headers: {
        "x-donkey-client-id": CLIENT_ID,
        "x-donkey-runner-secret": secret,
        "x-donkey-runner-user": job.userId,
      },
    };
  if (process.env.NODE_ENV === "production")
    throw new Error("CUT_RUNNER_SECRET is not set — the runner cannot call the hosted API.");
  // A dev worker run by hand against the dev server: the bypass grant, the
  // same one the eval scripts use.
  return {
    base: CUT_HOSTED_ORIGIN,
    headers: { "x-donkey-client-id": CLIENT_ID, "x-donkey-dev-auth-bypass": "1" },
  };
}
