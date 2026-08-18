import { Suspense } from "react";
import { ProjectsHome } from "@/cut/components/ProjectsHome";
import { SessionGate } from "@/cut/components/SessionGate";

export const unstable_instant = { prefetch: "static" };

// Suspense: the view reads the open folder from ?folder=…, and useSearchParams
// needs a boundary in a statically prerendered shell. SessionGate is what makes
// that shell worth having: the sidebar and this pane's skeleton are the first
// paint, and the shelf fills in when the account id lands.
export default function Home() {
  return (
    <Suspense>
      <SessionGate>
        <ProjectsHome />
      </SessionGate>
    </Suspense>
  );
}
