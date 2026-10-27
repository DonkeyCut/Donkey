"use client";

import { useTranslations } from "next-intl";
import { useSyncExternalStore } from "react";

import { LanguagePicker } from "@/components/LanguagePicker";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useFlagCopy } from "@/app/[locale]/cut/app/(home)/settings/profile/useFlagCopy";
import { useLabels } from "@/i18n/labels";
import {
  readTheme,
  setTheme,
  subscribeTheme,
  THEME_CHOICES,
  type ThemeChoice,
} from "@/lib/theme";
import { useUpdateLocale } from "@/queries/accountProfile";
import { useAccountFlags, useSetAccountFlag } from "@/queries/featureFlags";

// Editor preferences: the language and theme, then the account flags that
// follow the user to every browser, such as what the top bar shows.
export function EditorSection() {
  const t = useTranslations("settings.editor");
  const flagCopy = useFlagCopy();
  const set = useSetAccountFlag();
  const prefs = useAccountFlags().data?.filter((f) => f.group === "editor") ?? [];

  return (
    <div className="rounded-xl border bg-card p-5">
      <div className="text-sm font-medium">{t("title")}</div>
      <div className="mt-4 border-t pt-4">
        <LanguageRow />
        <div className="mt-4 border-t pt-4">
          <ThemeRow />
        </div>
        {prefs.map((pref) => (
          <div key={pref.id} className="mt-4 border-t pt-4">
            <div className="flex items-start justify-between gap-6">
              <span className="min-w-0">
                <span className="block text-sm font-medium">{flagCopy(pref.id).title}</span>
                <span className="mt-0.5 block text-sm text-muted-foreground">
                  {flagCopy(pref.id).description}
                </span>
              </span>
              <Switch
                aria-label={flagCopy(pref.id).title}
                checked={pref.enabled}
                onCheckedChange={(v) => set.mutate({ flag: pref.id, enabled: v === true })}
              />
            </div>
          </div>
        ))}
        {set.isError && (
          <p className="mt-3 text-sm text-red-600">{t("saveFailed")}</p>
        )}
      </div>
    </div>
  );
}

// Language: saved to the account, so every browser it signs in on, its
// emails and its chat replies follow it.
function LanguageRow() {
  const t = useTranslations("settings.editor");
  const updateLocale = useUpdateLocale();

  return (
    <div className="flex items-center justify-between gap-6">
      <span className="min-w-0">
        <span className="block text-sm font-medium">{t("language")}</span>
        <span className="mt-0.5 block text-sm text-muted-foreground">{t("languageHint")}</span>
      </span>
      <LanguagePicker placement="settings" save={(locale) => updateLocale.mutateAsync(locale)} />
    </div>
  );
}

// Appearance: System follows the OS; Light and Dark pin it in this browser.
function ThemeRow() {
  const t = useTranslations("settings.editor");
  const themeLabel = useLabels("theme");
  const theme = useSyncExternalStore(subscribeTheme, readTheme, () => "system" as const);

  return (
    <div className="flex items-center justify-between gap-6">
      <span className="min-w-0">
        <span className="block text-sm font-medium">{t("appearance")}</span>
        <span className="mt-0.5 block text-sm text-muted-foreground">{t("appearanceHint")}</span>
      </span>
      <Select value={theme} onValueChange={(v) => setTheme(v as ThemeChoice)}>
        <SelectTrigger aria-label={t("appearance")} className="w-28">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {THEME_CHOICES.map((choice) => (
            <SelectItem key={choice} value={choice}>
              {themeLabel(choice)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
