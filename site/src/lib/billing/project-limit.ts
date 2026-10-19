// The free plan's project limit, as the freeProjectLimit setting states it:
// how many projects a free account holds besides its starter. Pure, so the
// page's gate, the ChatGPT tool and the tests read one rule.
import { starterProjectId } from "@/cut/lib/starter";

/** How many of an account's projects count against the limit. */
export function countedProjects(ids: string[], userId: string): number {
  const starter = starterProjectId(userId);
  return ids.filter((id) => id !== starter).length;
}

/** Whether `counted` projects leave no room under `limit`; null is no limit. */
export function projectLimitFull(counted: number, limit: number | null): boolean {
  return limit !== null && counted >= limit;
}
