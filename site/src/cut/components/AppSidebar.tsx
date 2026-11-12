"use client";

import { DonkeyMark } from "@/components/DonkeyMark";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { FolderOpen, House, LayoutTemplate } from "lucide-react";
import { NavStorage } from "@/cut/components/NavStorage";
import { NavUser } from "@/cut/components/NavUser";
import { homeHref, useCutBase, type CutTab } from "@/cut/lib/nav";
import { cn } from "@/lib/utils";

// Each tab's name is its key in the home catalog's tab names.
type NavEntry = { tab: CutTab; icon: typeof House };

// Where work starts, everything the person has, and what Donkey offers to
// start from.
const NAV: NavEntry[] = [
  { tab: "home", icon: House },
  { tab: "assets", icon: FolderOpen },
  { tab: "templates", icon: LayoutTemplate },
];

export function AppSidebar() {
  const t = useTranslations("home");
  const pathname = usePathname();
  const base = useCutBase();

  // One sidebar row, lit while its page is open.
  const navLink = ({ tab, icon: Icon }: NavEntry) => {
    const href = homeHref(base, tab);
    const active = pathname === href;
    return (
      <Link
        key={tab}
        href={href}
        className={cn(
          "flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
          active && "bg-muted text-foreground"
        )}
      >
        <Icon className="size-4" />
        <span className="truncate">{t(`tabs.${tab}`)}</span>
      </Link>
    );
  };

  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-border bg-card px-3 py-4">
      <div className="mb-5 flex items-center gap-2.5 px-2">
        <span className="grid size-9 shrink-0 place-items-center p-0.5">
          <DonkeyMark alt="Donkey Cut" />
        </span>
        <span className="text-[17px] font-semibold tracking-tight">Donkey Cut</span>
      </div>

      <nav className="flex flex-col gap-0.5">{NAV.map(navLink)}</nav>
      <div className="mt-auto flex flex-col">
        <NavStorage />
        <NavUser />
      </div>
    </aside>
  );
}
