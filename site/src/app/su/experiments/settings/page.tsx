"use client";

import { useState } from "react";

import { SchemaField, type JsonSchema } from "@/app/su/experiments/SchemaField";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { SuStandIn } from "@/app/su/SuStandIn";
import { useResetSetting, useSaveSetting, useSettings, type SettingRow } from "@/queries/settings";

// Every registered setting, editable. The value on screen is what the product
// reads for everyone outside an experiment; Reset returns it to the default
// declared in code.
export default function SuSettingsPage() {
  const settings = useSettings();
  if (!settings.data) {
    return <SuStandIn />;
  }
  if (settings.data.settings.length === 0) {
    return (
      <p className="max-w-2xl text-sm text-muted-foreground">
        No setting is registered yet. A feature declares one in the settings registry and it
        appears here, with a form drawn from its schema.
      </p>
    );
  }
  return (
    <div className="max-w-2xl space-y-6 pb-9">
      {settings.data.settings.map((row) => (
        <SettingCard key={row.key} row={row} />
      ))}
    </div>
  );
}

function SettingCard({ row }: { row: SettingRow }) {
  const save = useSaveSetting();
  const reset = useResetSetting();
  const [draft, setDraft] = useState<unknown>(row.value);
  const [savedFrom, setSavedFrom] = useState(() => JSON.stringify(row.value));
  // A save or reset that lands replaces the row; the draft follows it. The
  // comparison is by content: a refetch hands back an equal object under a
  // new reference, and that must not throw away what is being typed.
  const incoming = JSON.stringify(row.value);
  if (savedFrom !== incoming) {
    setSavedFrom(incoming);
    setDraft(row.value);
  }
  const dirty = JSON.stringify(draft) !== JSON.stringify(row.value);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          {row.title}
          <Badge variant="outline">{row.public ? "public" : "server"}</Badge>
          {row.overridden ? <Badge variant="secondary">overridden</Badge> : null}
          {row.invalid ? <Badge variant="destructive">invalid, reset</Badge> : null}
        </CardTitle>
        <CardDescription>{row.description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <SchemaField
          id={`setting-${row.key}`}
          schema={row.schema as JsonSchema}
          value={draft}
          onChange={setDraft}
        />
        <div className="flex items-center gap-2">
          <Button
            disabled={!dirty || save.isPending}
            onClick={() => save.mutate({ key: row.key, value: draft })}
          >
            {save.isPending ? "Saving…" : "Save"}
          </Button>
          <Button
            variant="outline"
            disabled={!row.overridden || reset.isPending}
            onClick={() => reset.mutate(row.key)}
          >
            Reset to default
          </Button>
          {row.updatedAt ? (
            <span className="text-xs text-muted-foreground">
              changed {new Date(row.updatedAt).toLocaleString()}
            </span>
          ) : null}
        </div>
        {save.isError ? (
          <p className="text-sm text-destructive">The value was rejected. Check each field.</p>
        ) : null}
      </CardContent>
    </Card>
  );
}
