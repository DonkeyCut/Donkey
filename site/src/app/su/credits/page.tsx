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
import { SETTINGS } from "@/lib/config/registry";
import {
  creditGrantExpiryPresets,
  creditTopUpDefaultDollars,
  creditTopUpPresetsDollars,
  formatCreditExpiry,
  maxCreditGrantDollars,
  maxCreditGrantExpiryDays,
} from "@/lib/credits/top-up";
import { useAccount, useOfferCredits } from "@/queries/credits";

// Quick-pick amounts mirror the pay-as-you-go presets; super users can also type
// a custom dollar value. The grant route caps a single grant at
// maxCreditGrantDollars to guard against typos.
const presetDollars = creditTopUpPresetsDollars;

// How long the grant lives: a preset, a custom day count, or never. The pick
// starts on the lifetime the signup grant defaults to. An empty custom field
// stands for never.
const defaultExpiryDays = SETTINGS.signupCredits.default.expiresAfterDays;

function describeExpiry(days: number | null): string {
  if (days === null) return "never expires";
  const preset = creditGrantExpiryPresets.find((p) => p.days === days);
  return `expires in ${preset ? preset.label : `${days} days`}`;
}

export default function SuCreditsPage() {
  const account = useAccount();
  const grant = useOfferCredits();
  // null means "use the current user's email as the default recipient"; once the
  // super user edits the field we track their override here.
  const [emailOverride, setEmailOverride] = useState<string | null>(null);
  const [amount, setAmount] = useState(String(creditTopUpDefaultDollars));
  const [expiry, setExpiry] = useState(defaultExpiryDays === null ? "" : String(defaultExpiryDays));
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [lastResult, setLastResult] = useState<string | null>(null);

  // The layout gates this route to super users; this only bridges the beat
  // before the cached account data lands.
  if (!account.data) {
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

  const expiresAfterDays = expiry.trim() === "" ? null : Number(expiry);
  const expiryValid =
    expiresAfterDays === null ||
    (Number.isInteger(expiresAfterDays) &&
      expiresAfterDays >= 1 &&
      expiresAfterDays <= maxCreditGrantExpiryDays);
  const expiryLabel = describeExpiry(expiresAfterDays);

  const submit = () => {
    if (!amountValid || !expiryValid) {
      return;
    }
    setLastResult(null);
    grant.mutate(
      {
        amountDollars,
        expiresAfterDays,
        ...(grantingToSelf
          ? { userId: account.data.userId }
          : { email: overrideEmail }),
      },
      {
        onSuccess: (result) => {
          setLastResult(
            `Offered $${amountDollars} to ${result.targetUser.email}. The credit lands when they claim it from the email${
              result.offer.closesAt ? ` by ${formatCreditExpiry(new Date(result.offer.closesAt))}` : ""
            }${
              result.offer.expiresAfterDays === null
                ? " and never expires."
                : `, and ${describeExpiry(result.offer.expiresAfterDays)} from then.`
            }`,
          );
          // Reset back to the default recipient (the current user).
          setEmailOverride(null);
          setConfirmOpen(false);
        },
      },
    );
  };

  return (
    <div className="max-w-2xl space-y-6 pb-9">
      <Card>
        <CardHeader>
          <CardTitle>Offer credits</CardTitle>
          <CardDescription>
            The recipient gets an email with a claim button; the credit lands
            when they click it. Defaults to your account.
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

          <div className="space-y-2">
            <Label htmlFor="grant-expiry">Expires</Label>
            <div className="flex flex-wrap items-center gap-2">
              {creditGrantExpiryPresets.map((preset) => (
                <Button
                  key={preset.days}
                  onClick={() => setExpiry(String(preset.days))}
                  type="button"
                  variant={expiry === String(preset.days) ? "default" : "outline"}
                >
                  {preset.label}
                </Button>
              ))}
              <Button
                onClick={() => setExpiry("")}
                type="button"
                variant={expiry.trim() === "" ? "default" : "outline"}
              >
                Never
              </Button>
              <Input
                className="max-w-[7rem]"
                id="grant-expiry"
                max={maxCreditGrantExpiryDays}
                min={1}
                onChange={(event) => setExpiry(event.target.value)}
                placeholder="Days"
                type="number"
                value={expiry}
              />
            </div>
          </div>

          <Button
            disabled={grant.isPending || !amountValid || !expiryValid}
            onClick={() => setConfirmOpen(true)}
          >
            {grant.isPending ? "Sending…" : `Offer $${amountDollars}`}
          </Button>

          <Dialog onOpenChange={setConfirmOpen} open={confirmOpen}>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Confirm credit offer</DialogTitle>
                <DialogDescription>
                  Email <span className="font-medium">{recipientLabel}</span> an
                  offer of <span className="font-medium">${amountDollars}</span> in
                  credits? Once claimed, the credit {expiryLabel}.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <DialogClose render={<Button variant="outline" />}>
                  Cancel
                </DialogClose>
                <Button disabled={grant.isPending} onClick={submit}>
                  {grant.isPending ? "Sending…" : `Offer $${amountDollars}`}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>

          {lastResult ? (
            <p className="text-sm text-muted-foreground">{lastResult}</p>
          ) : null}
          {grant.isError ? (
            <p className="text-sm text-destructive">
              Offer failed. Check the email and amount, then try again.
            </p>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
