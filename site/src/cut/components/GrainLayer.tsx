"use client";

import { GRAIN_URL_SIDE, grainShiftAt, grainTileUrl } from "@donkeycut/effects-kit";

/**
 * Film grain over a DOM surface — the preview stage and the effect tiles: the
 * kit's grain tile overlay-blended at `alpha`, moved to `t`'s offset so each
 * frame wears fresh grain. The layer is a size container, so the tile sizes
 * against the surface's short side, and it moves by transform, on the
 * compositor.
 */
export function GrainLayer({ alpha, t }: { alpha: number; t: number }) {
  const url = grainTileUrl();
  const tile = GRAIN_URL_SIDE;
  if (!url || alpha <= 0) {
    return null;
  }
  const shift = grainShiftAt(t);
  return (
    <span
      className="pointer-events-none absolute inset-0 overflow-hidden mix-blend-overlay"
      style={{ opacity: alpha, containerType: "size" }}
    >
      <span
        className="absolute right-0 bottom-0 will-change-transform"
        style={{
          left: `calc(-1 * ${tile})`,
          top: `calc(-1 * ${tile})`,
          backgroundImage: `url(${url})`,
          backgroundSize: `${tile} ${tile}`,
          transform: `translate(calc(${shift.x.toFixed(4)} * ${tile}), calc(${shift.y.toFixed(4)} * ${tile}))`,
        }}
      />
    </span>
  );
}
