/**
 * Named easing curves for key tracks.
 *
 * A key's `ease` is the curve out of that key and into the next; a key with
 * none moves at a constant rate. The names follow the family/direction
 * convention motion designers already speak — `sine.inOut` is the gentle
 * glide a camera takes between two cards, `power3.out` the quick start that
 * settles, `power3.inOut` the whip. The list is the one source the pose
 * track, the camera, the inspector menus and the chat tools all read.
 */

export const EASE_IDS = [
  "linear",
  "sine.in",
  "sine.out",
  "sine.inOut",
  "power2.in",
  "power2.out",
  "power2.inOut",
  "power3.in",
  "power3.out",
  "power3.inOut",
] as const;

export type EaseId = (typeof EASE_IDS)[number];

export const EASE_LABELS: Record<EaseId, string> = {
  linear: "Linear",
  "sine.in": "Sine in",
  "sine.out": "Sine out",
  "sine.inOut": "Sine in-out",
  "power2.in": "Power2 in",
  "power2.out": "Power2 out",
  "power2.inOut": "Power2 in-out",
  "power3.in": "Power3 in",
  "power3.out": "Power3 out",
  "power3.inOut": "Power3 in-out",
};

/** Each ease as cubic bezier handles, for keyframe tracks that time
 * themselves with handles rather than by name (motion presets). */
export const EASE_BEZIER: Record<EaseId, [number, number, number, number]> = {
  linear: [0, 0, 1, 1],
  "sine.in": [0.12, 0, 0.39, 0],
  "sine.out": [0.61, 1, 0.88, 1],
  "sine.inOut": [0.37, 0, 0.63, 1],
  "power2.in": [0.11, 0, 0.5, 0],
  "power2.out": [0.5, 1, 0.89, 1],
  "power2.inOut": [0.45, 0, 0.55, 1],
  "power3.in": [0.32, 0, 0.67, 0],
  "power3.out": [0.33, 1, 0.68, 1],
  "power3.inOut": [0.65, 0, 0.35, 1],
};

export const isEaseId = (v: unknown): v is EaseId => EASE_IDS.includes(v as EaseId);

/** Progress `p` (0..1) through the named curve. Every curve starts at 0 and
 * lands on 1, so a key is reached exactly on its time whatever the ease. */
export function easeAt(id: EaseId | undefined, p: number): number {
  const x = p <= 0 ? 0 : p >= 1 ? 1 : p;
  switch (id) {
    case undefined:
    case "linear":
      return x;
    case "sine.in":
      return 1 - Math.cos((x * Math.PI) / 2);
    case "sine.out":
      return Math.sin((x * Math.PI) / 2);
    case "sine.inOut":
      return -(Math.cos(Math.PI * x) - 1) / 2;
    case "power2.in":
      return x * x;
    case "power2.out":
      return 1 - (1 - x) * (1 - x);
    case "power2.inOut":
      return x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2;
    case "power3.in":
      return x * x * x;
    case "power3.out":
      return 1 - Math.pow(1 - x, 3);
    case "power3.inOut":
      return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
  }
}

/** easeAt as an ffmpeg expression over progress `u` (already 0..1), so a
 * filter graph runs the same curve the preview does. */
export function easeExpr(id: EaseId | undefined, u: string): string {
  switch (id) {
    case "sine.in":
      return `(1-cos(${u}*PI/2))`;
    case "sine.out":
      return `sin(${u}*PI/2)`;
    case "sine.inOut":
      return `((1-cos(PI*${u}))/2)`;
    case "power2.in":
      return `pow(${u},2)`;
    case "power2.out":
      return `(1-pow(1-${u},2))`;
    case "power2.inOut":
      return `if(lt(${u},0.5),2*pow(${u},2),1-pow(2-2*${u},2)/2)`;
    case "power3.in":
      return `pow(${u},3)`;
    case "power3.out":
      return `(1-pow(1-${u},3))`;
    case "power3.inOut":
      return `if(lt(${u},0.5),4*pow(${u},3),1-pow(2-2*${u},3)/2)`;
    default:
      return u;
  }
}
