import { SETTINGS, type Settings } from "@/lib/config/registry";

// The sound editing tunables — the split edit's ramp and how a separate
// recording is lined up — bound once at session start from account config (the
// tab) or the global setting (a worker job), and read where a clip's sound is
// laid out.

let sound: Settings["cutSound"] = SETTINGS.cutSound.default;

export function bindCutSound(value: unknown): void {
  const parsed = SETTINGS.cutSound.schema.safeParse(value);
  if (parsed.success) sound = parsed.data;
}

export function cutSound(): Settings["cutSound"] {
  return sound;
}
