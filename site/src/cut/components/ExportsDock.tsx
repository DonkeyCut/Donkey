"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
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
import { Button } from "@/components/ui/button";
import { useElapsed } from "@/cut/hooks/useElapsed";
import { downloadExport, revealExport } from "@/cut/lib/exportClient";
import {
  beginExportPolling,
  endExportPolling,
  exportBackend,
  useExports,
  type ExportJob,
  type LocalRow,
} from "@/cut/lib/exportStore";
import { projectHref, useCutBase } from "@/cut/lib/nav";
import { cn } from "@/lib/utils";

/**
 * The app-wide exports dock: one card pinned to the bottom-right that shows
 * every export across every project, live in every tab. It mirrors the engine's
 * job feed, so a render started in one project keeps showing while you open
 * another, exports queued past the running cap show their place in line, and a
 * finished file is one click from Finder or a re-download. Mounted once in the
 * Cut app layout, above the per-project editor.
 */
export function ExportsDock() {
  const jobs = useExports((s) => s.jobs);
  const local = useExports((s) => s.local);
  const dismissed = useExports((s) => s.dismissed);
  const rendering = useExports((s) => s.rendering);
  const [collapsed, setCollapsed] = useState(false);

  // Poll the feed while the dock is mounted (i.e. the whole time the app is up).
  useEffect(() => {
    beginExportPolling();
    return endExportPolling;
  }, []);

  const items = useMemo(() => {
    const rank = (status: string) =>
      status === "running" || status === "rendering"
        ? 0
        : status === "queued" || status === "preparing"
          ? 1
          : status === "done"
            ? 2
            : 3;
    // A row this tab is rendering shows as its local row, which has the
    // progress; the reserved job row behind it stays out of the dock.
    const visible = jobs.filter((j) => !dismissed.includes(j.id) && !rendering.includes(j.id));
    return [
      ...visible.map((j) => ({ kind: "job" as const, data: j })),
      ...local.map((r) => ({ kind: "local" as const, data: r })),
    ].sort((a, b) => {
      const dr = rank(a.data.status) - rank(b.data.status);
      return dr !== 0 ? dr : (a.data.createdAt ?? 0) - (b.data.createdAt ?? 0);
    });
  }, [jobs, local, dismissed, rendering]);

  if (items.length === 0) return null;

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
    <div className="fixed right-4 bottom-4 z-50 w-72 overflow-hidden rounded-xl border border-border bg-card shadow-lg">
      {multi && (
        <div className="flex items-center gap-2 px-3 py-2">
          <span className="text-xs font-semibold">Exports</span>
          <span className="flex-1 truncate text-[11px] text-muted-foreground tabular-nums">
            {[running && `${running} running`, waiting && `${waiting} queued`]
              .filter(Boolean)
              .join(" · ") || `${items.length} done`}
          </span>
          {settled > 0 && (
            <Button
              variant="ghost"
              size="xs"
              className="text-muted-foreground"
              onClick={() => useExports.getState().dismissSettled()}
            >
              Clear all
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={collapsed ? "Expand exports" : "Collapse exports"}
            onClick={() => setCollapsed((c) => !c)}
          >
            <ChevronDown className={cn("transition-transform", !collapsed && "rotate-180")} />
          </Button>
        </div>
      )}
      {!collapsed && (
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
  const base = useCutBase();
  return (
    <Link
      href={projectHref(base, projectId, "projects")}
      className="block truncate text-xs font-medium hover:underline"
      title={name || "Untitled"}
    >
      {name || "Untitled"}
    </Link>
  );
}

function ExportRow({ job }: { job: ExportJob }) {
  // The job's own backend, not the globally bound one: the row must keep
  // working after the app rebinds to the other residency.
  const backend = exportBackend(job.residency);
  const caps = backend.caps;
  const elapsed = useElapsed(job.status === "running" ? job.startedAt ?? null : null);
  const pct = Math.round(job.progress * 100);

  const sub =
    job.status === "running"
      ? `${pct}%${elapsed ? ` · ${elapsed}` : ""}`
      : job.status === "queued"
        ? "Queued"
        : job.status === "done"
          ? "Ready"
          : job.error || "Export failed";

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
              Cancel
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Dismiss"
              title="Hide — the export keeps running"
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
                    aria-label="Show in Finder"
                    title="Show in Finder"
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
                  aria-label="Download again"
                  title="Download"
                  onClick={() => downloadExport(job.id, job.outName!, backend)}
                >
                  <Download />
                </Button>
              </>
            )}
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Dismiss"
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
            aria-label="Dismiss"
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
            ? `Rendering… ${pct}%`
            : row.status === "preparing"
              ? "Preparing…"
              : row.error || "Couldn't start export"}
        </div>
      </div>
      {rendering && (
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Stop export"
          onClick={() => useExports.getState().cancel(row.id)}
        >
          <X />
        </Button>
      )}
      {row.status === "error" && (
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Dismiss"
          onClick={() => useExports.getState().dismiss(row.id)}
        >
          <X />
        </Button>
      )}
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
