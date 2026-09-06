"use client";

import { usePathname } from "next/navigation";

import { suSurfaceAt } from "@/app/su/nav";
import { SidebarTrigger } from "@/components/ui/sidebar";

// The title is the surface's; the description and action belong to whichever
// tab is showing, since a section's tabs each drive their own work. On a
// phone the rail is off screen, so the header carries the button that opens it.
export function SuHeader() {
  const pathname = usePathname();
  const { surface, tab } = suSurfaceAt(pathname);
  return (
    <div className="sticky top-0 z-20 mx-auto flex w-full max-w-6xl shrink-0 items-start justify-between gap-4 bg-background px-4 pt-4 pb-4 md:px-10 md:pt-9">
      <div className="flex min-w-0 items-start gap-2">
        <SidebarTrigger className="-ml-1.5 shrink-0 md:hidden" />
        <div className="min-w-0">
          <h1 className="text-lg font-semibold tracking-tight">
            {surface.title}
          </h1>
          {tab.description ? (
            <p className="mt-1 text-sm text-muted-foreground">
              {tab.description}
            </p>
          ) : null}
        </div>
      </div>
      {tab.Action ? <tab.Action /> : null}
    </div>
  );
}
