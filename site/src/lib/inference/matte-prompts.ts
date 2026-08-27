// The matte request's point prompts, shared by every matte adapter: the
// client sends parameters.points = [{x, y, frame, label, object}] with x/y in
// pixels of the uploaded segment and frame as the segment frame index.
import { isJsonObject } from "@/lib/inference/json";

export type MattePointPrompt = {
  x: number;
  y: number;
  frame: number;
  label: 0 | 1;
  object: string;
};

export function mattePointPrompts(value: unknown): MattePointPrompt[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: MattePointPrompt[] = [];
  for (const item of value) {
    if (!isJsonObject(item)) {
      continue;
    }
    const x = Number(item.x);
    const y = Number(item.y);
    const frame = Number(item.frame ?? 0);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      continue;
    }
    out.push({
      x,
      y,
      frame: Number.isFinite(frame) ? frame : 0,
      label: item.label === 0 ? 0 : 1,
      object:
        typeof item.object === "string" && /^[\w-]{1,32}$/.test(item.object)
          ? item.object
          : "subject",
    });
  }
  return out.slice(0, 64);
}

/** The request's text prompt — what to matte, in a few words. A runaway
 * description truncates: the leading words still say what to track, while an
 * emptied prompt would fail the request with an error naming the wrong
 * cause. */
export function matteConceptPrompt(value: unknown): string {
  const prompt = typeof value === "string" ? value.trim() : "";
  return prompt.slice(0, 200);
}
