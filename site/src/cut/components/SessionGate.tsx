"use client";

import type { ReactNode } from "react";
import { Loader2 } from "lucide-react";

import { useEngineUser } from "@/cut/lib/backend/hooks";

// The line between the app's chrome and its contents. Every engine URL carries
// the account id (the `u` param), and the id only exists once the browser has
// read the session cookie, so everything that reads the engine waits here.
//
// Nothing behind it is worth showing half-drawn, so the wait is not a skeleton
// per pane: AppLoadingOverlay covers the whole window until the id lands, and
// the shell — sidebar, banner, content — arrives whole underneath it.
export function SessionGate({
  children,
  fallback = null,
}: {
  children: ReactNode;
  /** Shown while the session resolves. Nothing, by default: the overlay is
   *  what a visitor sees during the wait. */
  fallback?: ReactNode;
}) {
  const user = useEngineUser();
  return <>{user ? children : fallback}</>;
}

/** What a loading app looks like: a spinner centered on an opaque surface.
 * Fixed, so it centers on the viewport wherever it is mounted. */
export function AppLoading() {
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-background">
      <Loader2 className="size-6 animate-spin text-muted-foreground" />
    </div>
  );
}

/** The cold-load cover, mounted once in the app shell: the app is a spinner in
 * the middle of the window until the account id lands. */
export function AppLoadingOverlay() {
  const user = useEngineUser();
  if (user) return null;
  return <AppLoading />;
}
