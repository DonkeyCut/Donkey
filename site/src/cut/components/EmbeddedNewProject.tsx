"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { cloudBackend } from "@/cut/lib/backend/cloud";
import { seedNewProjectDoc } from "@/cut/lib/docCache";
import { framedHref } from "@/cut/lib/hostBridge";
import { projectHref, useCutBase } from "@/cut/lib/nav";
import { lastChosenAspect } from "@/cut/lib/store";
import type { ProjectSummary } from "@/cut/lib/types";
import { track } from "@/lib/analytics";

// The card's way forward when the project it was opened on can't be shown.
// The card is the whole surface, so there is no projects home to go back to:
// a new cloud project is made and opened here in its place.
export function EmbeddedNewProject() {
  const router = useRouter();
  const base = useCutBase();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const aspect = lastChosenAspect() ?? undefined;
      const res = await cloudBackend.fetch("/api/cut/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Untitled", folderId: null, aspect }),
      });
      if (!res.ok) throw new Error("Could not create the project.");
      const project = (await res.json()) as ProjectSummary;
      seedNewProjectDoc(project.id, project.name, "cloud", aspect);
      track("project_created", { source: "chatgpt_card" });
      router.replace(framedHref(projectHref(base, project.id, "projects")));
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : "Could not create the project.");
      setBusy(false);
    }
  };

  return (
    <>
      <Button variant="outline" disabled={busy} onClick={() => void create()}>
        Create New Project
      </Button>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </>
  );
}
