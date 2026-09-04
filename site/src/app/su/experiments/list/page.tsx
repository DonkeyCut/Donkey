"use client";

import { useState } from "react";

import { ExperimentDialog } from "@/app/su/experiments/ExperimentDialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { describeAudience } from "@donkeycut/abexp";
import type { ExperimentStatus } from "@/lib/config/experiment";
import type { MetricResult, VerdictState } from "@donkeycut/abexp";
import {
  useAddHoldout,
  useComputeResults,
  useDeleteExperiment,
  useExperiments,
  useHoldout,
  useRemoveAssignment,
  useRemoveHoldout,
  useSetAssignment,
  useSetExperimentStatus,
  type ExperimentSummary,
} from "@/queries/experiments";

type BadgeVariant = "default" | "secondary" | "outline" | "destructive";

const STATUS_VARIANT: Record<ExperimentStatus, BadgeVariant> = {
  draft: "outline",
  running: "default",
  paused: "secondary",
  ended: "destructive",
};

const VERDICT: Record<VerdictState, { label: string; variant: BadgeVariant }> = {
  insufficient: { label: "Too early", variant: "outline" },
  keep_running: { label: "Keep running", variant: "secondary" },
  ship: { label: "Ship it", variant: "default" },
  stop: { label: "Stop it", variant: "destructive" },
};


const HOLD_OUT_KEY = "__hold_out__";

const pct = (x: number) => `${(100 * x).toFixed(1)}%`;
const when = (iso: string) => new Date(iso).toLocaleString();

export default function SuExperimentsListPage() {
  const experiments = useExperiments();
  const [editing, setEditing] = useState<ExperimentSummary | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  // The dialog mounts fresh per open so its draft starts from the row.
  const [dialogKey, setDialogKey] = useState(0);
  const open = (e: ExperimentSummary | null) => {
    setEditing(e);
    setDialogKey((k) => k + 1);
    setDialogOpen(true);
  };

  if (!experiments.data) return <Skeleton className="h-40 w-full" />;

  return (
    <div className="space-y-6 pb-9">
      <div className="flex justify-end">
        <Button onClick={() => open(null)}>New experiment</Button>
      </div>
      {experiments.data.experiments.length === 0 ? (
        <p className="text-sm text-muted-foreground">No experiments yet.</p>
      ) : null}
      {experiments.data.experiments.map((e) => (
        <ExperimentRow key={e.id} experiment={e} onEdit={() => open(e)} />
      ))}
      <Holdout />
      {dialogOpen ? (
        <ExperimentDialog key={dialogKey} existing={editing} open={dialogOpen} onOpenChange={setDialogOpen} />
      ) : null}
    </div>
  );
}

function ExperimentRow({ experiment: e, onEdit }: { experiment: ExperimentSummary; onEdit: () => void }) {
  const setStatus = useSetExperimentStatus();
  const remove = useDeleteExperiment();
  const compute = useComputeResults();
  const status = e.status as ExperimentStatus;
  const go = (next: ExperimentStatus) => setStatus.mutate({ id: e.id, status: next });
  const busy = setStatus.isPending || remove.isPending;

  return (
    <div className="rounded-lg border p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-medium">{e.name}</span>
            <span className="font-mono text-xs text-muted-foreground">{e.key}</span>
            <Badge variant={STATUS_VARIANT[status]}>{status}</Badge>
          </div>
          {e.description ? <p className="mt-1 text-sm text-muted-foreground">{e.description}</p> : null}
          <p className="mt-1 text-xs text-muted-foreground">
            {describeAudience(e.audience)} · {e.percent}% enrolled
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {status === "draft" ? (
            <Button size="sm" disabled={busy} onClick={() => go("running")}>
              Start
            </Button>
          ) : null}
          {status === "running" ? (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => go("paused")}>
              Pause
            </Button>
          ) : null}
          {status === "paused" ? (
            <Button size="sm" disabled={busy} onClick={() => go("running")}>
              Resume
            </Button>
          ) : null}
          {status === "running" || status === "paused" ? (
            <Button size="sm" variant="destructive" disabled={busy} onClick={() => go("ended")}>
              End
            </Button>
          ) : null}
          {status !== "ended" ? (
            <Button size="sm" variant="ghost" onClick={onEdit}>
              Edit
            </Button>
          ) : null}
          {status === "draft" ? (
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => remove.mutate(e.id)}>
              Delete
            </Button>
          ) : null}
        </div>
      </div>

      <table className="mt-3 w-full text-sm">
        <thead className="text-left text-xs text-muted-foreground">
          <tr>
            <th className="py-1 font-normal">Variant</th>
            <th className="py-1 font-normal">Weight</th>
            <th className="py-1 font-normal">Changes</th>
            <th className="py-1 text-right font-normal">Assigned</th>
            <th className="py-1 text-right font-normal">Exposed</th>
          </tr>
        </thead>
        <tbody>
          {e.variants.map((v, i) => {
            const stat = e.stats.find((s) => s.key === v.key);
            return (
              <tr key={v.key} className="border-t">
                <td className="py-1.5">
                  {v.name} <span className="font-mono text-xs text-muted-foreground">{v.key}</span>
                  {i === 0 ? <span className="ml-1 text-xs text-muted-foreground">control</span> : null}
                </td>
                <td className="py-1.5 tabular-nums">{v.weight}</td>
                <td className="py-1.5 text-xs text-muted-foreground">
                  {Object.keys(v.config).join(", ") || "nothing"}
                </td>
                <td className="py-1.5 text-right tabular-nums">{stat?.assigned ?? 0}</td>
                <td className="py-1.5 text-right tabular-nums">{stat?.exposed ?? 0}</td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {status !== "draft" ? (
        <div className="mt-4 space-y-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium">Results</span>
              {e.results ? (
                <Badge variant={VERDICT[e.results.verdict.state].variant}>
                  {VERDICT[e.results.verdict.state].label}
                </Badge>
              ) : null}
              <span className="text-xs text-muted-foreground">
                {e.resultsAt ? `computed ${when(e.resultsAt)}` : "not computed yet; the nightly run will"}
              </span>
            </div>
            <Button size="sm" variant="outline" disabled={compute.isPending} onClick={() => compute.mutate(e.id)}>
              {compute.isPending ? "Computing…" : "Compute now"}
            </Button>
          </div>
          {compute.isError ? <p className="text-sm text-destructive">{compute.error.message}</p> : null}
          {e.results ? (
            <>
              <p className="text-sm">
                {e.results.verdict.reason}
                {e.results.verdict.neededPerArm !== null && e.results.verdict.state !== "ship" ? (
                  <span className="text-muted-foreground">
                    {" "}
                    About {e.results.verdict.neededPerArm.toLocaleString()} exposed per arm reads a{" "}
                    {Math.round(100 * plannedLift(e.results.metrics[0]))}% lift.
                  </span>
                ) : null}
              </p>
              {e.results.metrics.map((m) => (
                <MetricTable key={m.key} metric={m} control={e.results!.control} />
              ))}
              {e.results.notes.map((note) => (
                <p key={note} className="text-xs text-muted-foreground">
                  {note}
                </p>
              ))}
            </>
          ) : null}
        </div>
      ) : null}

      <Overrides experiment={e} />
    </div>
  );
}

// The lift the sample-size estimate planned for: the larger of the standard
// one and what the arms have shown so far.
function plannedLift(metric: MetricResult | undefined): number {
  const observed = metric?.comparisons.map((c) => Math.abs(c.relativeLift ?? 0)) ?? [];
  return Math.max(0.2, ...observed);
}

function MetricTable({ metric, control }: { metric: MetricResult; control: string }) {
  return (
    <table className="w-full text-sm">
      <thead className="text-left text-xs text-muted-foreground">
        <tr>
          <th className="py-1 font-normal">
            {metric.name}
            {metric.event ? <span className="ml-1 font-mono">{metric.event}</span> : null}
          </th>
          <th className="py-1 text-right font-normal">Exposed</th>
          <th className="py-1 text-right font-normal">Converted</th>
          <th className="py-1 text-right font-normal">Rate</th>
          <th className="py-1 text-right font-normal">Lift</th>
          <th className="py-1 text-right font-normal">p</th>
          <th className="py-1 text-right font-normal">Beats control</th>
        </tr>
      </thead>
      <tbody>
        {metric.variants.map((v) => {
          const cmp = metric.comparisons.find((c) => c.variant === v.key);
          return (
            <tr key={v.key} className="border-t">
              <td className="py-1 font-mono text-xs">{v.key}</td>
              <td className="py-1 text-right tabular-nums">{v.exposed}</td>
              <td className="py-1 text-right tabular-nums">{v.converted}</td>
              <td className="py-1 text-right tabular-nums">{pct(v.rate)}</td>
              <td className="py-1 text-right tabular-nums">
                {v.key === control ? "—" : cmp?.relativeLift === null || cmp === undefined ? "n/a" : pct(cmp.relativeLift)}
              </td>
              <td className="py-1 text-right tabular-nums">
                {v.key === control ? "—" : cmp?.pValue == null ? "n/a" : cmp.pValue.toFixed(3)}
              </td>
              <td className="py-1 text-right tabular-nums">
                {v.key === control || !cmp ? "—" : pct(cmp.probabilityBeatsControl)}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

// Assignments written by hand: an account put into a variant, or held out of
// this one experiment.
function Overrides({ experiment: e }: { experiment: ExperimentSummary }) {
  const set = useSetAssignment();
  const remove = useRemoveAssignment();
  const [email, setEmail] = useState("");
  const [variant, setVariant] = useState<string>(e.variants[0]?.key ?? HOLD_OUT_KEY);
  const submit = () => {
    if (!email.trim()) return;
    set.mutate(
      { id: e.id, email: email.trim(), variant: variant === HOLD_OUT_KEY ? null : variant },
      { onSuccess: () => setEmail("") },
    );
  };
  return (
    <div className="mt-4 space-y-2">
      <span className="text-sm font-medium">Overrides</span>
      {e.overrides.length > 0 ? (
        <ul className="space-y-1 text-sm">
          {e.overrides.map((o) => (
            <li key={o.userId} className="flex items-center gap-2">
              <span>{o.email}</span>
              <span className="font-mono text-xs text-muted-foreground">{o.variant ?? "held out"}</span>
              <Button
                size="sm"
                variant="ghost"
                disabled={remove.isPending}
                onClick={() => remove.mutate({ id: e.id, userId: o.userId })}
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="flex items-center gap-2">
        <Input
          className="max-w-xs"
          placeholder="account email"
          value={email}
          onChange={(ev) => setEmail(ev.target.value)}
          onKeyDown={(ev) => {
            if (ev.key === "Enter") submit();
          }}
        />
        <Select value={variant} onValueChange={(v) => setVariant(v ?? HOLD_OUT_KEY)}>
          <SelectTrigger className="w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {e.variants.map((v) => (
              <SelectItem key={v.key} value={v.key}>
                {v.name}
              </SelectItem>
            ))}
            <SelectItem value={HOLD_OUT_KEY}>Hold out</SelectItem>
          </SelectContent>
        </Select>
        <Button size="sm" variant="outline" disabled={set.isPending || !email.trim()} onClick={submit}>
          Set
        </Button>
      </div>
      {set.isError ? <p className="text-sm text-destructive">{set.error.message}</p> : null}
    </div>
  );
}

// Accounts kept out of every experiment.
function Holdout() {
  const holdout = useHoldout();
  const add = useAddHoldout();
  const remove = useRemoveHoldout();
  const [email, setEmail] = useState("");
  const [note, setNote] = useState("");
  const submit = () => {
    if (!email.trim()) return;
    add.mutate(
      { email: email.trim(), note: note.trim() || null },
      {
        onSuccess: () => {
          setEmail("");
          setNote("");
        },
      },
    );
  };
  return (
    <div className="rounded-lg border p-4">
      <div className="space-y-1">
        <span className="font-medium">Holdout</span>
        <p className="text-sm text-muted-foreground">
          Accounts kept out of every experiment: they are never assigned, read the plain
          configuration, and never count in a result.
        </p>
      </div>
      {holdout.data && holdout.data.holdout.length > 0 ? (
        <ul className="mt-3 space-y-1 text-sm">
          {holdout.data.holdout.map((h) => (
            <li key={h.userId} className="flex items-center gap-2">
              <span>{h.email}</span>
              {h.note ? <span className="text-xs text-muted-foreground">{h.note}</span> : null}
              <Button size="sm" variant="ghost" disabled={remove.isPending} onClick={() => remove.mutate(h.userId)}>
                Remove
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="mt-3 flex items-center gap-2">
        <Input
          className="max-w-xs"
          placeholder="account email"
          value={email}
          onChange={(ev) => setEmail(ev.target.value)}
        />
        <Input
          className="max-w-xs"
          placeholder="note"
          value={note}
          onChange={(ev) => setNote(ev.target.value)}
          onKeyDown={(ev) => {
            if (ev.key === "Enter") submit();
          }}
        />
        <Button size="sm" variant="outline" disabled={add.isPending || !email.trim()} onClick={submit}>
          Hold out
        </Button>
      </div>
      {add.isError ? <p className="mt-2 text-sm text-destructive">{add.error.message}</p> : null}
    </div>
  );
}
