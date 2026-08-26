"use client";

import { Button } from "@/components/ui/button";
import { useRunOutreachScan } from "@/queries/outreach";

export function ScanOutreachButton() {
  const scan = useRunOutreachScan();
  return (
    <div className="flex items-center gap-3">
      {scan.isError ? (
        <span className="text-sm text-destructive">Scan failed.</span>
      ) : null}
      <Button
        disabled={scan.isPending}
        onClick={() => scan.mutate()}
        size="sm"
        variant="outline"
      >
        {scan.isPending ? "Scanning…" : "Scan now"}
      </Button>
    </div>
  );
}
