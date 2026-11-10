import { Suspense } from "react";
import { AppLoading, SessionGate } from "@/cut/components/SessionGate";
import { TemplateUseView } from "@/cut/components/TemplateUseView";

// "Use as new project" from a template's page lands here: inside the app, where
// every place a project can live is in reach. The id and run are request data,
// so they resolve inside this boundary and the shell stays prerendered.
export default function TemplateUsePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ run?: string }>;
}) {
  return (
    <Suspense fallback={<AppLoading />}>
      {Promise.all([params, searchParams]).then(([{ id }, { run }]) => (
        <SessionGate>
          <TemplateUseView id={decodeURIComponent(id)} run={run ?? ""} />
        </SessionGate>
      ))}
    </Suspense>
  );
}
