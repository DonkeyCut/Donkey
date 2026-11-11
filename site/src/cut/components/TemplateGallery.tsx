"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { LayoutTemplate, Loader2, MoreHorizontal, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Pagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from "@/components/ui/pagination";
import { useDescribeError } from "@/i18n/describeError";
import { apiJson } from "@/cut/lib/api";
import { projectHref, useCutBase } from "@/cut/lib/nav";
import { newProjectAllowed } from "@/cut/lib/projectLimit";
import { forgetProject } from "@/cut/lib/projectPurge";
import {
  refetchProjects,
  useOwnTemplates,
  useTemplateIndex,
} from "@/cut/lib/queries";
import { backendFor, type Residency } from "@/cut/lib/residency";
import {
  filterTemplates,
  lengthOf,
  localized,
  pageWindow,
  TEMPLATE_ASPECTS,
  TEMPLATE_CATEGORIES,
  TEMPLATE_LENGTHS,
  TEMPLATE_STYLES,
  templatePage,
  templatePoster,
  type GalleryTemplate,
  type TemplateFilter,
} from "@/cut/lib/templateGallery";
import { copyAsKind } from "@/cut/lib/templateUse";
import { formatTime } from "@/cut/lib/time";
import { parseRatio, type ProjectSummary } from "@/cut/lib/types";
import { errorFromBody } from "@/cut/lib/userError";
import { track } from "@/lib/analytics";
import { CardPreview } from "./ProjectsHome";
import { DeleteConfirm } from "./selectionMenu";

// The gallery's filters, each a URL param so Back and reload keep the view.
// Source picks the person's own templates or Donkey's.
const FILTER_KEYS = ["source", "category", "aspect", "length", "style"] as const;
type FilterKey = (typeof FILTER_KEYS)[number];

const TEMPLATE_SOURCES = ["mine", "donkey"] as const;
type TemplateSource = (typeof TEMPLATE_SOURCES)[number];
type Filter = TemplateFilter & { source?: TemplateSource };

// The "no filter" item's value; Select needs a value for every item.
const ANY = "any";

const OPTIONS: Record<FilterKey, readonly string[]> = {
  source: TEMPLATE_SOURCES,
  category: TEMPLATE_CATEGORIES,
  aspect: TEMPLATE_ASPECTS,
  length: TEMPLATE_LENGTHS,
  style: TEMPLATE_STYLES,
};

// Every card takes the same area, so a wide template spreads and a tall one
// stands with equal weight, as the projects home lays out its tiles.
const CARD_AREA = 200 * 356;
// Projects without an aspect are 9:16.
const DEFAULT_FRAME = { w: 9, h: 16 };
const DEFAULT_ASPECT = "9:16";

type OwnTemplate = { project: ProjectSummary; residency: Residency };
type Card = { kind: "own"; template: OwnTemplate } | { kind: "gallery"; template: GalleryTemplate };

// Cards per page, and the URL param that holds the page so Back and reload
// keep it.
const PAGE_SIZE = 24;
const PAGE_PARAM = "page";

/** The page a URL asks for; anything unreadable is the first. */
function pageFrom(raw: string | null): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 1 ? n : 1;
}


/** The filter a URL asks for, ignoring values the gallery doesn't know. */
function filterFrom(params: URLSearchParams): Filter {
  const pick = <K extends FilterKey>(key: K) => {
    const v = params.get(key);
    return v && OPTIONS[key].includes(v) ? (v as Filter[K]) : undefined;
  };
  return {
    source: pick("source"),
    category: pick("category"),
    aspect: pick("aspect"),
    length: pick("length"),
    style: pick("style"),
  };
}

/** The person's own templates the filter keeps. They carry no category or
 * style, so filtering by either leaves them out. */
function filterOwn(all: OwnTemplate[], f: Filter): OwnTemplate[] {
  if (f.source === "donkey" || f.category || f.style) {
    return [];
  }
  return all.filter(
    ({ project: p }) =>
      (!f.aspect || (p.aspect ?? DEFAULT_ASPECT) === f.aspect) &&
      (!f.length || lengthOf(p.duration) === f.length)
  );
}

/** A card's width for its frame shape at a fixed area. */
function cardWidth(frame: { w: number; h: number }, area: number): number {
  return Math.round(Math.sqrt((area * frame.w) / frame.h));
}

/** One grid of templates, the person's own first, under one row of filter
 * chips. */
export function TemplateGallery() {
  const t = useTranslations("home.templates");
  const tp = useTranslations("home.projects");
  const tk = useTranslations("home.pick");
  const describeError = useDescribeError();
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const base = useCutBase();
  const client = useQueryClient();
  const mine = useOwnTemplates();
  const index = useTemplateIndex();
  const [busy, setBusy] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<OwnTemplate | null>(null);
  const [error, setError] = useState<string | null>(null);
  const filter = filterFrom(new URLSearchParams(params.toString()));
  const own = filterOwn(mine, filter);
  const gallery = filter.source === "mine" ? [] : filterTemplates(index.data?.templates ?? [], filter);
  const loading = filter.source !== "mine" && index.isPending;

  // One page of the grid: the person's own templates first, then Donkey's.
  // A page past the end, after a filter narrows the list, shows the last one.
  const cards: Card[] = [
    ...own.map((o): Card => ({ kind: "own", template: o })),
    ...gallery.map((tpl): Card => ({ kind: "gallery", template: tpl })),
  ];
  const pages = Math.max(1, Math.ceil(cards.length / PAGE_SIZE));
  const page = Math.min(pageFrom(params.get(PAGE_PARAM)), pages);
  const shown = cards.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  // Open another page and start it at the top.
  const goTo = (n: number) => {
    const next = new URLSearchParams(params.toString());
    if (n === 1) {
      next.delete(PAGE_PARAM);
    } else {
      next.set(PAGE_PARAM, String(n));
    }
    const qs = next.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname);
  };

  // Swap one filter in the URL; "any" removes it. A new filter starts on
  // the first page.
  const setFilter = (key: FilterKey, value: string) => {
    const next = new URLSearchParams(params.toString());
    next.delete(PAGE_PARAM);
    if (value === ANY) {
      next.delete(key);
    } else {
      next.set(key, value);
    }
    const qs = next.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  };

  const label = (key: FilterKey, value: string): string => {
    if (key === "source") {
      return t(`sources.${value as TemplateSource}`);
    }
    if (key === "category") {
      return t(`categories.${value as GalleryTemplate["category"]}`);
    }
    if (key === "aspect") {
      return t(`aspects.${value as GalleryTemplate["aspect"]}`);
    }
    if (key === "length") {
      return t(`lengths.${value as (typeof TEMPLATE_LENGTHS)[number]}`);
    }
    return t(`styles.${value as GalleryTemplate["style"]}`);
  };

  // A copy of the template on its own shelf, marked a project, opened.
  const startFrom = async ({ project: p, residency: r }: OwnTemplate) => {
    setError(null);
    if (!(await newProjectAllowed(client))) {
      return;
    }
    setBusy(p.id);
    try {
      const id = await copyAsKind(r, p.id, "project", p.name);
      void refetchProjects(client, r);
      track("project_created", { source: "template" });
      router.push(projectHref(base, id, "projects"));
    } catch (e) {
      setError(describeError(e, t("detail.failed")));
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    if (!deleting) {
      return;
    }
    const { project, residency } = deleting;
    setBusy(project.id);
    try {
      const res = await backendFor(residency).fetch(`/api/cut/projects/${project.id}`, { method: "DELETE" });
      if (!res.ok) {
        throw errorFromBody(await apiJson<object>(res), tp("deleteProjectFailed"));
      }
      forgetProject(project.id, residency);
      void refetchProjects(client, residency);
      setDeleting(null);
    } catch (e) {
      setError(describeError(e, tp("deleteProjectFailed")));
    } finally {
      setBusy(null);
    }
  };

  const active = FILTER_KEYS.some((k) => filter[k]);

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-5 px-4 py-9 sm:px-10">
      <h1 className="text-lg font-semibold tracking-tight">{t("title")}</h1>

      {/* One row of filter chips; on a phone the row scrolls sideways. */}
      <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pt-1 pb-1 sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0">
        {FILTER_KEYS.map((key) => (
          <Select key={key} value={filter[key] ?? ANY} onValueChange={(v) => setFilter(key, String(v))}>
            <SelectTrigger className="h-8 shrink-0 rounded-full px-3 text-[13px]" aria-label={t(`filters.${key}`)}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ANY} className="text-[13px]">
                {key === "source" ? t("sources.all") : `${t(`filters.${key}`)}: ${t("all")}`}
              </SelectItem>
              {OPTIONS[key].map((v) => (
                <SelectItem key={v} value={v} className="text-[13px]">
                  {label(key, v)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ))}
        {active && (
          <Button variant="ghost" size="sm" className="shrink-0 rounded-full" onClick={() => router.replace(pathname)}>
            {t("clearFilters")}
          </Button>
        )}
      </div>

      {error && <p className="text-[13px] text-destructive">{error}</p>}

      {loading && own.length === 0 ? (
        <Loader2 className="mx-auto my-16 size-5 animate-spin text-muted-foreground" />
      ) : cards.length === 0 ? (
        <p className="py-16 text-center text-sm text-muted-foreground">{t("empty")}</p>
      ) : (
        <div className="flex flex-wrap items-start gap-5 pt-1">
          {shown.map((card) =>
            card.kind === "own" ? (
              <OwnTemplateCard
                key={card.template.project.id}
                template={card.template}
                busy={busy}
                onUse={() => void startFrom(card.template)}
                onDelete={() => setDeleting(card.template)}
              />
            ) : (
              <TemplateCard key={card.template.id} template={card.template} />
            )
          )}
        </div>
      )}

      {pages > 1 && <GalleryPages page={page} pages={pages} onPage={goTo} />}

      <DeleteConfirm
        open={!!deleting}
        title={deleting ? tp("deleteTitle", { what: tk("named", { name: deleting.project.name }) }) : ""}
        description={`${tp("deletesFolders", { count: 1 })} ${tp("cannotUndo")}`}
        action={tp("deleteProjects", { count: 1 })}
        busy={busy !== null}
        onClose={() => setDeleting(null)}
        onConfirm={() => void remove()}
      />
    </div>
  );
}

/** The page bar under the grid. */
function GalleryPages({ page, pages, onPage }: { page: number; pages: number; onPage: (n: number) => void }) {
  return (
    <Pagination className="pt-4">
      <PaginationContent>
        <PaginationItem>
          <PaginationPrevious disabled={page === 1} onClick={() => onPage(page - 1)} />
        </PaginationItem>
        {pageWindow(page, pages).map((n, i) =>
          n === null ? (
            <PaginationItem key={`gap-${i}`}>
              <PaginationEllipsis />
            </PaginationItem>
          ) : (
            <PaginationItem key={n}>
              <PaginationLink isActive={n === page} onClick={() => onPage(n)}>
                {n}
              </PaginationLink>
            </PaginationItem>
          )
        )}
        <PaginationItem>
          <PaginationNext disabled={page === pages} onClick={() => onPage(page + 1)} />
        </PaginationItem>
      </PaginationContent>
    </Pagination>
  );
}

/** One of the person's own templates: a project of theirs marked as one. It
 * opens in the editor like any project; its menu makes a new project from it. */
function OwnTemplateCard({
  template: { project: p, residency: r },
  busy,
  onUse,
  onDelete,
}: {
  template: OwnTemplate;
  busy: string | null;
  onUse: () => void;
  onDelete: () => void;
}) {
  const t = useTranslations("home.templates");
  const tp = useTranslations("home.projects");
  const base = useCutBase();
  const frame = parseRatio(p.aspect) ?? DEFAULT_FRAME;

  return (
    <div className="group relative max-w-full" style={{ width: cardWidth(frame, CARD_AREA) }}>
      <Link href={projectHref(base, p.id, "templates")} className="block outline-none">
        <div
          className="relative grid place-items-center overflow-hidden rounded-2xl border border-border bg-muted transition-shadow group-hover:shadow-[0_6px_28px_rgba(0,0,0,0.12)] group-has-focus-visible:ring-3 group-has-focus-visible:ring-ring/50"
          style={{ aspectRatio: `${frame.w} / ${frame.h}` }}
        >
          <CardPreview project={p} residency={r} />
          {busy === p.id && (
            <span className="absolute inset-0 grid place-items-center bg-black/40">
              <Loader2 className="size-5 animate-spin text-white" />
            </span>
          )}
          <span className="absolute right-2 bottom-2 rounded-md bg-black/65 px-1.5 py-0.5 font-mono text-[10px] text-white tabular-nums">
            {formatTime(p.duration)}
          </span>
        </div>
        <div className="mt-2 truncate px-0.5 text-[13px] font-medium">{p.name}</div>
        <div className="px-0.5 text-xs text-muted-foreground">{t("sources.mine")}</div>
      </Link>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={tp("actions")}
              disabled={busy !== null}
              className="absolute top-2 right-2 bg-black/40 text-white opacity-0 group-hover:opacity-100 hover:bg-black/60 hover:text-white focus-visible:opacity-100 data-popup-open:opacity-100"
            />
          }
        >
          <MoreHorizontal />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={onUse}>
            <LayoutTemplate /> {t("detail.use")}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onClick={onDelete}>
            <Trash2 /> {tp("delete")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

/** One gallery card: the template's still. Its page plays it. */
export function TemplateCard({
  template,
  area = CARD_AREA,
}: {
  template: GalleryTemplate;
  area?: number;
}) {
  const t = useTranslations("home.templates");
  const locale = useLocale();
  const [w, h] = template.aspect.split(":").map(Number);

  return (
    <Link
      href={templatePage(template.id)}
      className="group max-w-full outline-none"
      style={{ width: cardWidth({ w, h }, area) }}
    >
      <div
        className="relative overflow-hidden rounded-2xl border border-border bg-muted transition-shadow group-hover:shadow-[0_6px_28px_rgba(0,0,0,0.12)] group-focus-visible:ring-3 group-focus-visible:ring-ring/50"
        style={{ aspectRatio: `${w} / ${h}` }}
      >
        {/* Lazy: the browser fetches posters as cards scroll near the view. */}
        {/* eslint-disable-next-line @next/next/no-img-element -- a signed CDN still, not a Next asset */}
        <img
          src={templatePoster(template)}
          alt=""
          loading="lazy"
          decoding="async"
          className="absolute inset-0 size-full object-cover"
        />
        <span className="absolute right-2 bottom-2 rounded-md bg-black/65 px-1.5 py-0.5 font-mono text-[10px] text-white tabular-nums">
          {formatTime(template.seconds)}
        </span>
      </div>
      <div className="mt-2 truncate px-0.5 text-[13px] font-medium">
        {localized(template.name, locale)}
      </div>
      <div className="px-0.5 text-xs text-muted-foreground">
        {t(`categories.${template.category}`)} ·{" "}
        {t(`aspects.${template.aspect}`)}
      </div>
    </Link>
  );
}
