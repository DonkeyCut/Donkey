import { SETTINGS, type Settings } from "@/lib/config/registry";

// Motion tunables — the shutter a newly switched-on motion blur starts at —
// bound once at session start from account config (the tab) or the global
// setting (a worker job). The value is written onto the item when the blur is
// switched on, so every renderer draws from the item alone.

let motion: Settings["cutMotion"] = SETTINGS.cutMotion.default;

export function bindCutMotion(value: unknown): void {
  const parsed = SETTINGS.cutMotion.schema.safeParse(value);
  if (parsed.success) motion = parsed.data;
}

export function cutMotion(): Settings["cutMotion"] {
  return motion;
}
