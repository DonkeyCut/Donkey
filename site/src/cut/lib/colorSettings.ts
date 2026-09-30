import { SETTINGS, type Settings } from "@/lib/config/registry";

// The color pipeline's tunables — LUT sizes, the proxy's size and quality, the
// LUT file cap — bound once at session start from account config (the tab) or
// the global setting (a worker job), and read wherever a LUT is sized.

let color: Settings["cutColor"] = SETTINGS.cutColor.default;

export function bindCutColor(value: unknown): void {
  const parsed = SETTINGS.cutColor.schema.safeParse(value);
  if (parsed.success) color = parsed.data;
}

export function cutColor(): Settings["cutColor"] {
  return color;
}
