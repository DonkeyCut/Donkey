import { redirect } from "next/navigation";

import { SU_NAV } from "@/app/su/nav";

// The section has no surface of its own; it opens its first tab.
export default function SuAnalyticsPage() {
  redirect(SU_NAV[0].tabs![0].href);
}
