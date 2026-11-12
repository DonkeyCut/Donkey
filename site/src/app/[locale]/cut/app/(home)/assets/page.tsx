import { Suspense } from "react";
import { AssetsView } from "@/cut/components/assets/AssetsView";
import { SessionGate } from "@/cut/components/SessionGate";

export const instant = true;

// Suspense: the view reads the open folder and type tab from the URL, and
// useSearchParams needs a boundary in a statically prerendered shell.
export default function AssetsPage() {
  return (
    <Suspense>
      <SessionGate>
        <AssetsView />
      </SessionGate>
    </Suspense>
  );
}
