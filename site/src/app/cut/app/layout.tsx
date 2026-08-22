import { Suspense, type ReactNode } from "react";

import { NoSessionReplay } from "@/app/_components/NoSessionReplay";
import { ConnectGate } from "@/cut/components/ConnectGate";
import { ExportsDock } from "@/cut/components/ExportsDock";
import { CutOnboarding } from "@/cut/components/onboarding/CutOnboarding";
import { RequireSession } from "@/cut/components/RequireSession";
import { AppLoading, AppLoadingOverlay, SessionGate } from "@/cut/components/SessionGate";

// The Cut app (projects home, library, editor) renders on the white product
// surface. The `app-surface` class on this wrapper is what repoints the
// --background token (see globals.css) for the whole document, so the cream
// landing background is gone from the first painted frame — including the
// browser's overscroll area — with no script to run. font-system matches the
// /app system font stack. RequireSession binds the account and redirects
// signed-out visitors to sign-in with their target URL as the callback.
// ConnectGate picks the backend the app runs on — the engine on this Mac when
// it answers without raising the browser's local-network prompt, the cloud
// otherwise — and owns the banner that reports an engine this browser can no
// longer reach. CutOnboarding is the welcome sequence a new account sees before
// any of it.
//
// Everything the app draws reads the engine, and every engine URL carries the
// account id, so the shell has nothing true to show before the session lands:
// a cold load is one centered spinner, and the sidebar and content arrive
// together behind it.

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
      className="app-surface min-h-screen bg-white font-system text-foreground antialiased"
    >
      <NoSessionReplay />
      {/* A route whose address carries data — the editor's project id — can't be
          in the prerendered shell, and the framework resolves that above the
          client shell below. The boundary is here so it has somewhere to land. */}
      <Suspense fallback={<AppLoading />}>
        <RequireSession>
          <ConnectGate>
            {children}
            {/* App-wide: exports keep showing as you move between projects. Both
              overlays read the account, so they wait for it; neither has a
              shape worth drawing before then. */}
            <SessionGate>
              <ExportsDock />
            </SessionGate>
          </ConnectGate>
          {/* Outside the gate so a first run covers the whole window, gate and
            all, and hands over to it when the last slide closes. */}
          <SessionGate>
            <CutOnboarding />
          </SessionGate>
        </RequireSession>
      </Suspense>
      {/* The cold-load cover, over the shell and the banner both: the app is one
          centered spinner until the account id lands. It sits outside the
          boundary above so it also covers what that boundary is waiting on. */}
      <AppLoadingOverlay />
    </div>
  );
}
