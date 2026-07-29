"use client";

import { useProSubscription, useUsage } from "@/queries/billing";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableRow,
} from "@/components/ui/table";
import { formatUsd } from "@/lib/credits/format-usd";

// One labeled usage line (product on the left, status/amount on the right).
function UsageRow({ label, value }: { label: string; value: string }) {
  return (
    <TableRow>
      <TableCell className="font-medium text-foreground">{label}</TableCell>
      <TableCell className="text-right text-muted-foreground">
        {value}
      </TableCell>
    </TableRow>
  );
}

export function UsageCard() {
  const usage = useUsage();
  const pro = useProSubscription();

  // Only gate on the Vision usage query; the Pro row degrades on its own so a
  // slow or failing Pro request never blocks the Vision summary from rendering.
  if (usage.isLoading) {
    return (
      <Card>
        <CardContent>
          <Skeleton className="h-24 w-full" />
        </CardContent>
      </Card>
    );
  }

  const data = usage.data;
  const limit = data?.limit ?? 0;
  const extra = data?.extraRemaining ?? 0;
  const pct =
    data && limit > 0
      ? Math.min(100, Math.round((data.used / limit) * 100))
      : 0;

  // Donkey Pro is the app-inference subscription; its included allowance is spent
  // separately from the Vision API quota below. Used = allowance − remaining.
  const proData = pro.data;
  const proActive = proData?.isActive ?? false;
  const proAllowance =
    proData?.monthlyAllowance != null
      ? Number.parseFloat(proData.monthlyAllowance)
      : null;
  const proRemaining = Number.parseFloat(proData?.allowanceRemaining ?? "0");
  const proUsed =
    proAllowance != null ? Math.max(0, proAllowance - proRemaining) : null;

  // Don't assert "No Pro plan" while the Pro query is still loading or errored —
  // that would mislabel an actual Pro user. Only claim it once we have data.
  const proStatus = pro.isLoading
    ? "Loading…"
    : proActive && proUsed != null && proData?.monthlyAllowance != null
      ? `${formatUsd(String(proUsed))} of ${formatUsd(proData.monthlyAllowance)} used this month`
      : pro.isError
        ? "Unavailable"
        : "No Pro plan — using credits";

  const visionStatus =
    data && limit > 0
      ? `${data.used.toLocaleString()} of ${limit.toLocaleString()} calls used · ${data.remaining.toLocaleString()} remaining`
      : extra > 0
        ? "No subscription — using your extra calls"
        : "No active plan — subscribe to start making calls";

  return (
    <Card>
      <CardContent className="space-y-4">
        <Table>
          <TableBody>
            <UsageRow label="Donkey Pro (app)" value={proStatus} />
            <UsageRow label="Vision API" value={visionStatus} />
            {extra > 0 ? (
              <UsageRow
                label="Extra Vision API calls"
                value={`${extra.toLocaleString()} available`}
              />
            ) : null}
          </TableBody>
        </Table>
        {data && limit > 0 ? (
          <div
            aria-label="Vision API quota used"
            className="h-2 w-full overflow-hidden rounded-full bg-muted"
          >
            <div
              className="h-full rounded-full bg-primary"
              style={{ width: `${pct}%` }}
            />
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
