"use client";

import { useLocale } from "next-intl";
import { useEffect, useRef } from "react";

import { bindCreatorLocale } from "@/cut/lib/defaultNames";
import { switchLocale } from "@/i18n/localeCookie";
import { useAccountProfile, useUpdateLocale } from "@/queries/accountProfile";

// The account's language follows the person across browsers. This browser's
// cookie decides what the proxy serves, so once the profile loads, an account
// language that differs from the page's switches the page to it. An account
// with no language yet takes this browser's, which is what its emails and
// headless chat turns are written in from then on.
export function LocaleSync() {
  const locale = useLocale();
  const profile = useAccountProfile();
  const updateLocale = useUpdateLocale();
  const recorded = useRef(false);
  const saved = profile.data?.locale;

  // What the editor creates (an untitled project, a new title) is named in
  // the language the page draws in.
  useEffect(() => {
    void bindCreatorLocale(locale);
  }, [locale]);

  useEffect(() => {
    if (!profile.data) {
      return;
    }
    if (saved && saved !== locale) {
      switchLocale(saved);
      return;
    }
    if (!saved && !recorded.current) {
      recorded.current = true;
      updateLocale.mutate(locale);
    }
  }, [profile.data, saved, locale, updateLocale]);

  return null;
}
