"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useDescribeError } from "@/i18n/describeError";
import { useComputeSettled } from "@/cut/lib/backend/hooks";
import { homeHref, projectHref, useCutBase } from "@/cut/lib/nav";
import { useNewProjectTarget } from "@/cut/lib/newProject";
import { newProjectAllowed } from "@/cut/lib/projectLimit";
import { refetchProjects, useTemplateIndex } from "@/cut/lib/queries";
import { localized, templatePoster } from "@/cut/lib/templateGallery";
import { copyTemplate } from "@/cut/lib/templateUse";
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

type Phase =
  | { state: "copying"; done: number; total: number }
  | { state: "blocked" }
  | { state: "failed"; message: string };

/** The in-app half of "Use as new project": copies the template to where new
 * projects land for this person, then opens the copy. It
 * runs inside the app so the Mac engine and the browser store are both in
 * reach. */
export function TemplateUseView({ id, run }: { id: string; run: string }) {
  const t = useTranslations("home.templates");
  const locale = useLocale();
  const describeError = useDescribeError();
  const router = useRouter();
  const base = useCutBase();
  const client = useQueryClient();
  const settled = useComputeSettled();
  const { target } = useNewProjectTarget();
  const index = useTemplateIndex();
  const template = index.data?.templates.find((tpl) => tpl.id === id);
  const [phase, setPhase] = useState<Phase>({ state: "copying", done: 0, total: 0 });
  const started = useRef(false);

  // Start once the gate knows whether this Mac has an engine, since that
  // decides where the project lands.
  useEffect(() => {
    if (!template || !settled || started.current) {
      return;
    }
    started.current = true;
    const open = (projectId: string) => router.replace(projectHref(base, projectId, "projects"));
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
        open(projectId);
      } catch (e) {
        setPhase({ state: "failed", message: describeError(e, t("detail.failed")) });
      }
    })();
  }, [template, settled, target, run, base, client, router, t, locale, describeError]);

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

  const [w, h] = template.aspect.split(":").map(Number);
  return (
    <div className="grid h-full place-items-center px-4">
      <div className="flex w-full max-w-xs flex-col items-center gap-4 text-center">
        <div
          className="w-40 overflow-hidden rounded-2xl border border-border bg-muted"
          style={{ aspectRatio: `${w} / ${h}` }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element -- a signed CDN still, not a Next asset */}
          <img src={templatePoster(template)} alt="" className="size-full object-cover" />
        </div>
        <div className="text-sm font-medium">{localized(template.name, locale)}</div>
        {phase.state === "copying" ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            {phase.total > 0 ? t("detail.progress", { done: phase.done, total: phase.total }) : t("detail.using")}
          </div>
        ) : (
          <>
            {phase.state === "failed" && <p className="text-sm text-destructive">{phase.message}</p>}
            <Button variant="outline" nativeButton={false} render={<Link href={homeHref(base, "templates")}>{t("detail.close")}</Link>} />
          </>
        )}
      </div>
    </div>
  );
}
