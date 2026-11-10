"use client";

import Link from "next/link";
import { useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Clock, Film, Gauge, Link2, Monitor, Music, Type, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DonkeyMark } from "@/components/DonkeyMark";
import { homeHref, useCutBase } from "@/cut/lib/nav";
import { useTemplateIndex } from "@/cut/lib/queries";
import { ASPECT_FRAME, localized, similarTemplates, type GalleryTemplate } from "@/cut/lib/templateGallery";
import { TemplateCard } from "./TemplateGallery";

// How many related templates the panel offers, and their card size.
const SIMILAR_COUNT = 4;
const SIMILAR_CARD_AREA = 120 * 213;
// How long "Link copied" stays on the button.
const COPIED_MS = 2000;

/** Where "Use as new project" goes: the app's use page, with a fresh run id
 * so a reload there never copies twice. */
function runHref(base: string, id: string): string {
  return `${homeHref(base, "templates")}/${encodeURIComponent(id)}?run=${crypto.randomUUID()}`;
}

/** The template page's top bar: the way back to the gallery and the name. */
export function TemplateTopBar({ template }: { template: GalleryTemplate }) {
  const t = useTranslations("home.templates");
  const locale = useLocale();
  const base = useCutBase();
  return (
    <header className="flex h-full items-center gap-2 border-b border-border bg-card pr-3 pl-2">
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={t("detail.close")}
        nativeButton={false}
        render={<Link href={homeHref(base, "templates")} />}
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
export function TemplateInfo({ template }: { template: GalleryTemplate }) {
  const t = useTranslations("home.templates");
  const locale = useLocale();
  const base = useCutBase();
  const index = useTemplateIndex();
  const [copied, setCopied] = useState(false);
  const frame = ASPECT_FRAME[template.aspect];
  const similar = similarTemplates(index.data?.templates ?? [], template.id, SIMILAR_COUNT);

  const copyLink = () => {
    void navigator.clipboard.writeText(window.location.href).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), COPIED_MS);
    });
  };

  const spec = (Icon: typeof Clock, line: string) => (
    <div className="flex items-center gap-2 text-[13px] text-foreground/90">
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
        <Button size="lg" nativeButton={false} render={<a href={runHref(base, template.id)} />}>
          {t("detail.use")}
        </Button>
        <Button variant="outline" onClick={copyLink}>
          <Link2 data-icon="inline-start" />
          {copied ? t("detail.linkCopied") : t("detail.copyLink")}
        </Button>
      </div>

      <div className="grid grid-cols-2 gap-x-3 gap-y-2.5">
        {spec(Monitor, t("detail.size", { width: frame.width, height: frame.height }))}
        {spec(Clock, t("detail.seconds", { seconds: Math.round(template.seconds) }))}
        {spec(Film, t("detail.slots", { count: template.slots }))}
        {spec(Gauge, t("detail.fps", { fps: template.fps }))}
        {spec(Type, t("detail.texts", { count: template.texts }))}
      </div>

      <p className="text-[13px] leading-relaxed text-foreground/90">{localized(template.description, locale)}</p>

      <div className="flex items-center gap-2 border-t border-border pt-4 text-[13px] text-muted-foreground">
        <Music className="size-4 shrink-0" />
        {t("detail.noMusic")}
      </div>

      {similar.length > 0 && (
        <div className="flex flex-col gap-3 border-t border-border pt-4">
          <h2 className="text-[13px] font-semibold">{t("detail.similar")}</h2>
          <div className="flex flex-wrap items-start gap-3">
            {similar.map((s) => (
              <TemplateCard key={s.id} template={s} area={SIMILAR_CARD_AREA} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
