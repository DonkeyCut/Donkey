"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { useAccount } from "@/queries/credits";
import {
  recentJobsQueryKey,
  useJobStatus,
  useRecentJobs,
  useStartJob,
  type AsyncJobListItem,
} from "@/queries/jobs";

// The list shows each job's stored payload and result as-is, so it stays
// honest for job kinds this card doesn't know about: flatten the primitive
// fields into "email: x@y.com · projects: 3".
function describeFields(value: unknown): string {
  if (typeof value !== "object" || value === null) return "";
  return Object.entries(value)
    .filter(([, v]) => ["string", "number", "boolean"].includes(typeof v))
    .map(([k, v]) => `${k}: ${String(v)}`)
    .join(" · ");
}

function deletedSentence(
  email: string,
  result: Record<string, unknown> | undefined,
): string {
  return (
    `Deleted ${email} — ${String(result?.projects ?? 0)} project(s), ` +
    `${String(result?.libraryAssets ?? 0)} library asset(s), ` +
    `${String(result?.r2Objects ?? 0)} stored object(s).`
  );
}

// A finished delete-user job reads as the same sentence as the inline status;
// other kinds (and unfinished jobs) keep the flattened raw fields.
function doneSummary(item: AsyncJobListItem): string | null {
  if (item.kind !== "delete-user" || item.state !== "done") return null;
  const payload = item.payload as { email?: unknown } | null;
  const email = typeof payload?.email === "string" ? payload.email : "";
  return deletedSentence(email, item.result);
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

// Super-user tooling on the profile page. Today: delete a user and everything
// they own, for cleaning production test accounts out of the data. The delete
// runs as a background job on the hosted API; this card starts it and polls
// the outcome. The confirm dialog makes the super user retype the email so a
// paste-slip can't take out the wrong account.
export function SuperuserSection() {
  const account = useAccount();
  const queryClient = useQueryClient();
  const start = useStartJob();
  const [email, setEmail] = useState("");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmEmail, setConfirmEmail] = useState("");
  // The job being watched, and the address it was started for — the input
  // clears on start, so the status line needs its own copy.
  const [jobId, setJobId] = useState<string | null>(null);
  const [jobEmail, setJobEmail] = useState("");
  const job = useJobStatus(jobId);
  // Every hook here is gated so a non-super user's browser never calls the
  // job APIs at all: the list is disabled below, and the status poll only
  // starts once this card has itself started a job.
  const superUser = account.data?.superUser === true;
  const recent = useRecentJobs(superUser);

  // Render nothing for non-super users (and while we don't yet know).
  if (!superUser) {
    return null;
  }

  const target = email.trim();
  const confirmed = target !== "" && confirmEmail.trim() === target;

  const openConfirm = () => {
    setConfirmEmail("");
    setConfirmOpen(true);
  };

  const submit = () => {
    if (!confirmed) return;
    start.mutate(
      { kind: "delete-user", payload: { email: target } },
      {
        onSuccess: ({ jobId: startedId }) => {
          setJobId(startedId);
          setJobEmail(target);
          setEmail("");
          setConfirmOpen(false);
          queryClient.invalidateQueries({ queryKey: recentJobsQueryKey });
        },
      },
    );
  };

  const state = job.data?.state;
  const running = jobId !== null && (job.isPending || state === "queued" || state === "running");

  return (
    <div className="rounded-xl border bg-card p-5">
      <div className="text-sm font-medium">Super user</div>
      <div className="mt-4 space-y-3 border-t pt-4">
        <div>
          <div className="text-sm font-medium">Delete user</div>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Permanently deletes the account and everything it owns — projects,
            media, credits, and billing.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Input
            aria-label="User email"
            className="max-w-xs"
            id="delete-user-email"
            onChange={(event) => setEmail(event.target.value)}
            placeholder="user@example.com"
            type="email"
            value={email}
          />
          <Button
            disabled={target === "" || start.isPending || running}
            onClick={openConfirm}
            variant="destructive"
          >
            Delete User
          </Button>
        </div>

        {running ? (
          <p className="text-sm text-muted-foreground">Deleting {jobEmail}…</p>
        ) : null}
        {state === "done" ? (
          <p className="text-sm text-muted-foreground">
            {deletedSentence(jobEmail, job.data?.result)}
          </p>
        ) : null}
        {state === "error" ? (
          <p className="text-sm text-destructive">
            Couldn&apos;t delete {jobEmail}: {job.data?.error ?? "unknown error"}
          </p>
        ) : null}
        {start.isError ? (
          <p className="text-sm text-destructive">
            Couldn&apos;t start the delete — check the email and try again.
          </p>
        ) : null}
      </div>

      <div className="mt-4 border-t pt-4">
        <div className="text-sm font-medium">Recent jobs</div>
        {recent.data?.jobs.length ? (
          <ul className="mt-3 space-y-3">
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
        ) : (
          <p className="mt-3 text-sm text-muted-foreground">
            {recent.isPending ? "Loading…" : "No jobs yet."}
          </p>
        )}
      </div>

      <Dialog onOpenChange={setConfirmOpen} open={confirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete {target}?</DialogTitle>
            <DialogDescription>
              This permanently deletes the account and all of its data:
              projects, media, library, chats, credits, and billing. Type the
              email to confirm.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="delete-user-confirm">Email</Label>
            <Input
              autoComplete="off"
              id="delete-user-confirm"
              onChange={(event) => setConfirmEmail(event.target.value)}
              placeholder={target}
              type="email"
              value={confirmEmail}
            />
          </div>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>
              Cancel
            </DialogClose>
            <Button
              disabled={!confirmed || start.isPending}
              onClick={submit}
              variant="destructive"
            >
              {start.isPending ? "Starting…" : "Delete everything"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
