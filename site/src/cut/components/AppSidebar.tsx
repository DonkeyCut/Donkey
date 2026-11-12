"use client";

import { useState, useSyncExternalStore } from "react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { FolderOpen, House, LayoutTemplate, PanelLeft } from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
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

// Open or closed to an icon rail, remembered per browser.
type Rail = "open" | "closed";
const RAIL_KEY = "cut-sidebar";
const railListeners = new Set<() => void>();
const readRail = (): Rail => (localStorage.getItem(RAIL_KEY) === "closed" ? "closed" : "open");
const serverRail = (): Rail => "open";
const subscribeRail = (notify: () => void) => {
  railListeners.add(notify);
  window.addEventListener("storage", notify);
  return () => {
    railListeners.delete(notify);
    window.removeEventListener("storage", notify);
  };
};

export function AppSidebar() {
  const t = useTranslations("home");
  const pathname = usePathname();
  const base = useCutBase();
  const rail = useSyncExternalStore(subscribeRail, readRail, serverRail);
  const open = rail === "open";

  // The width animates for a click only: a page load that restores a closed
  // sidebar lands closed.
  const [animate, setAnimate] = useState(false);
  const toggle = () => {
    setAnimate(true);
    localStorage.setItem(RAIL_KEY, open ? "closed" : "open");
    railListeners.forEach((notify) => notify());
  };

  // One sidebar row, lit while its page is open. Closed, the row is its icon
  // and the name moves to a tooltip.
  const navLink = ({ tab, icon: Icon }: NavEntry) => {
    const href = homeHref(base, tab);
    const active = pathname === href;
    const row = (
      <Link
        key={tab}
        href={href}
        aria-label={open ? undefined : t(`tabs.${tab}`)}
        className={cn(
          "flex h-9 items-center gap-2.5 rounded-lg px-2.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
          active && "bg-muted text-foreground"
        )}
      >
        <Icon className="size-4 shrink-0" />
        {open && <span className="truncate">{t(`tabs.${tab}`)}</span>}
      </Link>
    );
    if (open) {
      return row;
    }
    return (
      <Tooltip key={tab}>
        <TooltipTrigger render={row} />
        <TooltipContent side="right">{t(`tabs.${tab}`)}</TooltipContent>
      </Tooltip>
    );
  };

  return (
    <TooltipProvider>
      <aside
        className={cn(
          "flex shrink-0 flex-col border-r border-border bg-card py-4",
          animate && "transition-[width] duration-200",
          open ? "w-60 px-3" : "w-[60px] px-2.5"
        )}
      >
        <div className="mb-5 flex h-9 items-center gap-1.5">
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  onClick={toggle}
                  aria-label={t(open ? "sidebar.close" : "sidebar.open")}
                  aria-expanded={open}
                  className="grid size-9 shrink-0 cursor-pointer place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                />
              }
            >
              <PanelLeft className="size-[18px]" />
            </TooltipTrigger>
            <TooltipContent side="right">{t(open ? "sidebar.close" : "sidebar.open")}</TooltipContent>
          </Tooltip>
          {open && <span className="truncate text-[17px] font-semibold tracking-tight">Donkey Cut</span>}
        </div>

        <nav className="flex flex-col gap-0.5">{NAV.map(navLink)}</nav>
        <div className="mt-auto flex flex-col">
          {open && <NavStorage />}
          <NavUser face={open ? "row" : "avatar"} />
        </div>
      </aside>
    </TooltipProvider>
  );
}
