import type { ExportDoc } from "@/cut/lib/renderSnapshot";
import type { ExportSettings } from "@/cut/lib/exportClient";
import type { VideoClip } from "@/cut/lib/types";

export type SourceSegment = { file: string; from: number; to: number };

/** Plain sequential clips can reuse their source tracks. */
export function sourceSequence(doc: ExportDoc) {
  if (!doc.clips.length || doc.audioClips.length || doc.overlays.length ||
      (doc.subtitles.showOnVideo && doc.subtitles.cues.length)) return null;
  const clips = [...doc.clips].sort((a, b) => a.start - b.start);
  const segments: { asset: ExportDoc["assets"][number]; from: number; to: number }[] = [];
  let end = 0;
  const neutral: Partial<Record<keyof VideoClip, unknown>> = {
    track: 0, muted: false, volume: 1, fit: "fit", zoom: 1,
    panX: 0, panY: 0, flipH: false, flipV: false, rotation: 0, opacity: 1,
    speed: 1, reverse: false, smoothSlow: false, transition: 0, hidden: false,
  };
  const metadata = new Set(["id", "assetId", "name", "groupId", "in", "out", "start"]);
  for (const clip of clips) {
    if (Math.abs(clip.start - end) > 0.000001) return null;
    for (const [key, value] of Object.entries(clip)) {
      if (metadata.has(key) || value === undefined) continue;
      if (!(key in neutral) || value !== neutral[key as keyof VideoClip]) return null;
    }
    const asset = doc.assets.find((a) => a.id === clip.assetId);
    if (!asset || asset.type !== "video" || asset.block || !asset.width || !asset.height ||
        !Number.isFinite(clip.in) || !Number.isFinite(clip.out) || clip.in < 0 || clip.out <= clip.in || clip.out > asset.duration + 0.000001) return null;
    if (segments.length && (asset.width !== segments[0].asset.width || asset.height !== segments[0].asset.height)) return null;
    const previous = segments.at(-1);
    if (previous?.asset.id === asset.id && Math.abs(previous.to - clip.in) < 0.000001) previous.to = clip.out;
    else segments.push({ asset, from: clip.in, to: clip.out });
    end += clip.out - clip.in;
  }
  return segments;
}

export function sourceExportPlan(doc: ExportDoc, settings: ExportSettings): SourceSegment[] | null {
  if (!settings.copySource || settings.container !== "mp4" || settings.audioCodec !== "aac") return null;
  const sources = sourceSequence(doc);
  if (!sources || settings.width !== sources[0].asset.width || settings.height !== sources[0].asset.height) return null;
  const from = Math.max(0, settings.range?.start ?? 0);
  const to = settings.range?.end ?? Infinity;
  let start = 0;
  const result: SourceSegment[] = [];
  for (const source of sources) {
    const end = start + source.to - source.from;
    const a = Math.max(from, start), b = Math.min(to, end);
    if (b > a) result.push({ file: source.asset.fileName, from: source.from + a - start, to: b === end ? source.to : source.from + b - start });
    start = end;
  }
  return result.length ? result : null;
}
