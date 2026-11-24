"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useEnvironment } from "@/cut/lib/environment";
import { cn } from "@/lib/utils";
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
import { homeHref, useCutBase } from "@/cut/lib/nav";
import {
  useOwnTemplates,
  useTemplateFavorites,
  useTemplateIndex,
  useTemplateSearch,
} from "@/cut/lib/queries";
import {
  favoritesFirst,
  filterTemplates,
  lengthOf,
  localized,
  pageWindow,
  TEMPLATE_ASPECTS,
  TEMPLATE_CATEGORIES,
  TEMPLATE_LENGTHS,
  TEMPLATE_STYLES,
  templatePage,
  type GalleryTemplate,
  type TemplateCandidate,
  type TemplateFilter,
  type TemplateMatch,
} from "@/cut/lib/templateGallery";
import { GalleryTile, type PanelNav } from "./GalleryTile";
import {
  DEFAULT_ASPECT,
  OwnTemplateCard,
  type OwnTemplate,
} from "./OwnTemplateCard";
import { TemplateDetail } from "./TemplateDetail";
import { TemplateSearch } from "./TemplateSearch";
import { TemplateSheet } from "./TemplateSheet";

// The gallery's filters, each a URL param so Back and reload keep the view.
// Source shows Donkey's templates by default, the ones the person starred,
// or the person's own.
const FILTER_KEYS = [
  "source",
  "category",
  "aspect",
  "length",
  "style",
] as const;
type FilterKey = (typeof FILTER_KEYS)[number];

const TEMPLATE_SOURCES = ["favorites", "mine"] as const;
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

type Card =
  | { kind: "own"; template: OwnTemplate }
  | { kind: "gallery"; template: GalleryTemplate };

// Cards per page, and the URL param that holds the page so Back and reload
// keep it.
const PAGE_SIZE = 24;
const PAGE_PARAM = "page";

// The URL param that holds the search, so Back and reload keep it too.
const QUERY_PARAM = "q";

// Placeholder tiles while the gallery's index loads: two rows of the widest
// grid.
const SKELETON_TILES = 6;

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

/** The person's own templates the filter keeps: only under My templates.
 * They carry no category or style, so filtering by either leaves them out. */
function filterOwn(all: OwnTemplate[], f: Filter): OwnTemplate[] {
  if (f.source !== "mine" || f.category || f.style) {
    return [];
  }
  return all.filter(
    ({ project: p }) =>
      (!f.aspect || (p.aspect ?? DEFAULT_ASPECT) === f.aspect) &&
      (!f.length || lengthOf(p.duration) === f.length),
  );
}

/** How one of the person's own templates reads to search. */
function ownCandidate({ project: p }: OwnTemplate): TemplateCandidate {
  return {
    id: p.id,
    label: `${p.name}; the person's own template; frame ${p.aspect ?? DEFAULT_ASPECT}; ${Math.round(p.duration)}s long`,
  };
}

/** The items a search kept, best fit first; every item when nothing is searched. */
function byFit<T>(
  items: T[],
  idOf: (item: T) => string,
  matches: TemplateMatch[] | null,
): T[] {
  if (!matches) {
    return items;
  }
  const fit = new Map(matches.map((m) => [m.id, m.fit]));
  return items
    .filter((i) => fit.has(idOf(i)))
    .sort((a, b) => fit.get(idOf(b))! - fit.get(idOf(a))!);
}

/** One grid of templates, Donkey's or the person's own, under one row of
 * filter chips. */
export function TemplateGallery() {
  const t = useTranslations("home.templates");
  const { chatgpt } = useEnvironment();
  const describeError = useDescribeError();
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const base = useCutBase();
  const mine = useOwnTemplates();
  const index = useTemplateIndex();
  const favorites = useTemplateFavorites();
  // The template the panel shows sits at its own page's URL, pushed over the
  // gallery's, so a reload or a shared link lands on that page. The grid
  // behind keeps reading the gallery's own query while the panel is open.
  const openId = templateAt(pathname);
  const [view, setView] = useState(params.toString());
  if (!openId && view !== params.toString()) {
    setView(params.toString());
  }
  const filter = filterFrom(new URLSearchParams(view));
  const query = new URLSearchParams(view).get(QUERY_PARAM)?.trim() ?? "";

  // A search reads the person's own templates too while they are the source.
  const ownCandidates = useMemo(
    () => (filter.source === "mine" ? mine.map(ownCandidate) : []),
    [filter.source, mine],
  );
  const search = useTemplateSearch(query, ownCandidates);
  const matches = query ? (search.data ?? []) : null;

  // Starred templates lead, the latest star first; a search ranks by fit.
  // Favorites keeps only the starred.
  const own = byFit(filterOwn(mine, filter), (o) => o.project.id, matches);
  const listed = favoritesFirst(
    filterTemplates(index.data?.templates ?? [], filter),
    (tpl) => tpl.id,
    favorites.ids,
  );
  const gallery = byFit(
    filter.source === "mine"
      ? []
      : filter.source === "favorites"
        ? listed.filter((tpl) => favorites.ids?.has(tpl.id))
        : listed,
    (tpl) => tpl.id,
    matches,
  );
  const loading =
    (filter.source !== "mine" && index.isPending) ||
    (filter.source === "favorites" && favorites.pending) ||
    (!!query && search.isPending);

  // One page of the grid: the source's templates.
  // A page past the end, after a filter narrows the list, shows the last one.
  const cards: Card[] = [
    ...own.map((o): Card => ({ kind: "own", template: o })),
    ...gallery.map((tpl): Card => ({ kind: "gallery", template: tpl })),
  ];
  const pages = Math.max(1, Math.ceil(cards.length / PAGE_SIZE));
  const page = Math.min(
    pageFrom(new URLSearchParams(view).get(PAGE_PARAM)),
    pages,
  );
  const shown = cards.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  // Open another page and start it at the top of the gallery.
  const gridRef = useRef<HTMLDivElement>(null);
  const goTo = (n: number) => {
    const next = new URLSearchParams(params.toString());
    if (n === 1) {
      next.delete(PAGE_PARAM);
    } else {
      next.set(PAGE_PARAM, String(n));
    }
    const qs = next.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    gridRef.current?.scrollTo({ top: 0 });
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

  // Swap the search in the URL; an empty one removes it. A new search starts
  // on the first page.
  const setQuery = useCallback(
    (value: string) => {
      const next = new URLSearchParams(window.location.search);
      next.delete(PAGE_PARAM);
      if (value) {
        next.set(QUERY_PARAM, value);
      } else {
        next.delete(QUERY_PARAM);
      }
      const qs = next.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [router, pathname],
  );

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

  const active = FILTER_KEYS.some((k) => filter[k]) || !!query;
  const searchError =
    query && search.isError
      ? describeError(search.error, t("searchFailed"))
      : null;

  const open = openId
    ? (index.data?.templates.find((tpl) => tpl.id === openId) ?? null)
    : null;

  // The panel slides out with the last template still in it.
  const [panelTemplate, setShown] = useState<GalleryTemplate | null>(open);
  if (open && open !== panelTemplate) {
    setShown(open);
  }

  // Whether the open template's history entry is ours to take back off the
  // stack. One reached by the forward button already had its own.
  const pushed = useRef(false);
  const galleryHref = view
    ? `${homeHref(base, "templates")}?${view}`
    : homeHref(base, "templates");
  const panel: PanelNav = {
    open: (id) => {
      // A similar template swaps in place, so closing still returns to the grid.
      if (openId) {
        window.history.replaceState(null, "", templatePage(id));
        return;
      }
      window.history.pushState(null, "", templatePage(id));
      pushed.current = true;
    },
    close: () => {
      if (pushed.current) {
        pushed.current = false;
        window.history.back();
        return;
      }
      window.history.pushState(null, "", galleryHref);
    },
  };

  // The back button closing the panel leaves nothing of ours on the stack.
  useEffect(() => {
    if (!openId) {
      pushed.current = false;
    }
  }, [openId]);

  // The whole gallery scrolls: the title goes up with the grid, the filter
  // row pins to the top over it, and the page bar floats over its foot.
  return (
    <div className="relative h-full">
      <div ref={gridRef} className="h-full overflow-y-auto">
        {/* In the ChatGPT card the Templates tab above is the title. */}
        <div className={cn("mx-auto w-full max-w-7xl px-4 sm:px-10", chatgpt ? "pt-3" : "pt-6")}>
          <h1 className={chatgpt ? "sr-only" : "text-lg font-semibold tracking-tight"}>{t("title")}</h1>
        </div>

        <div className="sticky top-0 z-10 bg-background">
          <div className="mx-auto flex w-full max-w-7xl flex-col gap-2 px-4 py-3 sm:px-10">
            {/* The search, then one row of filter chips it folds away while
                it is open; on a phone the row scrolls sideways. */}
            <TemplateSearch
              query={query}
              busy={!!query && search.isFetching}
              onSearch={setQuery}
            >
              {FILTER_KEYS.map((key) => (
                <Select
                  key={key}
                  value={filter[key] ?? ANY}
                  onValueChange={(v) => setFilter(key, String(v))}
                >
                  <SelectTrigger
                    className="h-8 shrink-0 rounded-full border-foreground/20 px-3 text-[13px] hover:bg-muted dark:border-foreground/25"
                    aria-label={t(`filters.${key}`)}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ANY} className="text-[13px]">
                      {key === "source"
                        ? t("sources.default")
                        : `${t(`filters.${key}`)}: ${t("all")}`}
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
                <Button
                  variant="ghost"
                  size="sm"
                  className="shrink-0 rounded-full"
                  onClick={() => router.replace(pathname)}
                >
                  {t("clearFilters")}
                </Button>
              )}
            </TemplateSearch>

            {searchError && (
              <p className="text-[13px] text-destructive">{searchError}</p>
            )}
          </div>
        </div>

        <div
          className={cn(
            "mx-auto w-full max-w-7xl px-4 sm:px-10",
            pages > 1 ? "pb-24" : "pb-6",
          )}
        >
          {loading && own.length === 0 ? (
            <div className="grid grid-cols-1 gap-x-6 gap-y-10 pt-1 sm:grid-cols-2 lg:grid-cols-3">
              {Array.from({ length: SKELETON_TILES }, (_, i) => (
                <Skeleton key={i} className="aspect-video rounded-2xl" />
              ))}
            </div>
          ) : cards.length === 0 ? (
            <p className="py-16 text-center text-sm text-muted-foreground">
              {query
                ? t("noMatches")
                : filter.source === "favorites" &&
                    FILTER_KEYS.every((k) => k === "source" || !filter[k])
                  ? t("noFavorites")
                  : t("empty")}
            </p>
          ) : (
            <div className="grid grid-cols-1 gap-x-6 gap-y-10 pt-1 sm:grid-cols-2 lg:grid-cols-3">
              {shown.map((card) =>
                card.kind === "own" ? (
                  <OwnTemplateCard
                    key={card.template.project.id}
                    template={card.template}
                    from="templates"
                  />
                ) : (
                  <GalleryTile
                    key={card.template.id}
                    template={card.template}
                    panel={panel}
                  />
                ),
              )}
            </div>
          )}
        </div>
      </div>

      {/* A pill floating over the grid's foot; the grid pads its end so the
          last row scrolls clear of it. */}
      {pages > 1 && (
        <div className="pointer-events-none absolute inset-x-0 bottom-4 flex justify-center px-4">
          <div className="pointer-events-auto rounded-full border border-border bg-popover/90 p-1 shadow-lg backdrop-blur-md">
            <GalleryPages page={page} pages={pages} onPage={goTo} />
          </div>
        </div>
      )}

      {panelTemplate && (
        <TemplatePanel
          template={panelTemplate}
          open={!!open}
          closeHref={galleryHref}
          panel={panel}
        />
      )}
    </div>
  );
}

// The current page: a grey fill in place of the outline, in both themes.
const CURRENT_PAGE =
  "border-transparent bg-foreground/10 font-semibold hover:bg-foreground/10 dark:border-transparent dark:bg-foreground/15 dark:hover:bg-foreground/15";

/** The page bar floating over the grid. */
function GalleryPages({
  page,
  pages,
  onPage,
}: {
  page: number;
  pages: number;
  onPage: (n: number) => void;
}) {
  return (
    <Pagination className="w-auto">
      <PaginationContent>
        <PaginationItem>
          <PaginationPrevious
            className="rounded-full"
            disabled={page === 1}
            onClick={() => onPage(page - 1)}
          />
        </PaginationItem>
        {pageWindow(page, pages).map((n, i) =>
          n === null ? (
            <PaginationItem key={`gap-${i}`}>
              <PaginationEllipsis />
            </PaginationItem>
          ) : (
            <PaginationItem key={n}>
              <PaginationLink
                className={cn("rounded-full", n === page && CURRENT_PAGE)}
                isActive={n === page}
                onClick={() => onPage(n)}
              >
                {n}
              </PaginationLink>
            </PaginationItem>
          ),
        )}
        <PaginationItem>
          <PaginationNext
            className="rounded-full"
            disabled={page === pages}
            onClick={() => onPage(page + 1)}
          />
        </PaginationItem>
      </PaginationContent>
    </Pagination>
  );
}

// The template id in a template page's path, e.g. "/templates/surf-session".
export function templateAt(pathname: string): string | null {
  const prefix = templatePage("");
  if (!pathname.startsWith(prefix) || pathname.length === prefix.length) {
    return null;
  }
  return decodeURIComponent(pathname.slice(prefix.length));
}

/** A template over the gallery: a panel that slides in from the right edge
 * and holds the template's player, timeline and details, the grid dimmed on
 * its left. */
export function TemplatePanel({
  template,
  open,
  closeHref,
  panel,
}: {
  template: GalleryTemplate;
  open: boolean;
  closeHref: string;
  panel: PanelNav;
}) {
  const locale = useLocale();
  return (
    <TemplateSheet
      open={open}
      title={localized(template.name, locale)}
      onClose={panel.close}
    >
      <TemplateDetail
        template={template}
        closeHref={closeHref}
        panel={panel}
      />
    </TemplateSheet>
  );
}
