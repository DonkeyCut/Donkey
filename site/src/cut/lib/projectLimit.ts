// The free project limit, checked before any new project is made: the
// projects home, the sidebar, a file dropped on the home, a duplicate, and
// the ChatGPT card all ask here first. A move keeps the count, so it never
// asks.
import type { QueryClient } from "@tanstack/react-query";

import { track } from "@/lib/analytics";
import { PLAN_TERMS } from "@/lib/billing/plans";
import { countedProjects, projectLimitFull } from "@/lib/billing/project-limit";
import { accountConfigQueryKey, fetchAccountConfig } from "@/queries/accountConfig";
import { fetchProSubscription, proSubscriptionQueryKey } from "@/queries/billing";

import { currentEngineUser } from "./api";
import { listedProjectIds } from "./queries";
import { openUpgrade } from "./upgrade";

/** True when the account may make another project. When it may not, the
 * upgrade wall is already up. */
export async function newProjectAllowed(client: QueryClient): Promise<boolean> {
  // Signed out, the projects are this browser's own and no plan applies.
  const userId = currentEngineUser();
  if (!userId) {
    return true;
  }

  const config = await client.ensureQueryData({ queryKey: accountConfigQueryKey, queryFn: fetchAccountConfig });
  const limit = config.settings.freeProjectLimit.projects;
  if (limit === null) {
    return true;
  }

  // Plus keeps the free limit; Pro and Max lift it.
  const subscription = await client.ensureQueryData({ queryKey: proSubscriptionQueryKey, queryFn: fetchProSubscription });
  if (subscription.plan && PLAN_TERMS[subscription.plan].unlimitedProjects) {
    return true;
  }

  const ids = await listedProjectIds(client);
  if (!projectLimitFull(countedProjects(ids, userId), limit)) {
    return true;
  }

  track("project_limit_hit", { limit });
  openUpgrade("projects");
  return false;
}
