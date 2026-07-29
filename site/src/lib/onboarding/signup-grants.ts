import { creditStringToMicros } from "@/lib/credits/amounts";
import { grantCredits } from "@/lib/credits/inference";
import { grantVisionCalls } from "@/lib/credits/vision-grants";
import { signupAppCredits } from "@/lib/onboarding/sequence";

// Single source of truth for what a new account starts with. Both grants are
// idempotent and keyed to the user, so provisioning can run more than once (e.g.
// a retried signup) without ever double-granting. The credit amount itself is
// in sequence.ts, which the welcome slides can import too.
export const signupVisionFreeCalls = 100; // lifetime free Vision API calls

export async function provisionSignupGrants(userId: string): Promise<void> {
  // Settle the two grants independently: one failing must not block the other,
  // and signup itself must never fail because a bonus grant hiccupped.
  const results = await Promise.allSettled([
    grantSignupAppCredits(userId),
    grantSignupVisionCalls(userId),
  ]);

  for (const result of results) {
    if (result.status === "rejected") {
      console.error("[signup-grants] failed to provision a signup grant", {
        reason: result.reason,
        userId,
      });
    }
  }
}

async function grantSignupAppCredits(userId: string): Promise<void> {
  // grantCredits dedupes on (source, sourceId, userId), so this is a no-op on
  // re-run.
  await grantCredits({
    amountMicros: creditStringToMicros(signupAppCredits),
    description: "Signup bonus credits",
    source: "signup",
    sourceId: `signup-app-credit:${userId}`,
    userId,
  });
}

async function grantSignupVisionCalls(userId: string): Promise<void> {
  // A one-time vision_call grant — no subscription required. The Vision route
  // and the api-keys gate both accept grant balance as access. Idempotent via
  // (userId, unit, source, sourceId).
  await grantVisionCalls({
    calls: signupVisionFreeCalls,
    description: "Signup bonus Vision API calls",
    source: "signup",
    sourceId: `signup-vision-calls:${userId}`,
    userId,
  });
}
