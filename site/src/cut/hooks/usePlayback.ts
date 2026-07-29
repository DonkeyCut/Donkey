"use client";

import { useEffect, type RefObject } from "react";
import { clipSpeed, getClipSpans, overlayLayers, projectDuration, useEditor } from "@/cut/lib/store";
import { isFullRect, projectFadeSeconds, rectOf } from "@/cut/lib/types";
import type { ClipSpan, MediaAsset, VideoClip } from "@/cut/lib/types";
import { FrameCompositor, MISSING_FRAME, PENDING_FRAME, type Frame } from "@/cut/lib/composite";
import { duckGainAt, overlayPlan, prerollLead, trackZeroPlan } from "@/cut/lib/framePlan";
import { reportMediaElementError } from "@/cut/lib/mediaLinks";
import { registerSourceSampler } from "@/cut/lib/previewCanvas";

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

// Ahead of a clip's entrance its element is played muted and undrawn, so the
// decoder is already running across the in-point when the cut lands and the
// handoff play() resumes hot instead of spinning a cold decoder up. How long
// that roll gets is `prerollLead`, and when a clip is close enough to be worth
// keeping alive is the frame plan's `upcoming` — both live there, so the
// picture and the decoders agree on when a clip is about to be needed.

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
  // Wall-clock stamp for advancing time where track 0 has nothing playing —
  // in a gap or past its end there is no track-0 video element to act as the
  // master clock.
  private lastPlayNow = 0;
  // Everything this engine puts on the canvas goes through here. The engine
  // owns the decoders and the clock; the compositor owns the picture, and an
  // export renders through the same one.
  private comp: FrameCompositor;

  constructor(private canvas: HTMLCanvasElement) {
    this.comp = new FrameCompositor(canvas);
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
      const speed = clipSpeed(span.clip);
      const lead = prerollLead(span.clip.in, speed);
      // The imminent clip inside its own pre-roll window is `warmNext`'s to
      // play hot; a parking seek here would fight it, so leave it alone. A clip
      // with no roll to give (an untrimmed one) has no such window, and stays
      // parked here right up to the cut.
      if (lead > 0 && span.start - t <= lead) continue;
      const el = this.videoFor(span.clip, span.asset); // creating it starts the fetch
      // Park a not-yet-imminent clip exactly where the pre-roll will play from
      // (`warmNext`'s `from`), not on its entrance frame: parking at `in` and
      // then seeking back for the roll-in discards the warmed buffer, and over
      // the network (cloud media) that late re-seek is what used to stall the
      // handoff. Parked here, the pre-roll's seek is a no-op on already-buffered
      // bytes and the cut lands hot.
      if (!isImageEl(el) && !el.seeking && el.paused) {
        const target = span.clip.in - lead * speed;
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
    const speed = clipSpeed(span.clip);
    // Only as long a roll as there is source ahead of the in-point to cover it
    // — nothing at all for an untrimmed clip, which stays parked on its already
    // hot keyframe 0 instead. Farther out than that, it is warmAhead's to park
    // and buffer.
    const lead = prerollLead(span.clip.in, speed);
    if (t < span.start - lead) return;
    const rate = safeRate(speed);
    if (el.playbackRate !== rate) el.playbackRate = rate;
    el.muted = true; // silent until it becomes master and unmutes
    // Already rolling: let it run — it crosses `in` on its own as the cut lands.
    if (!el.paused) return;
    // Seat it `lead` of source before the entrance, then play forward so it
    // reaches `in` right as the playhead reaches the cut.
    const from = span.clip.in - lead * speed;
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

  /** The picture a media element is currently showing, in the form the
   * compositor takes. An element that exists but has no decodable frame is
   * `pending`, which is what keeps a skim from strobing black. */
  private frameOf(el: MediaEl | null | undefined): Frame {
    if (!el) return MISSING_FRAME;
    if (!elReady(el)) return PENDING_FRAME;
    return { kind: "ready", image: el, width: elW(el), height: elH(el) };
  }

  /** Draw `masterSpan` full-frame, plus any transition live at time `t` in
   * its style's geometry (blend, dip, push, wipe, shape reveal), plus the
   * clips' own entrance/exit animations. Returns the master element (the
   * playback clock). */
  private composite(masterSpan: ClipSpan, spans: ClipSpan[], t: number, play: boolean) {
    // A hidden clip is silent as well as black.
    // What the frame should be at `t` — the same answer an export gets.
    const plan = trackZeroPlan(masterSpan, spans, t);
    // A hidden clip is silent as well as black.
    const masterEl = this.prepare(masterSpan, t, play, masterSpan.clip.muted || !!masterSpan.clip.hidden);
    this.activeClipId = masterSpan.clip.id;
    const keep = new Set([masterSpan.clip.id]);
    // Prime the next clip's decoder+audio pipeline shortly before its entrance
    // (the dissolve start, or the hard cut) so the handoff `play()` resumes hot
    // — no cold-start spin-up freezing the picture and playhead at the cut.
    if (plan.upcoming) {
      this.warmNext(plan.upcoming, t);
      keep.add(plan.upcoming.clip.id);
    }
    // Each clip owns its element, so a transition's two clips decode side by
    // side — a true blend even when they are trims of the same source.
    let incEl: MediaEl | null = null;
    if (plan.incoming) {
      incEl = this.prepare(plan.incoming, t, play, true); // the outgoing clip keeps the audio
      keep.add(plan.incoming.clip.id);
    }
    // A live voiceover ducks the master clip's sound under it. The clip's own
    // volume rides on top (the element clamps at 1; export honors up to 1.5).
    const duck = duckGainAt(useEditor.getState().audioClips, t);
    if (!isImageEl(masterEl)) {
      masterEl.volume = Math.max(
        0,
        Math.min(1, plan.gain * duck * (masterSpan.clip.volume ?? 1))
      );
    }
    this.pauseExcept(keep);
    // No clear here — the tick clears once before compositing, so a regioned
    // clip draws into its rect over the already-black frame.
    if (plan.backdrop) this.drawBackdropFrame(plan.backdrop.span, plan.backdrop.at, t);
    this.comp.drawCrossJoin(
      plan.style,
      plan.p,
      {
        masterFrame: this.frameOf(masterEl),
        masterClip: masterSpan.clip,
        masterAlpha: plan.masterAlpha,
        masterZoom: plan.masterZoom,
        masterFx: {
          dx: plan.masterFxFrac.dx * this.canvas.width,
          dy: plan.masterFxFrac.dy * this.canvas.height,
        },
        incFrame: this.frameOf(incEl),
        incClip: plan.incoming?.clip,
        incAlpha: plan.incAlpha,
        incZoom: plan.incZoom,
      },
      t
    );
    // Veil only the master clip's own footprint, like the export's per-clip
    // fade filter: a regioned clip darkens inside its rect while a track
    // behind shows through the margins; tracks drawn after (above) stay lit.
    if (plan.veil > 0) this.comp.fillBlackVeil(plan.veil, rectOf(masterSpan.clip));
    return masterEl;
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
  private drawBackdropFrame(span: ClipSpan, at: number, t: number) {
    const el = this.videoFor(span.clip, span.asset);
    if (!isImageEl(el) && el.paused && !el.seeking && Math.abs(el.currentTime - at) > 0.15) {
      el.currentTime = Math.max(0, at);
    }
    this.comp.drawLayer(this.frameOf(el), span.clip, false, 1, t);
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

  /** Overlay clips live at time `t`, with their assets and transition ramps,
   * in draw order. */
  private liveOverlays(t: number) {
    const s = useEditor.getState();
    return overlayPlan(
      [...new Set(overlayLayers(s.clips).map((c) => c.track))],
      (track) => getClipSpans(s.clips, s.assets, track),
      t
    );
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
      this.comp.drawIntoRect(this.frameOf(el), rect, cover, alpha, t, zoom, clip);
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
      this.comp.drawLayer(MISSING_FRAME, undefined, true, 1, 0);
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
      this.comp.clear();
      // Where track 0 has nothing live there is no master frame — just black
      // and the other tracks still running at `pt`.
      if (span) this.composite(span, spans, Math.min(pt, span.start + span.len), false);
      else this.pauseExcept(new Set());
      this.drawOverlays(pt, false, active, overlaysLive);
      this.comp.drawProjectFade(this.projectFadeGain(pt, total));
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
    this.comp.clear();

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
          this.comp.drawProjectFade(this.projectFadeGain(total, total));
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
        this.comp.drawProjectFade(this.projectFadeGain(total, total));
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
    this.comp.drawProjectFade(fadeGain);
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
