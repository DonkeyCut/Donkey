"use client";

import type { ReactNode } from "react";

import { NoSessionReplay } from "@/app/_components/NoSessionReplay";
import { SuHeader } from "@/app/su/SuHeader";
import { SuSidebar } from "@/app/su/SuSidebar";
import { SidebarProvider } from "@/components/ui/sidebar";
import { useWarmAnalyticsRollup } from "@/queries/analytics";

// The section's two-pane shell. It mounts only for a super user: the proxy
// (src/proxy.ts) has already checked the session and the role before the
// route runs.
//
// The sidebar provider is the outermost element so the header's menu button
// and the rail share one open state: on a phone the rail is a sheet the
// header opens, on a wider screen it is the fixed left column.
export function SuShell({ children }: { children: ReactNode }) {
  useWarmAnalyticsRollup();
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
    <SidebarProvider
      translate="no"
      className="app-surface h-screen min-h-0 bg-background font-system text-foreground antialiased"
    >
      <NoSessionReplay />
      <SuSidebar />
      <main className="flex min-w-0 flex-1 flex-col overflow-y-auto">
        <SuHeader />
        <div className="min-h-0 flex-1">
          <div className="mx-auto h-full w-full max-w-6xl px-4 md:px-10">
            {/* The header is sticky and opaque, so the top of the gap below
                it lives here: a focus ring on the first control needs room
                that the header cannot paint over. */}
            <div className="h-full px-px pt-1 pb-px">{children}</div>
          </div>
        </div>
      </main>
    </SidebarProvider>
  );
}
