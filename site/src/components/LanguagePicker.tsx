"use client";

import { BR, CN, DE, ES, FR, JP, KR, US } from "country-flag-icons/react/3x2";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { switchLocale } from "@/i18n/localeCookie";
import { LOCALE_NAMES, LOCALES, isLocale, type Locale } from "@/i18n/locales";

// Where the picker sits decides how its trigger looks: the marketing footer's
// bold bordered style, or the settings rows' compact one.
type Placement = "footer" | "settings";

const TRIGGER_CLASS: Record<Placement, string> = {
  footer: "h-9 gap-2 rounded-lg border-2 border-foreground bg-card text-[15px] font-semibold text-foreground",
  settings: "w-44",
};

// The footer sits at the bottom of the page, so its menu opens upward with the
// whole list showing. The settings menu lands on the chosen language.
const MENU_PROPS: Record<Placement, { side?: "top"; align?: "start"; alignItemWithTrigger: boolean }> = {
  footer: { side: "top", align: "start", alignItemWithTrigger: false },
  settings: { alignItemWithTrigger: true },
};

// The flag beside each language: the country its translation is written for.
const FLAG: Record<Locale, typeof US> = {
  en: US,
  es: ES,
  "pt-BR": BR,
  fr: FR,
  de: DE,
  ja: JP,
  ko: KR,
  "zh-CN": CN,
};

// A flag and the language's own name, in the menu and in the trigger. The
// hairline keeps the white flags (Japan, Korea) visible on a light menu.
function LanguageLabel({ locale }: { locale: Locale }) {
  const Flag = FLAG[locale];
  return (
    <span className="flex min-w-0 items-center gap-2">
      <span className="h-3 w-[18px] shrink-0 overflow-hidden rounded-[2px] ring-1 ring-foreground/15">
        <Flag aria-hidden className="block size-full" />
      </span>
      <span className="truncate">{LOCALE_NAMES[locale]}</span>
    </span>
  );
}

/**
 * The language menu. Each language is named in itself; choosing one saves it
 * (the account's copy too, through `save`, when someone is signed in) and
 * reloads the page in it.
 */
export function LanguagePicker({
  placement,
  save,
}: {
  placement: Placement;
  save?: (locale: Locale) => Promise<unknown>;
}) {
  const t = useTranslations("common");
  const locale = useLocale();
  const [busy, setBusy] = useState(false);

  // Save first, so the reload already reads the account's new choice.
  const pick = async (value: unknown) => {
    if (!isLocale(value) || value === locale) {
      return;
    }
    setBusy(true);
    try {
      await save?.(value);
    } finally {
      switchLocale(value);
    }
  };

  return (
    <Select value={locale} onValueChange={(value) => void pick(value)} disabled={busy}>
      <SelectTrigger aria-label={t("language")} className={TRIGGER_CLASS[placement]}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent {...MENU_PROPS[placement]}>
        {LOCALES.map((choice) => (
          <SelectItem key={choice} value={choice} lang={choice}>
            <LanguageLabel locale={choice} />
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
