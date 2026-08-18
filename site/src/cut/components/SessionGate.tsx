"use client";

import type { ReactNode } from "react";

import { Skeleton } from "@/components/ui/skeleton";
import { useEngineUser } from "@/cut/lib/backend/hooks";

// The line between the app's chrome and its contents. The sidebar, the surface,
// and the banner render from the first byte; everything that reads the engine
// waits behind this, because every engine URL carries the account id (the `u`
// param) and the id only exists once the browser has read the session cookie.
//
// Holding the surface here — rather than above the sidebar — is what lets the
// app paint before the session resolves: the shell a visitor sees on a cold
// load is the real navigation with a skeleton where the content will land.
export function SessionGate({
  children,
  fallback,
}: {
  children: ReactNode;
  /** Shown while the session resolves. Defaults to a page-sized skeleton. */
  fallback?: ReactNode;
}) {
  const user = useEngineUser();
  if (user) return <>{children}</>;
  return <>{fallback ?? <SessionSkeleton />}</>;
}

/** The shape of a loading app surface: a title over a body that fills the
 * column it was given, so it reads the same in the home panes and the editor. */
export function SessionSkeleton() {
  return (
    <div className="h-full w-full p-10">
      <Skeleton className="h-8 w-48" />
      <Skeleton className="mt-6 h-[calc(100%-3.5rem)] w-full" />
    </div>
  );
}
