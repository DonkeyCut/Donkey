import { Suspense } from "react";
import { HomeView } from "@/cut/components/home/HomeView";
import { HomeFolderRedirect } from "@/cut/components/assets/HomeFolderRedirect";
import { SessionGate } from "@/cut/components/SessionGate";

export const instant = true;

// Suspense: the folder redirect reads ?folder=…, and useSearchParams needs a
// boundary in a statically prerendered shell. SessionGate holds the page until
// the account id lands; the shell's loading overlay covers that wait.
export default function Home() {
  return (
    <Suspense>
      <HomeFolderRedirect />
      <SessionGate>
        <HomeView />
      </SessionGate>
    </Suspense>
  );
}
