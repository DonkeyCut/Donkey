"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
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
import { homeHref, projectHref, useCutBase } from "@/cut/lib/nav";
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
  type GalleryTemplate,
  type TemplateFilter,
} from "@/cut/lib/templateGallery";
import { copyAsKind } from "@/cut/lib/templateUse";
import { formatTime } from "@/cut/lib/time";
import type { ProjectSummary } from "@/cut/lib/types";
import { errorFromBody } from "@/cut/lib/userError";
import { track } from "@/lib/analytics";
import { CardPreview } from "./ProjectsHome";
import { DeleteConfirm } from "./selectionMenu";
import { GalleryTile, type PanelNav } from "./GalleryTile";
import { TemplateDetail } from "./TemplateDetail";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { Dialog, DialogPortal } from "@/components/ui/dialog";

// The gallery's filters, each a URL param so Back and reload keep the view.
// Source shows Donkey's templates by default, or the person's own.
const FILTER_KEYS = ["source", "category", "aspect", "length", "style"] as const;
type FilterKey = (typeof FILTER_KEYS)[number];

const TEMPLATE_SOURCES = ["mine"] as const;
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

// Projects without an aspect are 9:16.
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

/** The person's own templates the filter keeps: only under My templates.
 * They carry no category or style, so filtering by either leaves them out. */
function filterOwn(all: OwnTemplate[], f: Filter): OwnTemplate[] {
  if (f.source !== "mine" || f.category || f.style) {
    return [];
  }
  return all.filter(
    ({ project: p }) =>
      (!f.aspect || (p.aspect ?? DEFAULT_ASPECT) === f.aspect) &&
      (!f.length || lengthOf(p.duration) === f.length)
  );
}

/** One grid of templates, Donkey's or the person's own, under one row of
 * filter chips. */
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
  // The template the panel shows sits at its own page's URL, pushed over the
  // gallery's, so a reload or a shared link lands on that page. The grid
  // behind keeps reading the gallery's own query while the panel is open.
  const openId = templateAt(pathname);
  const [view, setView] = useState(params.toString());
  if (!openId && view !== params.toString()) {
    setView(params.toString());
  }
  const filter = filterFrom(new URLSearchParams(view));
  const own = filterOwn(mine, filter);
  const gallery = filter.source === "mine" ? [] : filterTemplates(index.data?.templates ?? [], filter);
  const loading = filter.source !== "mine" && index.isPending;

  // One page of the grid: the source's templates.
  // A page past the end, after a filter narrows the list, shows the last one.
  const cards: Card[] = [
    ...own.map((o): Card => ({ kind: "own", template: o })),
    ...gallery.map((tpl): Card => ({ kind: "gallery", template: tpl })),
  ];
  const pages = Math.max(1, Math.ceil(cards.length / PAGE_SIZE));
  const page = Math.min(pageFrom(new URLSearchParams(view).get(PAGE_PARAM)), pages);
  const shown = cards.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  // Open another page and start it at the top of the grid, the one part of
  // the page that scrolls.
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

  const open = openId ? (index.data?.templates.find((tpl) => tpl.id === openId) ?? null) : null;

  // The panel slides out with the last template still in it.
  const [panelTemplate, setShown] = useState<GalleryTemplate | null>(open);
  if (open && open !== panelTemplate) {
    setShown(open);
  }

  // Whether the open template's history entry is ours to take back off the
  // stack. One reached by the forward button already had its own.
  const pushed = useRef(false);
  const galleryHref = view ? `${homeHref(base, "templates")}?${view}` : homeHref(base, "templates");
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

  // The title and filters stay above the grid and the page bar below it;
  // only the grid scrolls between them.
  return (
    <div className="flex h-full flex-col">
      <div className="mx-auto flex w-full max-w-7xl shrink-0 flex-col gap-5 px-4 pt-9 pb-4 sm:px-10">
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
                  {key === "source" ? t("sources.default") : `${t(`filters.${key}`)}: ${t("all")}`}
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
        </div>

        {error && <p className="text-[13px] text-destructive">{error}</p>}
      </div>

      <div ref={gridRef} className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-7xl px-4 pb-6 sm:px-10">
          {loading && own.length === 0 ? (
            <Loader2 className="mx-auto my-16 size-5 animate-spin text-muted-foreground" />
          ) : cards.length === 0 ? (
            <p className="py-16 text-center text-sm text-muted-foreground">{t("empty")}</p>
          ) : (
            <div className="grid grid-cols-1 gap-3 pt-1 sm:grid-cols-2 lg:grid-cols-3">
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
                  <GalleryTile key={card.template.id} template={card.template} panel={panel} />
                )
              )}
            </div>
          )}
        </div>
      </div>

      {pages > 1 && (
        <div className="shrink-0 border-t border-border py-3">
          <GalleryPages page={page} pages={pages} onPage={goTo} />
        </div>
      )}

      {panelTemplate && <TemplatePanel template={panelTemplate} open={!!open} closeHref={galleryHref} panel={panel} />}

      <DeleteConfirm
        open={!!deleting}
        title={
          deleting
            ? tp("deleteTitle", {
                what: tk("named", { name: deleting.project.name }),
              })
            : ""
        }
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
    <Pagination>
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
  return (
    <div className="group relative">
      <Link href={projectHref(base, p.id, "templates")} aria-label={p.name} className="block outline-none">
        <div className="relative grid aspect-video place-items-center overflow-hidden rounded-xl bg-black group-has-focus-visible:ring-3 group-has-focus-visible:ring-ring/50">
          {/* The project's own frame shape, whole in the tile, as gallery
              tiles stand their stills. */}
          <div
            className="relative h-full max-w-full"
            style={{
              aspectRatio: (p.aspect ?? DEFAULT_ASPECT).replace(":", " / "),
            }}
          >
            <CardPreview project={p} residency={r} />
          </div>
          {busy === p.id && (
            <span className="absolute inset-0 grid place-items-center bg-black/40">
              <Loader2 className="size-5 animate-spin text-white" />
            </span>
          )}
          <span className="absolute bottom-2 left-2 max-w-[70%] truncate rounded-md bg-black/65 px-1.5 py-0.5 text-[11px] font-medium text-white opacity-0 transition-opacity group-hover:opacity-100 group-has-focus-visible:opacity-100 pointer-coarse:opacity-100">
            {p.name} · {t("sources.mine")}
          </span>
          <span className="absolute right-2 bottom-2 rounded-md bg-black/65 px-1.5 py-0.5 font-mono text-[10px] text-white tabular-nums">
            {formatTime(p.duration)}
          </span>
        </div>
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

// The template id in a template page's path, e.g. "/templates/surf-session".
function templateAt(pathname: string): string | null {
  const prefix = templatePage("");
  if (!pathname.startsWith(prefix) || pathname.length === prefix.length) {
    return null;
  }
  return decodeURIComponent(pathname.slice(prefix.length));
}

/** A template over the gallery: a panel that slides in from the right edge
 * and holds the template's player, timeline and details, the grid dimmed on
 * its left. */
function TemplatePanel({
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
    <Dialog open={open} onOpenChange={(next) => !next && panel.close()}>
      <DialogPortal>
        <DialogPrimitive.Backdrop className="fixed inset-0 z-50 bg-black/60 transition-opacity duration-300 ease-out supports-backdrop-filter:backdrop-blur-xs data-ending-style:opacity-0 data-starting-style:opacity-0" />
        <DialogPrimitive.Popup className="app-surface fixed inset-y-0 right-0 z-50 w-full max-w-[1600px] overflow-hidden border-border bg-background text-foreground shadow-2xl outline-none transition-transform duration-300 ease-out data-ending-style:translate-x-full data-starting-style:translate-x-full md:w-[calc(100vw-3rem)] md:rounded-l-2xl md:border-l">
          <DialogPrimitive.Title className="sr-only">{localized(template.name, locale)}</DialogPrimitive.Title>
          <TemplateDetail template={template} closeHref={closeHref} panel={panel} />
        </DialogPrimitive.Popup>
      </DialogPortal>
    </Dialog>
  );
}
