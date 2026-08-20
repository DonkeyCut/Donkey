/**
 * Filmstrip tile planning: which frame each tile of a clip's strip shows.
 *
 * Tiles sit on a source-time grid, so the strip holds still while a trimmed
 * edge sweeps across it. Each tile spans `stepT` seconds of source; the asset
 * carries a pre-sampled strip with one thumb every `thumbStep` seconds
 * (roughly two). While a tile spans at least that much, the nearest
 * pre-sampled thumb is a faithful picture of the tile's whole span.
 *
 * Zoomed past that, a tile spans a fraction of the sampling interval, and on
 * footage that cuts between scenes the nearest thumb can show a moment up to
 * `thumbStep / 2` away — a visibly wrong scene under the playhead. Those
 * tiles each name a capture time (`wantT`) for a true frame at their own
 * moment: the tile's midpoint, on a fine fixed grid (tenths of a second) so
 * cache keys hold still through scrolls and trims. The midpoint is the one
 * time that keeps a tile on its own side of a scene cut — a capture pulled
 * toward the tile's edge lands on the neighboring scene whenever a cut sits
 * inside the tile, and the strip then flips a whole tile early. `exactFrame`
 * answers with captures already in hand; a tile without one keeps the nearest
 * pre-sampled thumb until its capture lands.
 *
 * Detected scene cuts (`cuts`, measured at import) split any refining tile
 * they pass through: each side captures its own scene, so the strip changes
 * picture at the cut's own pixel and the boundary area under the pointer
 * shows what actually plays there.
 */

export type FilmTile = {
  src: string;
  /** Pixel offset within the clip box. */
  left: number;
  width: number;
  /** The tile's midpoint in source seconds. */
  srcT: number;
  /** Capture time for a true frame; null while the pre-sampled strip is
   * already finer than the tile grid. */
  wantT: number | null;
  /** `src` is a true frame at `wantT`. */
  exact: boolean;
};

/** Widest a strip gets before tiles widen by whole grid cells. */
export const FILM_TILE_CAP = 120;

/** Capture times land on this grid, tenths of a second: fine enough that a
 * capture sits imperceptibly close to its tile's midpoint, coarse enough that
 * a strip re-planned by a scroll or a trim asks for the same times again. */
export const WANT_GRID_S = 0.1;

/** Narrowest sub-tile a scene cut may split off. */
export const MIN_SUB_TILE_PX = 5;

/** A probe of the source: a moment, and whether the picture changed scene
 * between the previous probe and this one. */
export type ThumbProbe = { t: number; cut: boolean };

/** Where the pre-sampled strip grabs each bucket's thumb.
 *
 * The strip is read back by position (`thumbs[floor(t / thumbStep)]`), so
 * each bucket owns one thumb; this picks the moment inside the bucket that
 * thumb is grabbed at. Probes carry scene-change signals measured off small
 * decoded frames (the watch pipeline's grid signatures): each bucket grabs
 * the middle of its longest stretch of stable content, so a bucket crossed
 * by a scene cut shows the scene that owns most of it — a blind midpoint
 * grab lands right at a cut often enough to paint whole buckets with their
 * neighbor's scene. A bucket with no probes grabs its midpoint. */
export function pickThumbTimes(
  count: number,
  thumbStep: number,
  duration: number,
  probes: ThumbProbe[]
): number[] {
  const clampT = (t: number) => Math.max(0, Math.min(duration - 0.05, t));
  return Array.from({ length: count }, (_, k) => {
    const lo = k * thumbStep;
    const hi = (k + 1) * thumbStep;
    const inBucket = probes.filter((p) => p.t >= lo && p.t < hi);
    const mid = (k + 0.5) * thumbStep;
    if (inBucket.length === 0) return clampT(mid);
    const runs: ThumbProbe[][] = [[inBucket[0]]];
    for (let i = 1; i < inBucket.length; i++) {
      if (inBucket[i].cut) runs.push([]);
      runs[runs.length - 1].push(inBucket[i]);
    }
    const center = (r: ThumbProbe[]) => r[Math.floor((r.length - 1) / 2)].t;
    const best = runs.reduce((a, b) =>
      b.length > a.length ||
      (b.length === a.length && Math.abs(center(b) - mid) < Math.abs(center(a) - mid))
        ? b
        : a
    );
    return clampT(center(best));
  });
}

export function planFilmstrip(p: {
  thumbs: string[];
  thumbStep: number;
  /** Source length in seconds; capture times clamp inside it. */
  duration: number;
  /** Source width/height ratio. */
  aspect: number;
  /** Source time at the clip's left edge. */
  filmIn: number;
  /** Drawn width of the clip box, px. */
  w: number;
  pps: number;
  speed: number;
  tileH: number;
  minTileW: number;
  /** Scene changes in the source, seconds. A refining tile a cut passes
   * through splits at it, so the strip changes picture at the cut's own
   * pixel; the boundary area then shows what actually plays there. */
  cuts?: number[];
  /** Synchronous lookup of a captured true frame at a `wantT`. */
  exactFrame?: (wantT: number) => string | null;
}): FilmTile[] {
  if (!p.thumbs.length || !p.thumbStep) return [];
  const natural = Math.max(p.minTileW, Math.round(p.tileH * p.aspect));
  const cells = Math.max(1, Math.ceil(p.w / natural));
  const imgW = natural * Math.ceil(cells / FILM_TILE_CAP);
  const stepT = (imgW / p.pps) * p.speed;
  const filmOut = p.filmIn + (p.w / p.pps) * p.speed;
  const first = Math.max(0, Math.floor(p.filmIn / stepT));
  const last = Math.max(first, Math.ceil(filmOut / stepT) - 1);
  const refine = stepT < p.thumbStep;
  // A sub-tile narrower than a few pixels reads as a rendering artifact; a
  // cut that close to a tile boundary already flips within that distance.
  const minSubT = (MIN_SUB_TILE_PX / p.pps) * p.speed;
  const tiles: FilmTile[] = [];
  for (let k = first; k <= last; k++) {
    const t0 = k * stepT;
    const t1 = (k + 1) * stepT;
    const inner = refine
      ? (p.cuts ?? []).filter((c) => c > t0 + minSubT && c < t1 - minSubT).slice(0, 2)
      : [];
    const bounds = [t0, ...inner, t1];
    for (let s = 0; s + 1 < bounds.length; s++) {
      const a = bounds[s];
      const b = bounds[s + 1];
      const mid = (a + b) / 2;
      const idx = Math.min(p.thumbs.length - 1, Math.max(0, Math.floor(mid / p.thumbStep)));
      let src = p.thumbs[idx];
      let wantT: number | null = null;
      let exact = false;
      if (refine) {
        // Grid centers, never grid boundaries: cuts sit on frame boundaries
        // (whole and half seconds above all), and a capture that lands
        // exactly on a cut decodes the next scene's first frame — a tile
        // whose midpoint sits a hair before a cut would flip to the wrong
        // side of it. A sub-tile too narrow for a grid center inside it
        // captures at its own midpoint.
        const snapped = (Math.floor(mid / WANT_GRID_S) + 0.5) * WANT_GRID_S;
        wantT = snapped > a && snapped < b ? snapped : mid;
        wantT = Math.max(0, Math.min(p.duration - 0.05, wantT));
        const hit = p.exactFrame?.(wantT) ?? null;
        if (hit) {
          src = hit;
          exact = true;
        }
      }
      tiles.push({
        src,
        left: ((a - p.filmIn) / p.speed) * p.pps,
        width: ((b - a) / p.speed) * p.pps,
        srcT: mid,
        wantT,
        exact,
      });
    }
  }
  return tiles;
}
