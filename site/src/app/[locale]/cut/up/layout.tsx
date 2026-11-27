import type { ReactNode } from "react";

import { IntlScope } from "@/i18n/IntlScope";
import { UPLOAD_NAMESPACES } from "@/i18n/namespaces";

// The page a phone opens from an Upload dialog's code carries only its own words.
export default function UploadLayout({ children }: { children: ReactNode }) {
  return <IntlScope namespaces={UPLOAD_NAMESPACES}>{children}</IntlScope>;
}
