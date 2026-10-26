"use client";

import type { ReactNode } from "react";

import { Skeleton } from "@/components/ui/skeleton";
import { useEngineUser } from "@/cut/lib/backend/hooks";

// Account guard for Cut's settings pages: they read the account, so they
// wait for it.
//
// It waits on the app's account binding rather than on the session object.
// The auth client re-reads the session on every window focus and answers null
// while that request is in the air, and a guard reading it directly sent a
// signed-in user to sign-in mid-visit. RequireSession, above this whole
// subtree, is what redirects a visitor who really is signed out.
export function SettingsGuard({ children }: { children: ReactNode }) {
  const user = useEngineUser();

  if (!user) {
    return (
      <div className="max-w-2xl">
        <Skeleton className="h-40 w-full rounded-xl" />
      </div>
    );
  }

  return <>{children}</>;
}
