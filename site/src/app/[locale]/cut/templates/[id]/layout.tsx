import type { ReactNode } from "react";

import { IntlScope } from "@/i18n/IntlScope";
import { SHARE_NAMESPACES } from "@/i18n/namespaces";

// A template's page plays in the editor's stage over its share, so it reads
// the same catalogs a shared project does.
export default function TemplateLayout({ children }: { children: ReactNode }) {
  return <IntlScope namespaces={SHARE_NAMESPACES}>{children}</IntlScope>;
}
