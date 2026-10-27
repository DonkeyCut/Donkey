"use client";

import { BR, CN, DE, ES, FR, JP, KR, US } from "country-flag-icons/react/3x2";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { switchLocale } from "@/i18n/localeCookie";
import { ApiError } from "@/queries/apiClient";
import { useUpdateLocale } from "@/queries/accountProfile";
import { LOCALE_NAMES, LOCALES, isLocale, type Locale } from "@/i18n/locales";

// Where the picker sits decides how its trigger sizes: fit to the label in the
// marketing footer, a fixed width in the settings rows.
type Placement = "footer" | "settings";

const TRIGGER_CLASS: Record<Placement, string> = {
  footer: "gap-2",
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

// The account answers 401 to a visitor who is not signed in; their choice
// lives in this browser alone.
const UNAUTHORIZED = 401;

// Why a pick did not take, worded under `common`.
type PickFailure = "languageSaveFailed" | "languageBlocked";

/**
 * The language menu. Each language is named in itself; choosing one saves it
 * to the account when someone is signed in, so the editor does not switch it
 * back, then reloads the page in it.
 */
export function LanguagePicker({ placement }: { placement: Placement }) {
  const t = useTranslations("common");
  const locale = useLocale();
  const updateLocale = useUpdateLocale();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<PickFailure | null>(null);

  // Save first, so the reload already reads the account's new choice. A save
  // that fails leaves the page as it is: switching anyway would be undone by
  // the account's old language on the next editor load.
  const pick = async (value: unknown) => {
    if (!isLocale(value) || value === locale) {
      return;
    }
    setBusy(true);
    setFailure(null);
    try {
      await updateLocale.mutateAsync(value);
    } catch (error) {
      if (!(error instanceof ApiError && error.status === UNAUTHORIZED)) {
        setFailure("languageSaveFailed");
        setBusy(false);
        return;
      }
    }
    if (!switchLocale(value)) {
      setFailure("languageBlocked");
      setBusy(false);
    }
  };

  return (
    <div>
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
      {failure ? <p className="mt-2 text-sm text-destructive">{t(failure)}</p> : null}
    </div>
  );
}
