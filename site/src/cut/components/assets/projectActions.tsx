"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { TemplateMakeDialog } from "@/cut/components/TemplateMakeDialog";
import { apiJson } from "@/cut/lib/api";
import { quotaError } from "@/cut/lib/backend/cloud";
import { useListedResidencies } from "@/cut/lib/backend/hooks";
import { clearProjectThreads } from "@/cut/lib/chatThreads";
import { creatorLocale } from "@/cut/lib/defaultNames";
import { dropLocalProjectCopy } from "@/cut/lib/mediaSync";
import { copyProjectAcross } from "@/cut/lib/projectCopy";
import { newProjectAllowed } from "@/cut/lib/projectLimit";
import { forgetProject } from "@/cut/lib/projectPurge";
import { backendFor, patchProjects, refetchProjects } from "@/cut/lib/queries";
import type { Residency } from "@/cut/lib/residency";
import { useStarterGone } from "@/cut/lib/tourLock";
import type { ProjectSummary } from "@/cut/lib/types";
import { errorFromBody } from "@/cut/lib/userError";
import { useDescribeError } from "@/i18n/describeError";

// How often a queued cloud duplicate is checked on.
const COPY_POLL_MS = 2000;

// A delete that finds the project already gone has done its job.
const HTTP_NOT_FOUND = 404;

/** A project and the shelf it lives on. */
export type ShelvedProject = { project: ProjectSummary; residency: Residency };

/**
 * What a project card's ⋯ menu and right-click do — rename, duplicate, make
 * a template, move across shelves — shared by Assets and Home so a card
 * behaves the same wherever it sits. The page owns the busy flag and the
 * failure line, and renders `dialogs` once.
 */
export function useProjectActions({
  live,
  busy,
  setBusy,
  setFailure,
}: {
  live: (r: Residency) => boolean;
  busy: boolean;
  setBusy: (b: boolean) => void;
  setFailure: (f: string | null) => void;
}) {
  const t = useTranslations("home");
  const describeError = useDescribeError();
  const client = useQueryClient();
  const starterGone = useStarterGone();
  const residencies = useListedResidencies();
  const [renaming, setRenaming] = useState<ShelvedProject | null>(null);
  const [name, setName] = useState("");
  const [making, setMaking] = useState<ShelvedProject | null>(null);

  // Purge what this browser keeps for a gone project: a live scene run, its
  // renders, its chat history and the cached copy of its document.
  const purge = (id: string, residency: Residency) => {
    starterGone(id);
    forgetProject(id, residency);
  };

  const rename = async () => {
    if (!renaming) {
      return;
    }
    const { project: p, residency } = renaming;
    setRenaming(null);
    if (!live(residency)) {
      return;
    }
    const next = name.trim() || p.name;
    patchProjects(client, residency, (s) => ({
      ...s,
      projects: s.projects.map((x) =>
        x.id === p.id ? { ...x, name: next } : x,
      ),
    }));
    await backendFor(residency)
      .fetch(`/api/cut/projects/${p.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: next }),
      })
      .catch(() => void refetchProjects(client, residency));
  };

  const duplicate = async ({ project: p, residency }: ShelvedProject) => {
    if (!live(residency) || !(await newProjectAllowed(client))) {
      return;
    }
    setBusy(true);
    setFailure(null);
    try {
      const res = await backendFor(residency).fetch(
        `/api/cut/projects/${p.id}/duplicate`,
        {
          method: "POST",
          body: JSON.stringify({ locale: creatorLocale() }),
        },
      );
      const body = (await res.json().catch(() => null)) as {
        jobId?: string;
        error?: string;
      } | null;
      if (!res.ok) {
        throw (
          quotaError(res.status, body) ??
          errorFromBody(body, t("projects.duplicateFailed"))
        );
      }
      // Cloud duplicates queue; poll until this one lands. The engine answers
      // with the finished summary.
      if (body?.jobId) {
        for (;;) {
          await new Promise((done) => setTimeout(done, COPY_POLL_MS));
          const st = await backendFor(residency).fetch(
            `/api/cut/copy-jobs/${body.jobId}`,
          );
          if (!st.ok) {
            throw new Error(t("projects.duplicateFailed"));
          }
          const job = (await st.json()) as { state: string; error?: string };
          if (job.state === "done") {
            break;
          }
          if (job.state === "error") {
            throw errorFromBody(job, t("projects.duplicateFailed"));
          }
        }
      }
      await refetchProjects(client, residency);
    } catch (err) {
      setFailure(describeError(err, t("projects.duplicateFailed")));
    } finally {
      setBusy(false);
    }
  };

  // A project moves between the two places the user thinks in: Local and
  // Cloud. A local project offers the Cloud; a cloud project offers the Mac
  // engine when it is up, this browser's storage otherwise.
  const moveDests = (from: Residency): Residency[] => {
    if (from !== "cloud") {
      return residencies.includes("cloud") ? ["cloud"] : [];
    }
    const local = residencies.filter((d) => d !== "cloud" && live(d));
    return local.includes("local") ? ["local"] : local;
  };
  const moveAcross = async (
    dest: Residency,
    { project: p, residency }: ShelvedProject,
  ) => {
    if (!live(residency) || !live(dest)) {
      return;
    }
    setFailure(null);
    setBusy(true);
    try {
      await copyProjectAcross(backendFor(residency), backendFor(dest), p.id);
      await backendFor(residency)
        .fetch(`/api/cut/projects/${p.id}`, { method: "DELETE" })
        .catch(() => {});
      clearProjectThreads(p.id);
      if (residency === "cloud") {
        void dropLocalProjectCopy(p.id);
      }
      starterGone(p.id);
      await Promise.all([
        refetchProjects(client, residency),
        refetchProjects(client, dest),
      ]);
    } catch (err) {
      setFailure(describeError(err, t("projects.moveFailed")));
    } finally {
      setBusy(false);
    }
  };

  /** Deletes one project from its shelf, gone from the listing at once. */
  const remove = async ({ project: p, residency }: ShelvedProject) => {
    if (!live(residency)) {
      return;
    }
    setFailure(null);
    setBusy(true);
    patchProjects(client, residency, (s) => ({
      ...s,
      projects: s.projects.filter((x) => x.id !== p.id),
    }));
    try {
      const res = await backendFor(residency).fetch(
        `/api/cut/projects/${p.id}`,
        { method: "DELETE" },
      );
      if (!res.ok && res.status !== HTTP_NOT_FOUND) {
        throw errorFromBody(
          await apiJson<object>(res),
          t("projects.deleteProjectFailed"),
        );
      }
      purge(p.id, residency);
    } catch (err) {
      setFailure(describeError(err, t("projects.deleteFailed")));
      void refetchProjects(client, residency);
    } finally {
      setBusy(false);
    }
  };

  /** The ⋯ menu's entries for one project, all but delete: the page decides
   * what a delete confirms. */
  const menuFor = (e: ShelvedProject) => ({
    onRename: () => {
      setName(e.project.name);
      setRenaming(e);
    },
    onDuplicate: () => void duplicate(e),
    onMakeTemplate: () => {
      setFailure(null);
      setMaking(e);
    },
    moveTo: moveDests(e.residency).map((d) => ({
      target: d,
      run: () => void moveAcross(d, e),
    })),
  });

  const dialogs = (
    <>
      {making && (
        <TemplateMakeDialog
          project={making.project}
          residency={making.residency}
          onClose={() => setMaking(null)}
        />
      )}

      <Dialog open={!!renaming} onOpenChange={(o) => !o && setRenaming(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{t("projects.renameTitle")}</DialogTitle>
          </DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void rename();
            }}
          >
            <Input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <DialogFooter className="mt-4">
              <Button type="submit" disabled={busy} className="w-full">
                {t("projects.rename")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );

  return { menuFor, moveDests, moveAcross, remove, purge, dialogs };
}
