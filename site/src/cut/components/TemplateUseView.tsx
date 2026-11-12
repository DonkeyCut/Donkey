"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { useDescribeError } from "@/i18n/describeError";
import { useComputeSettled } from "@/cut/lib/backend/hooks";
import { homeHref, projectHref, useCutBase } from "@/cut/lib/nav";
import { useNewProjectTarget } from "@/cut/lib/newProject";
import { newProjectAllowed } from "@/cut/lib/projectLimit";
import { refetchProjects, useTemplateIndex } from "@/cut/lib/queries";
import { localized, templatePoster, type GalleryTemplate } from "@/cut/lib/templateGallery";
import { useEditor } from "@/cut/lib/store";
import { copyTemplate } from "@/cut/lib/templateUse";
import { cueTemplateTour } from "@/cut/lib/onboarding";
import { copyBarShare } from "@/cut/lib/copyBar";
import { track } from "@/lib/analytics";

// Each visit of the template page's "Use" link carries a fresh run id; the run
// records the project it made under that id, so a reload lands on that
// project and never copies the template twice.
const RUN_KEY = "template-run:";

function madeFor(run: string): string | null {
  try {
    return sessionStorage.getItem(RUN_KEY + run);
  } catch {
    return null;
  }
}

function recordRun(run: string, projectId: string) {
  try {
    sessionStorage.setItem(RUN_KEY + run, projectId);
  } catch {
    // Storage blocked: a reload of this page copies again.
  }
}

export type CopyPhase =
  | { state: "copying"; done: number; total: number }
  | { state: "blocked" }
  | { state: "done" }
  | { state: "failed"; message: string };

/** Copies `template` once, to where new projects land for this person, as
 * soon as the gate knows whether this Mac has an engine (that decides where
 * the project lands), then opens the copy. A `run` the copy is recorded under
 * reopens that copy on a reload. */
function useTemplateCopy(template: GalleryTemplate | undefined, run: string): CopyPhase {
  const t = useTranslations("home.templates");
  const locale = useLocale();
  const describeError = useDescribeError();
  const router = useRouter();
  const base = useCutBase();
  const client = useQueryClient();
  const settled = useComputeSettled();
  const { target } = useNewProjectTarget();
  const [phase, setPhase] = useState<CopyPhase>({ state: "copying", done: 0, total: 0 });
  const started = useRef(false);

  useEffect(() => {
    if (!template || !settled || started.current) {
      return;
    }
    started.current = true;
    const open = (projectId: string) => router.replace(projectHref(base, projectId, "home"));
    const earlier = run ? madeFor(run) : null;
    if (earlier) {
      open(earlier);
      return;
    }
    void (async () => {
      try {
        // At the project limit the upgrade prompt answers; the page offers
        // the way back.
        if (!(await newProjectAllowed(client))) {
          setPhase({ state: "blocked" });
          return;
        }
        const name = localized(template.name, locale);
        const projectId = await copyTemplate(template, target, name, (done, total) =>
          setPhase({ state: "copying", done, total })
        );
        if (run) {
          recordRun(run, projectId);
        }
        void refetchProjects(client, target);
        track("project_created", { source: "template" });
        cueTemplateTour(projectId);
        open(projectId);
      } catch (e) {
        setPhase({ state: "failed", message: describeError(e, t("detail.failed")) });
      }
    })();
  }, [template, settled, target, run, base, client, router, t, locale, describeError]);

  return phase;
}

/** A copy's progress: the still beside the name and what is happening, over
 * a bar while it runs, and once it stops, what came of it and the way on.
 * Every still and every state fills the same frame, so the card never
 * changes size: the still sits letterboxed in one 16:9 box, and the bottom
 * row holds the bar or the way on at one height. `working` says what runs
 * until a count arrives; `done` says what a finished copy made. */
function CopyProgress({
  still,
  name,
  phase,
  working,
  done,
  back,
}: {
  still: React.ReactNode;
  name: string;
  phase: CopyPhase;
  working: string;
  done?: React.ReactNode;
  back: React.ReactNode;
}) {
  const t = useTranslations("home.templates");
  const copying = phase.state === "copying";
  const counted = copying && phase.total > 0;
  return (
    <div className="flex w-full flex-col gap-5">
      <div className="flex items-center gap-5">
        <div className="relative grid aspect-video h-36 shrink-0 place-items-center overflow-hidden rounded-xl border border-border bg-black">
          {still}
        </div>
        <div className="flex min-w-0 flex-col gap-1.5">
          <div className="truncate text-lg font-semibold tracking-tight">{name}</div>
          {copying && (
            <div className="flex items-center gap-2 text-[15px] text-muted-foreground tabular-nums">
              <Loader2 className="size-4 shrink-0 animate-spin" />
              {counted ? t("detail.progress", { done: phase.done, total: phase.total }) : working}
            </div>
          )}
          {phase.state === "done" && done && <p className="line-clamp-3 text-[15px] text-muted-foreground">{done}</p>}
          {phase.state === "failed" && <p className="line-clamp-3 text-[15px] text-destructive">{phase.message}</p>}
        </div>
      </div>

      {/* One row, one height: the bar while the copy runs, a sliver until
          the first count arrives; the way on once it stops. */}
      <div className="flex h-9 items-center justify-end gap-2">
        {copying ? (
          <div className="relative h-2 w-full overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-foreground transition-[width] duration-300 ease-out"
              style={{ width: `${copyBarShare(phase.done, phase.total) * 100}%` }}
            />
          </div>
        ) : (
          back
        )}
      </div>
    </div>
  );
}

/** A template's still, letterboxed in the progress frame. */
function TemplateStill({ template }: { template: GalleryTemplate }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element -- a signed CDN still, not a Next asset
    <img src={templatePoster(template)} alt="" className="size-full object-contain" />
  );
}

/** The in-app half of "Use as new project" from a template's own page: it
 * runs inside the app so the Mac engine and the browser store are both in
 * reach. */
export function TemplateUseView({ id, run }: { id: string; run: string }) {
  const t = useTranslations("home.templates");
  const locale = useLocale();
  const base = useCutBase();
  const index = useTemplateIndex();
  const template = index.data?.templates.find((tpl) => tpl.id === id);
  const phase = useTemplateCopy(template, run);

  if (index.isPending) {
    return (
      <div className="grid h-full place-items-center">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!template) {
    return (
      <div className="grid h-full place-items-center px-4">
        <p className="text-sm text-muted-foreground">{t("detail.missing")}</p>
      </div>
    );
  }

  return (
    <div className="grid h-full place-items-center px-4">
      <div className="w-full max-w-sm">
        <CopyProgress
          still={<TemplateStill template={template} />}
          name={localized(template.name, locale)}
          phase={phase}
          working={t("detail.using")}
          back={<Button variant="outline" nativeButton={false} render={<Link href={homeHref(base, "templates")}>{t("detail.close")}</Link>} />}
        />
      </div>
    </div>
  );
}

/** "Use as new project" from the gallery's panel, inside the app already: the
 * template stops playing and the copy runs in a dialog centered over it, then
 * opens the project. */
export function TemplateUseDialog({ template, onClose }: { template: GalleryTemplate; onClose: () => void }) {
  const t = useTranslations("home.templates");
  const locale = useLocale();
  const phase = useTemplateCopy(template, "");

  // The template behind the dialog holds still while it is copied.
  useEffect(() => useEditor.getState().setPlaying(false), []);

  return (
    <CopyDialog
      still={<TemplateStill template={template} />}
      name={localized(template.name, locale)}
      phase={phase}
      working={t("detail.using")}
      closeLabel={t("detail.close")}
      onClose={onClose}
    />
  );
}

/** The copy dialog itself, centered over the page. While the copy runs it
 * cannot be dismissed; a stop offers the way back, and `actions` sit beside
 * it once the copy is done. */
export function CopyDialog({
  still,
  name,
  phase,
  working,
  done,
  actions,
  closeLabel,
  onClose,
}: {
  still: React.ReactNode;
  name: string;
  phase: CopyPhase;
  working: string;
  done?: React.ReactNode;
  actions?: React.ReactNode;
  closeLabel: string;
  onClose: () => void;
}) {
  const busy = phase.state === "copying";
  return (
    <Dialog open disablePointerDismissal={busy} onOpenChange={(next) => !next && !busy && onClose()}>
      <DialogContent
        position="center"
        overlay="always"
        overlayClassName="bg-black/30 backdrop-blur-sm"
        showCloseButton={false}
        className="p-7 sm:max-w-xl"
      >
        <DialogTitle className="sr-only">{name}</DialogTitle>
        <CopyProgress
          still={still}
          name={name}
          phase={phase}
          working={working}
          done={done}
          back={
            <>
              <Button variant="outline" onClick={onClose}>
                {closeLabel}
              </Button>
              {phase.state === "done" && actions}
            </>
          }
        />
      </DialogContent>
    </Dialog>
  );
}
