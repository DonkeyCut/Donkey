"use client";

import { useTranslations } from "next-intl";

/**
 * An account flag's switch label and hint in the reader's language. The
 * registry (lib/feature-flags.ts) keeps its English for the server; the
 * settings catalog holds one `flags.<id>` entry per registered flag, which
 * flagCopy.test.ts enforces.
 */
export function useFlagCopy(): (id: string) => { title: string; description: string } {
  const t = useTranslations("settings.flags");
  return (id) => ({
    title: t(`${id}.title` as Parameters<typeof t>[0]),
    description: t(`${id}.description` as Parameters<typeof t>[0]),
  });
}
