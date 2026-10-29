"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { Clapperboard, FolderOpen } from "lucide-react";
import { AppSidebar } from "@/cut/components/AppSidebar";
import { useEnvironment } from "@/cut/lib/environment";
import { useHostReady } from "@/cut/lib/hostBridge";
import { homeHref, useCutBase, type CutTab } from "@/cut/lib/nav";
import { cn } from "@/lib/utils";

const CARD_TABS: { tab: CutTab; label: "projects" | "library"; icon: typeof Clapperboard }[] = [
  { tab: "projects", label: "projects", icon: Clapperboard },
  { tab: "library", label: "library", icon: FolderOpen },
];

// The editor rail's tile: an icon chip over a small label.
const TILE = "flex w-full min-w-0 shrink-0 flex-col items-center gap-1 rounded-lg px-1 py-1.5 text-muted-foreground outline-none transition-colors hover:text-foreground";
const CHIP = "grid size-9 place-items-center rounded-lg transition-colors";
const LABEL = "w-full truncate text-center text-[10px] font-medium tracking-tight";

/** The home's navigation: the full sidebar on the web, the card's rail in
 * ChatGPT. */
export function HomeNav() {
  const { chatgpt } = useEnvironment();
  return chatgpt ? <CardRail /> : <AppSidebar />;
}

/**
 * The projects home inside the ChatGPT card. The host draws the app's name and
 * owns the account, so the rail carries only the two shelves, in the editor
 * rail's size; each shelf has its own New project.
 */
function CardRail() {
  const t = useTranslations("home");
  const pathname = usePathname();
  const base = useCutBase();
  useHostReady(true);

  return (
    <nav className="flex w-[68px] shrink-0 flex-col items-center gap-1 border-r border-border bg-card px-1 py-3">
      {CARD_TABS.map(({ tab, label, icon: Icon }) => {
        const href = homeHref(base, tab);
        const active = pathname === href;
        return (
          <Link key={tab} href={href} className={TILE} aria-current={active ? "page" : undefined}>
            <span className={cn(CHIP, active ? "bg-foreground/10 text-foreground" : "hover:bg-muted/60")}>
              <Icon className="size-4.5" />
            </span>
            <span className={cn(LABEL, active && "text-foreground")}>{t(`tabs.${label}`)}</span>
          </Link>
        );
      })}
    </nav>
  );
}
