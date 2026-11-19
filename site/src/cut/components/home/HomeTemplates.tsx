"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Star } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { GalleryTile, type PanelNav } from "@/cut/components/GalleryTile";
import { OwnTemplateCard } from "@/cut/components/OwnTemplateCard";
import { homeHref, useCutBase } from "@/cut/lib/nav";
import {
  useOwnTemplates,
  useTemplateFavorites,
  useTemplateIndex,
} from "@/cut/lib/queries";
import {
  favoritesFirst,
  localized,
  TEMPLATE_CATEGORIES,
  categoriesOf,
  type TemplateCategory,
} from "@/cut/lib/templateGallery";
import { cn } from "@/lib/utils";
import { startTemplateRef } from "./atRows";
import type { HomeDensity } from "./projectTile";

// How many templates the preview shows; Browse all has the rest.
const PREVIEW_TEMPLATES = 18;

// The chip that lifts the filter, and the two beside it: the templates the
// person starred, and their own.
const ALL = "all" as const;
const FAVORITES = "favorites" as const;
const MINE = "mine" as const;
type Chip = TemplateCategory | typeof ALL | typeof FAVORITES | typeof MINE;

// The grid's columns and gaps: three across the ChatGPT card's width.
const GRID: Record<HomeDensity, string> = {
  roomy: "grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-x-6 gap-y-10",
  compact: "grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-x-4 gap-y-6",
};

/**
 * A taste of the template gallery: a grid of Donkey's templates, starred
 * ones first, under chips for favorites, the person's own templates and the
 * gallery's categories, which filter it in place. A card opens
 * the template over the page, the way it opens over the gallery, and drags
 * into the prompt box as the project's starting point.
 */
export function HomeTemplates({
  panel,
  density,
}: {
  panel: PanelNav;
  density: HomeDensity;
}) {
  const t = useTranslations("home");
  const locale = useLocale();
  const base = useCutBase();
  const index = useTemplateIndex();
  const favorites = useTemplateFavorites();
  const mine = useOwnTemplates();
  const [picked, setChip] = useState<Chip>(ALL);

  // A chip with fewer templates keeps the grid as tall as it was when the
  // chip was clicked, so the page never gets shorter under the reader and
  // pulls the scroll up. Read once per click, never per frame.
  const grid = useRef<HTMLDivElement>(null);
  const [floor, setFloor] = useState<number | undefined>(undefined);
  const pickChip = (c: Chip) => {
    setFloor(grid.current?.offsetHeight);
    setChip(c);
  };
  const all = favoritesFirst(
    index.data?.templates ?? [],
    (tpl) => tpl.id,
    favorites.ids,
  );
  const starred = all.filter((tpl) => favorites.ids?.has(tpl.id));

  // Favorites and My templates sit beside All while they hold something; only
  // categories that hold a template get a chip, in the gallery's order. A
  // chip that empties, e.g. the last star taken off, hands back to All.
  const present = new Set(all.flatMap(categoriesOf));
  const chips: Chip[] = [
    ALL,
    ...(starred.length > 0 ? [FAVORITES] : []),
    ...(mine.length > 0 ? [MINE] : []),
    ...TEMPLATE_CATEGORIES.filter((c) => present.has(c)),
  ];
  const chip = chips.includes(picked) ? picked : ALL;
  const shown = (
    chip === ALL
      ? all
      : chip === FAVORITES
        ? starred
        : chip === MINE
          ? []
          : all.filter((tpl) => categoriesOf(tpl).includes(chip))
  ).slice(0, PREVIEW_TEMPLATES);
  const own = chip === MINE ? mine.slice(0, PREVIEW_TEMPLATES) : [];

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
                "inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-[13px] transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
                chip === c
                  ? "border-foreground bg-foreground text-background"
                  : "border-border bg-background text-muted-foreground hover:bg-muted hover:text-foreground",
              )}
            >
              {c === FAVORITES && (
                <Star
                  aria-hidden
                  className="-ml-0.5 size-3.5 fill-amber-400 text-amber-400"
                />
              )}
              {c === ALL
                ? t("start.allCategories")
                : c === FAVORITES || c === MINE
                  ? t(`templates.sources.${c}`)
                  : t(`templates.categories.${c}`)}
            </button>
          ))}
        </div>
      )}

      <div
        ref={grid}
        style={{ minHeight: floor }}
        className={cn("grid content-start", GRID[density])}
      >
        {index.isPending
          ? Array.from({ length: PREVIEW_TEMPLATES }, (_, i) => (
              <Skeleton key={i} className="aspect-video rounded-2xl" />
            ))
          : [
              ...own.map(({ project, residency }) => (
                // A card dragged into the prompt box starts the project from it.
                <OwnTemplateCard
                  key={project.id}
                  template={{ project, residency }}
                  from="home"
                  dragRef={startTemplateRef(
                    { kind: "own", project, residency },
                    project.name,
                  )}
                />
              )),
              ...shown.map((template) => (
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
              )),
            ]}
      </div>
    </section>
  );
}
