import { SETTINGS, type Settings } from "@/lib/config/registry";

// Font-suggestion tunables — the score a bundled face has to reach to count as
// the reference's face — bound once at session start from account config (the
// tab) or the global setting (a worker job).

let fontMatch: Settings["cutFontMatch"] = SETTINGS.cutFontMatch.default;

export function bindCutFontMatch(value: unknown): void {
  const parsed = SETTINGS.cutFontMatch.schema.safeParse(value);
  if (parsed.success) fontMatch = parsed.data;
}

export function cutFontMatch(): Settings["cutFontMatch"] {
  return fontMatch;
}
