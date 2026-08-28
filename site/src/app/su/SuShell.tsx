"use client";

import { useEffect, type ReactNode } from "react";

import { NoSessionReplay } from "@/app/_components/NoSessionReplay";
import { SuHeader } from "@/app/su/SuHeader";
import { SuSidebar } from "@/app/su/SuSidebar";
import { Skeleton } from "@/components/ui/skeleton";
import { SU_APP_ORIGIN } from "@/cut/lib/hosts";
import { authClient } from "@/lib/auth-client";
import { useAccount } from "@/queries/credits";

// The section's own gate and two-pane shell. Sign-in lives on the app's host,
// so a signed-out visitor leaves for it with this page's full address as the
// post-auth callback, and anyone signed in without the role is sent to the app.
// Both gates are for UX; the routes these pages call are withSuperUser and
// enforce the role server-side.
export function SuShell({ children }: { children: ReactNode }) {
  const { data: session, isPending: sessionPending } = authClient.useSession();
  const account = useAccount();
  const signedOut = !sessionPending && !session;
  const superUser = account.data?.superUser === true;

  useEffect(() => {
    if (!signedOut) return;
    const here = encodeURIComponent(window.location.href);
    window.location.replace(`${SU_APP_ORIGIN}/sign-in?callbackURL=${here}`);
  }, [signedOut]);

  // Only a definitive answer sends someone away: a failed account request
  // leaves the page waiting rather than bouncing the operator out mid-session.
  useEffect(() => {
    if (signedOut || !account.isSuccess || superUser) return;
    window.location.replace(`${SU_APP_ORIGIN}/app`);
  }, [account.isSuccess, signedOut, superUser]);

  // The section paints the white product surface. `app-surface` is what
  // repoints the --background token for the whole document (see globals.css),
  // so it belongs on the outermost element here.
  //
  // translate="no" covers the subtree: a browser's built-in translator rewrites
  // text nodes under a running React tree, the rewrite lands mid-hydration as a
  // text mismatch, and a later commit that moves one of those nodes throws
  // NotFoundError out of insertBefore and takes the page down. These surfaces
  // are dense text tables, which is exactly what a translator reaches for.
  return (
    <div
      translate="no"
      className="app-surface flex h-screen bg-background font-system text-foreground antialiased"
    >
      <NoSessionReplay />
      {superUser ? (
        <>
          <SuSidebar />
          <main className="flex min-w-0 flex-1 flex-col overflow-y-auto">
            <SuHeader />
            <div className="min-h-0 flex-1">
              <div className="mx-auto h-full w-full max-w-6xl px-10">
                {/* The header is sticky and opaque, so the top of the gap
                    below it lives here: a focus ring on the first control
                    needs room that the header cannot paint over. */}
                <div className="h-full px-px pt-1 pb-px">{children}</div>
              </div>
            </div>
          </main>
        </>
      ) : (
        <div className="mx-auto w-full max-w-3xl px-8 py-10">
          <Skeleton className="h-8 w-48" />
          <Skeleton className="mt-6 h-40 w-full" />
        </div>
      )}
    </div>
  );
}
