"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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
import {
  creditTopUpDefaultDollars,
  creditTopUpPresetsDollars,
  maxCreditGrantDollars,
} from "@/lib/credits/top-up";
import { useAccount, useGrantCredits } from "@/queries/credits";

// Quick-pick amounts mirror the pay-as-you-go presets; super users can also type
// a custom dollar value. The grant route caps a single grant at
// maxCreditGrantDollars to guard against typos.
const presetDollars = creditTopUpPresetsDollars;

export function SuperuserCreditsCard() {
  const account = useAccount();
  const grant = useGrantCredits();
  // null means "use the current user's email as the default recipient"; once the
  // super user edits the field we track their override here.
  const [emailOverride, setEmailOverride] = useState<string | null>(null);
  const [amount, setAmount] = useState(String(creditTopUpDefaultDollars));
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [lastResult, setLastResult] = useState<string | null>(null);

  // Render nothing for non-super users (and while we don't yet know).
  if (!account.data?.superUser) {
    return null;
  }

  // The field shows the user's own email by default; only treat it as a target
  // when the super user actually overrides it. An unedited (or cleared) field
  // grants to self by the authoritative userId, not by re-resolving the email.
  const email = emailOverride ?? account.data.email ?? "";
  const overrideEmail = emailOverride?.trim() ?? "";
  const grantingToSelf = overrideEmail === "";
  const recipientLabel = grantingToSelf ? "your account" : overrideEmail;

  const amountDollars = Number(amount);
  const amountValid =
    Number.isInteger(amountDollars) &&
    amountDollars > 0 &&
    amountDollars <= maxCreditGrantDollars;

  const submit = () => {
    if (!amountValid) {
      return;
    }
    setLastResult(null);
    grant.mutate(
      {
        amountDollars,
        ...(grantingToSelf
          ? { userId: account.data.userId }
          : { email: overrideEmail }),
      },
      {
        onSuccess: (result) => {
          setLastResult(
            `Added $${amountDollars} to ${result.targetUser.email} — new balance $${result.balance.balance}.`,
          );
          // Reset back to the default recipient (the current user).
          setEmailOverride(null);
          setConfirmOpen(false);
        },
      },
    );
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          Super user · Credits
        </CardTitle>
        <CardDescription>
          Defaults to your account — change the recipient to grant to another
          user. Visible to super users only.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="space-y-2">
          <Label htmlFor="grant-email">Recipient</Label>
          <Input
            className="max-w-xs"
            id="grant-email"
            onChange={(event) => setEmailOverride(event.target.value)}
            placeholder="user@example.com"
            type="email"
            value={email}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="grant-amount">Amount (USD)</Label>
          <div className="flex flex-wrap items-center gap-2">
            {presetDollars.map((preset) => (
              <Button
                key={preset}
                onClick={() => setAmount(String(preset))}
                type="button"
                variant={amount === String(preset) ? "default" : "outline"}
              >
                ${preset}
              </Button>
            ))}
            <Input
              className="max-w-[7rem]"
              id="grant-amount"
              max={maxCreditGrantDollars}
              min={1}
              onChange={(event) => setAmount(event.target.value)}
              placeholder="Custom"
              type="number"
              value={amount}
            />
          </div>
        </div>

        <Button
          disabled={grant.isPending || !amountValid}
          onClick={() => setConfirmOpen(true)}
        >
          {grant.isPending ? "Granting…" : `Grant $${amountDollars}`}
        </Button>

        <Dialog onOpenChange={setConfirmOpen} open={confirmOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Confirm credit grant</DialogTitle>
              <DialogDescription>
                Grant <span className="font-medium">${amountDollars}</span> in
                credits to{" "}
                <span className="font-medium">{recipientLabel}</span>?
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <DialogClose render={<Button variant="outline" />}>
                Cancel
              </DialogClose>
              <Button disabled={grant.isPending} onClick={submit}>
                {grant.isPending ? "Granting…" : `Grant $${amountDollars}`}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {lastResult ? (
          <p className="text-sm text-muted-foreground">{lastResult}</p>
        ) : null}
        {grant.isError ? (
          <p className="text-sm text-destructive">
            Grant failed. Check the email and amount, then try again.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
