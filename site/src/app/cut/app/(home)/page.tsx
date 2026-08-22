import { Suspense } from "react";
import { ProjectsHome } from "@/cut/components/ProjectsHome";
import { SessionGate } from "@/cut/components/SessionGate";

export const unstable_instant = { prefetch: "static" };

// Suspense: the view reads the open folder from ?folder=…, and useSearchParams
// needs a boundary in a statically prerendered shell. SessionGate holds the
// shelf until the account id lands; the shell's loading overlay is what covers
// that wait.
export default function Home() {
  return (
    <Suspense>
      <SessionGate>
        <ProjectsHome />
      </SessionGate>
    </Suspense>
  );
}
