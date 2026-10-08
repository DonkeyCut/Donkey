import type { EffectPreviewState } from "@donkeycut/effects-kit";

/**
 * The preview's channel split. A stage slice wears a glitch's rgb hit as an
 * SVG filter: the slice seen three times through a channel matrix — red moved
 * by the offset, green in place, blue moved back — and the three added up,
 * the same sum the canvas pass draws. The filters live in one hidden <svg>,
 * one per offset in whole px, and only the latest few are kept.
 */

const SVG_NS = "http://www.w3.org/2000/svg";

/** How many offsets keep their filter; a burst deals a new one per step. */
const KEPT_FILTERS = 16;

/** Each channel's matrix row set: the channel kept, the others zeroed. */
const CHANNELS: [string, number][] = [
  ["1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0", 1],
  ["0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0", 0],
  ["0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0", -1],
];

let defs: SVGDefsElement | null = null;
const made: string[] = [];

/** The CSS filter for the live split, "" when no effect is splitting. The
 * offsets are design px, scaled to the box's short side. */
export function rgbSplitFilter(states: EffectPreviewState[], width: number, height: number): string {
  const rgb = states.find((s) => s.rgb)?.rgb;
  if (!rgb) {
    return "";
  }
  const k = Math.min(width, height) / 1080;
  const dx = Math.round(rgb.dx * k);
  const dy = Math.round(rgb.dy * k);
  if (!dx && !dy) {
    return "";
  }
  const id = `cut-rgb-${dx}_${dy}`;
  ensureFilter(id, dx, dy);
  return `url(#${id})`;
}

/** Add the filter for one offset to the shared defs, dropping the oldest
 * past the keep. */
function ensureFilter(id: string, dx: number, dy: number): void {
  if (made.includes(id)) {
    return;
  }
  defs ??= createDefs();
  const filter = document.createElementNS(SVG_NS, "filter");
  filter.setAttribute("id", id);
  filter.setAttribute("color-interpolation-filters", "sRGB");
  filter.setAttribute("x", "-10%");
  filter.setAttribute("y", "-10%");
  filter.setAttribute("width", "120%");
  filter.setAttribute("height", "120%");

  // One moved, tinted copy per channel, then summed: "r" + "g", then + "b".
  CHANNELS.forEach(([values, sign], i) => {
    const offset = document.createElementNS(SVG_NS, "feOffset");
    offset.setAttribute("in", "SourceGraphic");
    offset.setAttribute("dx", String(sign * dx));
    offset.setAttribute("dy", String(sign * dy));
    offset.setAttribute("result", `o${i}`);
    const matrix = document.createElementNS(SVG_NS, "feColorMatrix");
    matrix.setAttribute("in", `o${i}`);
    matrix.setAttribute("type", "matrix");
    matrix.setAttribute("values", values);
    matrix.setAttribute("result", `c${i}`);
    filter.append(offset, matrix);
  });
  const sum = (a: string, b: string, result: string) => {
    const add = document.createElementNS(SVG_NS, "feComposite");
    add.setAttribute("in", a);
    add.setAttribute("in2", b);
    add.setAttribute("operator", "arithmetic");
    add.setAttribute("k2", "1");
    add.setAttribute("k3", "1");
    add.setAttribute("result", result);
    return add;
  };
  filter.append(sum("c0", "c1", "c01"), sum("c01", "c2", "out"));
  defs.append(filter);
  made.push(id);

  // The oldest offset goes once the keep is full.
  while (made.length > KEPT_FILTERS) {
    defs.querySelector(`#${CSS.escape(made.shift()!)}`)?.remove();
  }
}

/** The hidden <svg> the filters live in, made on first use. */
function createDefs(): SVGDefsElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("width", "0");
  svg.setAttribute("height", "0");
  svg.style.position = "absolute";
  svg.style.pointerEvents = "none";
  const d = document.createElementNS(SVG_NS, "defs");
  svg.append(d);
  document.body.append(svg);
  return d;
}
