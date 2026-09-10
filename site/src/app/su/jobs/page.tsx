import { redirect } from "next/navigation";

import { SU_NAV } from "@/app/su/nav";

// The section has no surface of its own; it opens its first tab.
export default function SuJobsPage() {
  redirect(SU_NAV.find((s) => s.href === "/jobs")!.tabs![0].href);
}
