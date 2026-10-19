import { starterProjectId } from "@/cut/lib/starter";
import { getActiveProSubscription } from "@/lib/billing/pro-subscription";
import { contextForUser, getSetting } from "@/lib/config/effective";
import { prisma } from "@/lib/prisma";

import { projectLimitFull } from "./project-limit";

/** Whether a free account's cloud projects fill its limit. The cloud is all a
 * server can count; the page's gate counts every shelf. */
export async function cloudProjectsFull(userId: string): Promise<boolean> {
  const { projects: limit } = await getSetting("freeProjectLimit", await contextForUser(userId, null));
  if (limit === null) {
    return false;
  }
  if (await getActiveProSubscription(userId)) {
    return false;
  }

  const counted = await prisma.cutProject.count({ where: { id: { not: starterProjectId(userId) }, userId } });
  return projectLimitFull(counted, limit);
}
