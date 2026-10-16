import { seedFontsFolder } from "@/cut/server/cloud/library";
import { seedStarterProject } from "@/cut/server/cloud/starter";
import { getGlobalSetting } from "@/lib/config/effective";
import { creditStringToMicros } from "@/lib/credits/amounts";
import { grantCredits } from "@/lib/credits/inference";
import { creditGrantExpiry } from "@/lib/credits/top-up";
import { type EmailUser } from "@/lib/email/resend";
import { deliverEmail } from "@/lib/email/outbox";
import { welcomeIdempotencyKey } from "@/lib/email/send-welcome";
import { isDeletedAddress } from "@/lib/onboarding/deleted-account";
import { claimSignupGrant, signupNetworkKey } from "@/lib/onboarding/signup-network";

// Single source of truth for what a new account starts with. All steps are
// idempotent and keyed to the user, so provisioning can run more than once
// (e.g. a retried signup) without double-granting, double-seeding, or
// double-sending. The grant amount and its lifetime are the signupCredits
// setting; the welcome email names the amount that landed. `headers` are the
// signup request's, which name the network the account came from.
export async function provisionSignupGrants(user: EmailUser, headers: Headers | undefined): Promise<void> {
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
  const eligible = !returning && setting.dollars > 0;
  const credits = eligible && (await networkHasGrant(user.id, headers)) ? String(setting.dollars) : null;
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

// Whether the network this signup came from still has a grant to give, under
// the signupCreditsPerNetwork limit; asking takes one. One person cycling
// accounts from one connection gets the first few grants and no more. A
// signup whose address can't be read, or whose claim fails, gets none, so
// the limit always holds.
async function networkHasGrant(userId: string, headers: Headers | undefined): Promise<boolean> {
  try {
    const key = headers ? signupNetworkKey(headers) : null;
    if (!key) {
      console.error("[signup-grants] signup carried no network address; signup credits withheld", { userId });
      return false;
    }

    const open = await claimSignupGrant(key, await getGlobalSetting("signupCreditsPerNetwork"));
    if (!open) {
      console.info("[signup-grants] network reached its signup grant limit; signup credits withheld", { userId });
    }
    return open;
  } catch (reason) {
    console.error("[signup-grants] failed to claim a network signup grant; signup credits withheld", { reason, userId });
    return false;
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
