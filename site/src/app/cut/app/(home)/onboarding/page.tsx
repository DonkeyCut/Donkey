"use client";

import { Suspense, useEffect } from "react";

import { ProjectsHome } from "@/cut/components/ProjectsHome";
import { openOnboarding } from "@/cut/lib/onboarding";

// The welcome sequence's own address. The sequence is a full-window overlay
// mounted in the app shell, so this route asks for it and renders the app home
// underneath — the same thing that's behind it everywhere else, and where the
// user lands when it closes.
export default function OnboardingPage() {
  useEffect(() => {
    openOnboarding();
  }, []);

  return (
    <Suspense>
      <ProjectsHome />
    </Suspense>
  );
}
