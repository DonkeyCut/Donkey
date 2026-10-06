import { SETTINGS, type Settings } from "@/lib/config/registry";

// Export loudness: the LUFS each named target masters to, the target an
// export starts on, and the true-peak ceiling — bound once at session start
// from account config (the tab) or the global setting (a worker job), and read
// wherever an export's settings are made.

let loudness: Settings["cutLoudness"] = SETTINGS.cutLoudness.default;

export function bindCutLoudness(value: unknown): void {
  const parsed = SETTINGS.cutLoudness.schema.safeParse(value);
  if (parsed.success) loudness = parsed.data;
}

export function cutLoudness(): Settings["cutLoudness"] {
  return loudness;
}

/** A loudness choice: off, or one of the named targets. */
export type LoudnessId = Settings["cutLoudness"]["defaultTarget"];

/** The choices in menu order. The numbers come from the setting. */
export const LOUDNESS_CHOICES = [
  { id: "off", label: "Off", detail: "the mix as it plays" },
  { id: "social", label: "Social", detail: "streaming and social platforms" },
  { id: "podcast", label: "Podcast", detail: "spoken word" },
  { id: "broadcast", label: "Broadcast", detail: "EBU R128 television" },
] as const satisfies readonly { id: LoudnessId; label: string; detail: string }[];

export const LOUDNESS_IDS = LOUDNESS_CHOICES.map((c) => c.id) as [LoudnessId, ...LoudnessId[]];

/** The settings fields a choice adds to an export: the target and the
 * ceiling, or nothing for off. */
export function loudnessSettings(id: LoudnessId | undefined): { loudness?: number; truePeakCeiling?: number } {
  const s = cutLoudness();
  const choice = id ?? s.defaultTarget;
  if (choice === "off") return {};
  return { loudness: s.targets[choice], truePeakCeiling: s.truePeakCeiling };
}

/** A choice as the menu shows it: "Social · −14 LUFS". */
export function loudnessLabel(id: LoudnessId): string {
  const c = LOUDNESS_CHOICES.find((x) => x.id === id)!;
  if (id === "off") return c.label;
  return `${c.label} · ${String(cutLoudness().targets[id]).replace("-", "−")} LUFS`;
}
