import { seedStarterProject } from "@/cut/server/cloud/starter";
import { creditStringToMicros } from "@/lib/credits/amounts";
import { grantCredits } from "@/lib/credits/inference";
import { grantVisionCalls } from "@/lib/credits/vision-grants";
import { type EmailUser } from "@/lib/email/resend";
import { sendWelcomeEmail } from "@/lib/email/send-welcome";
import { syncResendContact } from "@/lib/email/sync-contact";
import {
  signupAppCredits,
  signupVisionFreeCalls,
} from "@/lib/onboarding/sequence";

// Single source of truth for what a new account starts with. All steps are
// idempotent and keyed to the user, so provisioning can run more than once
// (e.g. a retried signup) without double-granting, double-seeding, or
// double-sending. The grant amounts are in sequence.ts, which the welcome
// slides and the welcome email import too.
export async function provisionSignupGrants(user: EmailUser): Promise<void> {
  // Settle the steps independently: one failing must not block the others,
  // and signup itself must never fail because a bonus grant hiccupped.
  const results = await Promise.allSettled([
    grantSignupAppCredits(user.id),
    grantSignupVisionCalls(user.id),
    seedStarterProject(user.id),
    sendWelcomeEmail(user),
    syncResendContact(user),
  ]);

  for (const result of results) {
    if (result.status === "rejected") {
      console.error("[signup-grants] failed to provision a signup grant", {
        reason: result.reason,
        userId: user.id,
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
