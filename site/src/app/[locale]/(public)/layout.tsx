import type { ReactNode } from "react";

import { IntlScope } from "@/i18n/IntlScope";
import { PUBLIC_NAMESPACES } from "@/i18n/namespaces";

// The root-level public pages — install, legal, auth, unsubscribe — share the
// marketing site's catalog.
export default function PublicLayout({ children }: { children: ReactNode }) {
  return <IntlScope namespaces={PUBLIC_NAMESPACES}>{children}</IntlScope>;
}
