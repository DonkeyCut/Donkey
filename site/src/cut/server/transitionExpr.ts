/**
 * The xfade options a transition renders with on the ffmpeg export.
 *
 * Most styles are xfade built-ins. The shaped styles ffmpeg has no built-in
 * for — the clock wipe, the slices — and any reveal softened by a feather
 * run as `custom` expressions spelling the same geometry the compositor
 * draws (lib/transitionShape.ts). xfade hands an expression `P`, which runs
 * 1 → 0 across the transition, the two pictures' values at the pixel as `A`
 * and `B`, and `a0(x,y)`…`b3(x,y)` to read any pixel of either. The filter
 * evaluates one expression on several slice threads at once, so nothing here
 * stores into expression variables: every term is spelled inline.
 */

import { fexpr } from "./filterGraph";
import {
  CLOCK_SWEEP,
  clampFeather,
  FEATHER_STYLES,
  SLICE_KNEE,
  SLICE_KNEE_SHARE,
  SLICE_PULL,
  SLICE_SETTLE,
  SLICE_SHUTTER,
  SLICE_STYLES,
  SLICE_TAPS,
  takesFeather,
} from "../lib/transitionShape";
import { TRANSITION_XFADE, type TransitionStyle } from "../lib/types";

/** Linear progress, 0 → 1. */
const PROG = "(1-P)";

/** A number written short and without exponent notation. */
const n = (v: number) => (Math.abs(v) < 1e-9 ? "0" : Number(v.toFixed(6)).toString());

/** The value plane `PLANE` of picture `src` ("a" or "b") holds at (x, y). */
const sample = (src: "a" | "b", x: string, y: string) =>
  `if(eq(PLANE,0),${src}0(${x},${y}),if(eq(PLANE,1),${src}1(${x},${y}),if(eq(PLANE,2),${src}2(${x},${y}),${src}3(${x},${y}))))`;

/** The slices' eased share of their move: the whip `shapeEase` draws, a
 * power rise to the knee and a power settle after it. `P` is what is left. */
const SLICE_EASE =
  `if(lt(${PROG},${n(SLICE_KNEE)}),${n(SLICE_KNEE_SHARE)}*pow(${PROG}/${n(SLICE_KNEE)},${n(SLICE_PULL)}),` +
  `1-${n(1 - SLICE_KNEE_SHARE)}*pow(P/${n(1 - SLICE_KNEE)},${n(SLICE_SETTLE)}))`;

/** The slope of that whip, `sliceSpeed`. */
const SLICE_SPEED =
  `if(lt(${PROG},${n(SLICE_KNEE)}),${n((SLICE_KNEE_SHARE * SLICE_PULL) / SLICE_KNEE)}*pow(${PROG}/${n(SLICE_KNEE)},${n(SLICE_PULL - 1)}),` +
  `${n(((1 - SLICE_KNEE_SHARE) * SLICE_SETTLE) / (1 - SLICE_KNEE))}*pow(P/${n(1 - SLICE_KNEE)},${n(SLICE_SETTLE - 1)}))`;

/** The clock wipe's eased sweep: quadratic out. */
const CLOCK_EASE = "(1-P*P)";

/**
 * A soft reveal: the incoming picture's share at the pixel, the
 * `featherAlpha` profile with its distances in plane px. `F` is the ramp,
 * the feather's share of the distance the edge crosses.
 */
function featherShare(style: TransitionStyle, feather: number): string {
  const f = n(clampFeather(feather));
  const R = "(hypot(W,H)/2)";
  const ramp = (d: string, span: string, F: string, reach = PROG) => `clip((${reach}*(${span}+${F})-(${d}))/${F},0,1)`;
  const Fw = `(${f}*W)`;
  const Fh = `(${f}*H)`;
  const Fr = `(${f}*${R})`;
  switch (style) {
    case "wipeleft":
      return ramp("W-X", "W", Fw);
    case "wiperight":
      return ramp("X", "W", Fw);
    case "wipeup":
      return ramp("H-Y", "H", Fh);
    case "wipedown":
      return ramp("Y", "H", Fh);
    case "splitopen":
      return ramp("abs(X-W/2)", "W/2", Fw);
    case "splitclose":
      return ramp("min(X,W-X)", "W/2", Fw);
    case "circleopen":
      return ramp("hypot(X-W/2,Y-H/2)", R, Fr);
    default:
      // circleclose: the outgoing picture shrinks into a soft circle.
      return `(1-${ramp("hypot(X-W/2,Y-H/2)", R, Fr, "P")})`;
  }
}

/**
 * One half of a slice, averaged over the shutter's taps. `u` is where the
 * half's strip — outgoing then incoming — reads at this pixel along the
 * slide axis, before the tap offset.
 */
function sliceHalf(across: boolean, dir: -1 | 1, seconds: number): string {
  const len = across ? "W" : "H";
  const coord = across ? "X" : "Y";
  // The half moves `dir * e * len`; the pixel reads the strip that far back.
  const u = `(${coord}-(${dir})*${SLICE_EASE}*${len})`;
  const streak = `(${SLICE_SPEED}*${n(seconds > 0 ? SLICE_SHUTTER / seconds : 0)}*${len})`;
  const taps = [...Array(SLICE_TAPS).keys()].map((k) => {
    const off = SLICE_TAPS > 1 ? n(k / (SLICE_TAPS - 1) - 0.5) : "0";
    const at = `(${u}-${off}*${streak})`;
    // Leftward/upward halves pull the incoming picture in after the outgoing
    // one's far edge; rightward/downward ones before its near edge.
    const out = dir < 0 ? `lt(${at},${len})` : `gte(${at},0)`;
    const inc = dir < 0 ? `(${at}-${len})` : `(${at}+${len})`;
    const read = (src: "a" | "b", v: string) => (across ? sample(src, v, "Y") : sample(src, "X", v));
    return `if(${out},${read("a", at)},${read("b", inc)})`;
  });
  return `((${taps.join("+")})/${SLICE_TAPS})`;
}

/** A slice: the frame cut in two, each half sliding its own way. */
function sliceExpr(style: TransitionStyle, seconds: number): string {
  const across = style === "sliceleft";
  const first = across ? "lt(Y,H/2)" : "lt(X,W/2)";
  return `if(${first},${sliceHalf(across, -1, seconds)},${sliceHalf(across, 1, seconds)})`;
}

/** The clock wipe: the incoming picture behind a hand pinned at the top-left
 * corner. The angle is measured in frame px, so a plane subsampled on one
 * axis sweeps the same wedge. */
function clockExpr(W: number, H: number): string {
  return `if(lte(atan2(Y/H*${n(H)},X/W*${n(W)}),${CLOCK_EASE}*${n(CLOCK_SWEEP)}),B,A)`;
}

/**
 * The option string for one xfade join of a W×H frame lasting `seconds`:
 * `transition=<name>` for a built-in, or `transition=custom:expr='…'`.
 * Unknown styles render as a fade.
 */
export function xfadeTransition(
  style: string | undefined,
  feather: number | undefined,
  seconds: number,
  W: number,
  H: number
): string {
  const known = style as TransitionStyle;
  const kind = TRANSITION_XFADE[known] ?? "fade";
  if (SLICE_STYLES.includes(known)) {
    return `transition=custom:expr=${fexpr(sliceExpr(known, seconds))}`;
  }
  if (known === "clockwipe") {
    return `transition=custom:expr=${fexpr(clockExpr(W, H))}`;
  }
  if (takesFeather(known) && clampFeather(feather) > 0 && FEATHER_STYLES.includes(known)) {
    return `transition=custom:expr=${fexpr(`A+(B-A)*${featherShare(known, feather!)}`)}`;
  }
  return `transition=${kind}`;
}
