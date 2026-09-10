"use client";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useEmailOutbox, useOutboxAction, type OutboxItem, type OutboxOverview } from "@/queries/emailOutbox";

function formatWhen(iso: string): string {
  const then = new Date(iso);
  const mins = Math.round((then.getTime() - Date.now()) / 60000);
  const abs = Math.abs(mins);
  if (abs < 1) return "now";
  const span =
    abs < 60
      ? `${abs}m`
      : abs < 60 * 24
        ? `${Math.floor(abs / 60)}h`
        : then.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return mins < 0 ? `${span} ago` : `in ${span}`;
}

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

const stateDot: Record<string, string> = {
  queued: "bg-muted-foreground/40",
  sending: "bg-blue-500 animate-pulse",
  sent: "bg-emerald-500",
  skipped: "bg-muted-foreground/40",
  failed: "bg-destructive",
};

// The day's quota as three stop lines on one counter. Each bar is how far
// that class of send may go today; the fill is what has gone out so far.
function QuotaSection({ quota }: { quota: OutboxOverview["quota"] }) {
  const { forecast } = quota;
  const classes = [
    {
      label: "Manual",
      ceiling: quota.ceilings.manual,
      note:
        quota.manualReserve > 0
          ? `${quota.manualReserve} held below this for hand-sent mail while work hours remain`
          : "work hours over; the hand-sent reserve is released",
    },
    { label: "Transactional", ceiling: quota.ceilings.transactional, note: "welcome and credit emails" },
    {
      label: "Bulk",
      ceiling: quota.ceilings.bulk,
      note: `holds back ${forecast.total} for the rest of today: ${forecast.signups} signups expected, ${forecast.expiry} expiry notices owed, ${forecast.headroom} headroom`,
    },
  ];
  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-baseline gap-x-3 text-sm">
        <span className="font-medium">Today, {quota.day} UTC</span>
        <span className="text-muted-foreground">
          {quota.sent} of {quota.providerLimit} sent · resets in {formatDuration(quota.resetsInSeconds)}
        </span>
      </div>
      <ul className="space-y-3">
        {classes.map((c) => {
          const ceiling = Math.max(0, c.ceiling);
          const width = Math.min(100, (100 * ceiling) / quota.providerLimit);
          const fill = Math.min(100, (100 * Math.min(quota.sent, ceiling)) / quota.providerLimit);
          const left = Math.max(0, ceiling - quota.sent);
          return (
            <li key={c.label} className="grid grid-cols-[120px_1fr_72px] items-center gap-x-3 gap-y-0.5 text-sm">
              <span>{c.label}</span>
              <div className="relative h-2 rounded-full bg-muted">
                <div className="absolute inset-y-0 left-0 rounded-full bg-muted-foreground/25" style={{ width: `${width}%` }} />
                <div className="absolute inset-y-0 left-0 rounded-full bg-foreground" style={{ width: `${fill}%` }} />
              </div>
              <span className={cn("text-right tabular-nums", left === 0 ? "text-destructive" : "text-muted-foreground")}>
                {left} left
              </span>
              <span className="col-span-3 text-xs text-muted-foreground">{c.note}</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function KindsSection({ kinds }: { kinds: OutboxOverview["kinds"] }) {
  const cell = "py-1.5 pr-3";
  return (
    <section className="space-y-2">
      <h2 className="text-sm font-medium">Kinds, in send order</h2>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-muted-foreground">
            <tr>
              <th className="py-1 pr-3 font-normal">Kind</th>
              <th className="py-1 pr-3 font-normal">Priority</th>
              <th className="py-1 pr-3 font-normal">Quota</th>
              <th className="py-1 pr-3 text-right font-normal">Queued</th>
              <th className="py-1 pr-3 text-right font-normal">Sent today</th>
              <th className="py-1 text-right font-normal">Failed</th>
            </tr>
          </thead>
          <tbody>
            {[...kinds]
              .sort((a, b) => b.priority - a.priority)
              .map((k) => (
                <tr key={k.kind} className="border-t">
                  <td className={cn(cell, "font-medium")}>{k.kind}</td>
                  <td className={cn(cell, "tabular-nums text-muted-foreground")}>{k.priority}</td>
                  <td className={cn(cell, "text-muted-foreground")}>{k.quota}</td>
                  <td className={cn(cell, "text-right tabular-nums")}>{k.queued}</td>
                  <td className={cn(cell, "text-right tabular-nums")}>{k.sentToday}</td>
                  <td className={cn("py-1.5 text-right tabular-nums", k.failed > 0 && "text-destructive")}>{k.failed}</td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function ItemRow({ item, onRetry, retrying }: { item: OutboxItem; onRetry: () => void; retrying: boolean }) {
  const when = item.sentAt
    ? formatWhen(item.sentAt)
    : item.backingOff
      ? `retries ${formatWhen(item.notBefore)}`
      : `queued ${formatWhen(item.createdAt)}`;
  return (
    <li className="flex items-start gap-2.5">
      <span className={cn("mt-1.5 size-2 shrink-0 rounded-full", stateDot[item.state] ?? stateDot.queued)} />
      <div className="min-w-0 flex-1 text-sm">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="font-medium">{item.kind}</span>
          {item.promotionName ? <span className="text-muted-foreground">{item.promotionName}</span> : null}
          <span className="text-muted-foreground">{item.email ?? "inbox"}</span>
          <span className="text-muted-foreground">{item.state}</span>
          <span className="text-muted-foreground">{when}</span>
          {item.attempts > 0 && item.state !== "sent" ? (
            <span className="text-muted-foreground">{item.attempts} tries</span>
          ) : null}
        </div>
        {item.error ? <p className="text-destructive">{item.error}</p> : null}
      </div>
      {item.state === "failed" ? (
        <Button disabled={retrying} onClick={onRetry} size="sm" variant="outline">
          Retry
        </Button>
      ) : null}
    </li>
  );
}

function ItemsSection({ title, items, empty }: { title: string; items: OutboxItem[]; empty: string }) {
  const action = useOutboxAction();
  return (
    <section className="space-y-2">
      <h2 className="text-sm font-medium">{title}</h2>
      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">{empty}</p>
      ) : (
        <ul className="space-y-2">
          {items.map((item) => (
            <ItemRow
              key={item.id}
              item={item}
              onRetry={() => action.mutate({ action: "retry", id: item.id })}
              retrying={action.isPending}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

// The outbox: where the day's quota stands, what each kind has queued and
// sent, and the rows waiting, failed, and lately sent. The layout gates this
// route to super users, so the hook runs unconditionally.
export default function SuEmailPage() {
  const outbox = useEmailOutbox();
  if (!outbox.data) {
    return (
      <p className="pb-9 text-sm text-muted-foreground">
        {outbox.isPending ? "Loading…" : "Could not load the outbox."}
      </p>
    );
  }
  const { items } = outbox.data;
  const byState = (states: string[]) => items.filter((i) => states.includes(i.state));
  return (
    <div className="max-w-3xl space-y-8 pb-9">
      <QuotaSection quota={outbox.data.quota} />
      <KindsSection kinds={outbox.data.kinds} />
      <ItemsSection title="Waiting" items={byState(["queued", "sending"])} empty="Nothing waiting." />
      <ItemsSection title="Failed" items={byState(["failed"])} empty="Nothing failed." />
      <ItemsSection title="Recently sent" items={byState(["sent", "skipped"])} empty="Nothing sent yet." />
    </div>
  );
}
