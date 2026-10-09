import { SETTINGS, type Settings } from "@/lib/config/registry";

// The export pass budget — the memory one ffmpeg pass may hold and the pieces
// it opens — bound once at session start from account config (the tab) or the
// global setting (a worker job), and sent with every export spec.

let passes: Settings["cutExportPasses"] = SETTINGS.cutExportPasses.default;

export function bindCutExportPasses(value: unknown): void {
  const parsed = SETTINGS.cutExportPasses.schema.safeParse(value);
  if (parsed.success) passes = parsed.data;
}

export function cutExportPasses(): Settings["cutExportPasses"] {
  return passes;
}
