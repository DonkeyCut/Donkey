"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { PanelNav } from "@/cut/components/GalleryTile";
import { TemplatePanel, templateAt } from "@/cut/components/TemplateGallery";
import { useTabTitle } from "@/cut/hooks/useTabTitle";
import { useEnvironment } from "@/cut/lib/environment";
import { homeHref, useCutBase } from "@/cut/lib/nav";
import { useTemplateIndex } from "@/cut/lib/queries";
import { templatePage, type GalleryTemplate } from "@/cut/lib/templateGallery";
import { HomeProjects } from "./HomeProjects";
import { HomePrompt } from "./HomePrompt";
import { HomeTemplates } from "./HomeTemplates";
import { StorageSwitcher } from "./StorageSwitcher";
import { useHomeCreate, useHomeResidency } from "./useHomeCreate";
import { useHomeProjects } from "./useHomeProjects";
import { useHomeUploads } from "./useHomeUploads";

// The drag type a browser gives files carried in from the desktop.
const FILES_TYPE = "Files";

/**
 * Home: one prompt box that starts a project, a Blank project pill under it,
 * the newest projects in a row, and a taste of the template gallery. Files
 * dropped anywhere on the page go into the prompt.
 */
export function HomeView() {
  const t = useTranslations("home");
  const { chatgpt } = useEnvironment();
  const picked = useHomeResidency();
  const { projects, loading, live, dual } = useHomeProjects();

  // Inside ChatGPT, projects and files go to the cloud, where ChatGPT's tools
  // can see them.
  const residency = chatgpt ? "cloud" : picked;
  const create = useHomeCreate(residency);
  const uploads = useHomeUploads(residency);
  const page = useRef<HTMLElement>(null);
  const dragging = usePageFileDrop(page, uploads.add);
  const panel = useTemplatePanel();

  useTabTitle(t("tabs.home"));

  return (
    <main
      ref={page}
      className="relative min-h-full bg-[#fcfcfc] px-6 pt-[72px] pb-20 sm:px-10 dark:bg-background"
    >
      {/* The ChatGPT card keeps its projects in the cloud; there is no choice. */}
      {!chatgpt && <StorageSwitcher className="absolute top-5 right-6 z-10" />}

      <div className="mx-auto flex max-w-[1080px] flex-col gap-14">
        <section className="flex flex-col items-center gap-5">
          <h1 className="text-center text-[32px] leading-10 font-normal tracking-[-0.02em]">
            {t("start.heading")}
          </h1>
          <HomePrompt uploads={uploads} create={create} projects={projects} />
          <div className="flex w-full max-w-[760px]">
            <Button
              type="button"
              variant="default"
              className="h-9 rounded-full px-4"
              disabled={create.busy}
              onClick={() => void create.start("home_blank", null, null)}
            >
              {t("start.blankProject")}
            </Button>
          </div>
        </section>

        <HomeProjects
          projects={projects}
          loading={loading}
          live={live}
          dual={dual}
        />
        <HomeTemplates panel={panel.nav} />
      </div>

      {panel.template && (
        <TemplatePanel
          template={panel.template}
          open={panel.open}
          closeHref={homeHref(panel.base, "home")}
          panel={panel.nav}
        />
      )}

      {dragging && <DropOverlay />}
    </main>
  );
}

/** The whole page as the drop target while files are carried over it. */
function DropOverlay() {
  const t = useTranslations("home.start");
  return (
    <div className="pointer-events-none fixed inset-0 z-50 flex bg-background/90 p-4 backdrop-blur-sm">
      <div className="flex flex-1 flex-col items-center justify-center gap-3.5 p-10 text-center">
        <span
          aria-hidden
          className="grid size-16 place-items-center rounded-full bg-foreground text-background"
        >
          <Upload className="size-7" />
        </span>
        <h2 className="text-2xl leading-8 font-semibold tracking-[-0.01em]">
          {t("dropTitle")}
        </h2>
        <p className="max-w-sm text-sm text-muted-foreground">
          {t("dropText")}
        </p>
      </div>
    </div>
  );
}

/**
 * Files dragged in from outside the page: whether they are over it now, and
 * what to do with them when they land. Drags from inside the page (a tile, a
 * chip) carry no files and pass by. Home stays mounted, hidden, behind the
 * editor and Assets, and a drop there is theirs: only a shown Home takes one.
 */
function usePageFileDrop(
  page: React.RefObject<HTMLElement | null>,
  onFiles: (files: File[]) => void,
) {
  const [over, setOver] = useState(false);
  const take = useRef(onFiles);
  useEffect(() => {
    take.current = onFiles;
  });

  useEffect(() => {
    // Enter and leave fire for every element crossed; a count of the ones
    // entered tells when the drag has left the window itself.
    let depth = 0;
    const carriesFiles = (e: DragEvent) =>
      !!page.current?.checkVisibility() &&
      !!e.dataTransfer &&
      Array.from(e.dataTransfer.types).includes(FILES_TYPE);

    const enter = (e: DragEvent) => {
      if (!carriesFiles(e)) {
        return;
      }
      depth += 1;
      setOver(true);
    };
    const leave = (e: DragEvent) => {
      if (!carriesFiles(e)) {
        return;
      }
      depth = Math.max(0, depth - 1);
      if (depth === 0) {
        setOver(false);
      }
    };
    const hover = (e: DragEvent) => {
      if (!carriesFiles(e)) {
        return;
      }
      e.preventDefault();
      if (e.dataTransfer) {
        e.dataTransfer.dropEffect = "copy";
      }
    };
    const drop = (e: DragEvent) => {
      if (!carriesFiles(e)) {
        return;
      }
      e.preventDefault();
      depth = 0;
      setOver(false);
      const files = Array.from(e.dataTransfer?.files ?? []);
      if (files.length > 0) {
        take.current(files);
      }
    };

    window.addEventListener("dragenter", enter);
    window.addEventListener("dragleave", leave);
    window.addEventListener("dragover", hover);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("dragover", hover);
      window.removeEventListener("drop", drop);
    };
  }, [page]);

  return over;
}

/**
 * A template opened from Home's grid, shown over the page the way the gallery
 * shows it: at the template's own URL, pushed over Home's, so the back button
 * closes it and a reload lands on the template's page.
 */
function useTemplatePanel() {
  const base = useCutBase();
  const pathname = usePathname();
  const index = useTemplateIndex();
  const openId = templateAt(pathname);

  // Only a template opened from this page opens over it. Home stays mounted
  // hidden behind the gallery, which opens its own at the same URL.
  // The flag drops when the URL leaves the template, judged on the change: the
  // router reports the pushed path a render after the click sets the flag.
  const [ours, setOurs] = useState(false);
  const [lastId, setLastId] = useState(openId);
  if (lastId !== openId) {
    setLastId(openId);
    if (!openId) {
      setOurs(false);
    }
  }
  const open =
    ours && openId
      ? (index.data?.templates.find((tpl) => tpl.id === openId) ?? null)
      : null;

  // The panel slides out with the last template still in it.
  const [shown, setShown] = useState<GalleryTemplate | null>(open);
  if (open && open !== shown) {
    setShown(open);
  }

  // Whether the open template's history entry is ours to take back off.
  const pushed = useRef(false);
  useEffect(() => {
    if (!openId) {
      pushed.current = false;
    }
  }, [openId]);

  const nav: PanelNav = {
    open: (id) => {
      // A similar template swaps in place, so closing still returns to Home.
      if (openId) {
        window.history.replaceState(null, "", templatePage(id));
        return;
      }
      window.history.pushState(null, "", templatePage(id));
      pushed.current = true;
      setOurs(true);
    },
    close: () => {
      if (pushed.current) {
        pushed.current = false;
        window.history.back();
        return;
      }
      window.history.pushState(null, "", homeHref(base, "home"));
    },
  };

  return { template: shown, open: !!open, nav, base };
}
