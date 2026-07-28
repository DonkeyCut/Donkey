import { AppSidebar } from "@/cut/components/AppSidebar";
import { StorageUpgradeDialog } from "@/cut/components/StorageUpgradeDialog";

export default function HomeLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full bg-background">
      <AppSidebar />
      <main className="min-w-0 flex-1 overflow-y-auto">{children}</main>
      {/* Every home surface uploads — projects, library — so the quota wall
          answers from the layout rather than from each page. */}
      <StorageUpgradeDialog />
    </div>
  );
}
