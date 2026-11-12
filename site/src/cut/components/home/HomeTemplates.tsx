"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Skeleton } from "@/components/ui/skeleton";
import { GalleryTile, type PanelNav } from "@/cut/components/GalleryTile";
import { homeHref, useCutBase } from "@/cut/lib/nav";
import { useTemplateIndex } from "@/cut/lib/queries";
import {
  localized,
  TEMPLATE_CATEGORIES,
  type TemplateCategory,
} from "@/cut/lib/templateGallery";
import { cn } from "@/lib/utils";
import { startTemplateRef } from "./atRows";

// How many templates the preview shows; Browse all has the rest.
const PREVIEW_TEMPLATES = 18;

// The chip that lifts the filter.
const ALL = "all";
type Chip = TemplateCategory | typeof ALL;

/**
 * A taste of the template gallery: a grid of Donkey's templates under chips
 * for the gallery's own categories, which filter it in place. A card opens
 * the template over the page, the way it opens over the gallery, and drags
 * into the prompt box as the project's starting point.
 */
export function HomeTemplates({ panel }: { panel: PanelNav }) {
  const t = useTranslations("home");
  const locale = useLocale();
  const base = useCutBase();
  const index = useTemplateIndex();
  const [chip, setChip] = useState<Chip>(ALL);

  // A chip with fewer templates keeps the grid as tall as it was when the
  // chip was clicked, so the page never gets shorter under the reader and
  // pulls the scroll up. Read once per click, never per frame.
  const grid = useRef<HTMLDivElement>(null);
  const [floor, setFloor] = useState<number | undefined>(undefined);
  const pickChip = (c: Chip) => {
    setFloor(grid.current?.offsetHeight);
    setChip(c);
  };
  const all = index.data?.templates ?? [];

  // Only categories that hold a template get a chip, in the gallery's order.
  const present = new Set(all.map((tpl) => tpl.category));
  const chips: Chip[] = [
    ALL,
    ...TEMPLATE_CATEGORIES.filter((c) => present.has(c)),
  ];
  const shown = (
    chip === ALL ? all : all.filter((tpl) => tpl.category === chip)
  ).slice(0, PREVIEW_TEMPLATES);

  if (!index.isPending && all.length === 0) {
    return null;
  }

  return (
    <section className="flex flex-col gap-4">
      <div className="flex items-baseline justify-between gap-4">
        <h2 className="text-base font-semibold">{t("start.templates")}</h2>
        <Link
          href={homeHref(base, "templates")}
          className="text-[13px] text-muted-foreground transition-colors hover:text-foreground"
        >
          {t("start.browseAll")}
        </Link>
      </div>

      {chips.length > 1 && (
        <div
          className="flex flex-wrap gap-2"
          role="group"
          aria-label={t("templates.filters.category")}
        >
          {chips.map((c) => (
            <button
              key={c}
              type="button"
              aria-pressed={chip === c}
              onClick={() => pickChip(c)}
              className={cn(
                "h-8 rounded-full border px-3 text-[13px] transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
                chip === c
                  ? "border-foreground bg-foreground text-background"
                  : "border-border bg-background text-muted-foreground hover:bg-muted hover:text-foreground",
              )}
            >
              {c === ALL
                ? t("start.allCategories")
                : t(`templates.categories.${c}`)}
            </button>
          ))}
        </div>
      )}

      <div
        ref={grid}
        style={{ minHeight: floor }}
        className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] content-start gap-x-6 gap-y-10"
      >
        {index.isPending
          ? Array.from({ length: PREVIEW_TEMPLATES }, (_, i) => (
              <Skeleton key={i} className="aspect-video rounded-2xl" />
            ))
          : shown.map((template) => (
              // A card dragged into the prompt box starts the project from it.
              <GalleryTile
                key={template.id}
                template={template}
                panel={panel}
                dragRef={startTemplateRef(
                  { kind: "gallery", template },
                  localized(template.name, locale),
                )}
              />
            ))}
      </div>
    </section>
  );
}
