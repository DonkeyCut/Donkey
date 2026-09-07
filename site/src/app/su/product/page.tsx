"use client";

import { SettingCard } from "@/app/su/experiments/SettingCard";
import { SuStandIn } from "@/app/su/SuStandIn";
import { PRODUCT_SETTING_KEYS } from "@/lib/config/registry";
import { useSettings } from "@/queries/settings";

// The settings that shape what an account gets, drawn with the same cards as
// the settings tab under Experiments.
const productKeys: ReadonlySet<string> = new Set(PRODUCT_SETTING_KEYS);

export default function SuProductPage() {
  const settings = useSettings();
  if (!settings.data) {
    return <SuStandIn />;
  }
  return (
    <div className="max-w-2xl space-y-6 pb-9">
      {settings.data.settings
        .filter((row) => productKeys.has(row.key))
        .map((row) => (
          <SettingCard key={row.key} row={row} />
        ))}
    </div>
  );
}
