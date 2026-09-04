/**
 * Filmstrip tile planning: which frame each tile of a clip's strip shows.
 *
 * Tiles sit on a source-time grid, so the strip holds still while a trimmed
 * edge sweeps across it. Each tile spans `stepT` seconds of source; the asset
 * carries a pre-sampled strip with one thumb every `thumbStep` seconds
 * (roughly two). While a tile spans at least that much, it shows the thumb
 * from the scene that owns most of its span, so a cut inside a wide tile
 * leaves the tile picturing what mostly plays there.
 *
 * Every tile also names a capture time (`wantT`) for a true frame at its own
 * moment: the tile's midpoint, on a fine fixed grid (tenths of a second) so
 * cache keys hold still through scrolls and trims. The midpoint is the one
 * time that keeps a tile on its own side of a scene cut — a capture pulled
 * toward the tile's edge lands on the neighboring scene whenever a cut sits
 * inside the tile, and the strip then flips a whole tile early. `exactFrame`
 * answers with captures already in hand; a tile without one keeps the nearest
 * pre-sampled thumb until its capture lands, so the strip sharpens in place
 * at every zoom.
 *
 * Detected scene cuts (`cuts`, measured at import) become tile edges at every
 * zoom: each scene divides into even tiles as close to the grid width as its
 * span allows, so the strip changes picture at the cut's own pixel, the
 * boundary area under the pointer shows what actually plays there, and tiles
 * between two cuts all share one width — a scene shorter than a tile is the
 * one place a narrow tile is the truth. Fast-cut footage keeps its scenes
 * visible zoomed all the way out; only a cut within a few pixels of another
 * edge merges away.
 *
 * A plan is drawn for a window (`view`): the stretch of the box the scroller
 * shows, plus a margin. Tiles outside it are neither planned nor drawn, so
 * a seven-minute clip zoomed to frames costs what fits on the screen, and
 * the tiles keep the strip's own aspect at every zoom. The grid is the
 * source's, so a scrolled window plans
 * the same tiles at the same places, and each tile carries an id from that
 * grid: a scroll keeps a tile's capture where it was, a zoom re-aims it.
 */

import { srcSpan, type Retime } from "@donkeycut/effects-kit";

export type FilmTile = {
  /** The tile's place on the source grid at this zoom, stable across
   * scrolls and trims; a zoom re-aims the same id at a new moment. */
  id: string;
  src: string;
  /** Pixel offset within the clip box. */
  left: number;
  width: number;
  /** The tile's midpoint in source seconds. */
  srcT: number;
  /** Capture time for the tile's true frame. */
  wantT: number;
  /** `src` is a true frame at `wantT`. */
  exact: boolean;
};

/** Most tiles a window holds before they widen by whole grid cells: the
 * window is a screen's worth, so this binds on a very wide screen with a
 * very narrow tile. */
export const FILM_TILE_CAP = 120;

/** Capture times land on this grid, tenths of a second: fine enough that a
 * capture sits imperceptibly close to its tile's midpoint, coarse enough that
 * a strip re-planned by a scroll or a trim asks for the same times again. */
export const WANT_GRID_S = 0.1;

/** Narrowest tile a scene cut may leave behind; cuts closer than this to the
 * source's ends or to each other merge away. */
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

/** Tiles on the timeline grid for a clip whose rate changes, or that plays
 * backward: `imgW` pixels each, the last one ending at the clip's edge, each
 * showing the source second playing at its middle. */
function planCurvedStrip(
  p: Omit<Parameters<typeof planFilmstrip>[0], "retime"> & { retime: Retime },
  imgW: number
): FilmTile[] {
  const rt = p.retime;
  const tiles: FilmTile[] = [];
  const n = Math.max(1, Math.ceil(p.w / imgW));
  const first = p.view ? Math.max(0, Math.floor(p.view.lo / imgW)) : 0;
  const last = p.view ? Math.min(n - 1, Math.ceil(p.view.hi / imgW) - 1) : n - 1;
  for (let i = first; i <= last; i++) {
    const left = i * imgW;
    const width = Math.min(imgW, p.w - left);
    if (width <= 0) break;
    const tMid = (left + width / 2) / p.pps;
    const mid = Math.max(0, Math.min(p.duration, rt.srcAt(tMid)));
    const edge = srcSpan(rt, left / p.pps, (left + width) / p.pps);
    const a = Math.max(0, edge.lo);
    const b = Math.min(p.duration, edge.hi);
    const idx = Math.min(p.thumbs.length - 1, Math.max(0, Math.floor(mid / p.thumbStep)));
    let src = p.thumbs[idx];
    let exact = false;
    const snapped = (Math.floor(mid / WANT_GRID_S) + 0.5) * WANT_GRID_S;
    let wantT = snapped > a && snapped < b ? snapped : mid;
    wantT = Math.max(0, Math.min(p.duration - 0.05, wantT));
    const hit = p.exactFrame?.(wantT) ?? null;
    if (hit) {
      src = hit;
      exact = true;
    }
    tiles.push({ id: String(i), src, left, width, srcT: mid, wantT, exact });
  }
  return tiles;
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
  /** Source seconds per timeline second across the strip (the clip's rate,
   * or its average rate under a curve). */
  speed: number;
  /** The clip's map, when its rate changes through the footage or it plays
   * backward. The strip then lays tiles on the timeline grid — a held moment
   * takes the width it plays for — with each tile picturing the source second
   * at its middle. */
  retime?: Retime;
  tileH: number;
  minTileW: number;
  /** Scene changes in the source, seconds, ascending. While refining they
   * become tile edges, so the strip changes picture at the cut's own pixel;
   * the boundary area then shows what actually plays there. */
  cuts?: number[];
  /** Synchronous lookup of a captured true frame at a `wantT`. */
  exactFrame?: (wantT: number) => string | null;
  /** The stretch of the box to plan, px from its left edge. Absent, the
   * whole box. */
  view?: { lo: number; hi: number };
}): FilmTile[] {
  if (!p.thumbs.length || !p.thumbStep) return [];
  if (p.view && p.view.hi <= p.view.lo) return [];
  const natural = Math.max(p.minTileW, Math.round(p.tileH * p.aspect));
  const span = p.view ? Math.min(p.w, p.view.hi - p.view.lo) : p.w;
  const cells = Math.max(1, Math.ceil(span / natural));
  const imgW = natural * Math.ceil(cells / FILM_TILE_CAP);
  if (p.retime && (!p.retime.uniform || p.retime.reverse))
    return planCurvedStrip({ ...p, retime: p.retime }, imgW);
  const stepT = (imgW / p.pps) * p.speed;
  const filmOut = p.filmIn + (p.w / p.pps) * p.speed;
  // The window, in source time, clamped to the clip.
  const viewIn = p.view ? Math.max(p.filmIn, p.filmIn + (p.view.lo / p.pps) * p.speed) : p.filmIn;
  const viewOut = p.view ? Math.min(filmOut, p.filmIn + (p.view.hi / p.pps) * p.speed) : filmOut;
  // A tile narrower than a few pixels reads as a rendering artifact; a cut
  // that close to an edge already flips within that distance.
  const minSubT = (MIN_SUB_TILE_PX / p.pps) * p.speed;
  // Scene seams partition the whole source, so the tiling depends only on
  // the source and the zoom: scrolls and trims re-plan onto the same tiles.
  const end = Math.max(p.duration, filmOut);
  const seams = [0];
  for (const c of p.cuts ?? []) {
    if (c >= seams[seams.length - 1] + minSubT && c <= end - minSubT) seams.push(c);
  }
  seams.push(end);
  const tiles: FilmTile[] = [];
  for (let s = 0; s + 1 < seams.length; s++) {
    const segA = seams[s];
    const segB = seams[s + 1];
    if (segB <= viewIn || segA >= viewOut) continue;
    const n = Math.max(1, Math.round((segB - segA) / stepT));
    const tw = (segB - segA) / n;
    const i0 = Math.max(0, Math.floor((viewIn - segA) / tw));
    const i1 = Math.min(n - 1, Math.ceil((viewOut - segA) / tw) - 1);
    for (let i = i0; i <= i1; i++) {
      const a = segA + i * tw;
      const b = segA + (i + 1) * tw;
      const mid = (a + b) / 2;
      const idx = Math.min(p.thumbs.length - 1, Math.max(0, Math.floor(mid / p.thumbStep)));
      let src = p.thumbs[idx];
      let exact = false;
      // Grid centers, never grid boundaries: cuts sit on frame boundaries
      // (whole and half seconds above all), and a capture that lands
      // exactly on a cut decodes the next scene's first frame — a tile
      // whose midpoint sits a hair before a cut would flip to the wrong
      // side of it. A tile too narrow for a grid center inside it captures
      // at its own midpoint.
      const snapped = (Math.floor(mid / WANT_GRID_S) + 0.5) * WANT_GRID_S;
      let wantT = snapped > a && snapped < b ? snapped : mid;
      wantT = Math.max(0, Math.min(p.duration - 0.05, wantT));
      const hit = p.exactFrame?.(wantT) ?? null;
      if (hit) {
        src = hit;
        exact = true;
      }
      tiles.push({
        id: `${s}:${i}`,
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
