"use client";

import { Button } from "@/components/ui/button";
import { useRunAnalytics } from "@/queries/analytics";

export function RunAnalyticsButton() {
  const run = useRunAnalytics();
  return (
    <div className="flex items-center gap-3">
      {run.isError ? (
        <span className="text-sm text-destructive">Run failed.</span>
      ) : null}
      <Button
        disabled={run.isPending}
        onClick={() => run.mutate()}
        size="sm"
        variant="outline"
      >
        {run.isPending ? "Running…" : "Run now"}
      </Button>
    </div>
  );
}
