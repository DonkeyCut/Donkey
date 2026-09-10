"use client";

import { cn } from "@/lib/utils";
import { useRecentJobs, type AsyncJobListItem } from "@/queries/jobs";

// The list shows each job's stored payload and result as-is, so it stays
// honest for job kinds this page doesn't know about: flatten the primitive
// fields into "email: x@y.com · projects: 3".
function describeFields(value: unknown): string {
  if (typeof value !== "object" || value === null) return "";
  return Object.entries(value)
    .filter(([, v]) => ["string", "number", "boolean"].includes(typeof v))
    .map(([k, v]) => `${k}: ${String(v)}`)
    .join(" · ");
}

// A finished delete-user job reads as one sentence; other kinds (and
// unfinished jobs) keep the flattened raw fields.
function doneSummary(item: AsyncJobListItem): string | null {
  if (item.kind !== "delete-user" || item.state !== "done") return null;
  const payload = item.payload as { email?: unknown } | null;
  const email = typeof payload?.email === "string" ? payload.email : "";
  const result = item.result;
  return (
    `Deleted ${email} — ${String(result?.projects ?? 0)} project(s), ` +
    `${String(result?.libraryAssets ?? 0)} library asset(s), ` +
    `${String(result?.r2Objects ?? 0)} stored object(s).`
  );
}

function formatWhen(iso: string): string {
  const then = new Date(iso);
  const mins = Math.floor((Date.now() - then.getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  if (mins < 60 * 24) return `${Math.floor(mins / 60)}h ago`;
  return then.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

const stateDot: Record<AsyncJobListItem["state"], string> = {
  queued: "bg-muted-foreground/40",
  running: "bg-blue-500 animate-pulse",
  done: "bg-emerald-500",
  error: "bg-destructive",
};

// Background jobs across the super-user surfaces — deletes started on Users,
// the analytics rollup, the outreach scan — newest first. The query polls
// while anything is queued or running, so states settle here without a
// refresh. The layout gates this route to super users, so the hook runs
// unconditionally.
export default function SuJobsPage() {
  const recent = useRecentJobs(true);

  if (!recent.data?.jobs.length) {
    return (
      <p className="pb-9 text-sm text-muted-foreground">
        {recent.isPending ? "Loading…" : "No jobs yet."}
      </p>
    );
  }

  return (
    <ul className="max-w-3xl space-y-3 pb-9">
      {recent.data.jobs.map((item) => (
        <li key={item.id} className="flex items-start gap-2.5">
          <span
            className={cn(
              "mt-1.5 size-2 shrink-0 rounded-full",
              stateDot[item.state],
            )}
          />
          <div className="min-w-0 text-sm">
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span className="font-medium">{item.kind}</span>
              <span className="text-muted-foreground">{item.state}</span>
              <span className="text-muted-foreground">
                {formatWhen(item.createdAt)}
              </span>
            </div>
            {doneSummary(item) ? (
              <p className="text-muted-foreground">{doneSummary(item)}</p>
            ) : (
              <>
                {describeFields(item.payload) ? (
                  <p className="truncate text-muted-foreground">
                    {describeFields(item.payload)}
                  </p>
                ) : null}
                {item.state === "done" && describeFields(item.result) ? (
                  <p className="truncate text-muted-foreground">
                    {describeFields(item.result)}
                  </p>
                ) : null}
              </>
            )}
            {item.state === "error" && item.error ? (
              <p className="text-destructive">{item.error}</p>
            ) : null}
          </div>
        </li>
      ))}
    </ul>
  );
}
