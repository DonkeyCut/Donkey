"use client";

/**
 * What the cut looks like at one instant, worked out from the document alone.
 *
 * Given the clips and a time, this says which pictures are on screen, how far
 * through a transition they are, what each one's alpha, zoom and frame motion
 * come to, and how loud it should be. It touches no decoder, no canvas and no
 * clock, which is what lets the live preview and an export ask the same
 * question and be given the same answer.
 *
 * Keeping it apart from both matters more than it looks. The preview reaches
 * this state by playing towards it; an export reaches it by jumping straight
 * there. If each worked out its own ramps, a fade would be a fade in the editor
 * and something slightly else in the file, and nobody would find out until they
 * watched the download.
 */

import { overlayAnimStyle, TRANSITION_ZOOM } from "./types";
import type { AudioClip, ClipAnim, ClipSpan, MediaAsset, TransitionStyle, VideoClip } from "./types";

/** The ramps a transition or clip animation puts on one upper-track clip. */
export interface OverlayFx {
  alpha: number;
  zoom: number;
  gain: number;
}

/**
 * The alpha/zoom/gain ramps a transition or clip animation puts on one
 * upper-track clip at `t`. A transition blends the incoming clip in over the
 * outgoing one (which keeps full alpha and its audio until its footprint
 * ends); a clip animation ramps the clip's own edge. On an upper track a fade
 * ramps to transparent — the tracks beneath show through — and the animation
 * styles that need frame motion degrade to a fade, both matching the export's
 * alpha ramps.
 */
export function overlayTransitionFx(
  span: ClipSpan,
  prev: ClipSpan | undefined,
  next: ClipSpan | undefined,
  t: number
): OverlayFx {
  let alpha = 1;
  let zoom = 1;
  let gain = 1;
  const style = span.clip.transitionStyle ?? "crossfade";
  const prevStyle = prev?.clip.transitionStyle ?? "crossfade";
  // Incoming side of the previous clip's transition: the clip blends in over
  // its own head — upper tracks composite through alpha, so the arrival is an
  // alpha ramp against whatever is beneath.
  if (prev && prev.transitionOut > 0) {
    const rel = t - span.start;
    if (rel < prev.transitionOut) {
      const p = Math.max(0, rel / prev.transitionOut);
      alpha = Math.min(alpha, p);
      gain = Math.min(gain, p);
      if (prevStyle === "crosszoom") zoom = TRANSITION_ZOOM - (TRANSITION_ZOOM - 1) * p;
    }
  }
  // Outgoing side of this clip's own cross zoom: the picture pushes in across
  // its last blend-window seconds, handing over at the cut.
  if (next && span.transitionOut > 0 && style === "crosszoom") {
    const from = span.start + span.len - span.transitionOut;
    if (t >= from) {
      const p = Math.min(1, (t - from) / span.transitionOut);
      zoom = 1 + (TRANSITION_ZOOM - 1) * p;
    }
  }
  // The clip's own entrance/exit animations. A transitioned joint owns its
  // edges: the transition plays there and the adjacent animation is held
  // (running both would fight over the same window).
  if (span.clip.animIn && !(prev && prev.transitionOut > 0)) {
    const d = Math.min(span.clip.animIn.seconds, span.len);
    const rel = t - span.start;
    if (d > 0 && rel < d) {
      const p = Math.max(0, rel / d);
      if (overlayAnimStyle(span.clip.animIn.style) === "zoom") {
        zoom = TRANSITION_ZOOM - (TRANSITION_ZOOM - 1) * p;
      } else {
        alpha = Math.min(alpha, p);
        gain = Math.min(gain, p);
      }
    }
  }
  if (span.clip.animOut && span.transitionOut <= 0) {
    const d = Math.min(span.clip.animOut.seconds, span.len);
    const left = span.start + span.len - t;
    if (d > 0 && left < d) {
      const p = Math.max(0, left / d);
      if (overlayAnimStyle(span.clip.animOut.style) === "zoom") {
        zoom = 1 + (TRANSITION_ZOOM - 1) * (1 - p);
      } else {
        alpha = Math.min(alpha, p);
        gain = Math.min(gain, p);
      }
    }
  }
  return { alpha, zoom, gain };
}

/** A track-0 clip's animation state: what its entrance/exit does to the frame. */
export interface ClipAnimFx {
  alpha: number;
  zoom: number;
  gain: number;
  /** Fade-to-black amount, painted by the caller's veil pass. */
  veil: number;
  /** Frame translation, as a fraction of canvas width/height. */
  dxFrac: number;
  dyFrac: number;
}

/**
 * A track-0 clip's own entrance/exit animation state at `rel` seconds into its
 * `len`-second footprint. Mirrors the export's per-segment ramps: fades veil
 * to/from black with the audio following; zoom uses the shared TRANSITION_ZOOM
 * ramps; pop scales from/to 80% with an alpha fade; slides translate the frame
 * (fractions of the canvas, matching xfade against black); wipes
 * reveal/conceal through a moving edge.
 */
export function clipAnimFx(
  clip: VideoClip,
  rel: number,
  len: number,
  // Edge context from the caller: a transitioned joint owns its edges (skip
  // that side), and an abutting hard cut gives the side a backdrop — the
  // neighbor's held frame — so a fade blends by alpha there instead of
  // veiling to black.
  edges?: { skipIn?: boolean; skipOut?: boolean; backdropIn?: boolean; backdropOut?: boolean }
): ClipAnimFx {
  const fx: ClipAnimFx = { alpha: 1, zoom: 1, gain: 1, veil: 0, dxFrac: 0, dyFrac: 0 };
  const apply = (a: ClipAnim, side: "in" | "out") => {
    const d = Math.min(a.seconds, len);
    if (d <= 0) return;
    // p runs 0→1 as the visible ramp progresses on either side: entrance
    // completeness on the head, remaining presence on the tail.
    const p =
      side === "in"
        ? Math.min(1, Math.max(0, rel / d))
        : Math.min(1, Math.max(0, (len - rel) / d));
    if (p >= 1) return;
    switch (a.style) {
      case "zoom":
        // Entrance settles TRANSITION_ZOOM→1; exit pushes 1→TRANSITION_ZOOM.
        fx.zoom *=
          side === "in"
            ? TRANSITION_ZOOM - (TRANSITION_ZOOM - 1) * p
            : 1 + (TRANSITION_ZOOM - 1) * (1 - p);
        break;
      case "pop":
        fx.zoom *= 0.8 + 0.2 * p;
        fx.alpha *= p;
        break;
      case "slideleft": // frame moves left: enters from the right, exits off the left
        fx.dxFrac += side === "in" ? 1 - p : -(1 - p);
        break;
      case "slideright":
        fx.dxFrac += side === "in" ? -(1 - p) : 1 - p;
        break;
      case "slideup": // frame moves up: enters from the bottom, exits off the top
        fx.dyFrac += side === "in" ? 1 - p : -(1 - p);
        break;
      case "slidedown":
        fx.dyFrac += side === "in" ? -(1 - p) : 1 - p;
        break;
      case "fade":
      default:
        // Fade — and the graceful fallback for a stored style this build no
        // longer knows (the export treats unknown styles the same way).
        if (side === "in" ? edges?.backdropIn : edges?.backdropOut) fx.alpha *= p;
        else fx.veil = Math.max(fx.veil, 1 - p);
        fx.gain = Math.min(fx.gain, p);
        break;
    }
  };
  if (clip.animIn && !edges?.skipIn) apply(clip.animIn, "in");
  if (clip.animOut && !edges?.skipOut) apply(clip.animOut, "out");
  return fx;
}

/**
 * The gain everything else drops to at time `t` while a ducking voiceover clip
 * is audible: the lowest `duck` among the clips live then, 1 when none
 * (mirrors the export's timeline-windowed volume filters).
 */
export function duckGainAt(audioClips: AudioClip[], t: number): number {
  let g = 1;
  for (const a of audioClips) {
    if (a.hidden || a.duck === undefined || a.duck >= 1) continue;
    const speed = a.speed && a.speed > 0 ? a.speed : 1;
    const len = Math.max(0.1, (a.out - a.in) / speed);
    if (t >= a.start && t < a.start + len) g = Math.min(g, Math.max(0, a.duck));
  }
  return g;
}

/** How much of a clip's animation window is still running at `rel`, for the
 * sides that show a neighbour's frame behind them. */
function animLive(a: ClipAnim | undefined, side: "in" | "out", rel: number, len: number) {
  if (!a || a.style === "zoom") return false;
  const d = Math.min(a.seconds, len);
  return side === "in" ? rel < d : len - rel < d;
}

/** Everything track 0 does at one instant. */
export interface TrackZeroPlan {
  master: ClipSpan;
  /** The clip blending in over the master, when a transition is live. */
  incoming: ClipSpan | null;
  style: TransitionStyle;
  /** Transition progress, 0 when none is live. */
  p: number;
  masterAlpha: number;
  masterZoom: number;
  /** Frame motion on the master, as a fraction of canvas width/height. */
  masterFxFrac: { dx: number; dy: number };
  incAlpha: number;
  incZoom: number;
  /** Fade-to-black over the master clip's own footprint, 0..1. */
  veil: number;
  /** What the master clip's audio is scaled by, before volume and ducking. */
  gain: number;
  /** A neighbour's held frame to draw behind a live edge animation. */
  backdrop: { span: ClipSpan; at: number } | null;
  /** The next clip, when it is close enough to be worth warming. */
  upcoming: ClipSpan | null;
}

/** How long before a clip's entrance its decoder should be spun up. */
export const PREROLL_LEAD_S = 0.5;

/**
 * How long the pre-roll for this clip can actually run, in timeline seconds.
 *
 * The roll plays the element forward so it arrives at the in-point exactly as
 * the cut lands, which it can only do where there is source ahead of that point
 * to play through: a trimmed clip gets the full lead, one that starts at 0 gets
 * none. Rolling for longer than the source allows leaves the element that far
 * past its in-point when the cut lands, and the handoff seeks back to reach it —
 * restarting the decoder at the join, which is the hitch the pre-roll exists to
 * remove.
 */
export function prerollLead(inPoint: number, speed: number): number {
  return Math.max(0, Math.min(PREROLL_LEAD_S, inPoint / speed));
}

/**
 * Work out track 0's state at time `t`: the transition live across the join,
 * the master clip's own entrance/exit ramps, and the neighbour frame that
 * belongs behind an animation at an abutting cut.
 */
export function trackZeroPlan(master: ClipSpan, spans: ClipSpan[], t: number): TrackZeroPlan {
  const idx = spans.indexOf(master);
  const next = spans[idx + 1];
  const prev = spans[idx - 1];
  const style = master.clip.transitionStyle ?? "crossfade";

  let p = 0;
  let incAlpha = 0;
  let masterZoom = 1;
  let incZoom = 1;
  let incoming: ClipSpan | null = null;
  const rel = t - master.start;
  // The blend window is the master's last `transitionOut` seconds: the next
  // clip's held first frame arrives over the live tail, fully there at the
  // cut, where the next clip starts playing. Clips never intersect — the
  // window claims no layout.
  if (master.transitionOut > 0 && next && t >= next.start - master.transitionOut) {
    p = Math.min(1, (t - (next.start - master.transitionOut)) / master.transitionOut);
    incAlpha = p;
    incoming = next;
    if (style === "crosszoom") {
      // The outgoing picture pushes in; the incoming one waits pushed in and
      // settles back over its own head once it starts (mirroring the export's
      // head ramp on the incoming segment).
      masterZoom = 1 + (TRANSITION_ZOOM - 1) * p;
      incZoom = TRANSITION_ZOOM;
    }
  }
  // The incoming side of the previous clip's cross zoom: settle back to 1
  // over this clip's own head.
  if (prev && prev.transitionOut > 0 && (prev.clip.transitionStyle ?? "crossfade") === "crosszoom") {
    if (rel < prev.transitionOut) {
      masterZoom *= TRANSITION_ZOOM - (TRANSITION_ZOOM - 1) * Math.max(0, rel / prev.transitionOut);
    }
  }
  const abutPrev =
    !!prev &&
    !prev.clip.hidden &&
    prev.transitionOut <= 0 &&
    Math.abs(prev.start + prev.len - master.start) < 0.02;
  const abutNext =
    !!next &&
    !next.clip.hidden &&
    master.transitionOut <= 0 &&
    Math.abs(master.start + master.len - next.start) < 0.02;
  const anim = clipAnimFx(master.clip, rel, master.len, {
    skipIn: (prev?.transitionOut ?? 0) > 0,
    skipOut: master.transitionOut > 0,
    backdropIn: abutPrev,
    backdropOut: abutNext,
  });

  // A neighbour's held frame goes behind a live edge animation at an abutting
  // cut: the previous clip's last frame behind an entrance, the next clip's
  // first frame behind an exit. A zoom keeps the frame covered, so it has none.
  let backdrop: TrackZeroPlan["backdrop"] = null;
  if (!incoming) {
    if (abutPrev && animLive(master.clip.animIn, "in", rel, master.len)) {
      backdrop = { span: prev, at: prev.clip.out - 0.05 };
    } else if (abutNext && animLive(master.clip.animOut, "out", rel, master.len)) {
      backdrop = { span: next, at: next.clip.in };
    }
  }

  return {
    master,
    incoming,
    style,
    p,
    masterAlpha: anim.alpha,
    masterZoom: masterZoom * anim.zoom,
    masterFxFrac: { dx: anim.dxFrac, dy: anim.dyFrac },
    incAlpha,
    incZoom,
    veil: anim.veil,
    // The outgoing sound leaves with the picture: it fades across the blend
    // window and the incoming clip enters clean at the cut, matching the
    // export's tail fade + hard join.
    gain: anim.gain * (1 - p),
    backdrop,
    upcoming: next && t < next.start && t >= next.start - PREROLL_LEAD_S ? next : null,
  };
}

/** One upper-track clip on screen, with its ramps resolved. */
export interface OverlayPlanItem {
  clip: VideoClip;
  asset: MediaAsset;
  alpha: number;
  zoom: number;
  gain: number;
}

/**
 * The upper-track clips live at `t`, in draw order: further-back tracks first,
 * and within a track earlier clips first, so a dissolving pair blends the
 * incoming clip in over the outgoing one.
 *
 * `spansOf` supplies a track's spans; callers pass the store's own
 * `getClipSpans` so span geometry is computed one way everywhere.
 */
export function overlayPlan(
  tracks: number[],
  spansOf: (track: number) => ClipSpan[],
  t: number
): OverlayPlanItem[] {
  const live: OverlayPlanItem[] = [];
  for (const track of [...tracks].sort((a, b) => a - b)) {
    const spans = spansOf(track);
    for (let i = 0; i < spans.length; i++) {
      const sp = spans[i];
      if (sp.clip.hidden) continue;
      if (t < sp.start || t >= sp.start + sp.len) continue;
      live.push({
        clip: sp.clip,
        asset: sp.asset,
        ...overlayTransitionFx(sp, spans[i - 1], spans[i + 1], t),
      });
    }
  }
  return live;
}
