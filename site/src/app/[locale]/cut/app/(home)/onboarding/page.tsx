"use client";

import { Suspense } from "react";

import { ProjectsHome } from "@/cut/components/ProjectsHome";
import { SessionGate } from "@/cut/components/SessionGate";

// The welcome sequence's own address. The sequence is a full-window overlay
// mounted in the app shell that reads this address itself and opens from its
// first paint, so this route only renders what's underneath it. On a computer
// the overlay opens the starter project behind the slides
// (CutOnboarding.tsx); a phone stays on the app home.
export default function OnboardingPage() {
  return (
    <Suspense>
      <SessionGate>
        <ProjectsHome />
      </SessionGate>
    </Suspense>
  );
}
