"use client";

import Link from "next/link";
import type { MouseEvent } from "react";
import { useLocale, useTranslations } from "next-intl";
import { localized, templatePage, templatePoster, type GalleryTemplate } from "@/cut/lib/templateGallery";
import { formatTime } from "@/cut/lib/time";

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

/** One gallery tile: the template's still on a wide black tile, its name and
 * length over the picture. A wide still fills the tile; another shape stands
 * whole in it. Its page plays it. */
export function GalleryTile({ template, panel }: { template: GalleryTemplate; panel?: PanelNav }) {
  const t = useTranslations("home.templates");
  const locale = useLocale();
  const name = localized(template.name, locale);

  return (
    <Link
      href={templatePage(template.id)}
      scroll={false}
      onClick={panel ? (e) => inPanel(e, () => panel.open(template.id)) : undefined}
      aria-label={name}
      className="group relative block aspect-video overflow-hidden rounded-xl bg-black outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      {/* Lazy: the browser fetches posters as tiles scroll near the view. */}
      {/* eslint-disable-next-line @next/next/no-img-element -- a signed CDN still, not a Next asset */}
      <img src={templatePoster(template)} alt="" loading="lazy" decoding="async" className="absolute inset-0 size-full object-contain" />
      <span className="absolute bottom-2 left-2 max-w-[70%] truncate rounded-md bg-black/65 px-1.5 py-0.5 text-[11px] font-medium text-white opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100 pointer-coarse:opacity-100">
        {name} · {t(`aspects.${template.aspect}`)}
      </span>
      <span className="absolute right-2 bottom-2 rounded-md bg-black/65 px-1.5 py-0.5 font-mono text-[10px] text-white tabular-nums">
        {formatTime(template.seconds)}
      </span>
    </Link>
  );
}
