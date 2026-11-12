import { Suspense } from "react";
import { LegacyAssetsRedirect } from "@/cut/components/assets/LegacyAssetsRedirect";

export const instant = true;

// Library became Assets. Links and bookmarks to it, a folder or a note
// inside it included, land on the same place there.
export default function LibraryPage() {
  return (
    <Suspense>
      <LegacyAssetsRedirect />
    </Suspense>
  );
}
