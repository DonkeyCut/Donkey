"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import {
  Carousel,
  CarouselContent,
  CarouselItem,
  CarouselNext,
  CarouselPrevious,
  type CarouselApi,
} from "@/components/ui/carousel";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Skeleton } from "@/components/ui/skeleton";
import {
  ProjectMenu,
  ProjectMenuItems,
  ProjectTile,
} from "@/cut/components/assets/ProjectCard";
import {
  useProjectActions,
  type ShelvedProject,
} from "@/cut/components/assets/projectActions";
import {
  DeleteConfirm,
  SelectionMenu,
  usePickWords,
  useSelectionMenu,
} from "@/cut/components/selectionMenu";
import { framedHref } from "@/cut/lib/hostBridge";
import { newTabClick } from "@/cut/lib/hostKeys";
import { assetsHref, projectHref, useCutBase } from "@/cut/lib/nav";
import { formatDate } from "@/cut/lib/time";
import { formatBytes } from "@/lib/bytes";
import { cn } from "@/lib/utils";
import { projectTileSize, TILE_LONG_SIDE } from "./projectTile";
import type { HomeProject } from "./useHomeProjects";

// MouseEvent.button for the middle (wheel) button.
const MIDDLE_BUTTON = 1;

// How many recent projects the row holds; the rest are a click away in Assets.
const RECENT_PROJECTS = 24;

// Placeholder cards while the first listing loads.
const SKELETON_CARDS = 5;

/**
 * The newest projects in a carousel: arrows by the heading step a page of
 * cards, and a dot per page sits under the row. Each card keeps its
 * project's shape with the same long side, so a wide card sits centred
 * against the tall ones around it.
 */
export function HomeProjects({
  projects,
  loading,
  live,
  dual,
}: {
  projects: HomeProject[];
  loading: boolean;
  live: (r: HomeProject["residency"]) => boolean;
  dual: boolean;
}) {
  const t = useTranslations("home");
  const locale = useLocale();
  const router = useRouter();
  const base = useCutBase();
  const [api, setApi] = useState<CarouselApi>();
  const { pages, page } = useCarouselPages(api);
  const { pickLabel } = usePickWords();

  // A card carries the same ⋯ menu and right-click it carries in Assets.
  // Right-click marks the card while its menu is open.
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<ShelvedProject | null>(null);
  const [marked, setMarked] = useState<Set<string>>(new Set());
  const actions = useProjectActions({ live, busy, setBusy, setFailure });
  const shown = projects.slice(0, RECENT_PROJECTS);
  const ctx = useSelectionMenu({
    picked: marked,
    setPicked: setMarked,
    shown: shown.map((x) => x.project.id),
  });
  const ctxProject = ctx.menu
    ? shown.find((x) => x.project.id === ctx.menu?.ids[0] && live(x.residency))
    : undefined;
  const menuOf = (x: ShelvedProject) => ({
    ...actions.menuFor(x),
    onDelete: () => setDeleting(x),
  });
  const closeCtx = () => {
    ctx.close();
    setMarked(new Set());
  };

  if (!loading && projects.length === 0) {
    return null;
  }

  // A click opens the project here; ⌘-click or a middle click opens a tab.
  const open = (e: React.MouseEvent, id: string) => {
    const href = framedHref(projectHref(base, id, "home"));
    if (e.button === MIDDLE_BUTTON || newTabClick(e)) {
      e.preventDefault();
      window.open(href, "_blank", "noopener");
      return;
    }
    if (e.button !== 0) {
      return;
    }
    router.push(href);
  };

  return (
    <Carousel
      setApi={setApi}
      opts={{
        align: "start",
        containScroll: "trimSnaps",
        slidesToScroll: "auto",
      }}
      aria-label={t("start.projects")}
    >
      <section className="flex flex-col gap-4">
        <div className="flex items-center justify-between gap-4">
          <h2 className="text-base font-semibold">{t("start.projects")}</h2>
          <div className="flex items-center gap-3">
            <Link
              href={assetsHref(base, "projects")}
              className="text-[13px] text-muted-foreground transition-colors hover:text-foreground"
            >
              {t("start.viewAllProjects")}
            </Link>
            {pages > 1 && (
              <div className="flex items-center gap-1.5">
                <CarouselPrevious
                  className="static"
                  aria-label={t("start.previousProjects")}
                />
                <CarouselNext
                  className="static"
                  aria-label={t("start.nextProjects")}
                />
              </div>
            )}
          </div>
        </div>

        {/* The bleed keeps hover shadows and focus rings inside the clipped
            viewport: 8px each side, 12px above and below. items-center sets
            wide cards midway down the tall ones. */}
        <div className="-mx-2" onContextMenu={(e) => void ctx.onContextMenu(e)}>
          <CarouselContent className="-ml-6 items-center py-3">
            {loading && projects.length === 0
              ? Array.from({ length: SKELETON_CARDS }, (_, i) => (
                  <CarouselItem key={i} className="basis-auto pl-8 last:pr-2">
                    <Skeleton
                      className="rounded-2xl"
                      style={{
                        width: projectTileSize("9:16").width,
                        height: TILE_LONG_SIDE,
                      }}
                    />
                  </CarouselItem>
                ))
              : shown.map((x) => {
                  const { project: p, residency: r } = x;
                  return (
                    <CarouselItem
                      key={p.id}
                      className="basis-auto pl-8 last:pr-2"
                    >
                      <ProjectTile
                        project={p}
                        residency={r}
                        offline={!live(r)}
                        badge={dual ? "residency" : "none"}
                        selected={marked.has(p.id)}
                        box={projectTileSize(p.aspect)}
                        meta={t("projects.cardMeta", {
                          size: formatBytes(p.sizeBytes ?? 0, locale),
                          date: formatDate(p.updatedAt, locale, t("justNow")),
                        })}
                        onClick={(e) => open(e, p.id)}
                        onAuxClick={(e) => open(e, p.id)}
                        menu={
                          live(r) && (
                            <ProjectMenu
                              className="absolute top-1.5 right-1.5 opacity-0 group-hover:opacity-100 pointer-coarse:opacity-100 data-[state=open]:opacity-100"
                              {...menuOf(x)}
                            />
                          )
                        }
                      />
                    </CarouselItem>
                  );
                })}
          </CarouselContent>
        </div>

        {pages > 1 && (
          <div className="-mt-1 flex justify-center gap-1.5">
            {Array.from({ length: pages }, (_, i) => (
              <button
                key={i}
                type="button"
                aria-label={t("start.projectsPage", { page: i + 1 })}
                aria-current={i === page ? "true" : undefined}
                onClick={() => api?.scrollTo(i)}
                className={cn(
                  "h-2 rounded-full transition-all outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
                  i === page
                    ? "w-5 bg-foreground"
                    : "w-2 bg-foreground/25 hover:bg-foreground/50",
                )}
              />
            ))}
          </div>
        )}
      </section>

      <SelectionMenu menu={ctxProject ? ctx.menu : null} onClose={closeCtx}>
        {ctxProject && <ProjectMenuItems {...menuOf(ctxProject)} />}
      </SelectionMenu>

      {actions.dialogs}

      {/* A failed action says so over the page, where the row stays clear. */}
      <AlertDialog
        open={failure !== null}
        onOpenChange={(o) => !o && setFailure(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{failure}</AlertDialogTitle>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogAction onClick={() => setFailure(null)}>
              {t("projects.failureOk")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <DeleteConfirm
        open={!!deleting}
        title={
          deleting
            ? t("library.deleteTitle", {
                what: pickLabel([], [deleting.project], "project", 0),
              })
            : ""
        }
        description={`${t("projects.deletesFolders", { count: 1 })} ${t("projects.cannotUndo")}`}
        action={t("library.delete")}
        busy={busy}
        onClose={() => setDeleting(null)}
        onConfirm={() => {
          const x = deleting;
          setDeleting(null);
          if (x) {
            void actions.remove(x);
          }
        }}
      />
    </Carousel>
  );
}

/**
 * The carousel's pages and the one in view: a page is the run of cards one
 * arrow click moves past, so the dots match the arrows. Both are re-read when
 * the cards change, e.g. as the first listing lands.
 */
function useCarouselPages(api: CarouselApi) {
  const [pages, setPages] = useState(0);
  const [page, setPage] = useState(0);

  useEffect(() => {
    if (!api) {
      return;
    }
    const read = () => {
      setPages(api.scrollSnapList().length);
      setPage(api.selectedScrollSnap());
    };
    read();
    api.on("reInit", read);
    api.on("select", read);
    return () => {
      api.off("reInit", read);
      api.off("select", read);
    };
  }, [api]);

  return { pages, page };
}
