"use client";

import Link from "next/link";
import { useState, type MouseEvent } from "react";
import { useLocale, useTranslations } from "next-intl";
import { ArrowUpRight } from "lucide-react";
import {
  clearRefDrag,
  setRefDragData,
  type AssetRef,
} from "@/cut/lib/assetRef";
import {
  localized,
  templatePage,
  templatePoster,
  type GalleryTemplate,
} from "@/cut/lib/templateGallery";
import { formatTime } from "@/cut/lib/time";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

// A card's own shape; a still of it fills the card.
const WIDE = "16:9";

/** Opening and closing the template panel from links inside it: a tile or
 * the close button keeps its real href for a new tab, and a plain click
 * stays in the panel. */
export type PanelNav = { open: (id: string) => void; close: () => void };

/** Run `go` in place of a plain left click's navigation; a click with a
 * modifier key opens the href as the browser would. */
export function inPanel(e: MouseEvent, go: () => void) {
  if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) {
    return;
  }
  e.preventDefault();
  go();
}

/** The words under a template's picture: its name, with an arrow that
 * leans out on hover, over a line of description. */
export function TemplateCaption({
  name,
  description,
}: {
  name: string;
  description?: string;
}) {
  return (
    <span className="flex flex-col gap-1 px-0.5">
      <span className="flex items-center justify-between gap-3">
        <span className="truncate text-[15px] font-medium tracking-[-0.01em]">
          {name}
        </span>
        <ArrowUpRight
          aria-hidden
          className="size-4 shrink-0 transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5"
        />
      </span>
      {description && (
        <span className="line-clamp-1 text-[13px] text-muted-foreground">
          {description}
        </span>
      )}
    </span>
  );
}

/** A template's facts in its picture's bottom-left corner, shown on hover,
 * e.g. "Travel / Vertical 9:16 / 0:15". */
export function TemplateFacts({ facts }: { facts: string[] }) {
  return (
    <span className="absolute bottom-2 left-2 max-w-[calc(100%-1rem)] truncate rounded-md bg-black/65 px-1.5 py-0.5 text-[11px] font-medium text-white opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100 group-has-focus-visible:opacity-100 pointer-coarse:opacity-100">
      {facts.join(" / ")}
    </span>
  );
}

/** One gallery tile: the template's still on a wide black card with its
 * facts on hover, and its name and description under it. A wide still fills
 * the card; another shape stands whole in it. Its page plays it. */
export function GalleryTile({
  template,
  panel,
  dragRef,
}: {
  template: GalleryTemplate;
  panel?: PanelNav;
  /** What the tile carries when dragged, e.g. into Home's prompt box. */
  dragRef?: AssetRef;
}) {
  const t = useTranslations("home.templates");
  const locale = useLocale();
  const name = localized(template.name, locale);

  // A skeleton holds the tile until its poster has drawn or failed. A poster
  // already in the cache is complete before React attaches onLoad, so the
  // ref reads that state on mount.
  const [settled, setSettled] = useState(false);
  const settle = () => setSettled(true);

  return (
    <Link
      href={templatePage(template.id)}
      scroll={false}
      onClick={
        panel ? (e) => inPanel(e, () => panel.open(template.id)) : undefined
      }
      onDragStart={dragRef ? (e) => setRefDragData(e, dragRef) : undefined}
      onDragEnd={dragRef ? clearRefDrag : undefined}
      className="group flex min-w-0 flex-col gap-3 outline-none"
    >
      <span className="relative block aspect-video overflow-hidden rounded-2xl border border-border bg-black transition-shadow group-hover:shadow-[0_6px_28px_rgba(0,0,0,0.12)] group-focus-visible:ring-3 group-focus-visible:ring-ring/50">
        {/* Lazy: the browser fetches posters as tiles scroll near the view. */}
        {/* eslint-disable-next-line @next/next/no-img-element -- a signed CDN still, not a Next asset */}
        <img
          ref={(el) => {
            if (el?.complete) {
              settle();
            }
          }}
          src={templatePoster(template)}
          alt=""
          loading="lazy"
          decoding="async"
          onLoad={settle}
          onError={settle}
          // A wide still fills the card edge to edge: the border leaves the
          // inside a hair off 16:9, so a contained still shows black slivers
          // at its sides.
          className={cn(
            "absolute inset-0 size-full",
            template.aspect === WIDE ? "object-cover" : "object-contain",
          )}
        />
        {!settled && <Skeleton className="absolute inset-0 rounded-none" />}
        <TemplateFacts
          facts={[
            t(`categories.${template.category}`),
            t(`aspects.${template.aspect}`),
            formatTime(template.seconds),
          ]}
        />
      </span>
      <TemplateCaption
        name={name}
        description={localized(template.description, locale)}
      />
    </Link>
  );
}
