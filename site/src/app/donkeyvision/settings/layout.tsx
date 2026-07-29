import type { Metadata } from "next";
import type { ReactNode } from "react";

import { SettingsShell } from "@/app/donkeyvision/settings/SettingsShell";
import { AppSurfaceBackground } from "@/components/AppSurfaceBackground";

export const metadata: Metadata = {
  title: "Settings | Donkey",
  description: "Manage your Vision API subscription and API keys.",
};

// QueryProvider is mounted once at the root layout, so the settings UI just
// needs its session-guarded shell here. The white product surface is this
// layout's own: the Vision marketing page one segment up renders on the cream
// landing background.
export default function SettingsLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-white font-system text-foreground">
      <AppSurfaceBackground />
      <SettingsShell>{children}</SettingsShell>
    </div>
  );
}
