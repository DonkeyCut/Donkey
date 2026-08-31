"use client";

import { usePathname } from "next/navigation";

import { suSurfaceAt } from "@/app/su/nav";

// The title is the surface's; the description and action belong to whichever
// tab is showing, since a section's tabs each drive their own work.
export function SuHeader() {
  const pathname = usePathname();
  const { surface, tab } = suSurfaceAt(pathname);
  return (
    <div className="sticky top-0 z-20 mx-auto flex w-full max-w-6xl shrink-0 items-start justify-between gap-4 bg-background px-10 pt-9 pb-4">
      <div>
        <h1 className="text-lg font-semibold tracking-tight">{surface.title}</h1>
        {tab.description ? (
          <p className="mt-1 text-sm text-muted-foreground">{tab.description}</p>
        ) : null}
      </div>
      {tab.Action ? <tab.Action /> : null}
    </div>
  );
}
