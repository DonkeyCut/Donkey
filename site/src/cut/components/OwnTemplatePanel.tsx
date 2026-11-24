"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { Clock, Loader2, Monitor, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { projectHref, useCutBase, type CutTab } from "@/cut/lib/nav";
import { TEMPLATE_ASPECTS, type TemplateAspect } from "@/cut/lib/templateGallery";
import { DEFAULT_ASPECT, type OwnTemplate } from "./OwnTemplateCard";
import { inPanel } from "./GalleryTile";
import { ASPECT_ICON, TemplateTopBar } from "./TemplateInfo";
import { TemplatePlayer } from "./TemplatePlayer";
import { TemplateSheet } from "./TemplateSheet";

/**
 * One of the person's own templates in the sheet Donkey's templates open in:
 * the cut playing read-only from the shelf that holds it, over its timeline,
 * beside a panel that makes a new project from it or opens it for editing.
 * The card owns the copy and the way out to the editor, so its busy state
 * and failure show here too.
 */
export function OwnTemplatePanel({
  template,
  open,
  from,
  busy,
  error,
  onUse,
  onEdit,
  onClose,
}: {
  template: OwnTemplate;
  open: boolean;
  /** The Home tab the editor's back button returns to. */
  from: CutTab;
  busy: boolean;
  error: string | null;
  onUse: () => void;
  /** Open the template in the editor; a modified click opens a new tab. */
  onEdit: () => void;
  onClose: () => void;
}) {
  const t = useTranslations("home.templates");
  const base = useCutBase();
  const { project: p, residency } = template;
  const href = projectHref(base, p.id, from);

  // The frame shape reads as the gallery's names it; any other shape shows
  // its ratio.
  const aspect = p.aspect ?? DEFAULT_ASPECT;
  const known = (TEMPLATE_ASPECTS as readonly string[]).includes(aspect)
    ? (aspect as TemplateAspect)
    : null;
  const AspectIcon = known ? ASPECT_ICON[known] : Monitor;

  const spec = (Icon: typeof Clock, line: string) => (
    <div className="flex items-center gap-1.5 text-[13px] whitespace-nowrap text-foreground/90">
      <Icon className="size-4 shrink-0 text-muted-foreground" />
      {line}
    </div>
  );

  return (
    <TemplateSheet open={open} title={p.name} onClose={onClose}>
      <div className="flex h-full flex-col overflow-y-auto md:flex-row md:overflow-hidden">
        <div className="flex min-w-0 shrink-0 flex-col md:min-h-0 md:flex-1">
          <div className="h-[46px] shrink-0">
            <TemplateTopBar name={p.name} closeHref={href} panel={{ close: onClose }} />
          </div>
          {/* On a phone the player and its timeline nearly fill the screen,
              and the panel scrolls up under them. */}
          <div className="h-[88dvh] min-h-0 md:h-auto md:flex-1">
            <TemplatePlayer projectId={p.id} source={{ kind: "own", residency }} />
          </div>
        </div>
        <aside className="shrink-0 border-t border-border bg-card md:w-80 md:overflow-y-auto md:border-t-0 md:border-l">
          <div className="flex flex-col gap-5 p-5">
            <div className="min-w-0">
              <h1 className="text-base font-semibold tracking-tight">{p.name}</h1>
              <p className="mt-1 text-[13px] text-muted-foreground">{t("sources.mine")}</p>
            </div>

            <div className="flex flex-col gap-2">
              <Button size="lg" disabled={busy} onClick={onUse}>
                {busy && <Loader2 data-icon="inline-start" className="animate-spin" />}
                {busy ? t("detail.using") : t("detail.use")}
              </Button>
              <Button variant="outline" nativeButton={false} render={<Link href={href} onClick={(e) => inPanel(e, onEdit)} />}>
                <Pencil data-icon="inline-start" />
                {t("detail.edit")}
              </Button>
              {error && <p className="text-[13px] text-destructive">{error}</p>}
            </div>

            <div className="flex flex-wrap gap-x-4 gap-y-2.5">
              {spec(AspectIcon, known ? t(`aspects.${known}`) : aspect)}
              {spec(Clock, t("detail.seconds", { seconds: Math.round(p.duration) }))}
            </div>
          </div>
        </aside>
      </div>
    </TemplateSheet>
  );
}
