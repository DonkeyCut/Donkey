"use client";

import { Button } from "@/components/ui/button";
import { useEmailOutbox, useOutboxAction } from "@/queries/emailOutbox";

export function DrainNowButton() {
  const outbox = useEmailOutbox();
  const drain = useOutboxAction();
  const pending = outbox.data?.drainPending ?? false;
  return (
    <div className="flex items-center gap-3">
      {drain.isError ? <span className="text-sm text-destructive">Drain failed.</span> : null}
      <Button
        disabled={drain.isPending || pending}
        onClick={() => drain.mutate({ action: "drain" })}
        size="sm"
        variant="outline"
      >
        {pending ? "Draining…" : "Drain now"}
      </Button>
    </div>
  );
}
