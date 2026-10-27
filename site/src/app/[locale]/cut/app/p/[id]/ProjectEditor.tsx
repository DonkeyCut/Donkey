"use client";

import { useSearchParams } from "next/navigation";

import { Editor } from "@/cut/components/Editor";
import { SessionGate } from "@/cut/components/SessionGate";

// `from` and `folder` record which tab (and folder within it) opened the
// project so the editor's back button returns there; residency is resolved from
// the id itself (lib/residency.ts). The id arrives as a plain string — the page
// resolves the route param above this, inside its own boundary.
export function ProjectEditor({ projectId }: { projectId: string }) {
  const params = useSearchParams();
  return (
    <SessionGate>
      <Editor
        projectId={projectId}
        from={params.get("from")}
        folder={params.get("folder")}
      />
    </SessionGate>
  );
}
