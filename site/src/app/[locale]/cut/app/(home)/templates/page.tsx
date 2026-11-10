import { Suspense } from "react";
import { SessionGate } from "@/cut/components/SessionGate";
import { TemplateGallery } from "@/cut/components/TemplateGallery";

export const instant = true;

// Suspense: the gallery reads its filters from the URL, and useSearchParams
// needs a boundary in a statically prerendered shell.
export default function TemplatesPage() {
  return (
    <Suspense>
      <SessionGate>
        <TemplateGallery />
      </SessionGate>
    </Suspense>
  );
}
