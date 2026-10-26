"use client";

import { useSyncExternalStore } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  readTheme,
  setTheme,
  subscribeTheme,
  THEME_CHOICES,
  THEME_LABELS,
  type ThemeChoice,
} from "@/lib/theme";
import { useAccountFlags, useSetAccountFlag } from "@/queries/featureFlags";

// Editor preferences: the theme this browser shows, then the account flags
// that follow the user to every browser, such as what the top bar shows.
export function EditorSection() {
  const set = useSetAccountFlag();
  const prefs = useAccountFlags().data?.filter((f) => f.group === "editor") ?? [];

  return (
    <div className="rounded-xl border bg-card p-5">
      <div className="text-sm font-medium">Editor</div>
      <div className="mt-4 border-t pt-4">
        <ThemeRow />
        {prefs.map((pref) => (
          <div key={pref.id} className="mt-4 border-t pt-4">
            <div className="flex items-start justify-between gap-6">
              <span className="min-w-0">
                <span className="block text-sm font-medium">{pref.title}</span>
                <span className="mt-0.5 block text-sm text-muted-foreground">
                  {pref.description}
                </span>
              </span>
              <Switch
                aria-label={pref.title}
                checked={pref.enabled}
                onCheckedChange={(v) => set.mutate({ flag: pref.id, enabled: v === true })}
              />
            </div>
          </div>
        ))}
        {set.isError && (
          <p className="mt-3 text-sm text-red-600">
            Couldn&apos;t save that change — try again.
          </p>
        )}
      </div>
    </div>
  );
}

// Appearance: System follows the OS; Light and Dark pin it in this browser.
function ThemeRow() {
  const theme = useSyncExternalStore(subscribeTheme, readTheme, () => "system" as const);

  return (
    <div className="flex items-center justify-between gap-6">
      <span className="min-w-0">
        <span className="block text-sm font-medium">Appearance</span>
        <span className="mt-0.5 block text-sm text-muted-foreground">
          Light, dark, or matching your system.
        </span>
      </span>
      <Select value={theme} onValueChange={(v) => setTheme(v as ThemeChoice)}>
        <SelectTrigger aria-label="Appearance" className="w-28">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {THEME_CHOICES.map((choice) => (
            <SelectItem key={choice} value={choice}>
              {THEME_LABELS[choice]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
