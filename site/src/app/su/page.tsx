import { redirect } from "next/navigation";

import { SU_NAV } from "./nav";

// The section root has no surface of its own; it opens the rail's first one.
export default function SuPage() {
  redirect(SU_NAV[0].href);
}
