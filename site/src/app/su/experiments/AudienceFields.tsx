"use client";

import type { Audience, AudienceInput } from "@donkeycut/abexp";

import { Field } from "@/app/su/Field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

// The audience rules as a form: an experiment enrols by them, a promotion
// mails by them. The draft holds strings, the way the fields do; the two
// conversions below move between it and the audience schema.

export type AudienceDraft = {
  minimumAccountAgeDays: string;
  countries: string;
  createdAfter: string;
  createdBefore: string;
  plan: "any" | "free" | "pro";
  paid: "any" | "yes" | "no";
  activeWithinDays: string;
  storageUsedPercentAtLeast: string;
  creditsUsedPercentAtLeast: string;
};

export const blankAudienceDraft = (): AudienceDraft => ({
  countries: "",
  createdAfter: "",
  createdBefore: "",
  minimumAccountAgeDays: "",
  plan: "any",
  paid: "any",
  activeWithinDays: "",
  storageUsedPercentAtLeast: "",
  creditsUsedPercentAtLeast: "",
});

const day = (iso: string | null) => (iso ? iso.slice(0, 10) : "");
const numberOrBlank = (n: number | null) => (n === null ? "" : String(n));
const dayStart = (d: string) => (d ? new Date(`${d}T00:00:00Z`).toISOString() : null);
const numberOrNull = (s: string) => (s.trim() === "" ? null : Number(s));

export const audienceDraftFrom = (a: Audience): AudienceDraft => ({
  minimumAccountAgeDays: numberOrBlank(a.minimumAccountAgeDays),
  countries: a.countries.join(", "),
  createdAfter: day(a.createdAfter),
  createdBefore: day(a.createdBefore),
  plan: a.plan,
  paid: a.paid,
  activeWithinDays: numberOrBlank(a.activeWithinDays),
  storageUsedPercentAtLeast: numberOrBlank(a.storageUsedPercentAtLeast),
  creditsUsedPercentAtLeast: numberOrBlank(a.creditsUsedPercentAtLeast),
});

export const audienceInputFrom = (draft: AudienceDraft): AudienceInput => ({
  minimumAccountAgeDays: draft.minimumAccountAgeDays.trim() ? Number(draft.minimumAccountAgeDays) : null,
  countries: draft.countries
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean),
  createdAfter: dayStart(draft.createdAfter),
  createdBefore: dayStart(draft.createdBefore),
  plan: draft.plan,
  paid: draft.paid,
  activeWithinDays: numberOrNull(draft.activeWithinDays),
  storageUsedPercentAtLeast: numberOrNull(draft.storageUsedPercentAtLeast),
  creditsUsedPercentAtLeast: numberOrNull(draft.creditsUsedPercentAtLeast),
});

export function AudienceFields({
  value,
  onChange,
  countries = true,
  disabled = false,
  children,
}: {
  value: AudienceDraft;
  onChange: (patch: Partial<AudienceDraft>) => void;
  // Country is read from the request that assigns an experiment; a send has
  // no request, so a promotion's form leaves it out.
  countries?: boolean;
  disabled?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <div className="space-y-3">
      <Label>Audience</Label>
      <div className="grid grid-cols-3 gap-3">
        {countries ? (
          <Field label="Countries (empty = any)" htmlFor="aud-countries">
            <Input
              id="aud-countries"
              placeholder="US, GB, CA"
              disabled={disabled}
              value={value.countries}
              onChange={(e) => onChange({ countries: e.target.value })}
            />
          </Field>
        ) : null}
        <Field label="Created on or after" htmlFor="aud-after">
          <Input
            id="aud-after"
            type="date"
            disabled={disabled}
            value={value.createdAfter}
            onChange={(e) => onChange({ createdAfter: e.target.value })}
          />
        </Field>
        <Field label="Created before" htmlFor="aud-before">
          <Input
            id="aud-before"
            type="date"
            disabled={disabled}
            value={value.createdBefore}
            onChange={(e) => onChange({ createdBefore: e.target.value })}
          />
        </Field>
        <Field label="Signed up at least (days)" htmlFor="aud-min-age">
          <Input
            id="aud-min-age"
            type="number"
            min={1}
            max={36500}
            disabled={disabled}
            value={value.minimumAccountAgeDays}
            onChange={(e) => onChange({ minimumAccountAgeDays: e.target.value })}
          />
        </Field>
        <Field label="Plan" htmlFor="aud-plan">
          <Select
            disabled={disabled}
            value={value.plan}
            onValueChange={(v) => onChange({ plan: v as AudienceDraft["plan"] })}
          >
            <SelectTrigger id="aud-plan">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="any">Any</SelectItem>
              <SelectItem value="free">No Pro</SelectItem>
              <SelectItem value="pro">Pro</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <Field label="Has paid" htmlFor="aud-paid">
          <Select
            disabled={disabled}
            value={value.paid}
            onValueChange={(v) => onChange({ paid: v as AudienceDraft["paid"] })}
          >
            <SelectTrigger id="aud-paid">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="any">Any</SelectItem>
              <SelectItem value="yes">Yes</SelectItem>
              <SelectItem value="no">No</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <Field label="Active within days" htmlFor="aud-active">
          <Input
            id="aud-active"
            type="number"
            min={1}
            max={365}
            disabled={disabled}
            value={value.activeWithinDays}
            onChange={(e) => onChange({ activeWithinDays: e.target.value })}
          />
        </Field>
        <Field label="Storage used ≥ %" htmlFor="aud-storage">
          <Input
            id="aud-storage"
            type="number"
            min={0}
            max={100}
            disabled={disabled}
            value={value.storageUsedPercentAtLeast}
            onChange={(e) => onChange({ storageUsedPercentAtLeast: e.target.value })}
          />
        </Field>
        <Field label="Credits spent ≥ %" htmlFor="aud-credits">
          <Input
            id="aud-credits"
            type="number"
            min={0}
            max={100}
            disabled={disabled}
            value={value.creditsUsedPercentAtLeast}
            onChange={(e) => onChange({ creditsUsedPercentAtLeast: e.target.value })}
          />
        </Field>
        {children}
      </div>
    </div>
  );
}
