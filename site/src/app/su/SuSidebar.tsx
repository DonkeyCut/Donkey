"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ArrowLeft } from "lucide-react";

import { SU_NAV, suSurfaceAt } from "@/app/su/nav";
import { SU_APP_ORIGIN } from "@/cut/lib/hosts";
import { cn } from "@/lib/utils";

const itemClass =
  "flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground";

// A section's tabs sit beneath it, inset to the label's column.
const tabClass =
  "flex items-center rounded-lg py-1.5 pl-[38px] pr-2.5 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground";

// The super-user section's left rail: same shell as the app sidebar, with the
// admin surfaces as tabs and a way back to the app pinned to the bottom.
export function SuSidebar() {
  const pathname = usePathname();
  const here = suSurfaceAt(pathname);

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
        {SU_NAV.map((surface) => {
          const { href, label, icon: Icon, tabs } = surface;
          const active = here.surface === surface;
          return (
            <div key={label} className="flex flex-col gap-0.5">
              <Link
                href={href}
                className={cn(itemClass, active && !tabs && "bg-muted text-foreground")}
              >
                <Icon className="size-4" />
                {label}
              </Link>
              {tabs && active
                ? tabs.map((tab) => (
                    <Link
                      key={tab.href}
                      href={tab.href}
                      className={cn(
                        tabClass,
                        here.tab === tab && "bg-muted font-medium text-foreground",
                      )}
                    >
                      {tab.label}
                    </Link>
                  ))
                : null}
            </div>
          );
        })}
      </nav>

      {/* The app is a different host, so this is a document load. */}
      <div className="mt-auto flex flex-col">
        <a href={`${SU_APP_ORIGIN}/app`} className={itemClass}>
          <ArrowLeft className="size-4" />
          Back to app
        </a>
      </div>
    </aside>
  );
}
