"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { Clapperboard, FolderOpen, Plus } from "lucide-react";
import { AppSidebar } from "@/cut/components/AppSidebar";
import { useCardCreate } from "@/cut/components/EmbeddedNewProject";
import { useEnvironment } from "@/cut/lib/environment";
import { useHostReady } from "@/cut/lib/hostBridge";
import { homeHref, useCutBase, type CutTab } from "@/cut/lib/nav";
import { cn } from "@/lib/utils";

const CARD_TABS: { tab: CutTab; label: "projects" | "library"; icon: typeof Clapperboard }[] = [
  { tab: "projects", label: "projects", icon: Clapperboard },
  { tab: "library", label: "library", icon: FolderOpen },
];

// The editor rail's tile: an icon chip over a small label.
const TILE = "flex w-full min-w-0 shrink-0 flex-col items-center gap-1 rounded-lg px-1 py-1.5 text-muted-foreground outline-none transition-colors hover:text-foreground disabled:opacity-50";
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
 * owns the account, so the rail carries only the way to a new project and the
 * two shelves, in the editor rail's size.
 */
function CardRail() {
  const t = useTranslations("home");
  const pathname = usePathname();
  const base = useCutBase();
  const { create, busy, error } = useCardCreate();
  useHostReady(true);

  return (
    <nav className="relative flex w-[68px] shrink-0 flex-col items-center gap-1 border-r border-border bg-card px-1 py-3">
      <button type="button" className={TILE} disabled={busy} onClick={() => void create()}>
        <span className={cn(CHIP, "hover:bg-muted/60")}>
          <Plus className="size-4.5" />
        </span>
        <span className={LABEL}>{t("newProject.button")}</span>
      </button>
      <div aria-hidden className="my-1 h-px w-8 shrink-0 bg-border" />
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
      {/* The rail is too narrow for a sentence, so a failed create speaks
          beside it. */}
      {error && (
        <p role="alert" className="absolute top-3 left-[76px] z-10 w-56 rounded-md border border-border bg-popover p-2 text-xs text-destructive shadow-md">
          {error}
        </p>
      )}
    </nav>
  );
}
