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
