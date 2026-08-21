import { Suspense, type ReactNode } from "react";

import { AppSurfaceBackground } from "@/components/AppSurfaceBackground";
import { NoSessionReplay } from "@/app/_components/NoSessionReplay";
import { ConnectGate } from "@/cut/components/ConnectGate";
import { ExportsDock } from "@/cut/components/ExportsDock";
import { CutOnboarding } from "@/cut/components/onboarding/CutOnboarding";
import { RequireSession } from "@/cut/components/RequireSession";
import { SessionGate, SessionSkeleton } from "@/cut/components/SessionGate";

// The Cut app (projects home, library, editor) renders on the same white
// product surface as Donkey's /app, not the cream marketing background of the
// landing page that lives one segment up. AppSurfaceBackground paints the root
// html white so the cream does not show through the overscroll area, and
// font-system matches the /app system font stack. RequireSession binds the
// account and redirects signed-out visitors to sign-in with their target URL as
// the callback. ConnectGate picks the backend the app runs on — the engine on
// this Mac when it answers without raising the browser's local-network prompt,
// the cloud otherwise — and owns the banner that reports an engine this browser
// can no longer reach. CutOnboarding is the welcome sequence a new account sees
// before any of it.
//
// The surface, the sidebar under it, and the banner are the shell: they render
// with no session and no account, which is what a cold load paints. Everything
// that reads the engine waits behind a SessionGate for the account id.

export default function CutAppLayout({ children }: { children: ReactNode }) {
  return (
    // translate="no" covers the whole app subtree. A browser's built-in
    // translator rewrites text nodes in place under a running React tree: the
    // rewrite lands mid-hydration as a text mismatch, and then a later commit
    // that moves one of the rewritten nodes throws NotFoundError out of
    // insertBefore and takes the editor down. The editor's text is chrome
    // around a canvas, so the page keeps its own words and stays standing.
    <div
      translate="no"
      className="min-h-screen bg-white font-system text-foreground antialiased"
    >
      <AppSurfaceBackground />
      <NoSessionReplay />
      {/* A route whose address carries data — the editor's project id — can't be
          in the prerendered shell, and the framework resolves that above the
          client shell below. The boundary is here so it has somewhere to land:
          the home routes suspend on nothing and prerender whole, and the editor
          arrives as this skeleton on the app's own surface. */}
      <Suspense fallback={<SessionSkeleton />}>
        <RequireSession>
          <ConnectGate>
            {children}
            {/* App-wide: exports keep showing as you move between projects. Both
              overlays read the account, so they wait for it; neither has a
              shape worth drawing before then. */}
            <SessionGate fallback={null}>
              <ExportsDock />
            </SessionGate>
          </ConnectGate>
          {/* Outside the gate so a first run covers the whole window, gate and
            all, and hands over to it when the last slide closes. */}
          <SessionGate fallback={null}>
            <CutOnboarding />
          </SessionGate>
        </RequireSession>
      </Suspense>
    </div>
  );
}
