"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ArrowLeft, ChartColumn, CreditCard, UserRound } from "lucide-react";

import { useCutBase } from "@/cut/lib/nav";
import { cn } from "@/lib/utils";

const NAV: { suffix: string; label: string; icon: typeof UserRound }[] = [
  { suffix: "", label: "Users", icon: UserRound },
  { suffix: "/credits", label: "Credits", icon: CreditCard },
  { suffix: "/analytics", label: "Analytics", icon: ChartColumn },
];

const itemClass =
  "flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground";

// The super-user section's left rail: same shell as the app sidebar, with the
// admin surfaces as tabs and a way back to the app pinned to the bottom.
export function SuSidebar() {
  const pathname = usePathname();
  const base = useCutBase();

  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-border bg-card px-3 py-4">
      <div className="mb-5 flex items-center gap-2.5 px-2">
        <span className="grid size-9 shrink-0 place-items-center p-0.5">
          <img
            src="/donkey-logo.svg"
            alt="Donkey Cut"
            width={36}
            height={36}
            className="block h-full w-full object-contain"
          />
        </span>
        <span className="text-[17px] font-semibold tracking-tight">Super user</span>
      </div>

      <nav className="flex flex-col gap-0.5">
        {NAV.map(({ suffix, label, icon: Icon }) => {
          const href = `${base}/su${suffix}`;
          const active = pathname === href;
          return (
            <Link
              key={label}
              href={href}
              className={cn(itemClass, active && "bg-muted text-foreground")}
            >
              <Icon className="size-4" />
              {label}
            </Link>
          );
        })}
      </nav>

      <div className="mt-auto flex flex-col">
        <Link href={base} className={itemClass}>
          <ArrowLeft className="size-4" />
          Back to app
        </Link>
      </div>
    </aside>
  );
}
