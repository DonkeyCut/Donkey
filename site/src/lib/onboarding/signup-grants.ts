import { seedFontsFolder } from "@/cut/server/cloud/library";
import { seedStarterProject } from "@/cut/server/cloud/starter";
import { getGlobalSetting } from "@/lib/config/effective";
import { creditStringToMicros } from "@/lib/credits/amounts";
import { grantCredits } from "@/lib/credits/inference";
import { creditGrantExpiry } from "@/lib/credits/top-up";
import { type EmailUser } from "@/lib/email/resend";
import { deliverEmail } from "@/lib/email/outbox";
import { welcomeIdempotencyKey } from "@/lib/email/send-welcome";
import { syncResendContact } from "@/lib/email/sync-contact";
import { isDeletedAddress } from "@/lib/onboarding/deleted-account";

// Single source of truth for what a new account starts with. All steps are
// idempotent and keyed to the user, so provisioning can run more than once
// (e.g. a retried signup) without double-granting, double-seeding, or
// double-sending. The grant amount and its lifetime are the signupCredits
// setting, edited on su; the welcome email names the amount that landed.
export async function provisionSignupGrants(user: EmailUser): Promise<void> {
  const setting = await getGlobalSetting("signupCredits");
  // An address that was deleted already had its signup credits once. The
  // starter project, fonts and welcome still land; the credits do not, and
  // the welcome email leaves them out.
  const returning = await isDeletedAddress(user.email);
  if (returning) {
    console.info("[signup-grants] address returned after deletion; signup credits withheld", {
      userId: user.id,
    });
  }
  const credits = returning || setting.dollars <= 0 ? null : String(setting.dollars);
  const expiresAt = creditGrantExpiry(setting.expiresAfterDays) ?? null;
  // Settle the steps independently: one failing must not block the others,
  // and signup itself must never fail because a bonus grant hiccupped.
  const results = await Promise.allSettled([
    credits === null
      ? Promise.resolve()
      : grantSignupAppCredits(user.id, credits, expiresAt),
    seedStarterProject(user.id),
    seedFontsFolder(user.id),
    deliverEmail({ idempotencyKey: welcomeIdempotencyKey(user.id), kind: "welcome", payload: { credits }, userId: user.id }),
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

export async function grantSignupAppCredits(
  userId: string,
  credits: string,
  expiresAt: Date | null,
) {
  // grantCredits dedupes on (source, sourceId, userId), so this is a no-op on
  // re-run.
  return grantCredits({
    amountMicros: creditStringToMicros(credits),
    description: "Signup bonus credits",
    expiresAt: expiresAt ?? undefined,
    source: "signup",
    sourceId: `signup-app-credit:${userId}`,
    userId,
  });
}
