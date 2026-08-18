import { Suspense } from "react";
import { LibraryView } from "@/cut/components/LibraryView";
import { SessionGate } from "@/cut/components/SessionGate";

export const unstable_instant = { prefetch: "static" };

// Suspense: the view reads the open folder from ?folder=…, and useSearchParams
// needs a boundary in a statically prerendered shell.
export default function LibraryPage() {
  return (
    <Suspense>
      <SessionGate>
        <LibraryView />
      </SessionGate>
    </Suspense>
  );
}
