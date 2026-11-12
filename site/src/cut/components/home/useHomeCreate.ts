"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { creatorNames } from "@/cut/lib/defaultNames";
import { seedNewProjectDoc } from "@/cut/lib/docCache";
import { framedHref } from "@/cut/lib/hostBridge";
import { saveHomeHandoff, type HomeHandoff } from "@/cut/lib/homeHandoff";
import { projectHref, useCutBase } from "@/cut/lib/nav";
import { useNewProjectTarget } from "@/cut/lib/newProject";
import { cueTemplateTour } from "@/cut/lib/onboarding";
import { newProjectAllowed } from "@/cut/lib/projectLimit";
import { patchProjects, refetchProjects } from "@/cut/lib/queries";
import { backendFor, type Residency } from "@/cut/lib/residency";
import { lastChosenAspect } from "@/cut/lib/store";
import { localized } from "@/cut/lib/templateGallery";
import { copyAsKind, copyTemplate } from "@/cut/lib/templateUse";
import type { ProjectSummary } from "@/cut/lib/types";
import { errorFromBody } from "@/cut/lib/userError";
import { useDescribeError } from "@/i18n/describeError";
import { track } from "@/lib/analytics";
import type { StartTemplate } from "./atRows";

/** What started a project on Home, for the creation event. */
type HomeSource = "home_prompt" | "home_blank";

/** Whether a template copy cues the template tour: `quiet` when the chat
 * starts working in the project on arrival. */
type TourCue = "tour" | "quiet";

/** Where a template copy stands while it runs, for the send button. */
export type StartProgress = { name: string; done: number; total: number };

/**
 * Making a project from Home: an empty one, or one from a template, on the
 * shelf the storage switcher points at, opened in the editor. A prompt rides
 * along as the chat's first message, which the editor sends on arrival.
 */
export function useHomeCreate(residency: Residency) {
  const t = useTranslations("home.start");
  const locale = useLocale();
  const describeError = useDescribeError();
  const router = useRouter();
  const base = useCutBase();
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<StartProgress | null>(null);
  const [error, setError] = useState<string | null>(null);

  // An empty project, seeded so the editor opens on its first frame.
  const emptyProject = async (): Promise<string> => {
    const aspect = lastChosenAspect() ?? undefined;
    const res = await backendFor(residency).fetch("/api/cut/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: creatorNames().untitled, folderId: null, aspect }),
    });
    if (!res.ok) {
      throw errorFromBody(await res.json().catch(() => null), t("createFailed"));
    }
    const project = (await res.json()) as ProjectSummary;
    patchProjects(client, residency, (s) => ({ ...s, projects: [project, ...s.projects] }));
    seedNewProjectDoc(project.id, project.name, residency, aspect);
    return project.id;
  };

  // A project copied from a template, the way Use as new project copies one:
  // Donkey's land where new projects go, a person's own stay on its shelf.
  // The tour cues only for a template the person starts to edit by hand; a
  // prompt riding along means the chat is about to work in it.
  const templateProject = async (start: StartTemplate, tour: TourCue): Promise<string> => {
    if (start.kind === "own") {
      const id = await copyAsKind(start.residency, start.project.id, "project", start.project.name);
      void refetchProjects(client, start.residency);
      return id;
    }
    const name = localized(start.template.name, locale);
    setProgress({ name, done: 0, total: 0 });
    const id = await copyTemplate(start.template, residency, name, (done, total) =>
      setProgress({ name, done, total })
    );
    void refetchProjects(client, residency);
    if (tour === "tour") {
      cueTemplateTour(id);
    }
    return id;
  };

  /** Make the project, park the first message for its chat, and open it.
   * Resolves true once the editor is on its way. */
  const start = async (source: HomeSource, first: HomeHandoff | null, template: StartTemplate | null): Promise<boolean> => {
    if (busy) {
      return false;
    }
    setBusy(true);
    setError(null);
    try {
      if (!(await newProjectAllowed(client))) {
        return false;
      }
      const id = template ? await templateProject(template, first ? "quiet" : "tour") : await emptyProject();
      if (first) {
        saveHomeHandoff(id, first);
      }
      track("project_created", { source });
      router.push(framedHref(projectHref(base, id, "home")));
      return true;
    } catch (e) {
      setError(describeError(e, t("createFailed")));
      return false;
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };

  return { start, busy, progress, error };
}

/** Where Home makes new projects: the switcher's pick. */
export function useHomeResidency(): Residency {
  return useNewProjectTarget().target;
}
