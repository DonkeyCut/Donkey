"use client";

import { useEffect, type RefObject } from "react";
import {
  clipSpeed,
  getClipSpans,
  overlayLayers,
  projectDuration,
  useEditor,
} from "@/cut/lib/store";
import { playheadAt, previewAt, setPlayhead, subscribePlayhead } from "@/cut/lib/playhead";
import { isFullRect, projectFadeSeconds, rectOf } from "@/cut/lib/types";
import type { ClipSpan, MediaAsset, VideoClip } from "@/cut/lib/types";
import { SubjectMaskCompositor } from "@/cut/lib/behindPass";
import { FrameCompositor, MISSING_FRAME, PENDING_FRAME, type Frame } from "@/cut/lib/composite";
import { duckGainAt, overlayPlan, trackZeroPlan } from "@/cut/lib/framePlan";
import { type ClipFrameSource, FrameSourcePool, mappingKey } from "@/cut/lib/frameSource";
import { PreviewMixer, type Voice } from "@/cut/lib/previewMixer";
import { markLiveSamples, markPresent, markTick, tracing } from "@/cut/lib/perfTrace";
import { registerSourceSampler } from "@/cut/lib/previewCanvas";

/**
 * The preview engine.
 *
 * Three things meet here and nothing else does. The frame plan says what the
 * cut looks like at an instant; the frame sources hold decoded pictures ready
 * to answer for it; the compositor paints. The engine's whole job is to pick
 * the instant, ask, and draw.
 *
 * The instant comes from the mixer's clock while playing and from the playhead
 * while paused, so sound and picture are two readings of one number rather than
 * two clocks chasing each other. A cut is not an event: at the moment the plan
 * names a different clip, that clip's frames are already decoded, because the
 * scheduler has been reading ahead of the playhead the whole time.
 *
 * The loop runs while something is moving. A paused editor with nothing dirty
 * schedules no frames at all.
 */

/** How far ahead of the playhead a clip's decoder is opened and started. */
const WARM_HORIZON_S = 2.5;
/** Inside this, an upcoming clip is walked rather than merely opened. */
const WARM_STREAM_S = 0.75;
/** Decoders alive at once. Past the tab's hardware decode slots the rest fall
 * back to software, and frames start arriving late. */
const DECODER_BUDGET = 12;

/** Source time of a clip at timeline time `t`. */
const sourceTimeOf = (clip: VideoClip, t: number) =>
  clip.in + Math.max(0, t - clip.start) * clipSpeed(clip);

/** The decode identity of a clip — see `mappingKey`. */
const keyOf = (clip: VideoClip, asset: MediaAsset) =>
  mappingKey(asset.id, clipSpeed(clip), clip.in, clip.start);

class Engine {
  private comp: FrameCompositor;
  private pool = new FrameSourcePool(DECODER_BUDGET, () => this.wake());
  private mixer = new PreviewMixer();
  private behind = new SubjectMaskCompositor(true);

  private raf = 0;
  private disposed = false;
  /** Set when something changed that the canvas has yet to show. */
  private dirty = true;
  /** Sources this frame is being drawn from. The warm pass leaves these alone:
   * a warm ask lands on the same source as a live clip whenever they share a
   * mapping — a plain split reads straight across its own cut — and steering a
   * walk that is already carrying the picture would tear it down every tick. */
  private used = new Set<ClipFrameSource>();
  /** The playhead value the engine itself wrote last, so its own echo is
   * tellable from an outside move — a seek while playing. */
  private written: number | null = null;

  private unsubscribe: () => void;
  private unwatch: () => void;
  private sizeWatch: MutationObserver;

  constructor(private canvas: HTMLCanvasElement) {
    this.comp = new FrameCompositor(canvas);
    this.tick = this.tick.bind(this);
    // A moved playhead and an edited document both change the picture. Either
    // one wakes the loop; nothing else does, so an idle editor costs nothing.
    this.unsubscribe = subscribePlayhead(() => this.wake());
    this.unwatch = useEditor.subscribe(() => this.wake());
    // The backing store follows the stage box, and assigning a canvas's width
    // or height erases it. That write comes from layout — no playhead move, no
    // document edit — so the attributes themselves are the wake signal.
    this.sizeWatch = new MutationObserver(() => this.wake());
    this.sizeWatch.observe(canvas, { attributes: true, attributeFilter: ["width", "height"] });
    this.wake();
  }

  dispose() {
    this.disposed = true;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.unsubscribe();
    this.unwatch();
    this.sizeWatch.disconnect();
    this.pool.closeAll();
    this.mixer.dispose();
  }

  /**
   * The height sources decode at: the canvas, rounded up to a coarse step.
   *
   * The pool keys sources on this number. Keyed on the raw canvas height, a
   * divider drag — which resizes the backing store pixel by pixel — would mint
   * a fresh decoder for every intermediate size and blow through the tab's
   * decode slots in a second. Rounding up keeps the identity still while the
   * box moves and never decodes below display size, and the step is small
   * enough that the extra rows decoded above it stay cheap.
   */
  private decodeHeight(): number {
    return Math.ceil(this.canvas.height / 180) * 180 || 180;
  }

  /** The engine's own playhead writes go through here, so `written` always
   * says what the engine last wrote. */
  private writeHead(t: number) {
    this.written = t;
    setPlayhead(t);
  }

  /** Something changed: draw at the next opportunity. */
  private wake() {
    this.dirty = true;
    this.schedule();
  }

  /**
   * Ask for one frame, and only one.
   *
   * Drawing writes the playhead, and writing the playhead wakes the engine, so
   * a tick that scheduled its own successor unconditionally would leave two
   * callbacks pending where it meant to leave one — and each of those would
   * leave two more. Every path books a frame through here, and here refuses to
   * book a second.
   */
  private schedule() {
    if (this.raf || this.disposed) return;
    this.raf = requestAnimationFrame(this.tick);
  }

  /** The clip's raw, ungraded decoder frame for analysis (the color panel's
   * Auto), or null when nothing has been decoded for it. */
  sourceFor(clipId: string): CanvasImageSource | null {
    const s = useEditor.getState();
    const clip = s.clips.find((c) => c.id === clipId);
    const asset = clip && s.assets.find((a) => a.id === clip.assetId);
    if (!clip || !asset) return null;
    const src = this.pool.get(keyOf(clip, asset), asset, this.decodeHeight());
    return src.frameAt(sourceTimeOf(clip, previewAt()))?.image ?? null;
  }

  /**
   * The picture a clip shows at timeline time `t`.
   *
   * Asking is never a wait. A source with the exact frame gives it; one running
   * behind gives the nearest it has, which is a held frame rather than a hole;
   * one that has decoded nothing yet is `pending`, which tells the compositor to
   * leave what is already on screen alone. Painting black for a decoder that is
   * merely a moment behind is what strobing looks like.
   */
  private frameFor(span: ClipSpan, t: number, playing: boolean): Frame {
    const src = this.pool.get(keyOf(span.clip, span.asset), span.asset, this.decodeHeight());
    this.used.add(src);
    const st = sourceTimeOf(span.clip, t);
    src.want(st, playing);
    // A failed source that already decoded frames keeps showing the nearest
    // one it holds — a transient blip (a network drop, a signed URL mid
    // re-mint) reads as a held frame, and only a source with nothing at all
    // to show goes missing.
    const frame = src.frameAt(st);
    if (frame)
      return { kind: "ready", image: frame.image, width: frame.width, height: frame.height };
    return src.failed ? MISSING_FRAME : PENDING_FRAME;
  }

  /** Open and start the decoders for clips about to arrive — on track 0 and
   * the overlay tracks alike — so a cut or an overlay's entrance lands on a
   * ring that is already full. */
  private warm(t: number, playing: boolean) {
    const s = useEditor.getState();
    const lists = [getClipSpans(s.clips, s.assets)];
    for (const track of new Set(overlayLayers(s.clips).map((c) => c.track))) {
      lists.push(getClipSpans(s.clips, s.assets, track));
    }
    for (const spans of lists) {
      for (const sp of spans) {
        if (sp.start <= t || sp.start > t + WARM_HORIZON_S) continue;
        const src = this.pool.get(keyOf(sp.clip, sp.asset), sp.asset, this.decodeHeight());
        // A source already carrying this frame's picture — or already warmed
        // for a nearer span — needs nothing. Its walk reads across the join on
        // its own, and a second ask would restart it.
        if (this.used.has(src)) continue;
        this.used.add(src);
        // Start where the clip opens. A walk is the useful thing to have ready —
        // the first step past a join then costs one frame rather than a seek —
        // but a walk started for every clip on the horizon spends decode a drag
        // elsewhere on the timeline is waiting for. So the clip about to be
        // reached gets a walk, and the ones behind it get the single frame that
        // lets a cut land on something.
        const imminent = sp.start - t <= WARM_STREAM_S;
        src.want(sp.clip.in, playing || imminent);
      }
    }
  }

  /** Overlay clips live at `t`, with their assets and ramps, in draw order. */
  private liveOverlays(t: number) {
    const s = useEditor.getState();
    return overlayPlan(
      [...new Set(overlayLayers(s.clips).map((c) => c.track))],
      (track) => getClipSpans(s.clips, s.assets, track),
      t
    );
  }

  /** Whole-video fade gain at `t`: ramps 0→1 over the project fade-in and 1→0
   * over the fade-out at the end of the cut. */
  private projectFadeGain(t: number, total: number) {
    const s = useEditor.getState();
    const fadeIn = projectFadeSeconds(s.fadeIn, total);
    const fadeOut = projectFadeSeconds(s.fadeOut, total);
    let g = 1;
    if (fadeIn > 0 && t < fadeIn) g = Math.min(g, Math.max(0, t / fadeIn));
    if (fadeOut > 0 && t > total - fadeOut) g = Math.min(g, Math.max(0, (total - t) / fadeOut));
    return Math.min(1, g);
  }

  /**
   * Everything audible at `t`, with the gain the frame plan gives it.
   *
   * The same ramps that dim the picture dim the sound: a clip fading out of a
   * dissolve takes its audio with it, an upper-track clip's transition carries
   * its own, and a live voiceover ducks the rest.
   */
  private voicesAt(t: number, spans: ClipSpan[], master: ClipSpan | undefined): Voice[] {
    const s = useEditor.getState();
    const out: Voice[] = [];
    const duck = duckGainAt(s.audioClips, t);
    if (master && !master.clip.muted && !master.clip.hidden) {
      const plan = trackZeroPlan(master, spans, t);
      out.push({
        id: master.clip.id,
        url: master.asset.url,
        start: master.start,
        in: master.clip.in,
        out: master.clip.out,
        speed: clipSpeed(master.clip),
        gain: plan.gain * duck * (master.clip.volume ?? 1),
      });
    }
    for (const { clip, asset, gain } of this.liveOverlays(t)) {
      if (clip.muted || clip.hidden || asset.type === "image") continue;
      out.push({
        id: clip.id,
        url: asset.url,
        start: clip.start,
        in: clip.in,
        out: clip.out,
        speed: clipSpeed(clip),
        gain: gain * (clip.volume ?? 1) * duck,
      });
    }
    for (const a of s.audioClips) {
      const asset = s.assets.find((x) => x.id === a.assetId);
      if (!asset || a.hidden) continue;
      const speed = a.speed && a.speed > 0 ? a.speed : 1;
      const len = Math.max(0.1, (a.out - a.in) / speed);
      if (t < a.start || t >= a.start + len) continue;
      // Fade envelope: linear ramps at either end of the clip.
      const rel = t - a.start;
      const fi = a.fadeIn ?? 0;
      const fo = a.fadeOut ?? 0;
      let g = 1;
      if (fi > 0 && rel < fi) g *= rel / fi;
      if (fo > 0 && rel > len - fo) g *= Math.max(0, (len - rel) / fo);
      // A ducking voiceover never ducks itself, or the others that duck.
      const dg = a.duck !== undefined && a.duck < 1 ? 1 : duck;
      out.push({
        id: a.id,
        url: asset.url,
        start: a.start,
        in: a.in,
        out: a.out,
        speed,
        gain: a.volume * g * dg,
      });
    }
    return out;
  }

  /** Draw track 0 at `t`: the master clip, whatever is blending into it, the
   * neighbour frame behind an edge animation, and the clip's own veil. */
  private drawTrackZero(
    master: ClipSpan,
    spans: ClipSpan[],
    t: number,
    playing: boolean,
    masterFrame: Frame
  ) {
    const plan = trackZeroPlan(master, spans, t);
    // The incoming side of a live blend decodes alongside the outgoing one, so
    // a dissolve blends two real pictures — including between two trims of the
    // same file, which keep their own sources by construction.
    const incFrame = plan.incoming
      ? this.frameFor(plan.incoming, Math.max(plan.incoming.start, t), playing)
      : MISSING_FRAME;
    if (plan.backdrop) {
      // A neighbour's held frame behind a live edge animation, drawn at the
      // exact source moment the plan asks for.
      const b = plan.backdrop;
      const src = this.pool.get(keyOf(b.span.clip, b.span.asset), b.span.asset, this.decodeHeight());
      this.used.add(src);
      src.want(b.at, false);
      const f = src.frameAt(b.at);
      this.comp.drawLayer(
        f ? { kind: "ready", image: f.image, width: f.width, height: f.height } : PENDING_FRAME,
        b.span.clip,
        false,
        1,
        t
      );
    }
    this.comp.drawCrossJoin(
      plan.style,
      plan.p,
      {
        masterFrame,
        masterClip: master.clip,
        masterAlpha: plan.masterAlpha,
        masterZoom: plan.masterZoom,
        masterFx: {
          dx: plan.masterFxFrac.dx * this.canvas.width,
          dy: plan.masterFxFrac.dy * this.canvas.height,
        },
        incFrame,
        incClip: plan.incoming?.clip,
        incAlpha: plan.incAlpha,
        incZoom: plan.incZoom,
      },
      t
    );
    // Veil only the master clip's own footprint, like the export's per-clip
    // fade filter: a regioned clip darkens inside its rect while a track behind
    // shows through the margins.
    if (plan.veil > 0) this.comp.fillBlackVeil(plan.veil, rectOf(master.clip));
  }

  /** Draw the overlay tracks over track 0, further-back first. */
  private drawOverlays(t: number, playing: boolean) {
    for (const { clip, asset, alpha, zoom } of this.liveOverlays(t)) {
      const span: ClipSpan = {
        clip,
        asset,
        start: clip.start,
        len: Math.max(0.1, (clip.out - clip.in) / clipSpeed(clip)),
        transitionOut: 0,
      };
      const frame = this.frameFor(span, t, playing);
      if (frame.kind !== "ready") continue;
      const rect = rectOf(clip);
      const cover = clip.fit === "fill" || (clip.fit == null && isFullRect(rect));
      this.comp.drawIntoRect(frame, rect, cover, alpha, t, zoom, clip);
    }
  }

  private tick() {
    this.raf = 0;
    if (this.disposed) return;
    markTick();
    const playing = useEditor.getState().playing;
    // Playing redraws every frame; paused, only what changed since the last
    // paint. Either way the loop stops as soon as there is nothing to do.
    if (playing || this.dirty) {
      this.dirty = false;
      this.render(playing);
    }
    if (playing || this.dirty) this.schedule();
  }

  private render(playing: boolean) {
    const s = useEditor.getState();
    const spans = getClipSpans(s.clips, s.assets);
    const total = projectDuration(s);
    // The frame's color is the project's, read fresh each frame: every clear
    // and every letterbox below paints it, so a cut with no footage at all
    // still plays a picture.
    this.comp.background = s.background;
    this.pool.beginFrame();
    this.used.clear();

    // The clock, before anything that can return early.
    //
    // Whether the mixer is running *is* whether the cut is playing — there is no
    // second flag to fall out of step with it. Kept as one, a frame that
    // returned early (a clip still opening, an empty timeline) could leave the
    // engine believing playback had already started while the mixer had stopped,
    // and the next play would read a clock that was never anchored: the picture
    // would sit at zero for the length of the cut.
    //
    // The playhead can also move while the clock runs — an arrow-key skip, the
    // assistant's seek, a preview range starting mid-play. The engine writes
    // the playhead itself every playing frame, so a value it did not write is
    // someone seeking, and the clock re-anchors there rather than snapping the
    // playhead back.
    let t: number;
    if (playing) {
      const head = playheadAt();
      if (!this.mixer.running || (this.written !== null && head !== this.written)) {
        this.mixer.start(Math.min(head, total));
        this.written = head;
      }
      t = Math.max(0, Math.min(this.mixer.now(), total));
    } else {
      // Pinned just inside the end: a preview time at exactly `total` lies past
      // the final span, and a skim off the right edge of the cut should hold
      // the last frame rather than clear to black.
      const end = Math.max(0, total - 0.001);
      t = Math.max(0, Math.min(previewAt(), end));
      if (this.mixer.running) this.mixer.stop();
    }

    // Nothing anywhere resets to a black frame at 0.
    if (
      spans.length === 0 &&
      overlayLayers(s.clips).length === 0 &&
      s.audioClips.length === 0 &&
      s.overlays.length === 0
    ) {
      this.mixer.stop();
      this.comp.drawLayer(MISSING_FRAME, undefined, true, 1, 0);
      if (s.playing) {
        useEditor.setState({ playing: false });
        this.writeHead(0);
      }
      return;
    }

    const master = spans.find((sp) => t >= sp.start && t < sp.start + sp.len);

    // Ask for the master's picture before clearing. A clip nothing has decoded
    // yet answers `pending`, and clearing on the strength of that would black
    // the frame out for as long as the file takes to open — the strobe this
    // whole design exists to remove. Leave what is on screen and stay dirty;
    // the clock, the audio, and the stop checks below still run, so a slow
    // open can't freeze the playhead or carry playback past a stop mark.
    const masterFrame = master ? this.frameFor(master, t, playing) : MISSING_FRAME;
    const pendingMaster = masterFrame.kind === "pending";
    const fadeGain = this.projectFadeGain(t, total);
    if (pendingMaster) {
      this.dirty = true;
    } else {
      this.comp.clear();
      if (master) this.drawTrackZero(master, spans, t, playing, masterFrame);
      this.drawOverlays(t, playing);
      // The subject-mask pass reads the canvas as it stands beneath it, then
      // publishes the matte the DOM's front subject-masked elements read.
      this.comp.subjectMatteProvider = (at) => this.behind.clipMatteOf(this.canvas, at);
      this.behind.draw(this.canvas, s.overlays, s.assets, t);
      this.comp.drawProjectFade(fadeGain);
    }

    // Decoders for what is about to arrive, and the ones nothing needs closed.
    this.warm(t, playing);
    this.pool.evict();

    if (playing) {
      this.mixer.setMasterGain(fadeGain);
      this.mixer.update(t, this.voicesAt(t, spans, master));
      // A scoped effect preview auto-pauses at its stop mark; the end of the
      // cut stops playback outright.
      const stop = s.previewStopAt;
      if (stop != null && t >= stop) {
        useEditor.setState({ playing: false, previewStopAt: null });
        this.writeHead(Math.min(t, stop));
      } else if (t >= total - 0.001) {
        useEditor.setState({ playing: false, previewStopAt: null });
        this.writeHead(total);
      } else {
        this.writeHead(t);
      }
    }

    if (tracing()) {
      let srcTs: number | null = null;
      let exact = true;
      if (master) {
        const src = this.pool.get(
          keyOf(master.clip, master.asset),
          master.asset,
          this.decodeHeight()
        );
        const st = sourceTimeOf(master.clip, t);
        srcTs = src.frameAt(st)?.timestamp ?? null;
        exact = src.hasExact(st);
      }
      markPresent({
        t,
        srcTs,
        clipId: master?.clip.id ?? null,
        exact,
        stale: masterFrame.kind !== "ready",
      });
      markLiveSamples(this.pool.held);
    }
  }
}

export function usePlayback(canvasRef: RefObject<HTMLCanvasElement | null>) {
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const engine = new Engine(canvas);
    // Dev-only automation hook, like installDevHooks: lets a headless run (or a
    // debugging session) reach the live engine.
    if (process.env.NODE_ENV !== "production") {
      (window as unknown as Record<string, unknown>).__cutDevEngine = engine;
    }
    registerSourceSampler((clipId) => engine.sourceFor(clipId));
    return () => {
      registerSourceSampler(null);
      engine.dispose();
    };
  }, [canvasRef]);
}
