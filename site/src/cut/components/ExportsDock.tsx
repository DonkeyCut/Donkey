"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import {
  Check,
  ChevronDown,
  CircleAlert,
  Clock,
  Download,
  FolderOpen,
  Loader2,
  X,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { useElapsed } from "@/cut/hooks/useElapsed";
import { downloadExport, revealExport } from "@/cut/lib/exportClient";
import {
  beginExportPolling,
  endExportPolling,
  exportBackend,
  useExportRows,
  useExports,
  type ExportJob,
  type LocalRow,
} from "@/cut/lib/exportStore";
import { framedHref } from "@/cut/lib/hostBridge";
import { projectHref, useCutBase } from "@/cut/lib/nav";
import { cn } from "@/lib/utils";
import { useDescribeError } from "@/i18n/describeError";
import { exportsDockOpen, inFlightCount, type DockChoice } from "@/cut/lib/exportsDockView";

/** Where the dock floats: the window's corner, or the timeline's inside a project. */
export type DockPlacement = "window" | "timeline";

const PLACEMENT_CLASS: Record<DockPlacement, string> = {
  window: "fixed right-4 bottom-4 max-h-[calc(100dvh-2rem)] max-w-[calc(100vw-2rem)]",
  // Clear of the timeline's scrollbars, above its playhead and ruler.
  timeline: "absolute right-8 bottom-8 max-h-[calc(100%-4rem)] max-w-[calc(100%-4rem)]",
};

/**
 * The app-wide exports dock: one card that shows every export across every
 * project, live in every tab. It mirrors the engine's job feed, so a render
 * started in one project keeps showing while you open another, exports queued
 * past the running cap show their place in line, and a finished file is one
 * click from Finder or a re-download. The Cut app layout mounts it in the
 * window's corner; inside a project it hovers over the timeline's corner and
 * hides with the timeline.
 */
export function ExportsDock({ placement }: { placement: DockPlacement }) {
  const t = useTranslations("editor.exportsDock");
  const [choice, setChoice] = useState<DockChoice>(null);

  // Inside a project the timeline carries the dock, so the window's stands down.
  const inProject = Boolean(useParams<{ id?: string }>()?.id);

  // Poll the feed while the dock is mounted (i.e. the whole time the app is up).
  useEffect(() => {
    beginExportPolling();
    return endExportPolling;
  }, []);

  // Every project's work, assembled the same way the Media tab assembles one
  // project's (`useExportRows`). The dock is the notification, so its own X
  // list applies here: a hidden row keeps rendering and keeps its place in the
  // Media tab's Exports list, where the cancel lives.
  const dismissed = useExports((s) => s.dismissed);
  const all = useExportRows();
  const items = useMemo(
    () => all.filter((i) => !dismissed.includes(i.data.id)),
    [all, dismissed]
  );

  // The dock opens while work is in flight and rests on its header once it
  // settles; a new export clears whatever was toggled for the last one.
  const statuses = items.map((i) => i.data.status);
  const inFlight = inFlightCount(statuses);
  const lastInFlight = useRef(inFlight);
  useEffect(() => {
    if (inFlight > lastInFlight.current) {
      setChoice(null);
    }
    lastInFlight.current = inFlight;
  }, [inFlight]);
  const open = exportsDockOpen(statuses, choice);

  if (items.length === 0) {
    return null;
  }
  if (placement === "window" && inProject) {
    return null;
  }

  const running = items.filter(
    (i) => i.data.status === "running" || i.data.status === "rendering"
  ).length;
  const waiting = items.filter(
    (i) => i.data.status === "queued" || i.data.status === "preparing"
  ).length;
  const settled = items.filter(
    (i) => i.data.status === "done" || i.data.status === "error"
  ).length;
  const multi = items.length > 1;

  return (
    <div
      className={cn(
        PLACEMENT_CLASS[placement],
        "z-50 w-72 overflow-y-auto overscroll-contain rounded-xl border border-border bg-card shadow-lg"
      )}
    >
      {(multi || !open || choice === "open") && (
        <div className="flex items-center gap-2 px-3 py-2">
          <span className="text-xs font-semibold">{t("title")}</span>
          <span className="flex-1 truncate text-[11px] text-muted-foreground tabular-nums">
            {[running && t("running", { count: running }), waiting && t("queuedCount", { count: waiting })]
              .filter(Boolean)
              .join(" · ") || t("doneCount", { count: items.length })}
          </span>
          {settled > 0 && (
            <Button
              variant="ghost"
              size="xs"
              className="text-muted-foreground"
              onClick={() => useExports.getState().dismissSettled()}
            >
              {t("clearAll")}
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={open ? t("collapse") : t("expand")}
            onClick={() => setChoice(open ? "closed" : "open")}
          >
            <ChevronDown className={cn("transition-transform", open && "rotate-180")} />
          </Button>
        </div>
      )}
      {open && (
        <div className="max-h-[min(60vh,22rem)] divide-y divide-border overflow-y-auto">
          {items.map((it) =>
            it.kind === "job" ? (
              <ExportRow key={it.data.id} job={it.data} />
            ) : (
              <LocalRowView key={it.data.id} row={it.data} />
            )
          )}
        </div>
      )}
    </div>
  );
}

function StatusIcon({ status }: { status: string }) {
  if (status === "running" || status === "preparing" || status === "rendering")
    return <Loader2 className="size-4 shrink-0 animate-spin text-primary" />;
  if (status === "queued") return <Clock className="size-4 shrink-0 text-muted-foreground" />;
  if (status === "done")
    return (
      <span className="grid size-4 shrink-0 place-items-center rounded-full bg-[#30d158] text-white">
        <Check className="size-2.5" />
      </span>
    );
  return <CircleAlert className="size-4 shrink-0 text-destructive" />;
}

function ProjectName({ projectId, name }: { projectId: string; name?: string }) {
  const t = useTranslations("editor.exportsDock");
  const base = useCutBase();
  return (
    <Link
      href={framedHref(projectHref(base, projectId, "projects"))}
      className="block truncate text-xs font-medium hover:underline"
      title={name || t("untitled")}
    >
      {name || t("untitled")}
    </Link>
  );
}

function ExportRow({ job }: { job: ExportJob }) {
  // The job's own backend, not the globally bound one: the row must keep
  // working after the app rebinds to the other residency.
  const t = useTranslations("editor.exportsDock");
  const describeError = useDescribeError();
  const backend = exportBackend(job.residency);
  const caps = backend.caps;
  const elapsed = useElapsed(job.status === "running" ? job.startedAt ?? null : null);
  const pct = Math.round(job.progress * 100);

  const sub =
    job.status === "running"
      ? `${pct}%${elapsed ? ` · ${elapsed}` : ""}`
      : job.status === "queued"
        ? t("queued")
        : job.status === "done"
          ? t("ready")
          : describeError(job, t("exportFailed"));

  return (
    <div className="relative flex items-center gap-2.5 px-3 py-2">
      <StatusIcon status={job.status} />
      <div className="min-w-0 flex-1">
        <ProjectName projectId={job.projectId} name={job.projectName} />
        <div
          className={cn(
            "truncate text-[11px] tabular-nums",
            job.status === "error" ? "text-destructive" : "text-muted-foreground"
          )}
        >
          {sub}
        </div>
      </div>
      <div className="flex items-center">
        {(job.status === "running" || job.status === "queued") && (
          <>
            <Button
              variant="ghost"
              size="xs"
              className="text-muted-foreground hover:text-destructive"
              onClick={() => useExports.getState().cancel(job.id)}
            >
              {t("cancel")}
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={t("dismiss")}
              title={t("hide")}
              onClick={() => useExports.getState().dismiss(job.id)}
            >
              <X />
            </Button>
          </>
        )}
        {job.status === "done" && (
          <>
            {job.outName && (
              <>
                {caps.revealInFinder && (
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label={t("showInFinder")}
                    title={t("showInFinder")}
                    onClick={() =>
                      void revealExport(job.projectId, job.outName!, backend).catch(() => {})
                    }
                  >
                    <FolderOpen />
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={t("downloadAgain")}
                  title={t("download")}
                  onClick={() => downloadExport(job.id, job.outName!, backend)}
                >
                  <Download />
                </Button>
              </>
            )}
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={t("dismiss")}
              onClick={() => useExports.getState().dismiss(job.id)}
            >
              <X />
            </Button>
          </>
        )}
        {job.status === "error" && (
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={t("dismiss")}
            onClick={() => useExports.getState().dismiss(job.id)}
          >
            <X />
          </Button>
        )}
      </div>
      {job.status === "running" && (
        <div className="absolute inset-x-0 bottom-0 h-0.5 bg-secondary">
          <div
            className="h-full bg-primary transition-[width] duration-300"
            style={{ width: `${pct}%` }}
          />
        </div>
      )}
    </div>
  );
}

function LocalRowView({ row }: { row: LocalRow }) {
  const t = useTranslations("editor.exportsDock");
  const describeError = useDescribeError();
  const rendering = row.status === "rendering";
  const pct = Math.round(Math.min(1, Math.max(0, row.progress ?? 0)) * 100);
  return (
    <div className="relative flex items-center gap-2.5 px-3 py-2">
      <StatusIcon status={row.status} />
      <div className="min-w-0 flex-1">
        <ProjectName projectId={row.projectId} name={row.projectName} />
        <div
          className={cn(
            "truncate text-[11px]",
            row.status === "error" ? "text-destructive" : "text-muted-foreground"
          )}
        >
          {rendering
            ? t("rendering", { pct })
            : row.status === "preparing"
              ? t("preparing")
              : describeError(row, t("startFailed"))}
        </div>
      </div>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label={t("dismiss")}
        title={row.status === "error" ? t("dismiss") : t("hide")}
        onClick={() => useExports.getState().dismiss(row.id)}
      >
        <X />
      </Button>
      {rendering && (
        <div className="absolute inset-x-0 bottom-0 h-0.5 bg-secondary">
          <div
            className="h-full bg-primary transition-[width] duration-300"
            style={{ width: `${pct}%` }}
          />
        </div>
      )}
    </div>
  );
}
