/**
 * Where effects stand in the element stack.
 *
 * Lane 0 is the top row and a bigger lane number sits further under it, so an
 * effect grades the lanes below its own and leaves the ones above alone. The
 * stage is therefore built in slices, bottom to top: the picture, the elements
 * under the deepest effect, that effect's paints, the elements above it, and
 * so on up. A slice wears the grade of every effect above it as a plain CSS
 * filter and their frame moves as a transform.
 *
 * The math is here, apart from React, because both exports walk the same stack.
 */

import type { EffectPreviewState } from "@donkeycut/effects-kit";

/** One effect live at a moment, with the lane that places it in the stack. */
export interface LiveEffect {
  lane: number;
  state: EffectPreviewState;
}

/** How the content under an effect moves: a zoom's push in, a shake, and the
 * horizontal jump that reads as tearing. Empty for the effects that only
 * filter. */
export function stageEffectTransform(states: EffectPreviewState[]): string | undefined {
  let dx = 0;
  let dy = 0;
  let zoom = 1;
  let origin = { x: 0.5, y: 0.5 };
  for (const st of states) {
    dx += st.dx ?? 0;
    dy += st.dy ?? 0;
    // Tearing shows as a jump of the frame itself; the fraction is of frame
    // width, so it scales with whatever size the stage is.
    if (st.ghostFrac) dx += st.ghostFrac * 1080 * 3;
    zoom *= st.zoom ?? 1;
    if (st.origin) origin = st.origin;
  }
  if (!dx && !dy && zoom === 1) return undefined;
  // The offsets are design pixels against a 1080 short side.
  const pct = (px: number) => ((px / 1080) * 100).toFixed(3);
  // Percentage translates are of the stage's own box, so the scale can be sat
  // on its origin without a transform-origin the callers would have to carry.
  // They are measured from the box's middle, which is where `transform-origin`
  // already stands: taken from the corner instead, the point held still lands
  // half a frame off and the push in walks the picture out of frame.
  const ox = (origin.x - 0.5) * 100;
  const oy = (origin.y - 0.5) * 100;
  return (
    `translate(${pct(dx)}%, ${pct(dy)}%) ` +
    `translate(${ox.toFixed(3)}%, ${oy.toFixed(3)}%) scale(${zoom}) ` +
    `translate(${(-ox).toFixed(3)}%, ${(-oy).toFixed(3)}%)`
  );
}

/** The grade of a run of effects, as one CSS filter. */
const stageEffectFilter = (states: EffectPreviewState[]) =>
  states
    .map((s) => s.cssFilter)
    .filter(Boolean)
    .join(" ") || undefined;

/** One slice of the stage, bottom of the stack first. */
export type StageSlice =
  | {
      kind: "elements";
      key: string;
      /** Elements on lanes in [from, to) — `from` counts down from the top. */
      from: number;
      to: number;
      filter?: string;
      transform?: string;
      /** The topmost slice carries the captions, which nothing grades. */
      captions: boolean;
    }
  | { kind: "paint"; key: string; states: EffectPreviewState[] };

/**
 * The stage bottom to top: what the picture itself wears, then alternating
 * element slices and the paints of the effect that sits over each.
 */
export function stageSlices(
  live: LiveEffect[],
  lanes: number[]
): { picture: { filter?: string; transform?: string }; slices: StageSlice[] } {
  const above = (lane: number) => live.filter((e) => e.lane < lane).map((e) => e.state);
  const all = live.map((e) => e.state);
  const slices: StageSlice[] = [];
  // Deepest first: elements under that effect, then its paints over them.
  for (let i = lanes.length - 1; i >= 0; i--) {
    const lane = lanes[i];
    slices.push({
      kind: "elements",
      key: `band-${lane}`,
      from: lane + 1,
      to: i + 1 < lanes.length ? lanes[i + 1] : Infinity,
      filter: stageEffectFilter(above(lane + 1)),
      transform: stageEffectTransform(above(lane + 1)),
      captions: false,
    });
    slices.push({
      kind: "paint",
      key: `paint-${lane}`,
      states: live.filter((e) => e.lane === lane).map((e) => e.state),
    });
  }
  slices.push({
    kind: "elements",
    key: "band-top",
    from: 0,
    to: lanes.length ? lanes[0] : Infinity,
    captions: true,
  });
  return {
    picture: { filter: stageEffectFilter(all), transform: stageEffectTransform(all) },
    slices,
  };
}
