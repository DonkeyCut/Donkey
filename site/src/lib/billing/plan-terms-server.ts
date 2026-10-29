// The plan terms as pages read them. The server's own checks read the
// planTerms setting fresh; pages read it from a cache scope, so the terms are part of each
// page's static HTML and every card paints with its numbers at once. A su
// save posts the revalidate route, which expires the scope and renders the
// landing again before anyone asks for it.
import { cacheLife, cacheTag, revalidateTag } from "next/cache";
import { after } from "next/server";

import { CUT_HOSTED_ORIGIN } from "@/cut/lib/hosts";
import type { PlanTermsTable } from "@/lib/billing/plans";
import { getGlobalSetting } from "@/lib/config/effective";

const PLAN_TERMS_TAG = "plan-terms";

/** The terms a page renders into its HTML. */
export async function cachedPlanTerms(): Promise<PlanTermsTable> {
  "use cache";
  cacheTag(PLAN_TERMS_TAG);
  cacheLife("max");
  return getGlobalSetting("planTerms");
}

/** Drop every page's copy of the terms now and render the landing again
 * once the response has gone out. A route handler cannot use updateTag, and
 * the stale-while-revalidate profile would show the next visitor the old
 * terms. */
export function revalidatePlanTerms(): void {
  revalidateTag(PLAN_TERMS_TAG, { expire: 0 });
  after(() => fetch(`${CUT_HOSTED_ORIGIN}/`, { cache: "no-store" }).catch(() => {}));
}
