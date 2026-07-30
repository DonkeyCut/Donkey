import type { ReactNode } from "react";

import { AppSurfaceBackground } from "@/components/AppSurfaceBackground";
import { NoSessionReplay } from "@/app/_components/NoSessionReplay";
import { ConnectGate } from "@/cut/components/ConnectGate";
import { ExportsDock } from "@/cut/components/ExportsDock";
import { CutOnboarding } from "@/cut/components/onboarding/CutOnboarding";
import { RequireSession } from "@/cut/components/RequireSession";

// The Cut app (projects home, library, editor) renders on the same white
// product surface as Donkey's /app, not the cream marketing background of the
// landing page that lives one segment up. AppSurfaceBackground paints the root
// html white so the cream does not show through the overscroll area, and
// font-system matches the /app system font stack. RequireSession gates the
// whole subtree on a signed-in session, redirecting signed-out visitors to
// sign-in with their target URL as the callback. ConnectGate picks the backend
// the app runs on — the engine on this Mac when it answers without raising the
// browser's local-network prompt, the cloud otherwise — and owns the banner
// that reports an engine this browser can no longer reach. CutOnboarding is the
// welcome sequence a new account sees before any of it.
export default function CutAppLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-white font-system text-foreground antialiased">
      <AppSurfaceBackground />
      <NoSessionReplay />
      <RequireSession>
        <ConnectGate>
          {children}
          {/* App-wide: exports keep showing as you move between projects. */}
          <ExportsDock />
        </ConnectGate>
        {/* Outside the gate so a first run covers the whole window, gate and
            all, and hands over to it when the last slide closes. */}
        <CutOnboarding />
      </RequireSession>
    </div>
  );
}
