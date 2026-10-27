import { Suspense } from "react";

import { AppLoading } from "@/cut/components/SessionGate";
import { ProjectEditor } from "./ProjectEditor";

// The project id is in the URL, so it is request data and the editor can never
// be part of the prerendered shell. Resolving the param here, inside this
// boundary, keeps the surface and the banner in that shell; the wait shows the
// app's loading spinner.
export default function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  return (
    <Suspense fallback={<AppLoading />}>
      {params.then(({ id }) => (
        <ProjectEditor projectId={id} />
      ))}
    </Suspense>
  );
}
