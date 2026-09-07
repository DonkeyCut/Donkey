"use client";

import { SettingCard } from "@/app/su/experiments/SettingCard";
import { SuStandIn } from "@/app/su/SuStandIn";
import { useSettings } from "@/queries/settings";

// Every registered setting, editable.
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
