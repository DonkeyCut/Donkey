"use client";

import { Suspense } from "react";

import { ProjectsHome } from "@/cut/components/ProjectsHome";

// The welcome sequence's own address. The sequence is a full-window overlay
// mounted in the app shell that reads this address itself and opens from its
// first paint, so this route only renders the app home underneath — the same
// thing that's behind it everywhere else, and where the user lands when it
// closes.
export default function OnboardingPage() {
  return (
    <Suspense>
      <ProjectsHome />
    </Suspense>
  );
}
