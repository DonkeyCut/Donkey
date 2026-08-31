"use client";

import { useEffect, type RefObject } from "react";
import {
  clipSpeed,
  getClipSpans,
  overlayLayers,
  projectDuration,
  useEditor,
} from "@/cut/lib/store";
import { matteLumaToAlpha } from "@donkeycut/effects-kit";
import { playheadAt, previewAt, setPlayhead, subscribePlayhead } from "@/cut/lib/playhead";
import { assetIsSilent, clipCovers, projectFadeSeconds, rectOf } from "@/cut/lib/types";
import type { ClipSpan, MediaAsset, VideoClip } from "@/cut/lib/types";
import { SubjectMaskCompositor } from "@/cut/lib/behindPass";
import { FrameCompositor, MISSING_FRAME, PENDING_FRAME, type Frame } from "@/cut/lib/composite";
import { crossHandles, duckGainAt, overlayPlan, soundCrossGain, trackZeroPlan } from "@/cut/lib/framePlan";
import { type ClipFrameSource, FrameSourcePool, mappingKey, walkCostMs } from "@/cut/lib/frameSource";
import { liveAudioFxAt } from "@/cut/lib/audioEffects";
import { PreviewMixer, type Voice } from "@/cut/lib/previewMixer";
import {
  flushMeter,
  markAudioClock,
  markLiveSamples,
  markLiveSources,
  markPresent,
  meterAudioClock,
  meterFrame,
  meterState,
  metering,
  markTick,
  tracing,
} from "@/cut/lib/perfTrace";
import { registerSourceSampler } from "@/cut/lib/previewCanvas";
import { backdropStill } from "@/cut/lib/backdropStills";
import { createRasterCanvas, type RasterSurface } from "@/cut/lib/raster";

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
/** Inside this, an upcoming clip is walked as well as opened. */
const WARM_STREAM_S = 0.75;
/** How long the master's picture has to be missing before a play is held at a
 * standstill. Short enough that a real stall is caught before the playhead has
 * gone anywhere, long enough that a decoder a frame behind at a join is not a
 * stutter and a cut in the sound. */
const STALL_HOLD_MS = 200;
/**
 * Decoders alive at once.
 *
 * Past the tab's hardware decode slots the rest fall back to software, where
 * they are the same processor split further, so it reads as a number that
 * should shrink on a machine with few slots. It does not. Shrinking it makes
 * a fast cut suspend and reopen sources it is about to need again, and a
 * reopen on such a machine costs a fresh decoder and a full walk from the
 * keyframe — the expensive thing, paid repeatedly. Measured on the eval's
 * few-slot profiles, cutting this to six moved late frames from 42% to 52%
 * and turned a flat play into one that decayed across its length.
 */
const DECODER_BUDGET = 12;

/** Source time of a clip at timeline time `t`. */
const sourceTimeOf = (clip: VideoClip, t: number) =>
  clip.in + Math.max(0, t - clip.start) * clipSpeed(clip);

/**
 * When the preview gives up resolution to keep the picture with the sound.
 *
 * A machine whose decoder cannot deliver a frame per frame period falls
 * further behind for as long as the play lasts: the sound goes on, the picture
 * does not, and nothing in the reader can invent the frames. Decoding smaller
 * is the one lever that reduces the work itself. The
 * trade is deliberate — a softer picture that stays with its sound beats a
 * sharp one seconds behind it.
 */
const TRAIL_LAG_S = 0.5;
/** How long the picture has to stay behind before the trade is taken. A cold
 * open hops once and catches up; this is about the state it cannot leave. */
const TRAIL_MS = 3_000;
/** Below this the preview would be mush, so it stops trading. */
const DECODE_FLOOR = 360;
/**
 * How long a play runs before the trade is on the table at all.
 *
 * Starting a play is the one moment every machine trails: nothing is decoded
 * yet, each source is finding its keyframe, and the first read of a file comes
 * off the link. That settles on its own within a few seconds and says nothing
 * about whether the machine can hold the cut. Trading resolution away for it
 * would leave every preview softer for the rest of the session on the strength
 * of its first breath.
 */
const PLAY_SETTLE_MS = 6_000;

/** The decode identity of a clip — see `mappingKey`. */
const keyOf = (clip: VideoClip, asset: MediaAsset) =>
  mappingKey(asset.id, clipSpeed(clip), clip.in, clip.start);

let engineSerial = 0;

/** Dev-only: engine lifecycle events, for the perf eval's timeline. Bounded so
 * an ordinary dev session never accumulates it. */
export function engineLog(msg: string): void {
  if (process.env.NODE_ENV === "production" || typeof window === "undefined") return;
  const w = window as unknown as { __cutEngineLog?: { at: number; msg: string }[] };
  const log = (w.__cutEngineLog ??= []);
  log.push({ at: Math.round(performance.now()), msg });
  if (log.length > 500) log.splice(0, log.length - 500);
}

/**
 * The source span a clip's voice plays, and where it lands.
 *
 * A clip normally plays exactly what it is trimmed to. A cross dissolve widens
 * that: the clip reaches into the handle on either side — source it was
 * trimmed away from — so it is still sounding after the picture has cut, or
 * already sounding before it. The widened span rides the voice for the clip's
 * whole life rather than only inside the handover, so the mixer decodes and
 * schedules one stable voice and the frame-by-frame gain is all that moves.
 */
const voiceSpan = (sp: ClipSpan) => {
  const speed = clipSpeed(sp.clip);
  return {
    url: sp.asset.url,
    start: sp.start - sp.soundBack,
    in: sp.clip.in - sp.soundBack * speed,
    out: sp.clip.out + sp.soundAhead * speed,
    speed,
    sound: sp.clip.sound,
  };
};

class Engine {
  /** Which engine this is, for the perf eval's pool dump. */
  readonly serial = ++engineSerial;

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
  /** Wall time the master's picture went missing, 0 while it is there. */
  private stalledAt = 0;
  /** How many 180-steps the preview has traded away, for the engine's life. */
  private dropped = 0;
  private steppedThisPlay = false;
  private trailingSince = 0;
  private playSince = 0;
  private wasPlaying = false;
  /** The last paused moment drawn, and whether the reader is heading down the
   * timeline. A paused reader's direction is a fact about the gesture, known
   * here and passed to every source read, since a source only ever sees its
   * own asks. */
  private lastRead: number | null = null;
  private readBackward = false;
  private lastWalkCost = 0;
  /** Whether the tick being drawn is a playing one — read by the matte
   * provider, which the compositor calls mid-frame. */
  private renderPlaying = false;
  /** Per removal clip: the last decoded matte luma frame converted to alpha,
   * so the conversion runs once per new frame rather than once per draw. Keyed
   * by clip — two clips reading the same matte at different times each keep
   * their own frame — and bounded LRU, so a long session's re-bakes and
   * deleted clips never pile up canvases. */
  private matteAlpha = new Map<string, { ts: number; canvas: RasterSurface }>();
  private static readonly MATTE_ALPHA_MAX = 8;

  private unsubscribe: () => void;
  private unwatch: () => void;
  private sizeWatch: MutationObserver;

  constructor(private canvas: HTMLCanvasElement) {
    this.comp = new FrameCompositor(canvas);
    this.comp.removalMatteProvider = (clip, at) => this.matteFor(clip, at);
    // A backdrop still decodes out of band; the frame that finds it missing
    // draws without it and the landing repaints.
    this.comp.backdropImageProvider = (assetId) =>
      backdropStill(useEditor.getState().assets, assetId, () => this.wake());
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
    engineLog(`engine ${this.serial} constructed`);
    this.wake();
  }

  dispose() {
    engineLog(`engine ${this.serial} disposed`);
    flushMeter();
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
   *
   * Nothing the window does moves it, for a second reason: the pool keys on
   * it, so a height that follows the canvas would abandon every open decoder
   * each time the box moved and pay a fresh keyframe walk for each.
   *
   * `noteLag` moves it exactly once per play, and pays that price knowingly.
   * The abandoned sources keep their decoders until the pool stands them down,
   * so for a second or two the machine holds about twice the decoders it needs
   * — on a machine already behind, which is the whole reason the step is being
   * taken. It is worth it because the alternative is a play that never catches
   * up at all, and because it happens once: the step is one-way, so the cost is
   * paid a single time and a wobbling picture never pays it again.
   */
  private decodeHeight(): number {
    const asked = Math.ceil(this.canvas.height / 180) * 180 || 180;
    return Math.max(DECODE_FLOOR, asked - this.dropped * 180);
  }

  /**
   * The picture has been behind the sound for a while, so decode smaller.
   *
   * One step per play and never back up. Stepping re-keys the pool, so every
   * open decoder is abandoned and each source pays a fresh keyframe walk;
   * paying that twice to undo it would cost more than the pixels are worth,
   * and paying it repeatedly inside one play is the storm the fixed height
   * exists to avoid.
   */
  private noteLag(lag: number, now: number, byteBound: boolean): void {
    if (lag <= TRAIL_LAG_S) {
      this.trailingSince = 0;
      return;
    }
    // Behind because the bytes are not here yet, which decoding smaller does
    // not help. The clock does not start while that is true, so the stretch
    // that earns the trade is one the decoder was responsible for.
    if (byteBound) return;
    if (!this.trailingSince) {
      this.trailingSince = now;
      return;
    }
    if (now - this.trailingSince < TRAIL_MS) return;
    if (now - this.playSince < PLAY_SETTLE_MS) return;
    if (this.steppedThisPlay || this.decodeHeight() <= DECODE_FLOOR) return;
    this.steppedThisPlay = true;
    this.trailingSince = 0;
    this.dropped++;
    engineLog(`decode step down to ${this.decodeHeight()}`);
    this.wake();
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

  /** Every open decoder and what it is doing, for the perf eval's pool dump. */
  poolState(): Record<string, unknown>[] {
    return [
      { serial: this.serial, disposed: this.disposed, raf: this.raf, dirty: this.dirty },
      ...this.pool.debugState(),
    ];
  }

  /** The clip's raw, ungraded decoder frame for analysis (the color panel's
   * Auto), or null when nothing has been decoded for it. */
  sourceFor(clipId: string): CanvasImageSource | null {
    const s = useEditor.getState();
    const clip = s.clips.find((c) => c.id === clipId);
    const asset = clip && s.assets.find((a) => a.id === clip.assetId);
    if (!clip || !asset) return null;
    const src = this.pool.get(keyOf(clip, asset), asset, this.decodeHeight());
    return src.frameAt(sourceTimeOf(clip, previewAt()), clip.in, clip.out)?.image ?? null;
  }

  /**
   * The alpha matte for a removal clip at timeline time `t`: the baked matte
   * video read like any other source, its luma turned into alpha. Null while
   * nothing has decoded yet — the picture draws plain until the matte lands.
   */
  private matteFor(clip: VideoClip, at: number): CanvasImageSource | null {
    const m = clip.removal?.matte;
    if (!m) return null;
    const s = useEditor.getState();
    const asset = s.assets.find((a) => a.id === m.assetId);
    if (!asset) return null;
    const dur = Math.max(0.001, asset.duration);
    const mt = Math.max(0, Math.min(sourceTimeOf(clip, at) - m.in, dur - 0.001));
    // Coverage tolerates far less resolution than the picture, and the luma →
    // alpha read below is a per-frame pixel pass; capping the matte's decode
    // keeps that pass off the frame budget.
    const src = this.pool.get(
      mappingKey(asset.id, clipSpeed(clip), m.in, clip.start),
      asset,
      Math.min(this.decodeHeight(), 480)
    );
    this.used.add(src);
    src.want(mt, this.renderPlaying);
    const frame = src.frameAt(mt, 0, dur);
    if (!frame) return null;
    const held = this.matteAlpha.get(clip.id);
    // Re-insert on every touch so the cap below drops the clip drawn longest
    // ago.
    this.matteAlpha.delete(clip.id);
    if (held && held.ts === frame.timestamp) {
      this.matteAlpha.set(clip.id, held);
      return held.canvas as CanvasImageSource;
    }
    const canvas = held?.canvas ?? createRasterCanvas(frame.width, frame.height);
    if (canvas.width !== frame.width) canvas.width = frame.width;
    if (canvas.height !== frame.height) canvas.height = frame.height;
    const ctx = canvas.getContext("2d") as CanvasRenderingContext2D | null;
    if (!ctx) return null;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(frame.image, 0, 0, canvas.width, canvas.height);
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    matteLumaToAlpha(img.data);
    ctx.putImageData(img, 0, 0);
    this.matteAlpha.set(clip.id, { ts: frame.timestamp, canvas });
    if (this.matteAlpha.size > Engine.MATTE_ALPHA_MAX) {
      const oldest = this.matteAlpha.keys().next().value;
      if (oldest !== undefined) this.matteAlpha.delete(oldest);
    }
    return canvas as CanvasImageSource;
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
  private frameFor(span: ClipSpan, t: number, playing: boolean, master = false): Frame {
    const src = this.pool.get(keyOf(span.clip, span.asset), span.asset, this.decodeHeight());
    this.used.add(src);
    const st = sourceTimeOf(span.clip, t);
    src.want(st, playing, this.readBackward);
    // A failed source that already decoded frames keeps showing the nearest
    // one it holds — a transient blip (a network drop, a signed URL mid
    // re-mint) reads as a held frame, and only a source with nothing at all
    // to show goes missing. The clip's own span bounds the answer: two clips
    // split from one file share a source, and a held frame from across the
    // split would show the other scene at a paused playhead.
    const frame = src.frameAt(st, span.clip.in, span.clip.out);
    // The picture on track 0 is the one being watched, so it is the one the
    // machine is judged on — see the meter in `perfTrace`.
    if (master && playing) {
      const lag = frame ? Math.max(0, st - frame.timestamp) : 0;
      // The trade does not wait for anyone to turn diagnostics on.
      this.noteLag(lag, performance.now(), src.byteBound);
      if (metering()) meterFrame(lag, !frame);
    }
    if (frame)
      return { kind: "ready", image: frame.image, width: frame.width, height: frame.height };
    return src.failed ? MISSING_FRAME : PENDING_FRAME;
  }

  /** Open and start the decoders for clips about to arrive — on track 0 and
   * the overlay tracks alike — so a cut or an overlay's entrance lands on a
   * ring that is already full. */
  private warm(t: number, playing: boolean) {
    if (process.env.NODE_ENV !== "production") {
      const cost = walkCostMs();
      if (cost && cost !== this.lastWalkCost) {
        this.lastWalkCost = cost;
        engineLog(`walk cost ${cost}ms`);
      }
    }
    const s = useEditor.getState();
    const lists = [getClipSpans(s.clips, s.assets)];
    for (const track of new Set(overlayLayers(s.clips).map((c) => c.track))) {
      lists.push(getClipSpans(s.clips, s.assets, track));
    }
    // A pointer backing down the timeline arrives at the previous clip's last
    // frame, so that clip's tail is landed backward ahead of it: the cut is
    // crossed onto windows already there.
    if (this.readBackward) {
      for (const spans of lists) {
        for (const sp of spans) {
          const end = sp.start + sp.len;
          if (end > t || t - end > WARM_STREAM_S) continue;
          const src = this.pool.get(keyOf(sp.clip, sp.asset), sp.asset, this.decodeHeight());
          if (this.used.has(src)) continue;
          this.used.add(src);
          const tail = Math.max(sp.clip.in, sourceTimeOf(sp.clip, end) - 0.001);
          src.want(tail, false, true);
        }
      }
    }
    // The clips ahead are for a reader moving that way. One backing down the
    // timeline is leaving them, and a walk started for the nearest — sent as
    // if playing — would take the decoder the backward walk is using and let
    // go of the frames it landed.
    if (this.readBackward) return;
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

  /** Each upper track's spans, for the sound side — a cross dissolve up there
   * crosses the same way track 0's does. */
  private overlaySpans(): ClipSpan[][] {
    const s = useEditor.getState();
    return [...new Set(overlayLayers(s.clips).map((c) => c.track))].map((track) =>
      getClipSpans(s.clips, s.assets, track)
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
   * its own, and a live voiceover ducks the rest. A cross dissolve is the
   * ramp on its own — the picture cuts and only these gains move — and it is
   * the one thing here that makes a clip audible outside its own footprint,
   * so both sides of the crossing are really playing at once.
   */
  private voicesAt(t: number, spans: ClipSpan[], master: ClipSpan | undefined): Voice[] {
    const s = useEditor.getState();
    const out: Voice[] = [];
    const duck = duckGainAt(s.audioClips, t);
    if (master && !master.clip.muted && !master.clip.hidden && !assetIsSilent(master.asset)) {
      const plan = trackZeroPlan(master, spans, t);
      out.push({
        id: master.clip.id,
        ...voiceSpan(master),
        gain: plan.gain * soundCrossGain(spans, master, t) * duck * (master.clip.volume ?? 1),
      });
    }
    // The other half of a crossing: a neighbour playing into its handle, past
    // its own footprint, carried by the cross ramp alone.
    for (const spans0 of [spans, ...this.overlaySpans()]) {
      for (const { span, gain } of crossHandles(spans0, t)) {
        if (assetIsSilent(span.asset)) continue;
        // The clip's own id, not a second voice: the handle is the same voice
        // carrying on past the cut, and a new id would stop and re-open it
        // there — a decode gap in the middle of the crossing.
        out.push({
          id: span.clip.id,
          ...voiceSpan(span),
          gain: gain * (span.clip.volume ?? 1) * duck,
        });
      }
    }
    for (const { span, clip, asset, gain } of this.liveOverlays(t)) {
      if (clip.muted || clip.hidden || assetIsSilent(asset)) continue;
      out.push({
        id: clip.id,
        ...voiceSpan(span),
        gain: gain * (clip.volume ?? 1) * duck,
      });
    }
    for (const a of s.audioClips) {
      const asset = s.assets.find((x) => x.id === a.assetId);
      if (!asset || a.hidden || assetIsSilent(asset)) continue;
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
        sound: a.sound,
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
      const f = src.frameAt(b.at, b.span.clip.in, b.span.clip.out);
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
    for (const { span, clip, alpha, zoom } of this.liveOverlays(t)) {
      const frame = this.frameFor(span, t, playing);
      if (frame.kind !== "ready") continue;
      this.comp.drawIntoRect(frame, rectOf(clip), clipCovers(clip), alpha, t, zoom, clip);
    }
  }

  /** When the last tick ran, for spotting a starved loop in the dev log. */
  private lastTickAt = 0;

  private tick() {
    this.raf = 0;
    if (this.disposed) return;
    markTick();
    if (process.env.NODE_ENV !== "production") {
      const now = performance.now();
      if (this.lastTickAt && now - this.lastTickAt > 500) {
        engineLog(`engine ${this.serial} tick gap ${Math.round(now - this.lastTickAt)}ms`);
      }
      this.lastTickAt = now;
    }
    const playing = useEditor.getState().playing;
    if (playing !== this.wasPlaying) {
      this.wasPlaying = playing;
      this.trailingSince = 0;
      if (playing) {
        this.steppedThisPlay = false;
        this.playSince = performance.now();
      }
    }
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
    this.comp.removalBypass = s.removalPeek;
    this.renderPlaying = playing;
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
      if (this.mixer.running) {
        this.mixer.stop();
        flushMeter();
      }
    }

    // Nothing anywhere resets to a black frame at 0.
    if (
      spans.length === 0 &&
      overlayLayers(s.clips).length === 0 &&
      s.audioClips.length === 0 &&
      s.overlays.length === 0
    ) {
      this.mixer.stop();
      this.stalledAt = 0;
      if (s.buffering) useEditor.setState({ buffering: false });
      this.comp.drawLayer(MISSING_FRAME, undefined, true, 1, 0);
      if (s.playing) {
        useEditor.setState({ playing: false });
        this.writeHead(0);
      }
      return;
    }

    // Which way a paused reader is going, before anything reads a source on
    // its behalf. The direction is the last move's: a pointer at rest is
    // still heading the way it was, and the frames landed under it stay.
    if (playing) {
      this.readBackward = false;
      this.lastRead = null;
    } else {
      if (this.lastRead !== null && Math.abs(t - this.lastRead) > 1e-4)
        this.readBackward = t < this.lastRead;
      this.lastRead = t;
    }

    const master = spans.find((sp) => t >= sp.start && t < sp.start + sp.len);

    // Ask for the master's picture before clearing. A clip nothing has decoded
    // yet answers `pending`, and clearing on the strength of that would black
    // the frame out for as long as the file takes to open — the strobe this
    // whole design exists to remove. Leave what is on screen and stay dirty;
    // the clock, the audio, and the stop checks below still run, so a slow
    // open can't freeze the playhead or carry playback past a stop mark.
    const masterFrame = master ? this.frameFor(master, t, playing, true) : MISSING_FRAME;
    const pendingMaster = masterFrame.kind === "pending";
    // A play whose master clip has decoded nothing has nothing to play: the
    // clock would carry the playhead across a stretch of the cut nobody saw or
    // heard, and land somewhere further on when the file finally opened. So it
    // stands still and says so, and the play carries on from where it stopped.
    // A moment of it is a decoder a frame or two behind rather than a stall,
    // and stopping the clock for that would stutter the picture and cut the
    // sound at every join, so a stall has to hold before it counts. A gap in
    // the timeline is empty on purpose and plays through.
    if (playing && master && pendingMaster) {
      this.stalledAt ||= performance.now();
      if (performance.now() - this.stalledAt >= STALL_HOLD_MS) {
        this.mixer.hold(t);
        this.writeHead(t);
        if (!s.buffering) useEditor.setState({ buffering: true });
        this.dirty = true;
        return;
      }
    } else {
      this.stalledAt = 0;
      if (s.buffering) useEditor.setState({ buffering: false });
    }
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
      // The audio effect elements over this moment, each at the level its
      // window puts it at; the mixer carries them over the whole mix.
      this.mixer.setEffects(
        liveAudioFxAt(s.overlays, t).map(({ span, wet }) => ({
          id: span.id,
          effect: span.effect,
          amount: span.amount,
          wet,
        }))
      );
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
    } else {
      // The sound's readers on the same footing as the picture's: the clip
      // under a parked playhead has its file open before the play begins,
      // rather than opening it once the clock is already running.
      this.mixer.warm(t, this.voicesAt(t, spans, master));
    }

    if (tracing()) {
      let srcTs: number | null = null;
      let wantSrc: number | null = null;
      let exact = true;
      if (master) {
        const src = this.pool.get(
          keyOf(master.clip, master.asset),
          master.asset,
          this.decodeHeight()
        );
        const st = sourceTimeOf(master.clip, t);
        wantSrc = st;
        srcTs = src.frameAt(st, master.clip.in, master.clip.out)?.timestamp ?? null;
        exact = src.hasExact(st);
      }
      markPresent({
        t,
        srcTs,
        wantSrc,
        clipId: master?.clip.id ?? null,
        exact,
        stale: masterFrame.kind !== "ready",
      });
      markLiveSamples(this.pool.held);
      const clock = this.mixer.clockLead();
      markAudioClock(clock.lead, clock.reported);
      markLiveSources(this.pool.active, this.pool.size, this.pool.warmPixels);
    }

    if (playing && metering()) {
      const clock = this.mixer.clockLead();
      meterAudioClock(clock.lead, clock.reported);
      meterState({
        sources: this.pool.active,
        held: this.pool.held,
        warmMb: Math.round(this.pool.warmPixels * 4e-6),
        clips: s.clips.length,
        decodeHeight: this.decodeHeight(),
        canvasHeight: this.canvas.height,
      });
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
