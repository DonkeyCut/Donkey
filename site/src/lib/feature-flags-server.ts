import { ACCOUNT_FEATURE_FLAGS, featureFlagsFor } from "@/lib/feature-flags";
import { isDonkeySuperUser } from "@/lib/donkey-api-auth";
import { prisma } from "@/lib/prisma";

/** Whether an account flag is on for a user: the account's own row, or the
 * registry default. A flag the user's role cannot see is off whatever a row
 * says. */
export async function accountFlagEnabled(userId: string, flagId: string): Promise<boolean> {
  const flag = ACCOUNT_FEATURE_FLAGS.find((f) => f.id === flagId);
  if (!flag) return false;
  if (flag.group === "su" && !(await isDonkeySuperUser(userId))) return false;
  const row = await prisma.userFeatureFlag.findUnique({
    select: { enabled: true },
    where: { userId_flag: { userId, flag: flagId } },
  });
  return row?.enabled ?? flag.defaultEnabled;
}

/** The registry as this user may see it, with each flag's enabled state. */
export async function accountFlags(userId: string) {
  const [rows, superUser] = await Promise.all([
    prisma.userFeatureFlag.findMany({ where: { userId } }),
    isDonkeySuperUser(userId),
  ]);
  const enabled = new Map(rows.map((r) => [r.flag, r.enabled]));
  return featureFlagsFor(superUser).map((f) => ({
    ...f,
    enabled: enabled.get(f.id) ?? f.defaultEnabled,
  }));
}
