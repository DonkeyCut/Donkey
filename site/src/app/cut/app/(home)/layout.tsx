import { Suspense } from "react";

import { AppSidebar } from "@/cut/components/AppSidebar";
import { ClaimCreditsDialog } from "@/cut/components/ClaimCreditsDialog";
import { StorageUpgradeDialog } from "@/cut/components/StorageUpgradeDialog";

export default function HomeLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full bg-background">
      <AppSidebar />
      <main className="min-w-0 flex-1 overflow-y-auto">{children}</main>
      {/* Every home surface uploads — projects, library — so the quota wall
          answers from the layout rather than from each page. */}
      <StorageUpgradeDialog />
      {/* A credit offer's email link lands on the home with ?claim=…; the
          dialog reads the address, so it needs a boundary in the prerendered
          shell. */}
      <Suspense>
        <ClaimCreditsDialog />
      </Suspense>
    </div>
  );
}
