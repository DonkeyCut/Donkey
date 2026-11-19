"use client";

import { useEffect } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { FolderOpen, House, LayoutTemplate } from "lucide-react";
import { AppSidebar } from "@/cut/components/AppSidebar";
import { useEnvironment } from "@/cut/lib/environment";
import { useHostReady } from "@/cut/lib/hostBridge";
import { homeHref, useCutBase, type CutTab } from "@/cut/lib/nav";
import { cn } from "@/lib/utils";

const CARD_TABS: { tab: CutTab; icon: typeof House }[] = [
  { tab: "home", icon: House },
  { tab: "templates", icon: LayoutTemplate },
  { tab: "assets", icon: FolderOpen },
];

// A tab: an icon beside its label in a pill.
const TAB = "inline-flex h-8 shrink-0 items-center gap-2 rounded-full px-3 text-[13px] font-medium outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring/50";

/** The home's navigation: the full sidebar on the web, the card's tabs in
 * ChatGPT. */
export function HomeNav() {
  const { chatgpt } = useEnvironment();
  useDropSelectionOnNav();
  return chatgpt ? <CardTabs /> : <AppSidebar />;
}

/**
 * A text selection made on one page goes when another page shows. The router
 * keeps the pages it left mounted and hidden, so a select-all on Assets
 * would otherwise light up all of Home the moment Home shows again.
 */
function useDropSelectionOnNav() {
  const pathname = usePathname();
  useEffect(() => {
    const selection = window.getSelection();
    if (selection?.type === "Range") {
      selection.removeAllRanges();
    }
  }, [pathname]);
}

/**
 * The home inside the ChatGPT card. The host draws the app's name and owns
 * the account, so a bar across the top carries only Home, Templates and
 * Assets, on the layout's background. The layout stacks under it by the
 * `data-card-tabs` mark.
 */
function CardTabs() {
  const t = useTranslations("home");
  const pathname = usePathname();
  const base = useCutBase();
  useHostReady(true);

  return (
    <nav
      data-card-tabs
      className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-border px-3 py-2"
    >
      {CARD_TABS.map(({ tab, icon: Icon }) => {
        const href = homeHref(base, tab);
        const active = pathname === href;
        return (
          <Link
            key={tab}
            href={href}
            aria-current={active ? "page" : undefined}
            className={cn(
              TAB,
              active
                ? "bg-foreground/10 text-foreground"
                : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
            )}
          >
            <Icon className="size-4" />
            {t(`tabs.${tab}`)}
          </Link>
        );
      })}
    </nav>
  );
}
