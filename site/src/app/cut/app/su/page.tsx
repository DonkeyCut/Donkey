import { redirect } from "next/navigation";

import { CUT_APP_BASE } from "@/cut/lib/appBase";
import { SU_NAV } from "./nav";

// The section root has no surface of its own; it opens the rail's first one.
export default function SuPage() {
  redirect(`${CUT_APP_BASE}/su${SU_NAV[0].suffix}`);
}
