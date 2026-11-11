"use client";

import Link from "next/link";
import { useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Clock, Gauge, Link2, Monitor, Smartphone, Square, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DonkeyMark } from "@/components/DonkeyMark";
import { homeHref, useCutBase } from "@/cut/lib/nav";
import { useTemplateIndex } from "@/cut/lib/queries";
import { localized, similarTemplates, type GalleryTemplate, type TemplateAspect } from "@/cut/lib/templateGallery";
import { GalleryTile, inPanel, type PanelNav } from "./GalleryTile";
import { TemplateUseDialog } from "./TemplateUseView";

// How many related templates the panel offers.
const SIMILAR_COUNT = 4;
// How long "Link copied" stays on the button.
const COPIED_MS = 2000;

// The shape line's icon follows the frame's shape, as in the editor's top bar.
const ASPECT_ICON: Record<TemplateAspect, typeof Clock> = {
  "9:16": Smartphone,
  "4:5": Smartphone,
  "1:1": Square,
  "16:9": Monitor,
};

/** Where "Use as new project" goes: the app's use page, with a fresh run id
 * so a reload there never copies twice. */
function runHref(base: string, id: string): string {
  return `${homeHref(base, "templates")}/${encodeURIComponent(id)}?run=${crypto.randomUUID()}`;
}

/** The template page's top bar: the way back to the gallery and the name. */
export function TemplateTopBar({
  template,
  closeHref,
  panel,
}: {
  template: GalleryTemplate;
  closeHref: string;
  panel?: PanelNav;
}) {
  const t = useTranslations("home.templates");
  const locale = useLocale();
  return (
    <header className="flex h-full items-center gap-2 border-b border-border bg-card pr-3 pl-2">
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={t("detail.close")}
        nativeButton={false}
        render={<Link href={closeHref} scroll={false} onClick={panel ? (e) => inPanel(e, panel.close) : undefined} />}
      >
        <X />
      </Button>
      <span className="grid size-[22px] shrink-0 place-items-center">
        <DonkeyMark alt="Donkey" />
      </span>
      <span className="max-w-64 truncate px-1 text-sm font-medium tracking-tight">
        {localized(template.name, locale)}
      </span>
    </header>
  );
}

/** The template page's side panel: what the template is, and the button that
 * makes it the person's own project. */
export function TemplateInfo({ template, panel }: { template: GalleryTemplate; panel?: PanelNav }) {
  const t = useTranslations("home.templates");
  const locale = useLocale();
  const base = useCutBase();
  const index = useTemplateIndex();
  const [copied, setCopied] = useState(false);
  const [using, setUsing] = useState(false);
  const similar = similarTemplates(index.data?.templates ?? [], template.id, SIMILAR_COUNT);

  const copyLink = () => {
    void navigator.clipboard.writeText(window.location.href).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), COPIED_MS);
    });
  };

  const spec = (Icon: typeof Clock, line: string) => (
    <div className="flex items-center gap-1.5 text-[13px] whitespace-nowrap text-foreground/90">
      <Icon className="size-4 shrink-0 text-muted-foreground" />
      {line}
    </div>
  );

  return (
    <div className="flex flex-col gap-5 p-5">
      <div>
        <h1 className="text-base font-semibold tracking-tight">{localized(template.name, locale)}</h1>
        <p className="mt-1 text-[13px] text-muted-foreground">
          {t(`categories.${template.category}`)} · {t(`styles.${template.style}`)}
        </p>
      </div>

      <div className="flex flex-col gap-2">
        {/* In the app's panel the copy runs in place; the template's own page
            hands it to the app. */}
        {panel ? (
          <Button size="lg" onClick={() => setUsing(true)}>
            {t("detail.use")}
          </Button>
        ) : (
          <Button size="lg" nativeButton={false} render={<a href={runHref(base, template.id)} />}>
            {t("detail.use")}
          </Button>
        )}
        {using && <TemplateUseDialog template={template} onClose={() => setUsing(false)} />}
        <Button variant="outline" onClick={copyLink}>
          <Link2 data-icon="inline-start" />
          {copied ? t("detail.linkCopied") : t("detail.copyLink")}
        </Button>
      </div>

      {/* One row; a longer translation wraps the last spec under it. */}
      <div className="flex flex-wrap gap-x-4 gap-y-2.5">
        {spec(ASPECT_ICON[template.aspect], t(`aspects.${template.aspect}`))}
        {spec(Clock, t("detail.seconds", { seconds: Math.round(template.seconds) }))}
        {spec(Gauge, t("detail.fps", { fps: template.fps }))}
      </div>

      <p className="text-[13px] leading-relaxed text-foreground/90">{localized(template.description, locale)}</p>

      {similar.length > 0 && (
        <div className="flex flex-col gap-3 border-t border-border pt-4">
          <h2 className="text-[13px] font-semibold">{t("detail.similar")}</h2>
          <div className="grid grid-cols-1 gap-2">
            {similar.map((s) => (
              <GalleryTile key={s.id} template={s} panel={panel} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
