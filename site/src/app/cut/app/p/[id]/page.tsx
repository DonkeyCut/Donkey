import { Suspense } from "react";

import { SessionSkeleton } from "@/cut/components/SessionGate";
import { ProjectEditor } from "./ProjectEditor";

// The project id is in the URL, so it is request data and the editor can never
// be part of the prerendered shell. Resolving the param here, inside this
// boundary, is what keeps the rest of the app — surface, banner, sidebar — in
// that shell: the page arrives painted with a skeleton where the editor lands.
export default function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  return (
    <Suspense fallback={<SessionSkeleton />}>
      {params.then(({ id }) => (
        <ProjectEditor projectId={id} />
      ))}
    </Suspense>
  );
}
