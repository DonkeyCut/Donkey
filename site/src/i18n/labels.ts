"use client";

import { useTranslations } from "next-intl";

import type { Messages } from "@/i18n/namespaces";

// The UI names of the editor's registries — effects, transitions, eases,
// looks — keyed by the registry ids the timeline and the chat tools use. The
// registries keep their English labels for the model; the UI reads these.
export type LabelGroup = keyof Messages["labels"];

/** A registry id as a message key. Ids like "sine.in" carry dots, which a
 *  message key reserves for nesting. */
export function labelKey(id: string): string {
  return id.replaceAll(".", "_");
}

/** Names the ids of one registry in the page's language. */
export function useLabels(group: LabelGroup): (id: string) => string {
  const t = useTranslations("labels");
  return (id) => t(`${group}.${labelKey(id)}` as Parameters<typeof t>[0]);
}
