"use client";

import { useEffect, type ReactNode } from "react";
import { useRouter } from "next/navigation";

import { SuHeader } from "@/app/cut/app/su/SuHeader";
import { SuSidebar } from "@/app/cut/app/su/SuSidebar";
import { Skeleton } from "@/components/ui/skeleton";
import { useCutBase } from "@/cut/lib/nav";
import { useAccount } from "@/queries/credits";

// The super-user section: its own left rail with the admin surfaces as tabs,
// page details on the right. Everyone else is sent back to the app root — the
// client gate is for UX; the routes these pages call are withSuperUser and
// enforce the role server-side.
export default function SuLayout({ children }: { children: ReactNode }) {
  const router = useRouter();
  const base = useCutBase();
  const account = useAccount();
  const superUser = account.data?.superUser === true;

  useEffect(() => {
    if (account.isPending || superUser) return;
    router.replace(base);
  }, [account.isPending, superUser, router, base]);

  if (!superUser) {
    return (
      <div className="mx-auto max-w-3xl px-8 py-10">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="mt-6 h-40 w-full" />
      </div>
    );
  }

  return (
    <div className="flex h-full bg-background">
      <SuSidebar />
      <main className="flex min-w-0 flex-1 flex-col overflow-y-auto">
        <SuHeader />
        <div className="min-h-0 flex-1">
          <div className="mx-auto h-full w-full max-w-6xl px-10">
            <div className="h-full p-px">{children}</div>
          </div>
        </div>
      </main>
    </div>
  );
}
