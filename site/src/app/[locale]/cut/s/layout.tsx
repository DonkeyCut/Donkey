import type { ReactNode } from "react";

import { IntlScope } from "@/i18n/IntlScope";
import { SHARE_NAMESPACES } from "@/i18n/namespaces";

// A shared project mounts the editor read-only, so it reads the editor's
// catalog alongside its own.
export default function ShareLayout({ children }: { children: ReactNode }) {
  return <IntlScope namespaces={SHARE_NAMESPACES}>{children}</IntlScope>;
}
