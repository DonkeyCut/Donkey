"use client";

import { useState } from "react";

import { Field } from "@/app/su/Field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import type { Settings } from "@/lib/config/registry";
import {
  CLAIM_URL_PLACEHOLDER,
  OFFER_CLAIM_NAMES,
  OFFER_CLAIMS,
  type CreditOfferTerms,
  type OfferClaim,
} from "@/lib/credits/offerTerms";
import { useSettings } from "@/queries/settings";

// The credit offer an email carries, as one form: a switch that turns the
// offer on with the default terms, and the terms themselves. A promotion and
// an outreach note edit the same fields.

const NUMBERS = [
  ["dollars", "Dollars"],
  ["claimWindowDays", "Days to claim"],
  ["expiresAfterDays", "Days the credit lives"],
] as const;

/** The terms a new offer starts with: the Promotion credit offer setting,
 * or nothing until the settings have loaded. */
export function useCreditOfferDefaults(): CreditOfferTerms | undefined {
  const settings = useSettings();
  const value = settings.data?.settings.find((row) => row.key === "promotionCreditOffer")?.value as
    | Settings["promotionCreditOffer"]
    | undefined;
  if (!value) return undefined;
  const { dollars, claimWindowDays, expiresAfterDays, claim } = value;
  return { dollars, claimWindowDays, expiresAfterDays, claim };
}

export function CreditOfferFields({
  value,
  defaults,
  onChange,
  disabled = false,
  idPrefix = "offer",
  hint = `Each recipient gets their own link for AI credits; ${CLAIM_URL_PLACEHOLDER} is the link and {{claimBy}} their last day to claim.`,
}: {
  value: CreditOfferTerms | null;
  defaults: CreditOfferTerms | undefined;
  onChange: (next: CreditOfferTerms | null) => void;
  disabled?: boolean;
  idPrefix?: string;
  hint?: string;
}) {
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <Label htmlFor={`${idPrefix}-on`}>Credit offer</Label>
          <p className="text-xs text-muted-foreground">{hint}</p>
        </div>
        <Switch
          id={`${idPrefix}-on`}
          checked={value !== null}
          disabled={disabled || (value === null && !defaults)}
          onCheckedChange={(on) => onChange(on ? (defaults ?? null) : null)}
        />
      </div>
      {value ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Field label="Landed by" htmlFor={`${idPrefix}-claim`}>
            <Select
              disabled={disabled}
              value={value.claim}
              items={OFFER_CLAIM_NAMES}
              onValueChange={(v) => onChange({ ...value, claim: v as OfferClaim })}
            >
              <SelectTrigger id={`${idPrefix}-claim`} className="w-full min-w-0">
                <SelectValue className="truncate" />
              </SelectTrigger>
              <SelectContent>
                {OFFER_CLAIMS.map((claim) => (
                  <SelectItem key={claim} value={claim}>
                    {OFFER_CLAIM_NAMES[claim]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          {NUMBERS.map(([key, label]) => (
            <Field key={key} label={label} htmlFor={`${idPrefix}-${key}`}>
              <NumberInput
                id={`${idPrefix}-${key}`}
                disabled={disabled}
                value={value[key]}
                onChange={(n) => onChange({ ...value, [key]: n })}
              />
            </Field>
          ))}
        </div>
      ) : null}
    </div>
  );
}

// The field holds what is typed as text, so it can be cleared and retyped;
// the number goes up once the text is a whole number, and an empty field
// reports 0 so the form's schema refuses it. A value set from outside (a
// template load, the offer switched on) replaces the text.
function NumberInput({
  id,
  value,
  disabled,
  onChange,
}: {
  id: string;
  value: number;
  disabled: boolean;
  onChange: (n: number) => void;
}) {
  const [draft, setDraft] = useState({ text: String(value), value });
  const text = draft.value === value ? draft.text : String(value);
  return (
    <Input
      id={id}
      type="number"
      min={1}
      disabled={disabled}
      value={text}
      onChange={(e) => {
        const next = e.target.value;
        const n = next === "" ? 0 : Number(next);
        setDraft({ text: next, value: n });
        onChange(n);
      }}
    />
  );
}
