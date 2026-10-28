import { starterProjectId } from "@/cut/lib/starter";
import { PLAN_TERMS, isPaidPlan } from "@/lib/billing/plans";
import { getActiveSubscription } from "@/lib/billing/pro-subscription";
import { contextForUser, getSetting } from "@/lib/config/effective";
import { prisma } from "@/lib/prisma";

import { projectLimitFull } from "./project-limit";

/** Whether an account held to the free project limit has filled it. The cloud is all a
 * server can count; the page's gate counts every shelf. */
export async function cloudProjectsFull(userId: string): Promise<boolean> {
  const { projects: limit } = await getSetting("freeProjectLimit", await contextForUser(userId, null));
  if (limit === null) {
    return false;
  }
  const subscription = await getActiveSubscription(userId);
  if (subscription && isPaidPlan(subscription.planKey) && PLAN_TERMS[subscription.planKey].unlimitedProjects) {
    return false;
  }

  const counted = await prisma.cutProject.count({ where: { id: { not: starterProjectId(userId) }, userId } });
  return projectLimitFull(counted, limit);
}
