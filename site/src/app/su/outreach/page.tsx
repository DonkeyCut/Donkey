"use client";

import { useEffect, useState } from "react";

import { ago, OutreachComposeDialog } from "@/app/su/outreach/ComposeDialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatBytes } from "@/lib/bytes";
import { cn } from "@/lib/utils";
import {
  OUTREACH_REASON_LABELS,
  OUTREACH_REASONS,
  OUTREACH_WALL_REASONS,
  type OutreachReason,
  type OutreachStatus,
} from "@/lib/marketing/campaigns";
import {
  useBusyOutreachIds,
  useOutreach,
  useOutreachAction,
  useOutreachCounts,
  useOutreachSearch,
  type OutreachRow,
} from "@/queries/outreach";

const FILTERS: { status: OutreachStatus; label: string }[] = [
  { status: "todo", label: "To email" },
  { status: "sent", label: "Sent" },
  { status: "replied", label: "Replied" },
  { status: "ignored", label: "Ignored" },
];

// The walls the scan found lead the row in the warning tone, so a person
// who was declined or is leaving Pro stands out at a glance. Out of credits
// is carried by the balance badge that follows, and the two use reasons by
// the spent and stored badges, so those never repeat here.
const REASON_BADGES: readonly OutreachReason[] = OUTREACH_WALL_REASONS.filter(
  (reason) => reason !== "no_credits",
);

// The list carries the numbers the scan wrote; the badges say what they mean
// without a second read. Storage shows only when there is any, so a row with
// the badge is someone with media parked in the cloud.
function RowBadges({ row, group }: { row: OutreachRow; group?: string }) {
  const broke = Number(row.balance) <= 0;
  const stored = Number(row.storageBytes);
  return (
    <div className="mt-1 flex flex-wrap items-center gap-1.5">
      {group ? <Badge>{group}</Badge> : null}
      {REASON_BADGES.filter((reason) => row.reasons.includes(reason)).map((reason) => (
        <Badge key={reason} variant="destructive">
          {OUTREACH_REASON_LABELS[reason]}
          {reason === "payment_failed" && row.paymentFailedAt
            ? ` · ${ago(row.paymentFailedAt)}`
            : ""}
        </Badge>
      ))}
      <Badge variant="secondary">${row.spent} spent</Badge>
      <Badge variant={broke ? "destructive" : "outline"}>
        {broke ? `$0 left · ${ago(row.ranOutAt)}` : `$${row.balance} left`}
      </Badge>
      {stored > 0 ? (
        <Badge variant="secondary">{formatBytes(stored)} stored</Badge>
      ) : null}
      <Badge variant="outline">active {ago(row.lastActiveAt)}</Badge>
      <Badge variant="outline">joined {ago(row.signedUpAt)}</Badge>
      {row.sentCount > 0 ? (
        <Badge variant="outline">
          emailed {ago(row.lastSentAt)}
          {row.sentCount > 1 ? ` · ${row.sentCount}×` : ""}
        </Badge>
      ) : null}
    </div>
  );
}

export default function SuOutreachPage() {
  const [status, setStatus] = useState<OutreachStatus>("todo");
  // The to-email list narrows to one reason; the other lists show all.
  const [reason, setReason] = useState<OutreachReason | undefined>();
  const [query, setQuery] = useState("");
  // A search starts wide — matches from every tab in one list — and clicking
  // a tab pins it to that group until the next search begins.
  const [scoped, setScoped] = useState(false);
  const [sendTarget, setSendTarget] = useState<OutreachRow | null>(null);
  // The needle trails the field by a beat, so a search fires once per pause
  // in typing; clearing the field (handled in the input's onChange) brings
  // the plain list back at once.
  const [needle, setNeedle] = useState("");
  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed === "") return;
    const timer = setTimeout(() => setNeedle(trimmed), 300);
    return () => clearTimeout(timer);
  }, [query]);
  const list = useOutreach(status, status === "todo" ? reason : undefined);
  // Search matches in the database across every tab, so a hit past the page
  // cap is still found and every tab reports its true match count.
  const search = useOutreachSearch(needle, scoped ? status : undefined);
  const countsData = useOutreachCounts().data;
  const counts = countsData?.counts;
  const act = useOutreachAction();
  const busy = useBusyOutreachIds();

  // An address that is not on the list is put there, then opened for a note.
  const addByEmail = () =>
    act.mutate({ action: "add", email: needle }, { onSuccess: (result) => setSendTarget(result.row) });

  const searching = needle !== "";
  const allTabs = searching && !scoped;
  const rows = searching ? (search.data?.rows ?? []) : (list.data?.rows ?? []);
  const loading = searching ? search.isPending : list.isPending;
  // Badges show the server's numbers: match counts while searching, list
  // totals otherwise; while either is still loading they show nothing.
  const tabCounts = searching ? search.data?.counts : counts;
  // The rows are one page of the matches; when there are more, the list says
  // so instead of passing a page off as the whole answer.
  const matchTotal = search.data
    ? scoped
      ? search.data.counts[status]
      : FILTERS.reduce((sum, filter) => sum + search.data.counts[filter.status], 0)
    : 0;
  const truncated = searching && matchTotal > rows.length;
  const addFailed = act.isError && act.variables?.action === "add";
  const adding = act.isPending && act.variables?.action === "add";

  return (
    <div className="space-y-4 pb-9">
      <Input
        aria-label="Search name or email"
        className="max-w-sm"
        onChange={(event) => {
          if (query.trim() === "" || event.target.value.trim() === "") {
            setScoped(false);
          }
          if (event.target.value.trim() === "") setNeedle("");
          setQuery(event.target.value);
        }}
        placeholder="Search name or email"
        type="search"
        value={query}
      />

      <div className="flex flex-wrap items-center gap-2">
        {FILTERS.map((filter) => (
          <Button
            key={filter.status}
            onClick={() => {
              setStatus(filter.status);
              setScoped(true);
            }}
            size="sm"
            variant={
              !allTabs && status === filter.status ? "default" : "outline"
            }
          >
            {filter.label}
            {tabCounts ? (
              <span className="tabular-nums opacity-60">
                {tabCounts[filter.status]}
              </span>
            ) : null}
          </Button>
        ))}
      </div>

      {status === "todo" && !allTabs ? (
        <div className="flex flex-wrap items-center gap-1.5">
          {[undefined, ...OUTREACH_REASONS].map((id) => {
            const on = reason === id;
            const count = id ? countsData?.reasons?.[id] : counts?.todo;
            return (
              <button
                key={id ?? "all"}
                type="button"
                aria-pressed={on}
                onClick={() => setReason(id)}
                className={cn(
                  "flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors",
                  on ? "border-foreground" : "border-border text-muted-foreground hover:bg-muted/60",
                )}
              >
                {id ? OUTREACH_REASON_LABELS[id] : "All"}
                {count !== undefined ? (
                  <span className="tabular-nums opacity-60">{count}</span>
                ) : null}
              </button>
            );
          })}
        </div>
      ) : null}

      <div className="rounded-xl border bg-card">
        {rows.length > 0 ? (
          <ul className="divide-y">
            {rows.map((row) => (
              <li
                key={`${row.status}-${row.id}`}
                className="flex flex-wrap items-start justify-between gap-3 p-5"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-baseline gap-x-2">
                    <span className="text-sm font-medium">{row.name}</span>
                    <span className="truncate text-sm text-muted-foreground">
                      {row.email}
                    </span>
                  </div>
                  <RowBadges
                    group={
                      allTabs
                        ? FILTERS.find((f) => f.status === row.status)?.label
                        : undefined
                    }
                    row={row}
                  />
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {row.status === "sent" ? (
                    <Button
                      disabled={busy.has(row.id)}
                      onClick={() =>
                        act.mutate({ action: "replied", outreachId: row.id })
                      }
                      size="sm"
                      variant="outline"
                    >
                      Mark replied
                    </Button>
                  ) : null}
                  {row.status === "ignored" ? (
                    <Button
                      disabled={busy.has(row.id)}
                      onClick={() =>
                        act.mutate({ action: "unignore", outreachId: row.id })
                      }
                      size="sm"
                      variant="outline"
                    >
                      Restore
                    </Button>
                  ) : (
                    <Button
                      disabled={busy.has(row.id)}
                      onClick={() =>
                        act.mutate({ action: "ignore", outreachId: row.id })
                      }
                      size="sm"
                      variant="ghost"
                    >
                      Ignore
                    </Button>
                  )}
                  <Button
                    disabled={busy.has(row.id)}
                    onClick={() => setSendTarget(row)}
                    size="sm"
                  >
                    {row.sentCount > 0 ? "Email again" : "Email"}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-3 p-5">
            <p className="text-sm text-muted-foreground">
              {loading
                ? "Loading…"
                : searching
                  ? addFailed
                    ? `No account has the address ${needle}.`
                    : "No matches."
                  : "Nothing here. Run a scan to refresh."}
            </p>
            {searching && !loading ? (
              <Button disabled={adding} onClick={addByEmail} size="sm" variant="outline">
                {adding ? "Adding…" : `Add ${needle} to the list`}
              </Button>
            ) : null}
          </div>
        )}
      </div>

      {truncated ? (
        <p className="text-sm text-muted-foreground">
          Showing the first {rows.length} of {matchTotal} matches. Narrow the
          search to see the rest.
        </p>
      ) : null}

      {act.isError && !addFailed ? (
        <p className="text-sm text-destructive">
          That didn&apos;t go through. Run a scan and try again.
        </p>
      ) : null}

      <OutreachComposeDialog onClose={() => setSendTarget(null)} target={sendTarget} />
    </div>
  );
}
