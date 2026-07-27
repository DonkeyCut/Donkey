"use client";

import { useEffect, type RefObject } from "react";
import { clipSpeed, getClipSpans, overlayLayers, projectDuration, useEditor } from "@/cut/lib/store";
import { isFullRect, overlayAnimStyle, projectFadeSeconds, rectOf, TRANSITION_ZOOM } from "@/cut/lib/types";
import type { AudioClip, ClipAnim, ClipSpan, FrameRect, MediaAsset, TransitionStyle, VideoClip } from "@/cut/lib/types";
import { gradeTint, gradeToCssFilter, isNeutralGrade } from "@/cut/lib/colorGrade";
import { grainTile, lookCssFilter, lookPost } from "@/cut/lib/looks";
import { reportMediaElementError } from "@/cut/lib/mediaLinks";
import { registerSourceSampler } from "@/cut/lib/previewCanvas";

/** The alpha/zoom/gain ramps a transition or clip animation puts on one
 * upper-track clip at `t`. A transition blends the incoming clip in over the
 * outgoing one (which keeps full alpha and its audio until its footprint
 * ends); a clip animation ramps the clip's own edge. On an upper track a fade
 * ramps to transparent — the tracks beneath show through — and the animation
 * styles that need frame motion degrade to a fade, both matching the export's
 * alpha ramps. */
function overlayTransitionFx(
  span: ClipSpan,
  prev: ClipSpan | undefined,
  next: ClipSpan | undefined,
  t: number
): { alpha: number; zoom: number; gain: number } {
  let alpha = 1;
  let zoom = 1;
  let gain = 1;
  const style = span.clip.transitionStyle ?? "crossfade";
  const prevStyle = prev?.clip.transitionStyle ?? "crossfade";
  // Incoming side of the previous clip's transition: blend in.
  if (prev && prev.transitionOut > 0) {
    const rel = t - span.start;
    if (rel < prev.transitionOut) {
      const p = Math.max(0, rel / prev.transitionOut);
      alpha = Math.min(alpha, p);
      gain = Math.min(gain, p);
      if (prevStyle === "crosszoom") zoom = TRANSITION_ZOOM - (TRANSITION_ZOOM - 1) * p;
    }
  }
  // Outgoing side of this clip's own cross zoom: the picture pushes in while
  // the incoming clip settles back (it stays opaque — the blend is the
  // incoming clip's alpha).
  if (next && span.transitionOut > 0 && t >= next.start && style === "crosszoom") {
    const p = Math.min(1, (t - next.start) / span.transitionOut);
    zoom = 1 + (TRANSITION_ZOOM - 1) * p;
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

/** A track-0 clip's own entrance/exit animation state at `rel` seconds into
 * its `len`-second footprint. Mirrors the export's per-segment ramps: fades
 * veil to/from black with the audio following; zoom uses the shared
 * TRANSITION_ZOOM ramps; pop scales from/to 80% with an alpha fade; slides
 * translate the frame (fractions of the canvas, matching xfade against
 * black); wipes reveal/conceal through a moving edge. */
function clipAnimFx(
  clip: VideoClip,
  rel: number,
  len: number,
  // Edge context from the caller: a transitioned joint owns its edges (skip
  // that side), and an abutting hard cut gives the side a backdrop — the
  // neighbor's held frame — so a fade blends by alpha there instead of
  // veiling to black.
  edges?: { skipIn?: boolean; skipOut?: boolean; backdropIn?: boolean; backdropOut?: boolean }
) {
  const fx = {
    alpha: 1,
    zoom: 1,
    gain: 1,
    veil: 0, // fade-to-black amount, drawn by the caller's veil pass
    dxFrac: 0, // frame translation, fraction of canvas width/height
    dyFrac: 0,
  };
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

/** The gain everything else drops to at time `t` while a ducking voiceover
 * clip is audible: the lowest `duck` among the clips live then, 1 when none
 * (mirrors the export's timeline-windowed volume filters). */
function duckGainAt(audioClips: AudioClip[], t: number): number {
  let g = 1;
  for (const a of audioClips) {
    if (a.hidden || a.duck === undefined || a.duck >= 1) continue;
    const speed = a.speed && a.speed > 0 ? a.speed : 1;
    const len = Math.max(0.1, (a.out - a.in) / speed);
    if (t >= a.start && t < a.start + len) g = Math.min(g, Math.max(0, a.duck));
  }
  return g;
}

// A video clip on any track is backed by a <video> for footage or an <img>
// for a still image. These helpers read either kind uniformly so the
// compositor stays one code path — an image never seeks, plays, or carries
// audio.
type MediaEl = HTMLVideoElement | HTMLImageElement;
const isImageEl = (el: MediaEl): el is HTMLImageElement =>
  typeof HTMLImageElement !== "undefined" && el instanceof HTMLImageElement;
const elReady = (el: MediaEl) =>
  isImageEl(el) ? el.complete && el.naturalWidth > 0 : el.readyState >= 2 && el.videoWidth > 0;
const elW = (el: MediaEl) => (isImageEl(el) ? el.naturalWidth : el.videoWidth);
const elH = (el: MediaEl) => (isImageEl(el) ? el.naturalHeight : el.videoHeight);
// A source that will never become ready: a video decode error, or an image
// that finished loading (`complete`) with no pixels (a broken/unreachable URL).
// The compositor paints through these instead of wedging on them.
const elErrored = (el: MediaEl) =>
  isImageEl(el) ? el.complete && el.naturalWidth === 0 : !!el.error;
/** Browsers reject playbackRate outside roughly 0.0625–16, so the element
 * rate is clamped; beyond it the periodic seek correction carries the true
 * speed, at the cost of a choppier preview. Export renders the real rate. */
const safeRate = (speed: number) => Math.min(16, Math.max(0.0625, speed));

// Decode-ahead window. Every tick, clips whose entrance is within this many
// seconds of the playhead get their decoder built now and seeked to their first
// frame, so the file is already buffering (preload="auto") and frame 0 is
// decoded before the playhead reaches them — a cut lands with no cold-start
// hitch. Capped so a montage of tiny clips can't start a fetch storm that
// starves the clip actually on screen.
const WARM_HORIZON_S = 8;
const WARM_MAX = 4;

// Decoder health. A decoder can stop making progress two ways, and both used
// to be permanent for the life of the tab. It can error — and an errored
// element stays errored, because re-minting the media links does not repoint
// it: a signed URL is stable for its whole signing window, so the mint hands
// back the very string that just failed and nothing swaps. Or it can wedge
// before its first frame with nothing arriving, which nothing was watching for
// at all. Either way that clip played black for the rest of the session while
// its neighbours played fine. Decoders are cheap and replaceable, so a clip
// whose element stops advancing gets a new one, bounded so a source that
// really is unplayable settles into the paint-through path instead of
// refetching forever.
const DECODER_STALL_MS = 10_000;
const DECODER_RETRY_MS = 1_000;
const DECODER_REBUILDS = 3;

// Pre-roll lead. Inside this many seconds of a clip's entrance, its element is
// played muted and undrawn so the decoder is already running across the
// in-point when the cut lands — the handoff play() then resumes hot instead of
// spinning a cold decoder up. Kept short so the pre-rolled picture arrives at
// the in-point right as the playhead reaches the cut.
const PREROLL_LEAD_S = 0.5;

const pauseEl = (el: MediaEl) => {
  if (!isImageEl(el) && !el.paused) el.pause();
};
/** Build the decoder element for a clip's asset: an <img> for a still, a
 * hidden <video> for footage. */
function makeMediaEl(asset: MediaAsset): MediaEl {
  if (asset.type === "image") {
    const img = document.createElement("img");
    img.crossOrigin = "anonymous";
    // Detached elements never reach the global error listener — report
    // failures explicitly so an expired signed URL re-mints the batch.
    img.addEventListener("error", () => reportMediaElementError(img));
    img.src = asset.url;
    return img;
  }
  const v = document.createElement("video");
  v.playsInline = true;
  v.preload = "auto";
  v.crossOrigin = "anonymous";
  v.addEventListener("error", () => reportMediaElementError(v));
  v.src = asset.url;
  return v;
}
/** Release an element's source. Images just drop the src; videos stop and
 * unload the decoder. */
function teardown(el: MediaEl) {
  if (isImageEl(el)) {
    el.removeAttribute("src");
    return;
  }
  el.pause();
  el.removeAttribute("src");
  el.load();
}

// The canvas backing store is the full frame resolution (1080×1920 or
// 1920×1080, set by Preview from the project aspect) so the preview stays
// sharp on Retina displays. The engine reads the size off the canvas each
// frame, so an aspect switch takes effect seamlessly.

/**
 * Preview engine. One hidden <video> per track-0 clip and one <audio> per
 * soundtrack clip; the active clip's video element is the master clock while
 * playing and every frame is composited onto the preview canvas (contain-fit,
 * matching the export's letterboxing).
 */
class Engine {
  // Keyed by clip id, not asset id: two trims of the same source get their own
  // decoders, so a cross-dissolve can show both at once and the incoming clip
  // warms during the overlap instead of fighting the outgoing one over a single
  // element's seek head (the black flash between same-source segments).
  private videoEls = new Map<string, MediaEl>();
  // One element per overlay clip (keyed by clip id, not asset) so the same
  // source can appear on two tracks at once.
  private overlayEls = new Map<string, MediaEl>();
  private audioEls = new Map<string, HTMLAudioElement>();
  // Per-clip decoder health, keyed like the element maps: the last progress
  // reading and when it was taken, plus how many times this clip's decoder has
  // been rebuilt on the current source.
  private health = new Map<string, { mark: number; at: number; rebuilds: number }>();
  private raf = 0;
  private activeClipId: string | null = null;
  private disposed = false;
  // Scratch surface for per-clip color grades: the source draws here through
  // ctx.filter (+ a multiply tint), and the graded result is what the
  // compositor stamps onto the main canvas. One instance suffices — every use
  // is draw-then-immediately-copy.
  private gradeCanvas: HTMLCanvasElement | null = null;
  // Cached buffers for look post passes: a canvas-sized scratch for glow and
  // ghost self-copies, and a footprint-sized vignette gradient.
  private lookScratch: HTMLCanvasElement | null = null;
  private vignetteCanvas: HTMLCanvasElement | null = null;
  // Wall-clock stamp for advancing time where track 0 has nothing playing —
  // in a gap or past its end there is no track-0 video element to act as the
  // master clock.
  private lastPlayNow = 0;

  constructor(private canvas: HTMLCanvasElement) {
    this.tick = this.tick.bind(this);
    this.raf = requestAnimationFrame(this.tick);
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    for (const el of this.videoEls.values()) teardown(el);
    for (const el of this.overlayEls.values()) teardown(el);
    for (const el of this.audioEls.values()) el.pause();
    this.videoEls.clear();
    this.overlayEls.clear();
    this.audioEls.clear();
    this.health.clear();
  }

  /** The cached element for a clip, rebuilt when its source no longer matches —
   * a swap keeps the clip id but repoints the asset (a shot re-render), and the
   * old decoder would otherwise keep playing (or erroring on) the old file. */
  private elFor(map: Map<string, MediaEl>, clipId: string, asset: MediaAsset): MediaEl {
    let el = map.get(clipId);
    if (el && el.getAttribute("src") !== asset.url) {
      teardown(el);
      // A repoint is a new source, so it starts with a full rebuild budget.
      this.health.delete(clipId);
      el = undefined;
    }
    if (el && this.spent(clipId, el)) {
      teardown(el);
      el = undefined;
    }
    if (!el) {
      el = makeMediaEl(asset);
      map.set(clipId, el);
    }
    return el;
  }

  /** Whether this clip's decoder has stopped making progress and should be
   * replaced. A ready element is healthy and clears its streak; one whose
   * readiness and buffer are both still advancing is on its way there. What is
   * left is an element that errored, or that has sat at the same reading past
   * `DECODER_STALL_MS` — dead either way, and worth one more decoder. Says yes
   * at most `DECODER_REBUILDS` times per source, so an unplayable file stops
   * costing fetches and falls through to the paint-through path. */
  private spent(clipId: string, el: MediaEl): boolean {
    const now = performance.now();
    const h = this.health.get(clipId) ?? { mark: -1, at: now, rebuilds: 0 };
    if (elReady(el)) {
      this.health.set(clipId, { mark: -1, at: now, rebuilds: 0 });
      return false;
    }
    // Progress reading, not a clock: readiness plus how far the buffer reaches,
    // so a big file arriving slowly over a thin link is never mistaken for a
    // wedge and torn down mid-fetch.
    const mark = isImageEl(el)
      ? 0
      : el.readyState + (el.buffered.length ? el.buffered.end(el.buffered.length - 1) : 0);
    if (mark > h.mark) {
      this.health.set(clipId, { ...h, mark, at: now });
      return false;
    }
    const since = now - h.at;
    const dead = elErrored(el) ? since > DECODER_RETRY_MS : since > DECODER_STALL_MS;
    if (!dead || h.rebuilds >= DECODER_REBUILDS) {
      this.health.set(clipId, { ...h, mark });
      return false;
    }
    this.health.set(clipId, { mark: -1, at: now, rebuilds: h.rebuilds + 1 });
    return true;
  }

  private videoFor(clip: VideoClip, asset: MediaAsset): MediaEl {
    return this.elFor(this.videoEls, clip.id, asset);
  }

  /** Decode-ahead for track 0: build each soon-to-enter clip's element
   * and seek it to its entrance frame now, so its file is fetching and frame 0
   * is decoded before the playhead arrives. Only clips strictly ahead of `t`
   * are touched — the live master (and any dissolve partner) steers its own
   * clock through `composite`. Bounded by `WARM_HORIZON_S`/`WARM_MAX`; spans are
   * start-ordered, so we can stop once one is past the horizon. */
  private warmAhead(spans: ClipSpan[], t: number) {
    let warmed = 0;
    for (const span of spans) {
      if (span.start <= t) continue; // current or past — not ours to warm
      if (span.start > t + WARM_HORIZON_S) break;
      // The imminent clip inside the pre-roll window is `warmNext`'s to play
      // hot; a parking seek here would fight it, so leave it alone.
      if (span.start - t <= PREROLL_LEAD_S) continue;
      const el = this.videoFor(span.clip, span.asset); // creating it starts the fetch
      // Park a not-yet-imminent clip exactly where the pre-roll will play from
      // (`warmNext`'s `from`), not on its entrance frame: parking at `in` and
      // then seeking back `PREROLL_LEAD_S` for the roll-in discards the warmed
      // buffer, and over the network (cloud media) that late re-seek is what
      // used to stall the handoff. Parked here, the pre-roll's seek is a no-op
      // on already-buffered bytes and the cut lands hot.
      if (!isImageEl(el) && !el.seeking && el.paused) {
        const target = Math.max(0, span.clip.in - PREROLL_LEAD_S * clipSpeed(span.clip));
        if (Math.abs(el.currentTime - target) > 0.1) el.currentTime = target;
      }
      if (++warmed >= WARM_MAX) break;
    }
  }

  /** Decode-ahead counterpart for overlay tracks: warm each overlay clip whose
   * entrance is within the horizon (overlay clips aren't start-ordered, so this
   * scans rather than breaking early). A warmed element sits paused on its first
   * frame until the tick's overlay path takes it live. */
  private warmOverlaysAhead(t: number) {
    const s = useEditor.getState();
    let warmed = 0;
    for (const c of overlayLayers(s.clips)) {
      if (c.hidden || c.start <= t || c.start > t + WARM_HORIZON_S) continue;
      const asset = s.assets.find((a) => a.id === c.assetId);
      if (!asset) continue;
      const el = this.overlayVideoFor(c, asset);
      if (!isImageEl(el) && !el.seeking && Math.abs(el.currentTime - c.in) > 0.1) {
        el.currentTime = c.in;
      }
      if (++warmed >= WARM_MAX) break;
    }
  }

  /** Pre-roll the imminent next clip so its handoff is hot. A decode-ahead
   * element sits paused on its entrance frame with a cold decode pipeline, so
   * the handoff `play()` has to spin the decoder up — and past a trimmed
   * in-point, decode forward from the prior keyframe — before the clock
   * advances: the residual hitch at a cut, and the freeze that parking the
   * element back on its frame never cured. Instead, in the moments before the
   * cut, play the element muted and undrawn from `lead` of source before its
   * entrance, so it is already running across the in-point — arriving there as
   * the playhead reaches the cut — and the real `play()` resumes hot with
   * nothing skipped. */
  private warmNext(span: ClipSpan, t: number) {
    const el = this.videoFor(span.clip, span.asset);
    if (isImageEl(el)) return; // a still needs no pipeline
    // Farther out than the lead: leave it parked and buffering (warmAhead's job).
    if (t < span.start - PREROLL_LEAD_S) return;
    const speed = clipSpeed(span.clip);
    const rate = safeRate(speed);
    if (el.playbackRate !== rate) el.playbackRate = rate;
    el.muted = true; // silent until it becomes master and unmutes
    // Already rolling: let it run — it crosses `in` on its own as the cut lands.
    if (!el.paused) return;
    // Seat it `lead` of source before the entrance, then play forward so it
    // reaches `in` right as the playhead reaches the cut. Bounded at 0 for an
    // untrimmed clip, whose keyframe-0 start is already hot.
    const from = Math.max(0, span.clip.in - PREROLL_LEAD_S * speed);
    if (!el.seeking && Math.abs(el.currentTime - from) > 0.1) el.currentTime = from;
    if (el.readyState >= 2 && !el.seeking) void el.play().catch(() => {});
  }

  /** Seek/rate/play one clip's element toward its frame at timeline time `t`,
   * without touching any other element (the caller pauses stale ones). */
  private prepare(span: ClipSpan, t: number, play: boolean, muted: boolean): MediaEl {
    const el = this.videoFor(span.clip, span.asset);
    // A still never seeks, plays, or carries audio — it's ready as soon as the
    // <img> decodes. Skip every video-clock operation.
    if (isImageEl(el)) return el;
    const speed = clipSpeed(span.clip);
    const rate = safeRate(speed);
    if (el.playbackRate !== rate) el.playbackRate = rate;
    const target = span.clip.in + Math.max(0, t - span.start) * speed;
    // While playing, the element is its own clock and advances on its own, so
    // only re-seek on a real jump (a clip switch or a scrub) — never for the
    // sub-second lag between this frame's `target` (built from last frame's
    // clock read) and the freely-running element. At high speed that lag is
    // `speed × frameInterval` every frame, which a tight threshold would seek
    // backward each tick, stalling playback. When paused (scrubbing) keep it
    // tight so the frame under the mouse tracks precisely.
    // Let an in-flight seek finish before issuing the next one — restarting
    // the decoder every mousemove makes scrubbing stutter.
    const tol = play ? 0.34 : 0.05;
    if (Math.abs(el.currentTime - target) > tol && !el.seeking) el.currentTime = target;
    el.muted = muted;
    if (play) {
      if (el.paused && el.readyState >= 2) void el.play().catch(() => {});
    } else if (!el.paused) {
      el.pause();
    }
    return el;
  }

  private pauseExcept(keep: Set<string>) {
    for (const [clipId, el] of this.videoEls) {
      if (!keep.has(clipId)) pauseEl(el);
    }
  }

  /** Draw a video element into a sub-region of the frame. "fill" covers the
   * region and crops the overflow (clipped to the rect); "fit" contains the
   * whole picture inside it, centered. `zoom` scales the picture around the
   * region's center (zoom transitions), clipping the overflow to the rect. */
  /** The clip's raw, ungraded decoder frame for analysis (the color panel's
   * Auto), or null when no ready decoder exists for the clip. */
  sourceFor(clipId: string): CanvasImageSource | null {
    const el = this.videoEls.get(clipId) ?? this.overlayEls.get(clipId);
    return el && elReady(el) ? el : null;
  }

  /** The clip's picture with its color grade and look grading applied, or the
   * raw element when there is nothing to apply. Mirrors the export's chain
   * order — grade first (lutrgb/hue), then the look's color pass — as CSS
   * filters, with the grade's warm tint as a multiply pass, and source alpha
   * restored so transparent stills keep their transparency. The look's post
   * passes (vignette, grain, glow…) draw over the composited layer instead —
   * see applyLookPost. */
  private gradedSource(el: MediaEl, clip: VideoClip | undefined): CanvasImageSource {
    const grade = clip?.grade;
    const lookCss = lookCssFilter(clip?.look, clip?.lookAmount);
    if (isNeutralGrade(grade) && !lookCss) return el;
    const scratch = (this.gradeCanvas ??= document.createElement("canvas"));
    const w = elW(el);
    const h = elH(el);
    // Match both dimensions — a transition alternates two differently-sized
    // sources through this one scratch every frame, and a stale dimension
    // leaves the previous clip's pixels in the draw.
    if (scratch.width !== w) scratch.width = w;
    if (scratch.height !== h) scratch.height = h;
    const ctx = scratch.getContext("2d");
    // Without ctx.filter support, skip the whole treatment (never half-apply
    // the tint); export still renders it.
    if (!ctx || !("filter" in ctx)) return el;
    ctx.clearRect(0, 0, w, h);
    ctx.filter = [gradeToCssFilter(grade), lookCss].filter(Boolean).join(" ") || "none";
    ctx.drawImage(el, 0, 0, w, h);
    ctx.filter = "none";
    const tint = gradeTint(grade);
    if (tint) {
      ctx.globalCompositeOperation = "multiply";
      ctx.fillStyle = tint;
      ctx.fillRect(0, 0, w, h);
      // Multiply painted the transparent areas solid; carve the source's
      // alpha back in.
      ctx.globalCompositeOperation = "destination-in";
      ctx.drawImage(el, 0, 0, w, h);
      ctx.globalCompositeOperation = "source-over";
    }
    return scratch;
  }

  /** Draw a look's post passes over one composited layer's footprint (canvas
   * pixels): vignette, animated grain, self-copy glow, color washes, chroma
   * ghosts. `alpha` follows the layer so a dissolving clip's grain dissolves
   * with it. Every buffer here is cached — no per-frame allocation or pixel
   * reads. */
  private applyLookPost(clip: VideoClip | undefined, rx: number, ry: number, rw: number, rh: number, alpha: number) {
    const post = lookPost(clip?.look, clip?.lookAmount);
    if (!post || alpha <= 0 || rw <= 0 || rh <= 0) return;
    const ctx = this.canvas.getContext("2d");
    if (!ctx || !("filter" in ctx)) return;
    ctx.save();
    ctx.beginPath();
    ctx.rect(rx, ry, rw, rh);
    ctx.clip();
    if (post.glow) {
      // Copy the just-drawn region through a blur (and a highlight isolation
      // for halation) and lay it back over itself.
      const scratch = (this.lookScratch ??= document.createElement("canvas"));
      if (scratch.width !== this.canvas.width) scratch.width = this.canvas.width;
      if (scratch.height !== this.canvas.height) scratch.height = this.canvas.height;
      const sctx = scratch.getContext("2d");
      if (sctx && "filter" in sctx) {
        const blurPx = Math.max(1, post.glow.blurFrac * this.canvas.height);
        sctx.clearRect(rx, ry, rw, rh);
        sctx.filter = post.glow.bright
          ? `contrast(2.5) brightness(0.55) saturate(1.4) sepia(0.35) blur(${blurPx}px)`
          : `blur(${blurPx}px)`;
        sctx.drawImage(this.canvas, rx, ry, rw, rh, rx, ry, rw, rh);
        sctx.filter = "none";
        ctx.globalAlpha = post.glow.alpha * alpha;
        ctx.globalCompositeOperation = post.glow.mode;
        ctx.drawImage(scratch, rx, ry, rw, rh, rx, ry, rw, rh);
      }
    }
    if (post.ghost) {
      // VHS chroma fringing: warm and cool copies of the region nudged apart.
      const scratch = (this.lookScratch ??= document.createElement("canvas"));
      if (scratch.width !== this.canvas.width) scratch.width = this.canvas.width;
      if (scratch.height !== this.canvas.height) scratch.height = this.canvas.height;
      const sctx = scratch.getContext("2d");
      if (sctx && "filter" in sctx) {
        const shift = Math.max(1, post.ghost.shiftFrac * this.canvas.width);
        sctx.clearRect(rx, ry, rw, rh);
        sctx.filter = "sepia(1) saturate(4) hue-rotate(-40deg) brightness(0.55)";
        sctx.drawImage(this.canvas, rx, ry, rw, rh, rx, ry, rw, rh);
        sctx.filter = "none";
        ctx.globalAlpha = post.ghost.alpha * alpha;
        ctx.globalCompositeOperation = "lighter";
        ctx.drawImage(scratch, rx, ry, rw, rh, rx + shift, ry, rw, rh);
        if (sctx) {
          sctx.clearRect(rx, ry, rw, rh);
          sctx.filter = "sepia(1) saturate(4) hue-rotate(140deg) brightness(0.55)";
          sctx.drawImage(this.canvas, rx, ry, rw, rh, rx, ry, rw, rh);
          sctx.filter = "none";
          ctx.drawImage(scratch, rx, ry, rw, rh, rx - shift, ry, rw, rh);
        }
      }
    }
    ctx.globalCompositeOperation = "source-over";
    for (const wash of post.washes ?? []) {
      ctx.globalAlpha = wash.alpha * alpha;
      ctx.globalCompositeOperation = wash.mode;
      ctx.fillStyle = wash.color;
      ctx.fillRect(rx, ry, rw, rh);
    }
    if (post.grain) {
      const tile = grainTile(Math.floor(performance.now() / 80));
      if (tile) {
        ctx.globalAlpha = post.grain * alpha;
        ctx.globalCompositeOperation = "overlay";
        for (let y = ry; y < ry + rh; y += tile.height) {
          for (let x = rx; x < rx + rw; x += tile.width) {
            ctx.drawImage(tile, x, y);
          }
        }
      }
    }
    if (post.vignette) {
      // Cached radial gradient, rebuilt only when the footprint size changes.
      const vg = (this.vignetteCanvas ??= document.createElement("canvas"));
      if (vg.width !== Math.round(rw) || vg.height !== Math.round(rh)) {
        vg.width = Math.max(1, Math.round(rw));
        vg.height = Math.max(1, Math.round(rh));
        const vctx = vg.getContext("2d");
        if (vctx) {
          const g = vctx.createRadialGradient(
            vg.width / 2,
            vg.height / 2,
            Math.min(vg.width, vg.height) * 0.35,
            vg.width / 2,
            vg.height / 2,
            Math.hypot(vg.width, vg.height) / 2
          );
          g.addColorStop(0, "rgba(0,0,0,0)");
          g.addColorStop(1, "rgba(0,0,0,1)");
          vctx.clearRect(0, 0, vg.width, vg.height);
          vctx.fillStyle = g;
          vctx.fillRect(0, 0, vg.width, vg.height);
        }
      }
      ctx.globalAlpha = post.vignette * alpha;
      ctx.globalCompositeOperation = "source-over";
      ctx.drawImage(vg, rx, ry, rw, rh);
    }
    ctx.restore();
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
  }

  private drawIntoRect(
    el: MediaEl,
    rect: FrameRect,
    fill: boolean,
    alpha: number,
    zoom = 1,
    clip?: VideoClip
  ) {
    const ctx = this.canvas.getContext("2d");
    if (!ctx) return;
    const W = this.canvas.width;
    const H = this.canvas.height;
    const rx = rect.x * W;
    const ry = rect.y * H;
    const rw = rect.w * W;
    const rh = rect.h * H;
    const vw = elW(el);
    const vh = elH(el);
    const sc = (fill ? Math.max(rw / vw, rh / vh) : Math.min(rw / vw, rh / vh)) * zoom;
    const dw = vw * sc;
    const dh = vh * sc;
    const dx = rx + (rw - dw) / 2;
    const dy = ry + (rh - dh) / 2;
    const src = this.gradedSource(el, clip);
    const prevAlpha = ctx.globalAlpha;
    ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
    if (fill || zoom > 1) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(rx, ry, rw, rh);
      ctx.clip();
      ctx.drawImage(src, dx, dy, dw, dh);
      ctx.restore();
    } else {
      ctx.drawImage(src, dx, dy, dw, dh);
    }
    ctx.globalAlpha = prevAlpha;
    this.applyLookPost(clip, rx, ry, rw, rh, alpha);
  }

  /** Frame-motion effect a transition or animation puts on one layer draw:
   * a whole-frame translation in canvas px. */
  private drawLayer(
    el: MediaEl | null,
    clip: VideoClip | undefined,
    clear: boolean,
    alpha: number,
    zoom = 1,
    fx?: { dx?: number; dy?: number }
  ) {
    const ctx = this.canvas.getContext("2d");
    if (!ctx) return;
    const W = this.canvas.width;
    const H = this.canvas.height;
    if (!el) {
      if (clear) {
        ctx.fillStyle = "#000";
        ctx.fillRect(0, 0, W, H);
      }
      return;
    }
    // A hidden clip plays nothing: fill black only if we own the clear,
    // otherwise leave the frame as drawn so far.
    if (clip?.hidden) {
      if (clear) {
        ctx.fillStyle = "#000";
        ctx.fillRect(0, 0, W, H);
      }
      return;
    }
    // Mid-seek the element has no decodable frame; keep the previous frame
    // on the canvas instead of strobing black (matters while skimming).
    if (!elReady(el)) return;
    if (clear) {
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, W, H);
    }
    const hasFx = !!fx && (!!fx.dx || !!fx.dy);
    if (hasFx) {
      // Motion runs in full-canvas space — the export translates the whole
      // padded segment frame, so a regioned clip rides along with it.
      // Whole-pixel translation: a fractional offset antialiases both frame
      // edges and draws a hairline seam where a push's frames meet.
      ctx.save();
      ctx.translate(Math.round(fx!.dx ?? 0), Math.round(fx!.dy ?? 0));
    }
    // A regioned track-0 clip (split-screen half) draws into its rect over the
    // black frame; the full-frame path below keeps the pan-crop behavior.
    const rect = rectOf(clip ?? {});
    if (!isFullRect(rect)) {
      this.drawIntoRect(el, rect, clip?.fit === "fill", alpha, zoom, clip);
      if (hasFx) ctx.restore();
      return;
    }
    const fill = clip?.fit === "fill";
    const vw = elW(el);
    const vh = elH(el);
    const scale = (fill ? Math.max(W / vw, H / vh) : Math.min(W / vw, H / vh)) * zoom;
    const dw = vw * scale;
    const dh = vh * scale;
    let dx = (W - dw) / 2;
    let dy = (H - dh) / 2;
    if (fill) {
      // Pan the crop window across the overflow (matches the export crop).
      const kx = 0.5 + (clip?.panX ?? 0) / 2;
      const ky = 0.5 + (clip?.panY ?? 0) / 2;
      dx = -(dw - W) * kx;
      dy = -(dh - H) * ky;
    }
    const prevAlpha = ctx.globalAlpha;
    ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
    ctx.drawImage(this.gradedSource(el, clip), dx, dy, dw, dh);
    ctx.globalAlpha = prevAlpha;
    this.applyLookPost(clip, 0, 0, W, H, alpha);
    if (hasFx) ctx.restore();
  }

  /** Draw `masterSpan` full-frame, plus any transition live at time `t` in
   * its style's geometry (blend, dip, push, wipe, shape reveal), plus the
   * clips' own entrance/exit animations. Returns the master element (the
   * playback clock). */
  private composite(masterSpan: ClipSpan, spans: ClipSpan[], t: number, play: boolean) {
    // A hidden clip is silent as well as black.
    const masterEl = this.prepare(masterSpan, t, play, masterSpan.clip.muted || !!masterSpan.clip.hidden);
    this.activeClipId = masterSpan.clip.id;
    const keep = new Set([masterSpan.clip.id]);
    const idx = spans.indexOf(masterSpan);
    const next = spans[idx + 1];
    const prev = spans[idx - 1];
    const style = masterSpan.clip.transitionStyle ?? "crossfade";
    let incEl: MediaEl | null = null;
    let alpha = 0;
    let masterZoom = 1;
    let incZoom = 1;
    let black = 0; // fade-to-black veil over the master clip, 0..1
    let gain = 1; // master audio follows the picture through a fade edge
    // Prime the next clip's decoder+audio pipeline shortly before its entrance
    // (the dissolve start, or the hard cut) so the handoff `play()` resumes hot
    // — no cold-start spin-up freezing the picture and playhead at the cut.
    if (next && t < next.start && t >= next.start - PREROLL_LEAD_S) {
      this.warmNext(next, t);
      keep.add(next.clip.id);
    }
    // Transitions: once the incoming footprint starts, blend it in over the
    // master. Each clip owns its element, so the two decode side by side — a
    // true blend even when they are trims of the same source.
    let p = 0;
    if (masterSpan.transitionOut > 0 && next && t >= next.start) {
      p = Math.min(1, (t - next.start) / masterSpan.transitionOut);
      alpha = p;
      incEl = this.prepare(next, t, play, true); // the outgoing clip keeps the audio
      keep.add(next.clip.id);
      if (style === "crosszoom") {
        // The outgoing picture pushes in while the incoming one settles back.
        masterZoom = 1 + (TRANSITION_ZOOM - 1) * p;
        incZoom = TRANSITION_ZOOM - (TRANSITION_ZOOM - 1) * p;
      }
    }
    // The master's own entrance/exit animations; the export bakes the same
    // ramps into the segment before the join. A transitioned joint owns its
    // edges: with a live overlap behind or ahead, that side's animation is
    // held so it never fights the transition's motion (the incoming clip's
    // entrance is likewise held — its joint is this transition). An abutting
    // hard cut gives the animation a backdrop: the neighbor's held frame
    // shows behind it instead of black (black stays for the timeline's ends
    // and across gaps).
    const W = this.canvas.width;
    const H = this.canvas.height;
    const rel = t - masterSpan.start;
    const abutPrev =
      !!prev &&
      !prev.clip.hidden &&
      prev.transitionOut <= 0 &&
      Math.abs(prev.start + prev.len - masterSpan.start) < 0.02;
    const abutNext =
      !!next &&
      !next.clip.hidden &&
      masterSpan.transitionOut <= 0 &&
      Math.abs(masterSpan.start + masterSpan.len - next.start) < 0.02;
    const mAnim = clipAnimFx(masterSpan.clip, rel, masterSpan.len, {
      skipIn: (prev?.transitionOut ?? 0) > 0,
      skipOut: masterSpan.transitionOut > 0,
      backdropIn: abutPrev,
      backdropOut: abutNext,
    });
    const masterFx = { dx: mAnim.dxFrac * W, dy: mAnim.dyFrac * H };
    masterZoom *= mAnim.zoom;
    black = Math.max(black, mAnim.veil);
    gain = Math.min(gain, mAnim.gain);
    // A live voiceover ducks the master clip's sound under it. The clip's own
    // volume rides on top (the element clamps at 1; export honors up to 1.5).
    const duck = duckGainAt(useEditor.getState().audioClips, t);
    if (!isImageEl(masterEl)) {
      masterEl.volume = Math.max(0, Math.min(1, gain * duck * (masterSpan.clip.volume ?? 1)));
    }
    this.pauseExcept(keep);
    // No clear here — the tick clears once before compositing, so a regioned
    // clip draws into its rect over the already-black frame.
    // Backdrop for a live edge animation at an abutting cut: the previous
    // clip's last frame behind an entrance, the next clip's first frame
    // behind an exit. Zoom keeps the frame covered, so it skips the draw.
    if (!incEl) {
      const winLive = (a: ClipAnim | undefined, side: "in" | "out") => {
        if (!a || a.style === "zoom") return false;
        const d = Math.min(a.seconds, masterSpan.len);
        return side === "in" ? rel < d : masterSpan.len - rel < d;
      };
      if (abutPrev && winLive(masterSpan.clip.animIn, "in")) {
        this.drawBackdropFrame(prev!, prev!.clip.out - 0.05);
      } else if (abutNext && winLive(masterSpan.clip.animOut, "out")) {
        this.drawBackdropFrame(next!, next!.clip.in);
      }
    }
    this.drawCrossJoin(style, p, {
      masterEl,
      masterClip: masterSpan.clip,
      masterAlpha: mAnim.alpha,
      masterZoom,
      masterFx,
      incEl,
      incClip: next?.clip,
      incAlpha: alpha,
      incZoom,
    });
    // Veil only the master clip's own footprint, like the export's per-clip
    // fade filter: a regioned clip darkens inside its rect while a track
    // behind shows through the margins; tracks drawn after (above) stay lit.
    if (black > 0) this.fillBlackVeil(black, rectOf(masterSpan.clip));
    return masterEl;
  }

  /** Draw the master layer, and during a transition (`p` > 0, incoming
   * element live) compose the incoming clip over it in the style's geometry.
   * Everything runs in full-canvas space, matching the export's xfade over
   * fully padded segment frames. */
  private drawCrossJoin(
    style: TransitionStyle,
    p: number,
    d: {
      masterEl: MediaEl | null;
      masterClip: VideoClip;
      masterAlpha: number;
      masterZoom: number;
      masterFx: { dx: number; dy: number };
      incEl: MediaEl | null;
      incClip: VideoClip | undefined;
      incAlpha: number;
      incZoom: number;
    }
  ) {
    const ctx = this.canvas.getContext("2d");
    if (!ctx) return;
    const W = this.canvas.width;
    const H = this.canvas.height;
    const drawMaster = (fx = d.masterFx, alpha = d.masterAlpha) =>
      this.drawLayer(d.masterEl, d.masterClip, false, alpha, d.masterZoom, fx);
    // The blend styles ramp the incoming alpha; the geometric styles draw it
    // opaque inside their own moving region.
    const drawInc = (alpha = d.incAlpha, fx?: { dx: number; dy: number }) => {
      if (d.incEl) this.drawLayer(d.incEl, d.incClip, false, alpha, d.incZoom, fx);
    };
    const clipped = (path: () => void, draw: () => void) => {
      ctx.save();
      ctx.beginPath();
      path();
      ctx.clip();
      draw();
      ctx.restore();
    };
    if (!d.incEl || p <= 0) {
      drawMaster();
      return;
    }
    switch (style) {
      case "dipblack":
      case "dipwhite": {
        // Matches xfade fadeblack/fadewhite's measured plateau: out by ~30%,
        // solid to ~60%, in over the rest.
        const veil = Math.max(0, Math.min(1, Math.min(p / 0.3, (1 - p) / 0.4)));
        if (p < 0.45) drawMaster();
        else drawInc(1);
        this.fillVeil(style === "dipwhite" ? "255,255,255" : "0,0,0", veil);
        break;
      }
      case "blur": {
        // Defocus blend: blur peaks mid-transition on both sides (isotropic
        // here vs ffmpeg's horizontal hblur — reads the same). Without
        // ctx.filter this degrades to the plain crossfade below.
        const supports = "filter" in ctx;
        const r = Math.max(0.5, (Math.min(W, H) / 24) * (1 - Math.abs(2 * p - 1)));
        if (supports) ctx.filter = `blur(${r.toFixed(2)}px)`;
        drawMaster();
        drawInc();
        if (supports) ctx.filter = "none";
        break;
      }
      case "pushleft":
      case "pushright":
      case "pushup":
      case "pushdown": {
        // Both frames travel together; the incoming clip shoves the outgoing
        // one off the named edge.
        const [mx, my, ix, iy] =
          style === "pushleft"
            ? [-p * W, 0, (1 - p) * W, 0]
            : style === "pushright"
              ? [p * W, 0, -(1 - p) * W, 0]
              : style === "pushup"
                ? [0, -p * H, 0, (1 - p) * H]
                : [0, p * H, 0, -(1 - p) * H];
        drawMaster({ ...d.masterFx, dx: d.masterFx.dx + mx, dy: d.masterFx.dy + my });
        drawInc(1, { dx: ix, dy: iy });
        break;
      }
      case "wipeleft":
      case "wiperight":
      case "wipeup":
      case "wipedown": {
        // Hard reveal edge traveling in the named direction.
        const r =
          style === "wipeleft"
            ? { x: (1 - p) * W, y: 0, w: p * W, h: H }
            : style === "wiperight"
              ? { x: 0, y: 0, w: p * W, h: H }
              : style === "wipeup"
                ? { x: 0, y: (1 - p) * H, w: W, h: p * H }
                : { x: 0, y: 0, w: W, h: p * H };
        drawMaster();
        clipped(
          () => ctx.rect(r.x, r.y, r.w, r.h),
          () => drawInc(1)
        );
        break;
      }
      case "circleopen": {
        drawMaster();
        clipped(
          () => ctx.arc(W / 2, H / 2, (p * Math.hypot(W, H)) / 2, 0, Math.PI * 2),
          () => drawInc(1)
        );
        break;
      }
      case "circleclose": {
        // The outgoing picture collapses into a shrinking circle over the
        // incoming one.
        drawInc(1);
        clipped(
          () => ctx.arc(W / 2, H / 2, ((1 - p) * Math.hypot(W, H)) / 2, 0, Math.PI * 2),
          () => drawMaster()
        );
        break;
      }
      case "splitopen": {
        // Barn doors part from the center.
        drawMaster();
        clipped(
          () => ctx.rect(((1 - p) * W) / 2, 0, p * W, H),
          () => drawInc(1)
        );
        break;
      }
      case "splitclose": {
        // The incoming picture closes in from both side edges.
        drawMaster();
        clipped(
          () => {
            ctx.rect(0, 0, (p * W) / 2, H);
            ctx.rect(W - (p * W) / 2, 0, (p * W) / 2, H);
          },
          () => drawInc(1)
        );
        break;
      }
      default: {
        // crossfade / crosszoom: the classic A·(1−α)+B·α blend (zooms already
        // folded into the layer zoom factors).
        drawMaster();
        drawInc();
      }
    }
  }

  private overlayVideoFor(clip: VideoClip, asset: MediaAsset): MediaEl {
    return this.elFor(this.overlayEls, clip.id, asset);
  }

  /** Draw a neighbor clip's held frame full-frame beneath an edge animation.
   * A paused element parks on the wanted frame (the previous clip already
   * rests at its out point after the handoff; warm-ahead parks the next one
   * on its entrance frame); a pre-rolling element draws where it is — frames
   * moments ahead of its entrance, close enough at the cut. Until the
   * element has a decodable frame this draws nothing and the tick's black
   * clear shows, same as before. */
  private drawBackdropFrame(span: ClipSpan, at: number) {
    const el = this.videoFor(span.clip, span.asset);
    if (!isImageEl(el) && el.paused && !el.seeking && Math.abs(el.currentTime - at) > 0.15) {
      el.currentTime = Math.max(0, at);
    }
    if (elReady(el)) this.drawLayer(el, span.clip, false, 1, 1);
  }

  private clearCanvas() {
    const ctx = this.canvas.getContext("2d");
    if (!ctx) return;
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
  }

  /** Whole-video fade gain at time `t`: ramps 0→1 over the project fade-in and
   * 1→0 over the fade-out at the end of the cut. 1 when neither applies. */
  private projectFadeGain(t: number, total: number) {
    const s = useEditor.getState();
    const fadeIn = projectFadeSeconds(s.fadeIn, total);
    const fadeOut = projectFadeSeconds(s.fadeOut, total);
    let g = 1;
    if (fadeIn > 0 && t < fadeIn) g = Math.min(g, Math.max(0, t / fadeIn));
    if (fadeOut > 0 && t > total - fadeOut) g = Math.min(g, Math.max(0, (total - t) / fadeOut));
    return Math.min(1, g);
  }

  /** Paint an `amount` (0..1) color veil (`rgb` = "r,g,b") — over the whole
   * frame, or clipped to `rect` for a per-clip fade. Shared by the fade
   * animations, the dip transitions, and the whole-video project fade so
   * they can never drift apart. */
  private fillVeil(rgb: string, amount: number, rect?: FrameRect) {
    if (amount <= 0) return;
    const ctx = this.canvas.getContext("2d");
    if (!ctx) return;
    const W = this.canvas.width;
    const H = this.canvas.height;
    ctx.fillStyle = `rgba(${rgb},${Math.min(1, amount).toFixed(3)})`;
    if (rect) ctx.fillRect(rect.x * W, rect.y * H, rect.w * W, rect.h * H);
    else ctx.fillRect(0, 0, W, H);
  }

  private fillBlackVeil(amount: number, rect?: FrameRect) {
    this.fillVeil("0,0,0", amount, rect);
  }

  /** The picture side of the project fade: a black veil over the whole frame
   * (everything drawn this tick, on every track, at any time), matching the
   * export's fade on the final composite. */
  private drawProjectFade(gain: number) {
    this.fillBlackVeil(1 - gain);
  }

  /** Overlay clips live at time `t` — every track above 0, with their assets
   * and transition ramps, in draw order: further-back tracks first, and
   * within a track earlier clips first, so a dissolving pair blends the
   * incoming clip in over the outgoing one. */
  private liveOverlays(t: number) {
    const s = useEditor.getState();
    const live: { clip: VideoClip; asset: MediaAsset; alpha: number; zoom: number; gain: number }[] = [];
    const tracks = [...new Set(overlayLayers(s.clips).map((c) => c.track))].sort((a, b) => a - b);
    for (const track of tracks) {
      const spans = getClipSpans(s.clips, s.assets, track);
      for (let i = 0; i < spans.length; i++) {
        const sp = spans[i];
        if (sp.clip.hidden) continue;
        if (t < sp.start || t >= sp.start + sp.len) continue;
        live.push({ clip: sp.clip, asset: sp.asset, ...overlayTransitionFx(sp, spans[i - 1], spans[i + 1], t) });
      }
    }
    return live;
  }

  /** Seek/rate/play one overlay clip's element toward its frame at timeline
   * time `t` (the overlay counterpart of `prepare`). `gain` carries the
   * clip's transition ramp, so a fading picture takes its sound with it. */
  private prepareOverlay(clip: VideoClip, asset: MediaAsset, t: number, play: boolean, gain = 1): MediaEl {
    const el = this.overlayVideoFor(clip, asset);
    if (isImageEl(el)) return el;
    const speed = clip.speed && clip.speed > 0 ? clip.speed : 1;
    const rate = safeRate(speed);
    if (el.playbackRate !== rate) el.playbackRate = rate;
    const target = clip.in + Math.max(0, t - clip.start) * speed;
    const tol = play ? 0.34 : 0.05;
    if (Math.abs(el.currentTime - target) > tol && !el.seeking) el.currentTime = target;
    // Overlay audio previews like the export mixes it: the clip's own volume,
    // ducked under a live voiceover, silent when muted. (The tick dims it
    // further with the project fade.)
    el.muted = !!clip.muted;
    el.volume = Math.max(
      0,
      Math.min(1, gain * (clip.volume ?? 1) * duckGainAt(useEditor.getState().audioClips, t))
    );
    if (play) {
      if (el.paused && el.readyState >= 2) void el.play().catch(() => {});
    } else if (!el.paused) {
      el.pause();
    }
    return el;
  }

  /** The live overlays, each already primed toward `t`. Computed once so the
   * skim path's readiness check and the draw step share the same
   * filter/sort/seek instead of repeating it per frame. */
  private prepareOverlays(t: number, play: boolean) {
    return this.liveOverlays(t).map(({ clip, asset, alpha, zoom, gain }) => ({
      clip,
      alpha,
      zoom,
      el: this.prepareOverlay(clip, asset, t, play, gain),
    }));
  }

  /** Draw the overlay tracks over track 0 in z-order (further-back first). A
   * full-frame clip covers what's under it; a regioned one shares the frame,
   * letting lower tracks show in its margins. Collects the clips it touched
   * into `active`. Pass `prepared` (from `prepareOverlays`) to reuse an
   * already-primed set. */
  private drawOverlays(
    t: number,
    play: boolean,
    active: Set<string>,
    prepared?: { clip: VideoClip; el: MediaEl; alpha: number; zoom: number }[]
  ) {
    for (const { clip, el, alpha, zoom } of prepared ?? this.prepareOverlays(t, play)) {
      active.add(clip.id);
      if (!elReady(el)) continue;
      const rect = rectOf(clip);
      const cover = clip.fit === "fill" || (clip.fit == null && isFullRect(rect));
      this.drawIntoRect(el, rect, cover, alpha, zoom, clip);
    }
  }

  /** Pause overlay elements not drawn this frame; drop those whose clip is gone. */
  private cleanupOverlays(active: Set<string>) {
    const s = useEditor.getState();
    for (const [id, el] of this.overlayEls) {
      if (active.has(id)) continue;
      pauseEl(el);
      if (!overlayLayers(s.clips).some((c) => c.id === id)) {
        teardown(el);
        this.overlayEls.delete(id);
        this.health.delete(id);
      }
    }
  }

  private syncSoundtrack(t: number, playing: boolean, fadeGain = 1) {
    const s = useEditor.getState();
    const live = new Set<string>();
    for (const a of s.audioClips) {
      live.add(a.id);
      const asset = s.assets.find((x) => x.id === a.assetId);
      if (!asset) continue;
      let el = this.audioEls.get(a.id);
      // Same-id source swaps (a regenerated voiceover) rebuild the element.
      if (el && el.getAttribute("src") !== asset.url) {
        el.pause();
        el = undefined;
      }
      if (!el) {
        const audio = new Audio();
        audio.preload = "auto";
        audio.addEventListener("error", () => reportMediaElementError(audio));
        audio.src = asset.url;
        el = audio;
        this.audioEls.set(a.id, el);
      }
      // Detached audio can carry its video clip's rate; footprint is (out-in)/speed.
      const speed = a.speed && a.speed > 0 ? a.speed : 1;
      const len = Math.max(0.1, (a.out - a.in) / speed);
      // A hidden clip is muted from the mix — keep its element but never play it.
      const active = playing && !a.hidden && t >= a.start && t < a.start + len;
      if (active) {
        // Fade envelope: linear ramps at either end of the clip.
        const rel = t - a.start;
        const fi = a.fadeIn ?? 0;
        const fo = a.fadeOut ?? 0;
        let gain = 1;
        if (fi > 0 && rel < fi) gain *= rel / fi;
        if (fo > 0 && rel > len - fo) gain *= Math.max(0, (len - rel) / fo);
        // A live voiceover ducks the other soundtrack clips (music) too;
        // ducking clips never duck each other.
        const dg = a.duck !== undefined && a.duck < 1 ? 1 : duckGainAt(s.audioClips, t);
        el.volume = Math.max(0, Math.min(1, a.volume * gain * dg * fadeGain));
        const rate = safeRate(speed);
        if (el.playbackRate !== rate) el.playbackRate = rate;
        const expected = a.in + rel * speed;
        if (Math.abs(el.currentTime - expected) > 0.25) el.currentTime = expected;
        if (el.paused) void el.play().catch(() => {});
      } else if (!el.paused) {
        el.pause();
      }
    }
    for (const [id, el] of this.audioEls) {
      if (!live.has(id)) {
        el.pause();
        this.audioEls.delete(id);
      }
    }
  }

  private tick() {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.tick);

    const s = useEditor.getState();
    const spans = getClipSpans(s.clips, s.assets);
    // Drop decoders for clips that no longer exist (deleted or replaced).
    // videoEls holds track-0 decoders only, so compare against the spans —
    // gating on the whole clip list would let layer clips mask deletions and
    // keep dead <video> elements alive.
    if (this.videoEls.size > spans.length) {
      const live = new Set(s.clips.map((c) => c.id));
      for (const [id, el] of this.videoEls) {
        if (live.has(id)) continue;
        teardown(el);
        this.videoEls.delete(id);
        this.health.delete(id);
      }
    }
    // Whole-project length so time past track 0's end (a longer video track or
    // soundtrack) is still reachable while scrubbing and playing.
    const total = projectDuration(s);

    // Nothing anywhere — no track-0 clip, no overlay layer, no soundtrack —
    // resets to a black frame at 0. An empty track 0 with an overlay clip or
    // audio still plays: the tick body draws those layers and advances the wall
    // clock, so the guard must not bail on `spans.length === 0` alone.
    if (spans.length === 0 && overlayLayers(s.clips).length === 0 && s.audioClips.length === 0) {
      this.pauseExcept(new Set());
      this.drawLayer(null, undefined, true, 1);
      this.syncSoundtrack(0, false);
      if (s.playing) useEditor.setState({ playing: false, currentTime: 0 });
      return;
    }

    let t = Math.min(s.currentTime, total);

    // iMovie skimming: while paused with the mouse over the timeline, the
    // frame on screen lives at the skim point, not the playhead. The playhead
    // (currentTime) is never touched.
    const pt =
      !s.playing && s.skimTime !== null
        ? Math.max(0, Math.min(s.skimTime, total - 0.001))
        : t;

    // Keep the next few clips decoded and buffering ahead of the frame being
    // shown (the skim point while skimming, else the playhead — paused too, so
    // pressing play resumes clean). Runs before either branch since both
    // benefit; warms only clips ahead of the anchor, so it never touches the
    // element the branches are about to drive — anchored at the playhead while
    // skimming, its entrance-frame parking seeks would fight the skimmed
    // clip's own scrub seeks every tick and freeze the preview on any clip
    // ahead of the playhead.
    this.warmAhead(spans, pt);
    this.warmOverlaysAhead(pt);

    if (!s.playing) {
      // Not advancing: drop the wall-clock stamp so the first playing tick
      // starts a fresh delta instead of leaping over the paused stretch.
      this.lastPlayNow = 0;
      const span = spans.find((sp) => pt >= sp.start && pt < sp.start + sp.len);
      // Prime every layer live at `pt` — the track-0 element and each overlay
      // track — before repainting (create them, issue any seeks). A cold
      // element or an unbuffered seek has no decodable frame yet, and painting
      // around it tears the composite: black before the track-0 seek resolves,
      // or track 0 flashing through where an overlay covers it. Hold the last
      // painted frame until every live layer has a frame, so each scrubbed
      // frame is the same composite playback and export show.
      let ready = true;
      if (span) {
        const el = this.prepare(span, Math.min(pt, span.start + span.len), false, true);
        // A broken source never becomes ready; paint without it rather than
        // wedging the preview on it.
        if (!elErrored(el) && !elReady(el)) ready = false;
      }
      // Prime the overlays once; the readiness scan and the draw step below
      // reuse these instead of re-filtering/seeking them a second time.
      const overlaysLive = this.prepareOverlays(pt, false);
      for (const { el } of overlaysLive) {
        if (!elErrored(el) && !elReady(el)) ready = false;
      }
      if (!ready) {
        this.pauseExcept(new Set(span ? [span.clip.id] : []));
        this.syncSoundtrack(t, false);
        return;
      }
      const active = new Set<string>();
      this.clearCanvas();
      // Where track 0 has nothing live there is no master frame — just black
      // and the other tracks still running at `pt`.
      if (span) this.composite(span, spans, Math.min(pt, span.start + span.len), false);
      else this.pauseExcept(new Set());
      this.drawOverlays(pt, false, active, overlaysLive);
      this.drawProjectFade(this.projectFadeGain(pt, total));
      this.cleanupOverlays(active);
      this.syncSoundtrack(t, false);
      return;
    }

    let span = spans.find((sp) => t >= sp.start && t < sp.start + sp.len);

    // A just-started or just-scrubbed clip may still be decoding. Hold the last
    // painted frame rather than clearing to black — same as the skim path. (At a
    // dissolve boundary the incoming clip is already warm from the overlap, so
    // this only bites a genuinely cold first frame.)
    if (span) {
      const el = this.prepare(span, t, true, span.clip.muted || !!span.clip.hidden);
      // A broken source (unreachable still, decode error) never becomes ready;
      // fall through so the wall clock advances past it instead of freezing.
      if (!elReady(el) && !elErrored(el)) {
        this.pauseExcept(new Set([span.clip.id]));
        this.syncSoundtrack(t, true);
        return;
      }
    }

    // Clear to black, then prime the master element (and any dissolve
    // partner) over it and read the clock.
    const active = new Set<string>();
    this.clearCanvas();

    if (span) {
      let el = this.composite(span, spans, t, true);
      // The element clock is the truth but it's coarse: currentTime advances in
      // steps bigger than a frame, and copying it straight to the playhead
      // makes the indicator stutter and step backward. Advance by wall clock
      // instead — smooth by construction and never backward — and let the
      // element clock steer it: the playhead may run at most 60ms ahead of the
      // clock (a stalled element halts it with the picture) and snaps forward
      // only when the clock genuinely leads.
      const now = performance.now();
      const dt = this.lastPlayNow ? Math.min(0.25, (now - this.lastPlayNow) / 1000) : 0;
      let atEnd: boolean;
      if (isImageEl(el) || elErrored(el)) {
        // A still has no element clock, and a broken source's clock never
        // advances (steering by it would pin the playhead at the clip start) —
        // move purely by wall clock and end at the clip's timeline footprint.
        t = Math.max(span.start, Math.min(t + dt, span.start + span.len));
        atEnd = t >= span.start + span.len - 0.0001;
      } else {
        const speed = clipSpeed(span.clip);
        const derived = span.start + (el.currentTime - span.clip.in) / speed;
        const cand = Math.min(t + dt, derived + 0.06);
        t = derived - cand > 0.25 ? derived : Math.max(t, cand);
        t = Math.max(span.start, Math.min(t, span.start + span.len));
        atEnd = el.currentTime >= span.clip.out - 0.02 || el.ended;
      }
      // Clip boundary: hand off to the next clip when it abuts (or dissolves),
      // fall into the gap when it doesn't — track 0 plays black there and the
      // wall clock advances — or (if track 0 is done but another track runs
      // on) fall through to the wall-clock tail.
      if (atEnd) {
        const idx = spans.indexOf(span);
        const next = spans[idx + 1];
        if (next && next.start <= span.start + span.len + 0.001) {
          // Jump past the finished clip's whole footprint (including any
          // cross-dissolve overlap), not back to next.start — which still sits
          // inside the outgoing clip's footprint, so find() would re-pick the
          // clip we just finished and playback would ping-pong across the
          // dissolve forever.
          t = Math.max(next.start + 0.0001, span.start + span.len);
          span = next;
          el = this.composite(next, spans, t, true);
        } else if (next) {
          // A gap before the next clip: step just past this clip's footprint
          // so the next tick's find() sees no active span and the wall-clock
          // path carries time (and the soundtrack) across the black stretch.
          t = Math.max(t, span.start + span.len + 0.0001);
          pauseEl(el);
        } else if (t >= total - 0.001) {
          // Track 0 and every other track finished.
          useEditor.setState({ playing: false, currentTime: total, previewStopAt: null });
          pauseEl(el);
          this.drawOverlays(t, true, active);
          this.drawProjectFade(this.projectFadeGain(total, total));
          this.cleanupOverlays(active);
          this.syncSoundtrack(total, false);
          return;
        }
      }
      this.lastPlayNow = now;
    } else {
      // Nothing live on track 0 but another track is still playing: no master
      // element, so advance time by the wall clock and let the overlays follow.
      this.pauseExcept(new Set());
      const now = performance.now();
      const dt = this.lastPlayNow ? Math.min(0.25, (now - this.lastPlayNow) / 1000) : 0;
      this.lastPlayNow = now;
      t = t + dt;
      if (t >= total - 0.001) {
        useEditor.setState({ playing: false, currentTime: total, previewStopAt: null });
        this.drawOverlays(t, true, active);
        this.drawProjectFade(this.projectFadeGain(total, total));
        this.cleanupOverlays(active);
        this.syncSoundtrack(total, false);
        return;
      }
    }

    this.drawOverlays(t, true, active);
    // The whole-video fade veils the finished frame and dims the sound —
    // the master's element volume (set by composite) and the soundtrack.
    const fadeGain = this.projectFadeGain(t, total);
    if (fadeGain < 1) {
      if (span) {
        const mel = this.videoEls.get(span.clip.id);
        if (mel && !isImageEl(mel)) mel.volume = Math.min(mel.volume, fadeGain);
      }
      for (const el of this.overlayEls.values()) {
        if (!isImageEl(el)) el.volume = Math.min(el.volume, fadeGain);
      }
    }
    this.drawProjectFade(fadeGain);
    this.cleanupOverlays(active);
    // A scoped effect preview auto-pauses at its stop mark (the frame this
    // tick just painted is the stop frame — close enough at tick rate).
    if (s.previewStopAt != null && t >= s.previewStopAt) {
      useEditor.setState({
        playing: false,
        currentTime: Math.min(t, s.previewStopAt),
        previewStopAt: null,
      });
      this.syncSoundtrack(Math.min(t, s.previewStopAt), false);
      return;
    }
    useEditor.setState({ currentTime: t });
    this.syncSoundtrack(t, true, fadeGain);
  }
}

export function usePlayback(canvasRef: RefObject<HTMLCanvasElement | null>) {
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const engine = new Engine(canvas);
    registerSourceSampler((clipId) => engine.sourceFor(clipId));
    return () => {
      registerSourceSampler(null);
      engine.dispose();
    };
  }, [canvasRef]);
}
