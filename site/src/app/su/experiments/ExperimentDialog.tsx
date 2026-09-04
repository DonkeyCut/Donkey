"use client";

import { useState } from "react";
import { Plus, X } from "lucide-react";

import { SchemaField, type JsonSchema } from "@/app/su/experiments/SchemaField";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import type { AudienceInput } from "@donkeycut/abexp";
import { METRIC_SOURCES, experimentSchema, type ExperimentInput } from "@/lib/config/experiment";
import { PUBLIC_SETTING_KEYS, SETTINGS, type SettingKey } from "@/lib/config/registry";
import { useSettings } from "@/queries/settings";
import {
  useCreateExperiment,
  useUpdateExperiment,
  type ExperimentSummary,
} from "@/queries/experiments";

// One form for a new experiment and for editing one: who it enrols, the
// variants they draw (the first is the control), and the metrics that read
// it. A variant's settings are drawn with the same fields the settings tab
// uses.

type Draft = {
  key: string;
  name: string;
  description: string;
  percent: string;
  audience: {
    countries: string;
    createdAfter: string;
    createdBefore: string;
    plan: "any" | "free" | "pro";
    paid: "any" | "yes" | "no";
    activeWithinDays: string;
    storageUsedPercentAtLeast: string;
    creditsUsedPercentAtLeast: string;
  };
  variants: { key: string; name: string; weight: string; config: Record<string, unknown> }[];
  metrics: { key: string; name: string; source: (typeof METRIC_SOURCES)[number]; event: string }[];
};

const blank = (): Draft => ({
  key: "",
  name: "",
  description: "",
  percent: "100",
  audience: {
    countries: "",
    createdAfter: "",
    createdBefore: "",
    plan: "any",
    paid: "any",
    activeWithinDays: "",
    storageUsedPercentAtLeast: "",
    creditsUsedPercentAtLeast: "",
  },
  variants: [
    { key: "control", name: "Control", weight: "50", config: {} },
    { key: "treatment", name: "Treatment", weight: "50", config: {} },
  ],
  metrics: [{ key: "purchase", name: "Purchase", source: "purchase", event: "" }],
});

const day = (iso: string | null) => (iso ? iso.slice(0, 10) : "");
const numberOrBlank = (n: number | null) => (n === null ? "" : String(n));

const fromSummary = (e: ExperimentSummary): Draft => ({
  key: e.key,
  name: e.name,
  description: e.description ?? "",
  percent: String(e.percent),
  audience: {
    countries: e.audience.countries.join(", "),
    createdAfter: day(e.audience.createdAfter),
    createdBefore: day(e.audience.createdBefore),
    plan: e.audience.plan,
    paid: e.audience.paid,
    activeWithinDays: numberOrBlank(e.audience.activeWithinDays),
    storageUsedPercentAtLeast: numberOrBlank(e.audience.storageUsedPercentAtLeast),
    creditsUsedPercentAtLeast: numberOrBlank(e.audience.creditsUsedPercentAtLeast),
  },
  variants: e.variants.map((v) => ({ ...v, weight: String(v.weight) })),
  metrics: e.metrics.map((m) => ({ ...m, event: m.event ?? "" })),
});

const dayStart = (d: string) => (d ? new Date(`${d}T00:00:00Z`).toISOString() : null);
const numberOrNull = (s: string) => (s.trim() === "" ? null : Number(s));

function toInput(draft: Draft): unknown {
  const audience: AudienceInput = {
    countries: draft.audience.countries
      .split(",")
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean),
    createdAfter: dayStart(draft.audience.createdAfter),
    createdBefore: dayStart(draft.audience.createdBefore),
    plan: draft.audience.plan,
    paid: draft.audience.paid,
    activeWithinDays: numberOrNull(draft.audience.activeWithinDays),
    storageUsedPercentAtLeast: numberOrNull(draft.audience.storageUsedPercentAtLeast),
    creditsUsedPercentAtLeast: numberOrNull(draft.audience.creditsUsedPercentAtLeast),
  };
  return {
    key: draft.key.trim(),
    name: draft.name.trim(),
    description: draft.description.trim() || null,
    audience,
    percent: Number(draft.percent),
    variants: draft.variants.map((v) => ({
      key: v.key.trim(),
      name: v.name.trim(),
      weight: Number(v.weight),
      config: v.config,
    })),
    metrics: draft.metrics.map((m) => ({
      key: m.key.trim(),
      name: m.name.trim(),
      source: m.source,
      event: m.source === "event" ? m.event.trim() || null : null,
    })),
  };
}

export function ExperimentDialog({
  existing,
  open,
  onOpenChange,
}: {
  existing: ExperimentSummary | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [draft, setDraft] = useState<Draft>(() => (existing ? fromSummary(existing) : blank()));
  const [issues, setIssues] = useState<string[]>([]);
  const create = useCreateExperiment();
  const update = useUpdateExperiment();
  const settings = useSettings();
  const schemas = new Map(settings.data?.settings.map((s) => [s.key, s.schema as JsonSchema]));
  // Anything an account holds, drawn or written by hand: the route rejects a
  // save that drops either.
  const assignedKeys = new Set([
    ...(existing?.stats.filter((s) => s.assigned > 0).map((s) => s.key) ?? []),
    ...(existing?.overrides.flatMap((o) => (o.variant === null ? [] : [o.variant])) ?? []),
  ]);
  const pending = create.isPending || update.isPending;

  const submit = () => {
    const parsed = experimentSchema.safeParse(toInput(draft));
    if (!parsed.success) {
      setIssues(parsed.error.issues.map((i) => `${i.path.join(".") || "form"}: ${i.message}`));
      return;
    }
    setIssues([]);
    const input: ExperimentInput = parsed.data;
    const done = { onSuccess: () => onOpenChange(false), onError: (e: Error) => setIssues([e.message]) };
    if (existing) update.mutate({ id: existing.id, ...input }, done);
    else create.mutate(input, done);
  };

  const setAudience = (patch: Partial<Draft["audience"]>) =>
    setDraft((d) => ({ ...d, audience: { ...d.audience, ...patch } }));
  const setVariant = (i: number, patch: Partial<Draft["variants"][number]>) =>
    setDraft((d) => ({ ...d, variants: d.variants.map((v, j) => (j === i ? { ...v, ...patch } : v)) }));
  const setMetric = (i: number, patch: Partial<Draft["metrics"][number]>) =>
    setDraft((d) => ({ ...d, metrics: d.metrics.map((m, j) => (j === i ? { ...m, ...patch } : m)) }));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{existing ? "Edit experiment" : "New experiment"}</DialogTitle>
          <DialogDescription>
            Accounts in the audience draw a variant by weight the first time they load
            the app, and keep it. The first variant is the control.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-5">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Key" htmlFor="exp-key">
              <Input
                id="exp-key"
                placeholder="welcome_copy_v1"
                value={draft.key}
                onChange={(e) => setDraft({ ...draft, key: e.target.value })}
              />
            </Field>
            <Field label="Name" htmlFor="exp-name">
              <Input id="exp-name" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
            </Field>
          </div>
          <Field label="Description" htmlFor="exp-desc">
            <Textarea
              id="exp-desc"
              rows={2}
              value={draft.description}
              onChange={(e) => setDraft({ ...draft, description: e.target.value })}
            />
          </Field>

          <div className="space-y-3">
            <Label>Audience</Label>
            <div className="grid grid-cols-3 gap-3">
              <Field label="Countries (empty = any)" htmlFor="aud-countries">
                <Input
                  id="aud-countries"
                  placeholder="US, GB, CA"
                  value={draft.audience.countries}
                  onChange={(e) => setAudience({ countries: e.target.value })}
                />
              </Field>
              <Field label="Created on or after" htmlFor="aud-after">
                <Input
                  id="aud-after"
                  type="date"
                  value={draft.audience.createdAfter}
                  onChange={(e) => setAudience({ createdAfter: e.target.value })}
                />
              </Field>
              <Field label="Created before" htmlFor="aud-before">
                <Input
                  id="aud-before"
                  type="date"
                  value={draft.audience.createdBefore}
                  onChange={(e) => setAudience({ createdBefore: e.target.value })}
                />
              </Field>
              <Field label="Plan" htmlFor="aud-plan">
                <Select value={draft.audience.plan} onValueChange={(v) => setAudience({ plan: v as Draft["audience"]["plan"] })}>
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
                <Select value={draft.audience.paid} onValueChange={(v) => setAudience({ paid: v as Draft["audience"]["paid"] })}>
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
                  value={draft.audience.activeWithinDays}
                  onChange={(e) => setAudience({ activeWithinDays: e.target.value })}
                />
              </Field>
              <Field label="Storage used ≥ %" htmlFor="aud-storage">
                <Input
                  id="aud-storage"
                  type="number"
                  min={0}
                  max={100}
                  value={draft.audience.storageUsedPercentAtLeast}
                  onChange={(e) => setAudience({ storageUsedPercentAtLeast: e.target.value })}
                />
              </Field>
              <Field label="Credits spent ≥ %" htmlFor="aud-credits">
                <Input
                  id="aud-credits"
                  type="number"
                  min={0}
                  max={100}
                  value={draft.audience.creditsUsedPercentAtLeast}
                  onChange={(e) => setAudience({ creditsUsedPercentAtLeast: e.target.value })}
                />
              </Field>
              <Field label="Percent enrolled" htmlFor="exp-percent">
                <Input
                  id="exp-percent"
                  type="number"
                  min={0}
                  max={100}
                  value={draft.percent}
                  onChange={(e) => setDraft({ ...draft, percent: e.target.value })}
                />
              </Field>
            </div>
          </div>

          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <Label>Variants</Label>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() =>
                  setDraft({
                    ...draft,
                    variants: [...draft.variants, { key: "", name: "", weight: "50", config: {} }],
                  })
                }
              >
                <Plus /> Add variant
              </Button>
            </div>
            {draft.variants.map((variant, i) => (
              <div key={i} className="space-y-3 rounded-lg border p-3">
                <div className="grid grid-cols-[1fr_1fr_100px_auto] items-end gap-2">
                  <Field label={i === 0 ? "Key (control)" : "Key"} htmlFor={`v-${i}-key`}>
                    <Input
                      id={`v-${i}-key`}
                      disabled={assignedKeys.has(variant.key)}
                      value={variant.key}
                      onChange={(e) => setVariant(i, { key: e.target.value })}
                    />
                  </Field>
                  <Field label="Name" htmlFor={`v-${i}-name`}>
                    <Input id={`v-${i}-name`} value={variant.name} onChange={(e) => setVariant(i, { name: e.target.value })} />
                  </Field>
                  <Field label="Weight" htmlFor={`v-${i}-weight`}>
                    <Input
                      id={`v-${i}-weight`}
                      type="number"
                      min={0}
                      value={variant.weight}
                      onChange={(e) => setVariant(i, { weight: e.target.value })}
                    />
                  </Field>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label="Remove variant"
                    disabled={assignedKeys.has(variant.key) || draft.variants.length <= 1}
                    onClick={() =>
                      setDraft({ ...draft, variants: draft.variants.filter((_, j) => j !== i) })
                    }
                  >
                    <X />
                  </Button>
                </div>
                {PUBLIC_SETTING_KEYS.length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    No public setting is registered yet; the app reads the variant key itself.
                  </p>
                ) : null}
                <div className="grid gap-2">
                  {PUBLIC_SETTING_KEYS.map((key: SettingKey) => {
                    const carries = key in variant.config;
                    return (
                      <div key={key} className="space-y-2">
                        <div className="flex items-center gap-2">
                          <Switch
                            checked={carries}
                            onCheckedChange={(on) => {
                              const config = { ...variant.config };
                              if (on) config[key] = structuredClone(SETTINGS[key].default);
                              else delete config[key];
                              setVariant(i, { config });
                            }}
                          />
                          <span className="text-sm">{SETTINGS[key].title}</span>
                          <span className="text-xs text-muted-foreground">{key}</span>
                        </div>
                        {carries && schemas.get(key) ? (
                          <div className="pl-10">
                            <SchemaField
                              id={`v-${i}-${key}`}
                              schema={schemas.get(key)!}
                              value={variant.config[key]}
                              onChange={(next) =>
                                setVariant(i, { config: { ...variant.config, [key]: next } })
                              }
                            />
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>

          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <Label>Metrics</Label>
                <p className="text-xs text-muted-foreground">
                  Counted per exposed account, after its exposure. The first decides the verdict.
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() =>
                  setDraft({
                    ...draft,
                    metrics: [...draft.metrics, { key: "", name: "", source: "event", event: "" }],
                  })
                }
              >
                <Plus /> Add metric
              </Button>
            </div>
            {draft.metrics.map((metric, i) => (
              <div key={i} className="grid grid-cols-[1fr_1fr_140px_1fr_auto] items-end gap-2">
                <Field label={i === 0 ? "Key (primary)" : "Key"} htmlFor={`m-${i}-key`}>
                  <Input id={`m-${i}-key`} value={metric.key} onChange={(e) => setMetric(i, { key: e.target.value })} />
                </Field>
                <Field label="Name" htmlFor={`m-${i}-name`}>
                  <Input id={`m-${i}-name`} value={metric.name} onChange={(e) => setMetric(i, { name: e.target.value })} />
                </Field>
                <Field label="Source" htmlFor={`m-${i}-source`}>
                  <Select
                    value={metric.source}
                    onValueChange={(v) => setMetric(i, { source: v as Draft["metrics"][number]["source"] })}
                  >
                    <SelectTrigger id={`m-${i}-source`}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="event">PostHog event</SelectItem>
                      <SelectItem value="purchase">Purchase</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
                <Field label="Event" htmlFor={`m-${i}-event`}>
                  <Input
                    id={`m-${i}-event`}
                    disabled={metric.source !== "event"}
                    placeholder="export_completed"
                    value={metric.event}
                    onChange={(e) => setMetric(i, { event: e.target.value })}
                  />
                </Field>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label="Remove metric"
                  onClick={() => setDraft({ ...draft, metrics: draft.metrics.filter((_, j) => j !== i) })}
                >
                  <X />
                </Button>
              </div>
            ))}
          </div>

          {issues.length > 0 ? (
            <ul className="space-y-1 text-sm text-destructive">
              {issues.map((issue) => (
                <li key={issue}>{issue}</li>
              ))}
            </ul>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={pending} onClick={submit}>
            {pending ? "Saving…" : existing ? "Save" : "Create draft"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, htmlFor, children }: { label: string; htmlFor: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={htmlFor} className="text-xs text-muted-foreground">
        {label}
      </Label>
      {children}
    </div>
  );
}
