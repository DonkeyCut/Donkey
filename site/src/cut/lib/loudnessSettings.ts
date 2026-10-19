// Export loudness: the LUFS each named target masters to, the target an
// export starts on ("off" leaves the mix as mixed), and the true-peak ceiling
// a mastered mix is held under, dBTP.
export const CUT_LOUDNESS: {
  targets: { social: number; podcast: number; broadcast: number };
  defaultTarget: LoudnessId;
  truePeakCeiling: number;
} = {
  targets: { social: -14, podcast: -16, broadcast: -23 },
  defaultTarget: "off",
  truePeakCeiling: -1,
};

/** A loudness choice: off, or one of the named targets. */
export type LoudnessId = "off" | "social" | "podcast" | "broadcast";

/** The choices in menu order. The numbers come from CUT_LOUDNESS. */
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
  const s = CUT_LOUDNESS;
  const choice = id ?? s.defaultTarget;
  if (choice === "off") return {};
  return { loudness: s.targets[choice], truePeakCeiling: s.truePeakCeiling };
}

/** A choice as the menu shows it: "Social · −14 LUFS". */
export function loudnessLabel(id: LoudnessId): string {
  const c = LOUDNESS_CHOICES.find((x) => x.id === id)!;
  if (id === "off") return c.label;
  return `${c.label} · ${String(CUT_LOUDNESS.targets[id]).replace("-", "−")} LUFS`;
}
