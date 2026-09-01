"use client";

/**
 * The cut's sound while you watch it.
 *
 * Sound used to ride the same `<video>` and `<audio>` elements the picture came
 * from: the clip under the playhead was both the speaker and the clock, and
 * everything else chased it. That made the element's decode latency into the
 * project's timing, and it left no way to be sure the preview mixed a cut the
 * way the export would.
 *
 * Here every audible thing is a buffer scheduled on one `AudioContext`. The
 * context's own clock is what the preview runs on — it advances in real time,
 * never backward, and is sample-accurate — so the picture follows the sound
 * rather than the other way round.
 *
 * Every voice holds a reader walking its own file forward and hands the context
 * about a second of sound at a time. Reading in order is the part that matters:
 * a voice asking for a long span at once is asking for the whole interleaved
 * stretch of file that span is scattered through, which over a network is
 * minutes of bytes for seconds of sound and a voice permanently behind its own
 * playhead. Walking keeps the sound exactly as far into the file as the picture
 * is. A clip playing at a speed other than 1 is time-stretched rather than
 * resampled, which is what keeps its pitch and matches what the export writes;
 * a stretch needs its span in hand, so those voices read a short window instead
 * of walking.
 *
 * Gains are the only thing touched per frame, and only their value: the clip's
 * own volume, its fades, the duck under a live voiceover, the whole-project
 * fade, and how much of each audio effect is heard. The ramps themselves are
 * the frame plan's, so the mix follows the same description the picture does.
 *
 * The audio effect elements sit between the voices and that final fade, each
 * treating what the one before it handed on — the order the export's filter
 * chain runs them in.
 */

import {
  audioFxRecipe,
  buildAudioFx,
  soundRecipe,
  type AudioFxNodes,
  type ClipSound,
} from "@donkeycut/effects-kit";
import type { WrappedAudioBuffer } from "mediabunny";
import { assembleAudio, decodeAudioSpan, openAudioWalk, type AudioWalk } from "./mediaRead";
import { allowance, holdMemory } from "./memoryBudget";
import { meterAudioLate, meterClockJump } from "./perfTrace";
import { timeStretch } from "./timeStretch";

/** How much of a voice is pulled off its walk and scheduled at once, in source
 * seconds. Long enough that a stretch of sound is one scheduling decision;
 * short enough that the bytes it waits on are the ones the picture is reading
 * anyway. */
const GROUP_S = 1;
/** The first window scheduled from a standing start — a play begun, a seek
 * landed, a hold released. The picture opens on a frame already decoded, and a
 * sound that waits for a whole group joins it a group-read late; a short first
 * window puts the sound beside the first frame, and the fills behind it extend
 * the lead by whole groups. A link that cannot feed the second window in time
 * starts it where the clock stands, the way any late window starts — a beat of
 * sound and a catch-up beats a silence the length of the group. */
const FIRST_GROUP_S = 0.3;
/** Most reads one group is assembled from. A packet of compressed audio holds
 * a fraction of a second, so a group is tens of reads, and this is the ceiling
 * over them. */
const GROUP_PULLS = 128;
/** A stretched window is resynthesised on the main thread, so it is kept short
 * enough that the work lands inside a frame or two. */
const WINDOW_STRETCHED_S = 4;
/**
 * Stretched windows kept in hand.
 *
 * Two dozen four-second windows of stereo at 48kHz — enough that stepping back
 * over a cut replays what it just played, and bounded because everything older
 * than that is a full decode away regardless.
 */
const STRETCH_CACHE_BYTES = 24 * WINDOW_STRETCHED_S * 48_000 * 2 * 4;

/** What a set of decoded windows costs: float samples, one per channel. */
const decodedBytes = (held: Map<string, AudioBuffer>): number => {
  let n = 0;
  for (const b of held.values()) n += b.length * b.numberOfChannels * 4;
  return n;
};
/** Schedule more of a voice once the playhead is this close to running out.
 * The scheduling runs on the main thread, and what is scheduled is all the
 * sound there is while that thread is blocked — a delete that takes seconds
 * to land, an import decoding — so the lead is longer than the freezes a slow
 * machine has been measured to take. */
const AHEAD_S = 5;
/** Most the picture will be held back for the output device, whatever the
 * device claims. Well past a Bluetooth headset, and short of anything that
 * would read as the playhead refusing to move. */
const MAX_LATENCY_S = 0.4;
/** Sound late by more than this, mid-play, is a hole the listener hears: the
 * scheduling runs seconds ahead, so a window that misses its moment means the
 * thread was gone for that long. A voice's first window is a different thing
 * — it is read while the play is already running, by design — so only a long
 * one counts there. */
const LATE_GAP_S = 0.05;
const LATE_FIRST_S = 0.5;

/** One audible thing on the timeline: a clip's own sound, or a soundtrack item. */
export interface Voice {
  /** Stable across frames — the clip's id. A voice whose id survives keeps
   * playing; one that vanishes is stopped. */
  id: string;
  url: string;
  /** Where it starts on the timeline, and the source span it plays. */
  start: number;
  in: number;
  out: number;
  speed: number;
  /** Everything the frame plan says about how loud it is right now. */
  gain: number;
  /** The clip's own treatment, run on this voice alone before it joins the
   * bus. */
  sound?: ClipSound;
}

interface Scheduled {
  node: AudioBufferSourceNode;
  /** Timeline time this window ends at, so the next one starts there. */
  until: number;
}

interface LiveVoice {
  url: string;
  speed: number;
  in: number;
  out: number;
  start: number;
  /** Where this voice's scheduled windows land. The clip's own treatment
   * runs between here and the gain, so it hears the clip at its recorded
   * level — the same place the fold and the ffmpeg stanza run it, ahead of
   * the level, fades and duck the gain carries. */
  head: GainNode;
  gain: GainNode;
  /** The treatment's chain, and what it was built from, so a frame that
   * changes nothing about it touches no nodes. Rebuilt in place when the
   * treatment changes: the windows already scheduled play on through the
   * new chain, since they are connected to the head rather than to it. */
  fx: AudioFxNodes | null;
  soundKey: string;
  /** Windows already handed to the context, oldest first. */
  windows: Scheduled[];
  /** Timeline time everything scheduled so far runs out at. */
  scheduled: number;
  /** The reader walking this voice's source, open from where it last read to.
   * A voice that moves inside the same file re-aims it; a read that failed, or
   * a source that moved to another address, drops it. */
  walk: AudioWalk | null;
  /** A read in flight, so a slow one doesn't start a second one, and when it
   * started, so one that has stopped answering can be disowned. */
  filling: boolean;
  fillAt: number;
  /** Bumped by everything that moves the voice. A read carries the number it
   * started under and acts on what it got only while that still stands. */
  gen: number;
  /** Set when the voice has read to the end of its source. A position rather
   * than a verdict: anything that moves the voice clears it, so a seek back
   * into the clip plays again. */
  ended: boolean;
  /** The furthest point in the source a walk has ended at. A second walk that
   * gets no further has found where the track really stops. */
  reached: number;
  /** Consecutive failed reads, and the wall time (performance.now) the next
   * one may be tried at. */
  attempts: number;
  retryAt: number;
}

/** A read that has not answered in this long has stopped being a read — a
 * request left hanging by a link that went away. The voice disowns it and asks
 * again; waiting it out would cost the rest of the play. */
const FILL_STALL_MS = 15_000;
/** A failed read is asked again quickly a few times, then on a slow cadence for
 * as long as the failure holds. Nothing here is ever terminal, and that is the
 * point: a source that cannot be read this second — bytes still landing, a
 * token a moment past its window, a link that dropped — is nearly always
 * readable shortly, the picture's own readers wait it out exactly this way
 * (frameSource.ts), and a voice that stopped asking was silent for the life of
 * the page while the picture beside it healed. */
const READ_RETRY_MS = 1_000;
const READ_RETRIES = 3;
const READ_RECHECK_MS = 10_000;
/** How close to the clip's end a walk may stop and be believed. A track
 * routinely runs a fraction short of the picture it came with. */
const END_SLACK_S = 0.25;

/** One audio effect element the graph is carrying: its recipe's chain, and
 * the pair of gains that cross the mix between treated and untreated. */
interface LiveFx {
  nodes: AudioFxNodes;
  wet: GainNode;
  dry: GainNode;
  /** Where the treated and untreated sides meet — the next stage's input. */
  out: GainNode;
}

/** What the mixer is told about one effect element on the timeline: which
 * effect at what strength, and how much of it is heard right now. */
export interface FxVoice {
  id: string;
  effect: string;
  amount?: number;
  /** 0 = the untreated mix, 1 = the treated one. */
  wet: number;
}

/**
 * The preview's clock and mixer.
 *
 * One of these lives for as long as the editor is open. It holds the context,
 * the anchor that maps timeline seconds onto it, and one gain-fed voice per
 * audible clip.
 */
export class PreviewMixer {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  /** Where every voice lands, and what the effect chains treat. */
  private bus: GainNode | null = null;
  private fx = new Map<string, LiveFx>();
  /** What the built chains stand for, so a frame that changes nothing about
   * them touches gains alone. */
  private fxKey = "";
  private voices = new Map<string, LiveVoice>();
  /** Whether the clock is being kept still by `hold`, so entering a hold
   * silences the mix once rather than on every frame of it. */
  private holding = false;
  /** Where the clock is being kept while `holding`. */
  private heldAt = 0;
  /** Timeline time, context time and wall time of the same instant. Everything
   * scheduled is placed against this. */
  private anchor: { timeline: number; ctx: number; wall: number } | null = null;
  private decoded = new Map<string, AudioBuffer>();
  private readonly releaseMemory = holdMemory("audio", () => decodedBytes(this.decoded));

  /** Whether the clock is running. */
  get running(): boolean {
    return this.anchor !== null;
  }

  private context(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.master = this.ctx.createGain();
      this.master.connect(this.ctx.destination);
      // Voices meet on the bus, the effect chains treat what is on it, and the
      // project fade rides the sum — the order the export's ffmpeg graph has.
      this.bus = this.ctx.createGain();
      this.bus.connect(this.master);
    }
    return this.ctx;
  }

  /**
   * How far behind the graph's clock the sound is actually heard.
   *
   * `ctx.currentTime` is the moment the graph has *rendered* to, and a rendered
   * sample has not left the machine yet: it is sitting in the output buffer the
   * device will read next. `baseLatency` is what the graph itself holds and
   * `outputLatency` is what the device does, and their sum is the gap between
   * a sample being written and a person hearing it.
   *
   * The size of that gap is the platform's to decide, and platforms disagree by
   * an order of magnitude. CoreAudio hands back something in the tens of
   * milliseconds. WASAPI in shared mode — every Windows browser, by default —
   * routinely holds several times that, and a Bluetooth output holds more
   * again. A picture drawn against the unadjusted clock therefore runs ahead of
   * its own sound by an amount that is invisible where this is developed and
   * plainly wrong on the machines most people edit on.
   *
   * Capped, because the number comes from a driver: a device reporting
   * something absurd would otherwise hold the picture at the play position for
   * as long as it claimed.
   */
  private latency(): number {
    const ctx = this.ctx;
    if (!ctx) return 0;
    const reported = (ctx.baseLatency || 0) + (ctx.outputLatency || 0);
    return Math.min(MAX_LATENCY_S, Math.max(0, reported));
  }

  /** The moment leaving the speakers, given the moment the graph has rendered
   * to. Held at the play position over the first buffer: the sound starts at
   * once and the picture waits out the device rather than stepping backwards
   * into what has already been heard. */
  private heard(graph: number): number {
    return Math.max(this.anchor?.timeline ?? 0, graph - this.latency());
  }

  /**
   * Where the playhead is, from the sound's own clock.
   *
   * This is the whole point of the arrangement: the number the picture is drawn
   * against comes from the same clock the samples leave on, so they cannot
   * drift apart no matter what the main thread is doing. Leaving is the word —
   * what the graph has rendered is a buffer ahead of what is audible, and the
   * picture is drawn against the audible one.
   */
  now(): number {
    if (!this.anchor) return 0;
    // A hold is the clock standing still on purpose; nothing about it is drift.
    if (this.holding) return this.heldAt;
    const wall = this.anchor.timeline + (performance.now() - this.anchor.wall) / 1000;
    // A browser holds an `AudioContext` suspended until the page has been
    // interacted with, and a suspended context's clock does not move. Reading
    // it blindly would freeze the picture on a project played before the user
    // has touched anything, and picking it up once it finally starts would jump
    // the playhead by however long it stayed asleep. So the wall carries the cut
    // until the audio clock agrees with it, and a clock that disagrees is
    // re-anchored rather than believed.
    if (!this.ctx || this.ctx.state !== "running") return wall;
    const graph = this.anchor.timeline + (this.ctx.currentTime - this.anchor.ctx);
    // Measured on the graph's clock, which is the one the anchor was taken on.
    // Comparing the heard clock against the wall would read the device's own
    // buffer as drift and tear down every scheduled window to correct for it,
    // which on the machines with the largest buffers is the loudest thing this
    // class could do.
    if (Math.abs(graph - wall) > 0.25) {
      this.anchor.ctx = this.ctx.currentTime - (wall - this.anchor.timeline);
      // Everything already scheduled was placed against the old anchor and is
      // now wrong by the size of the jump — a context that sat suspended until
      // the user's next gesture, an output device switch. The clock alone
      // moving would leave those windows playing the wrong moment for up to
      // their full length, so they stop here and the next update refills from
      // where the clock now stands.
      meterClockJump();
      this.restart(wall);
      return this.heard(wall);
    }
    return this.heard(graph);
  }

  /**
   * Where the playhead is, with the clock allowed to re-aim nothing.
   *
   * A read asks with this. Asking with `now()` lets a read that took a moment
   * trip the re-anchor, and re-anchoring disowns every voice — including the
   * one this read was for, whose sound is then thrown away by the act of
   * finding out where to put it.
   */
  private at(): number {
    if (!this.anchor) return 0;
    const wall = this.anchor.timeline + (performance.now() - this.anchor.wall) / 1000;
    if (!this.ctx || this.ctx.state !== "running") return wall;
    const graph = this.anchor.timeline + (this.ctx.currentTime - this.anchor.ctx);
    return this.heard(Math.abs(graph - wall) > 0.25 ? wall : graph);
  }

  /**
   * How far the picture is being held behind the graph's clock right now, and
   * what the output device says it holds. Zero when nothing is playing.
   *
   * These are two independent readings of the same thing — one taken from what
   * the clock actually returns, one from the device — and the perf eval holds
   * them against each other. A preview that went back to drawing against the
   * rendered clock reports a lead of zero on a device claiming a fifth of a
   * second, which is the picture running that far ahead of its own sound.
   */
  clockLead(): { lead: number; reported: number } {
    const ctx = this.ctx;
    const reported = ctx ? (ctx.baseLatency || 0) + (ctx.outputLatency || 0) : 0;
    if (!this.anchor || !ctx || ctx.state !== "running") return { lead: 0, reported };
    const graph = this.anchor.timeline + (ctx.currentTime - this.anchor.ctx);
    return { lead: Math.max(0, graph - this.heard(graph)), reported };
  }

  /** Stop every scheduled window and re-aim each voice at `timeline`, keeping
   * the file each one is reading: a clock that jumped moved the voices inside
   * the same sources. */
  private restart(timeline: number): void {
    for (const live of this.voices.values()) {
      this.stopWindows(live);
      this.reaim(live, Math.max(live.start, timeline));
      // The voice is somewhere else in its file now, so where a walk stopped
      // at the old position says nothing about this one.
      live.reached = -Infinity;
    }
  }

  /** Stop and drop every window a voice has handed to the context. */
  private stopWindows(live: LiveVoice): void {
    for (const w of live.windows) {
      try {
        w.node.stop();
      } catch {
        // Already finished; stopping a spent node throws and means nothing.
      }
      w.node.disconnect();
    }
    live.windows = [];
  }

  /**
   * The voice is no longer reading where it was.
   *
   * This is the one that gives the file up, for the cases where the file is
   * the problem or is no longer the right one: a read that failed or stopped
   * answering, a voice released, a source that moved to another address. A
   * voice that has merely fallen behind keeps its reader and is re-aimed. The
   * read still in flight is disowned in the same breath: it carries the old
   * number and everything it comes back with is ignored.
   */
  private moved(live: LiveVoice): void {
    live.gen++;
    live.filling = false;
    live.ended = false;
    live.walk?.close();
    live.walk = null;
  }

  /**
   * Begin playing at timeline time `t`.
   *
   * The anchor is this very instant: the next `now()` reads `t` and counts
   * forward. Anchoring even slightly in the future reads *behind* `t` first,
   * which walks the playhead backwards on every play and, at the head of the
   * timeline, puts the clock before the first clip. The first audio window
   * pays for its own decode instead — `fill` starts a late window at the
   * current time with the missed sliver skipped, so the sound joins in sync a
   * few milliseconds in.
   */
  start(t: number): void {
    const ctx = this.context();
    void ctx.resume();
    this.restart(t);
    this.anchor = { timeline: t, ctx: ctx.currentTime, wall: performance.now() };
  }

  /**
   * Keep the clock at `t` while the cut has nothing to show.
   *
   * The context's clock runs whatever happens to it, so the anchor moves under
   * it: the timeline stands still while real time goes on, and the play picks
   * up where it stopped. Sound stops with it — a mix playing on over a picture
   * that is not moving is the sound of a cut coming apart, and what is already
   * scheduled would land at the wrong moment when the picture came back.
   */
  hold(t: number): void {
    if (!this.ctx || !this.anchor) return;
    if (!this.holding) {
      this.holding = true;
      this.heldAt = t;
      for (const live of this.voices.values()) {
        this.stopWindows(live);
        const from = Math.max(live.start, t);
        this.reaim(live, from);
        // The held moment's sound comes down while the picture opens: one
        // read aims the walk and pulls the bytes it sits in — the primer a
        // parked playhead uses — so the release finds an open file already
        // read where the first window starts.
        const source = live.in + (from - live.start) * live.speed;
        if (!live.filling && source < live.out - 1e-3) void this.prime(live, source);
      }
    }
    // Both clocks are pulled back to where the hold began, every frame of it:
    // the context's runs on, and the wall's is what carries a cut whose context
    // is not running.
    this.anchor.ctx = this.ctx.currentTime - (this.heldAt - this.anchor.timeline);
    this.anchor.wall = performance.now() - (this.heldAt - this.anchor.timeline) * 1000;
  }

  /** Stop the clock and silence everything, keeping each voice's reader: the
   * playhead is parked over the same clips it was playing, and the next play
   * is usually from where this one stopped. */
  stop(): void {
    this.anchor = null;
    this.holding = false;
    for (const live of this.voices.values()) this.stopWindows(live);
  }

  /** The whole-project fade, over the finished mix. */
  setMasterGain(g: number): void {
    if (this.master) this.master.gain.value = Math.max(0, Math.min(1, g));
  }

  /**
   * Carry these audio effects over the bus, in the order given.
   *
   * The chains run in series — the second effect treats what the first one
   * handed on, the way the export's filter chain does — and each one is
   * crossed into the mix by its own `wet`. The graph is rebuilt only when the
   * list itself changes; a caller that passes the effects near the playhead
   * therefore rebuilds while the entering or leaving chain is silent, and
   * every frame in between only moves gains.
   */
  setEffects(fx: FxVoice[]): void {
    const ctx = this.ctx;
    const bus = this.bus;
    const master = this.master;
    if (!ctx || !bus || !master) return;
    const key = fx.map((f) => `${f.id}:${f.effect}:${f.amount ?? ""}`).join("|");
    if (key !== this.fxKey) {
      this.fxKey = key;
      this.teardownFx();
      // The bus's old outlet goes first, so the stages built below are the
      // only path from it to the fade.
      bus.disconnect();
      let node: AudioNode = bus;
      for (const f of fx) {
        const recipe = audioFxRecipe(f.effect, f.amount);
        if (!recipe) continue;
        const nodes = buildAudioFx(ctx, recipe, ctx.currentTime);
        // One stage: what came in, and the treated copy of it, meeting at a
        // sum that the next stage reads.
        const wet = ctx.createGain();
        const dry = ctx.createGain();
        const out = ctx.createGain();
        wet.gain.value = 0;
        dry.gain.value = 1;
        node.connect(nodes.input);
        nodes.output.connect(wet);
        wet.connect(out);
        node.connect(dry);
        dry.connect(out);
        node = out;
        this.fx.set(f.id, { nodes, wet, dry, out });
      }
      node.connect(master);
    }
    for (const f of fx) {
      const live = this.fx.get(f.id);
      if (!live) continue;
      const w = Math.max(0, Math.min(1, f.wet));
      live.wet.gain.value = w;
      live.dry.gain.value = 1 - w;
    }
  }

  /** Drop every effect chain, stopping the modulators they started. */
  private teardownFx(): void {
    for (const live of this.fx.values()) {
      for (const src of live.nodes.sources) {
        try {
          src.stop();
        } catch {
          // Already stopped; a spent node throws and means nothing.
        }
      }
      live.nodes.input.disconnect();
      live.nodes.output.disconnect();
      live.wet.disconnect();
      live.dry.disconnect();
      live.out.disconnect();
    }
    this.fx.clear();
  }

  /**
   * Bring the mix in line with what is audible at timeline time `t`.
   *
   * Called every frame while playing. Voices that just became live are opened
   * and scheduled; voices that ran out are dropped; the rest have their gain
   * set to whatever the frame plan worked out. Nothing here awaits, so a slow
   * decode delays that one voice and nothing else.
   */
  update(t: number, voices: Voice[]): void {
    if (!this.anchor || !this.ctx) return;
    this.holding = false;
    // A context that stops running stops the sound and leaves the picture
    // playing on wall time — an output device taken away, a page the browser
    // put to sleep. Nothing else asks it back, since `start` is the only other
    // resume, so a play that lost its context stayed silent to the end of the
    // cut.
    if (this.ctx.state !== "running") void this.ctx.resume().catch(() => {});
    const seen = new Set<string>();
    for (const v of voices) {
      seen.add(v.id);
      // An edit to a playing clip arrives as the same id with new geometry — a
      // trim, a move, a speed change. Gain is the only part of a voice that
      // tunes live; everything else is baked into what was already scheduled,
      // so the voice reopens and the sound follows the edit the way the
      // picture does.
      const prev = this.voices.get(v.id);
      if (
        prev &&
        (prev.start !== v.start ||
          prev.in !== v.in ||
          prev.out !== v.out ||
          prev.speed !== v.speed)
      ) {
        this.release(prev);
        this.voices.delete(v.id);
      } else if (prev && prev.url !== v.url) {
        // The same sound at a new address: a signed link re-minted, an import
        // that landed in project storage and moved off the URL it arrived on.
        // The bytes already scheduled are the same sound, so they play on and
        // only the next read moves — dropping them would take the sound out
        // for as long as a cold open of the new address takes, which on a
        // long file is most of a minute and sounds like the audio quitting.
        this.forget(prev.url);
        prev.url = v.url;
        this.moved(prev);
        // A new address answers for itself, so nothing the old one did holds
        // this voice back from asking straight away.
        prev.attempts = 0;
        prev.retryAt = 0;
        prev.reached = -Infinity;
      }
      const live = this.voices.get(v.id) ?? this.open(v, t);
      if (!live) continue;
      live.gain.gain.value = Math.max(0, Math.min(3, v.gain));
      this.treat(live, v.sound);
      // A read that hangs holds the voice as surely as one that fails, and it
      // holds it quietly: nothing else would ever notice, and the voice would
      // wait on it for the rest of the play.
      if (live.filling && performance.now() - live.fillAt > FILL_STALL_MS) this.miss(live);
      if (
        !live.ended &&
        !live.filling &&
        live.scheduled < t + AHEAD_S &&
        performance.now() >= live.retryAt
      )
        void this.fill(v.id, live);
      // Windows that have finished playing hold their buffers alive.
      live.windows = live.windows.filter((w) => w.until > t - 1);
    }
    for (const [id, live] of this.voices) {
      if (seen.has(id)) continue;
      this.release(live);
      this.voices.delete(id);
    }
  }

  /** A window that missed its moment. Reported to the diagnostics meter once
   * it is past what the first read of a voice costs by design. */
  private noteLate(live: LiveVoice, lateS: number): void {
    if (lateS > (live.windows.length ? LATE_GAP_S : LATE_FIRST_S)) meterAudioLate(lateS);
  }

  /**
   * Get the sound ready for a play that has not started.
   *
   * Opening a reader is most of a second on a long file and several on a slow
   * link — a container parsed, a decoder configured, a seek into the middle of
   * it — and the sound used to do all of that after the play began. The picture
   * never did: the clip under a parked playhead has had a decoder open on it
   * all along, which is why the picture starts on the frame and the sound came
   * in seconds later, worst right after a seek.
   *
   * The playhead standing over a clip is all the notice the sound needs. Each
   * audible voice opens its file and takes one read at the moment it is parked
   * on, so the play finds an open file aimed where it is about to read. Nothing
   * is scheduled and nothing is heard; the context is left alone until a play
   * asks for it, which is also why this waits for one — a page that has not
   * played yet has no context to warm into.
   */
  warm(t: number, voices: Voice[]): void {
    if (this.running || !this.ctx) return;
    const seen = new Set<string>();
    for (const v of voices) {
      seen.add(v.id);
      const prev = this.voices.get(v.id);
      if (
        prev &&
        (prev.url !== v.url ||
          prev.start !== v.start ||
          prev.in !== v.in ||
          prev.out !== v.out ||
          prev.speed !== v.speed)
      ) {
        this.release(prev);
        this.voices.delete(v.id);
      }
      const live = this.voices.get(v.id) ?? this.open(v, t);
      if (!live) continue;
      live.gain.gain.value = 0;
      this.treat(live, v.sound);
      const from = Math.max(v.start, t);
      if (live.scheduled !== from) this.reaim(live, from);
      const source = live.in + (from - live.start) * live.speed;
      // Already reading, at the end of its source, or standing close enough
      // that the play's first read is the one it was going to make anyway.
      if (live.filling || source >= live.out - 1e-3) continue;
      if (live.walk && live.walk.position >= source && live.walk.position - source <= 1) continue;
      void this.prime(live, source);
    }
    for (const [id, live] of this.voices) {
      if (seen.has(id)) continue;
      this.release(live);
      this.voices.delete(id);
    }
  }

  /** One read taken to open the file and put the decoder on the moment the
   * playhead is parked at. What it reads is thrown away — the walk standing
   * there is the whole point — and a failure is left for the play to meet, so
   * a parked playhead never reports anything about a link. */
  private async prime(live: LiveVoice, source: number): Promise<void> {
    const gen = live.gen;
    live.filling = true;
    live.fillAt = performance.now();
    try {
      const walk = (live.walk ??= openAudioWalk(live.url, source, live.out));
      if (Math.abs(walk.position - source) > 0.02) walk.seek(source);
      await walk.next();
      // The read answering is the source answering: a voice backed off by an
      // outage is willing again the moment its file reads, so the play that
      // follows is never left waiting out a cadence the outage booked.
      if (live.gen === gen) {
        live.attempts = 0;
        live.retryAt = 0;
      }
    } catch {
      if (live.gen === gen) this.moved(live);
    } finally {
      if (live.gen === gen) live.filling = false;
    }
  }

  /** Let go of every decoded window. The next play decodes them again. */
  releaseCaches(): void {
    this.decoded.clear();
  }

  /** Drop the decode cache for a source that has been replaced. */
  private forget(url: string): void {
    for (const key of [...this.decoded.keys()]) {
      if (key.startsWith(`${url}|`)) this.decoded.delete(key);
    }
  }

  dispose(): void {
    this.stop();
    this.stopVoices();
    this.teardownFx();
    this.fxKey = "";
    this.decoded.clear();
    this.releaseMemory();
    void this.ctx?.close();
    this.ctx = null;
    this.master = null;
    this.bus = null;
  }

  private open(v: Voice, t: number): LiveVoice | null {
    const ctx = this.ctx;
    if (!ctx || !this.bus) return null;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    gain.connect(this.bus);
    const head = ctx.createGain();
    head.connect(gain);
    const live: LiveVoice = {
      url: v.url,
      speed: v.speed,
      in: v.in,
      out: v.out,
      start: v.start,
      head,
      gain,
      fx: null,
      soundKey: "",
      windows: [],
      // Scheduling begins where the playhead is: a voice opened mid-clip —
      // playback started inside it, or the clip edited while audible — decodes
      // from the moment it is heard, not from a head nobody will hear.
      scheduled: Math.max(v.start, t),
      walk: null,
      filling: false,
      fillAt: 0,
      gen: 0,
      ended: false,
      reached: -Infinity,
      attempts: 0,
      retryAt: 0,
    };
    this.voices.set(v.id, live);
    return live;
  }

  private release(live: LiveVoice): void {
    this.stopWindows(live);
    this.moved(live);
    live.head.disconnect();
    live.gain.disconnect();
    if (live.fx) {
      live.fx.input.disconnect();
      live.fx.output.disconnect();
      live.fx = null;
    }
  }

  /**
   * Put the clip's sound treatment between the voice's gain and the bus, or
   * take it out when the clip has none. Keyed on the treatment itself, so
   * every frame that leaves it alone costs a string compare and nothing
   * else, and a slider drag rebuilds a chain a few nodes long.
   */
  private treat(live: LiveVoice, sound: ClipSound | undefined): void {
    const ctx = this.ctx;
    const bus = this.bus;
    if (!ctx || !bus) return;
    const key = sound ? JSON.stringify(sound) : "";
    if (key === live.soundKey) return;
    live.soundKey = key;
    live.head.disconnect();
    if (live.fx) {
      live.fx.input.disconnect();
      live.fx.output.disconnect();
      live.fx = null;
    }
    const recipe = soundRecipe(sound);
    if (!recipe) {
      live.head.connect(live.gain);
      return;
    }
    const fx = buildAudioFx(ctx, recipe, ctx.currentTime);
    live.head.connect(fx.input);
    fx.output.connect(live.gain);
    live.fx = fx;
  }

  private stopVoices(): void {
    for (const live of this.voices.values()) this.release(live);
    this.voices.clear();
  }

  /**
   * Carry one voice a little further ahead of the playhead.
   *
   * The voice's walk hands back the sound in the order it plays, and a group of
   * it is scheduled as one, placed by the source timestamps the buffers carry.
   * A stretch of file with no audio in it therefore moves the sound to where it
   * belongs and everything after it keeps its own time.
   *
   * Nothing here is terminal. A read that fails or stops answering leaves the
   * voice waiting a moment and asking again, for as long as the play lasts,
   * because every reason a source stops answering mid-play is a reason it
   * starts again.
   */
  private async fill(id: string, live: LiveVoice): Promise<void> {
    if (!this.ctx || !this.anchor) return;
    const gen = ++live.gen;
    live.filling = true;
    live.fillAt = performance.now();
    // The voice can be moved out from under this read while it runs — a seek,
    // a clock jump, this very read disowned as stalled — and only the read that
    // still stands may act on what it got.
    const current = () => this.voices.get(id) === live && live.gen === gen;
    try {
      const from = live.scheduled;
      const sourceFrom = live.in + (from - live.start) * live.speed;
      if (sourceFrom >= live.out - 1e-3) {
        live.ended = true;
        return;
      }
      let buffer: AudioBuffer | null;
      try {
        // Nothing scheduled means the sound is standing still — the play just
        // began, a seek landed, a hold let go — and the picture is not
        // waiting. The first window is short so the sound joins it now.
        const group = live.windows.length ? GROUP_S : FIRST_GROUP_S;
        buffer =
          Math.abs(live.speed - 1) > 1e-3
            ? await this.stretchedWindow(live, sourceFrom)
            : await this.walkGroup(live, sourceFrom, current, group);
      } catch {
        // The read is the only part of this that says anything about the
        // source, so it is the only part a failure is spent on.
        if (current()) this.miss(live);
        return;
      }
      if (!current()) return;
      if (!buffer) {
        // A walk reports the same ending whether it read the track's last
        // sample or gave up on it: bytes that never came, a decoder closed
        // under it, a link that dropped mid-file. Believed, an ending a few
        // seconds into a long clip plays the rest of the cut in silence while
        // the picture reads happily past it — so an ending short of the clip
        // is a failed read, and another walk goes after the sound it did not
        // reach. Two things stop that running away: a walk that gets no
        // further than the one before it has found where the track really
        // stops, and a track that runs a fraction short of its picture is
        // inside the slack.
        if (sourceFrom >= live.out - END_SLACK_S || sourceFrom <= live.reached + 1e-3) {
          live.ended = true;
        } else {
          live.reached = sourceFrom;
          // A source that stopped answering mid-file is the one case a
          // re-mint cannot speak to, so this failure keeps to itself.
          this.miss(live, false);
        }
        return;
      }
      const tNow = this.at();
      if (!current() || live.scheduled !== from) return;
      const until = from + buffer.duration;
      if (until <= tNow) {
        this.noteLate(live, tNow - from);
        // The read outlived the moment it was for — a long wait on bytes, a
        // tab in the background. Where it left the walk is behind the clock
        // now, so the voice re-aims at the clock and gives up the stretch in
        // between; that stretch was going by either way.
        this.reaim(live, Math.max(live.scheduled, tNow));
        return;
      }
      const node = this.ctx.createBufferSource();
      node.buffer = buffer;
      node.connect(live.head);
      const at = this.anchor.ctx + (from - this.anchor.timeline);
      const now = this.ctx.currentTime;
      if (at >= now) {
        node.start(at);
      } else {
        // Late: start where the clock actually is, so the sound stays lined up
        // with the picture and skips what has already gone by.
        this.noteLate(live, now - at);
        node.start(now, now - at);
      }
      live.windows.push({ node, until });
      live.scheduled = until;
      live.attempts = 0;
    } catch {
      // Past the read, everything is scheduling: a context closed or swapped
      // under the voice while this group decoded. The source is fine, so the
      // voice spaces out its next attempt and keeps every one of its tries.
      this.backOff(live, 1);
    } finally {
      if (live.gen === gen) live.filling = false;
    }
  }

  /**
   * The next `GROUP_S` of a voice's sound, pulled off its walk.
   *
   * The walk is opened where the voice stands when it hasn't got one — the
   * first ask, or the first after something moved it — and kept open after
   * that, so a clip is one open file, one container parse and one decoder for
   * as long as it plays.
   */
  private async walkGroup(
    live: LiveVoice,
    sourceFrom: number,
    current: () => boolean,
    group: number
  ): Promise<AudioBuffer | null> {
    const walk = (live.walk ??= openAudioWalk(live.url, sourceFrom, live.out));
    // A walk outlives the read that opened it, so where it stands is its own
    // to say. Anything that moved it — a re-aim, a priming read taken before
    // the play began — is answered here rather than trusted.
    if (Math.abs(walk.position - sourceFrom) > 0.02) walk.seek(sourceFrom);
    const parts: WrappedAudioBuffer[] = [];
    let end = sourceFrom;
    // Bounded by the sound it holds and by the reads that go into it: a track
    // answering with buffers that carry no time would otherwise be pulled for
    // as long as the frame lasted.
    for (let pulls = 0; end - sourceFrom < group && pulls < GROUP_PULLS; pulls++) {
      const part = await walk.next();
      if (!current()) return null;
      if (!part) break;
      // The stall guard is about a source that stopped answering, and a walk
      // that is handing sound back has not: every part it delivers is the read
      // saying it is still there. Without this a cold open of a long file over
      // a slow link is disowned on the clock, re-opened from nothing, and
      // disowned again, and the voice never gets a group out.
      live.fillAt = performance.now();
      parts.push(part);
      end = part.timestamp + part.duration;
    }
    return assembleAudio(parts, sourceFrom, live.out);
  }

  /**
   * A window of a voice playing at a speed other than 1, re-laid at the length
   * the timeline gives it.
   *
   * Held briefly, because stepping back over a cut replays the same window and
   * everything older is a full decode away anyway.
   */
  private async stretchedWindow(live: LiveVoice, sourceFrom: number): Promise<AudioBuffer | null> {
    const sourceTo = Math.min(live.out, sourceFrom + WINDOW_STRETCHED_S * live.speed);
    const key = `${live.url}|${sourceFrom.toFixed(3)}|${sourceTo.toFixed(3)}|${live.speed}`;
    const held = this.decoded.get(key);
    if (held) return held;
    const raw = await decodeAudioSpan(live.url, sourceFrom, sourceTo);
    if (!raw) return null;
    const buffer = this.stretch(raw, 1 / live.speed);
    // Oldest first until the cache is back inside its share. Emptying the
    // whole cache would throw away the window the playhead is standing on along
    // with the ones it has finished, and the next frame would pay a full decode
    // for sound it was already holding.
    this.decoded.set(key, buffer);
    const cap = allowance("audio", STRETCH_CACHE_BYTES);
    let cached = decodedBytes(this.decoded);
    for (const [oldest, buf] of this.decoded) {
      if (cached <= cap || this.decoded.size <= 1) break;
      cached -= buf.length * buf.numberOfChannels * 4;
      this.decoded.delete(oldest);
    }
    return buffer;
  }

  /**
   * Move a voice up to the clock, keeping the file it is reading.
   *
   * A group that lands after the moment it was for is the ordinary shape of a
   * slow open: the file takes a few seconds to parse, and by the time the
   * first sound comes back the playhead has gone past it. Answering that by
   * giving up the walk starts the whole open again a second behind where it
   * just was, and again after that — the voice pays the open cost for the rest
   * of the play and never once catches the clock, which is a cut that plays
   * out in silence while the picture rolls on. The reader moves instead: same
   * file, same decoder, aimed where the sound is wanted.
   */
  private reaim(live: LiveVoice, timeline: number): void {
    live.gen++;
    live.filling = false;
    live.ended = false;
    live.scheduled = timeline;
    live.walk?.seek(live.in + (timeline - live.start) * live.speed);
  }

  /** A read that failed, came back empty, or stopped answering. The voice
   * gives up where it was, waits, and asks again — and asks for as long as the
   * play lasts. */
  private miss(live: LiveVoice, report = true): void {
    this.moved(live);
    live.attempts += 1;
    this.backOff(live, live.attempts);
    if (!report) return;
    // There is no element to reload and nothing else asks on the sound's
    // behalf, so a signed URL past its window would stay past it. The picture's
    // readers report their failed reads the same way; the re-mint that follows
    // swaps the store's URLs and every voice reopens under the new one.
    void import("./mediaLinks")
      .then((m) => m.reportMediaUrlError(live.url))
      .catch(() => {});
  }

  /** Hold the voice off until its next try, `step` failures in. */
  private backOff(live: LiveVoice, step: number): void {
    live.retryAt =
      performance.now() + (step <= READ_RETRIES ? READ_RETRY_MS * step : READ_RECHECK_MS);
  }

  /** Re-lay a buffer at a different length, keeping its pitch. */
  private stretch(buffer: AudioBuffer, factor: number): AudioBuffer {
    const channels: Float32Array[] = [];
    for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c));
    const out = timeStretch(channels, buffer.sampleRate, factor);
    const result = new AudioBuffer({
      length: Math.max(1, out[0]?.length ?? 1),
      numberOfChannels: Math.max(1, out.length),
      sampleRate: buffer.sampleRate,
    });
    // A fresh view per channel: `copyToChannel` wants a plain Float32Array,
    // and the stretch hands back views whose buffer type it declines.
    out.forEach((data, i) => result.copyToChannel(new Float32Array(data), i));
    return result;
  }
}
