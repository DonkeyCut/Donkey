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
import { recentJobsQueryKey, useStartJob } from "@/queries/jobs";

// User actions. Today: delete a user and everything they own, for cleaning
// production test accounts out of the data. The delete runs as a background
// job on the hosted API; this page starts it, and the Jobs surface tracks it
// to completion. The confirm dialog makes the super user retype the email so
// a paste-slip can't take out the wrong account. The layout gates this route
// to super users, so the job hooks run unconditionally here.
export default function SuUsersPage() {
  const queryClient = useQueryClient();
  const start = useStartJob();
  const [email, setEmail] = useState("");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmEmail, setConfirmEmail] = useState("");

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
        onSuccess: () => {
          setEmail("");
          setConfirmOpen(false);
          queryClient.invalidateQueries({ queryKey: recentJobsQueryKey });
        },
      },
    );
  };

  return (
    <div className="max-w-2xl space-y-6 pb-9">
      <div className="rounded-xl border bg-card p-5">
        <div className="space-y-3">
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
              disabled={target === "" || start.isPending}
              onClick={openConfirm}
              variant="destructive"
            >
              Delete User
            </Button>
          </div>

          {start.isError ? (
            <p className="text-sm text-destructive">
              Couldn&apos;t start the delete — check the email and try again.
            </p>
          ) : null}
          {start.isSuccess ? (
            <p className="text-sm text-muted-foreground">
              Delete started — it runs in the background and finishes under Jobs.
            </p>
          ) : null}
        </div>
      </div>

      <Dialog onOpenChange={setConfirmOpen} open={confirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete {target}?</DialogTitle>
            <DialogDescription>
              This permanently deletes the account and all of its data. Type
              to confirm.
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
