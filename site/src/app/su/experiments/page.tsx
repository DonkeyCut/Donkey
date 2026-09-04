import { redirect } from "next/navigation";

import { SU_NAV } from "@/app/su/nav";

// The section has no surface of its own; it opens its first tab.
export default function SuExperimentsPage() {
  const section = SU_NAV.find((s) => s.href === "/experiments")!;
  redirect(section.tabs![0].href);
}
