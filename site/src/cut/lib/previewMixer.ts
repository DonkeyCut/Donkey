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
 * rather than the other way round. Clips are scheduled a window at a time so
 * starting playback costs one short decode instead of the whole timeline, and a
 * clip playing at a speed other than 1 is time-stretched rather than resampled,
 * which is what keeps its pitch and matches what the export writes.
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

import { audioFxRecipe, buildAudioFx, type AudioFxNodes } from "@donkeycut/effects-kit";
import { decodeAudioSpan } from "./mediaRead";
import { timeStretch } from "./timeStretch";

/** How much of a voice is decoded and scheduled at once, in timeline seconds. */
const WINDOW_S = 20;
/** A stretched window is resynthesised on the main thread, so it is kept short
 * enough that the work lands inside a frame or two. */
const WINDOW_STRETCHED_S = 4;
/** Schedule the next window once the playhead is this close to running out. */
const AHEAD_S = 2;
/** Most the picture will be held back for the output device, whatever the
 * device claims. Well past a Bluetooth headset, and short of anything that
 * would read as the playhead refusing to move. */
const MAX_LATENCY_S = 0.4;

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
  gain: GainNode;
  /** Windows already handed to the context, oldest first. */
  windows: Scheduled[];
  /** Timeline time everything scheduled so far runs out at. */
  scheduled: number;
  /** A decode in flight, so a slow read doesn't start a second one. */
  filling: boolean;
  /** Set when the voice has run off the end of its source, or its source has
   * refused enough times to stop asking. */
  dead: boolean;
  /** Consecutive failed reads. A file that has just been imported is often
   * unreadable for a moment — the bytes are still going to storage, the
   * signed URL has not been minted — and a voice that gave up on the first
   * miss stayed silent for the life of the page. */
  misses: number;
  /** Wall time (performance.now) the next read may be attempted at. */
  retryAt: number;
}

/** How many times a voice re-reads a source that will not answer before it
 * gives up, and the backoff between tries. Six tries spans about half a
 * minute, which covers an import landing behind the playhead. */
const READ_RETRIES = 6;
const RETRY_BASE_MS = 400;
const RETRY_MAX_MS = 8_000;

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
  /** Timeline time, context time and wall time of the same instant. Everything
   * scheduled is placed against this. */
  private anchor: { timeline: number; ctx: number; wall: number } | null = null;
  private decoded = new Map<string, AudioBuffer>();

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
      this.restart(wall);
      return this.heard(wall);
    }
    return this.heard(graph);
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

  /** Stop every scheduled window and mark each voice to refill at `timeline`. */
  private restart(timeline: number): void {
    for (const live of this.voices.values()) {
      for (const w of live.windows) {
        try {
          w.node.stop();
        } catch {
          // Already finished; stopping a spent node throws and means nothing.
        }
        w.node.disconnect();
      }
      live.windows = [];
      live.scheduled = Math.max(live.start, timeline);
    }
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
    this.stopVoices();
    this.anchor = { timeline: t, ctx: ctx.currentTime, wall: performance.now() };
  }

  /** Stop the clock and silence everything. */
  stop(): void {
    this.anchor = null;
    this.stopVoices();
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
    const seen = new Set<string>();
    for (const v of voices) {
      seen.add(v.id);
      // An edit to a playing clip arrives as the same id with new geometry — a
      // trim, a move, a speed change, a re-minted URL. Gain is the only part of
      // a voice that tunes live; everything else is baked into what was already
      // scheduled, so the voice reopens and the sound follows the edit the way
      // the picture does.
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
      live.gain.gain.value = Math.max(0, Math.min(1.5, v.gain));
      if (
        !live.dead &&
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

  /** Drop the decode cache for a source that has been replaced. */
  forget(url: string): void {
    for (const key of [...this.decoded.keys()]) {
      if (key.startsWith(`${url}|`)) this.decoded.delete(key);
    }
  }

  dispose(): void {
    this.stop();
    this.teardownFx();
    this.fxKey = "";
    this.decoded.clear();
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
    const live: LiveVoice = {
      url: v.url,
      speed: v.speed,
      in: v.in,
      out: v.out,
      start: v.start,
      gain,
      windows: [],
      // Scheduling begins where the playhead is: a voice opened mid-clip —
      // playback started inside it, or the clip edited while audible — decodes
      // from the moment it is heard, not from a head nobody will hear.
      scheduled: Math.max(v.start, t),
      filling: false,
      dead: false,
      misses: 0,
      retryAt: 0,
    };
    this.voices.set(v.id, live);
    return live;
  }

  private release(live: LiveVoice): void {
    for (const w of live.windows) {
      try {
        w.node.stop();
      } catch {
        // Already finished; stopping a spent node throws and means nothing.
      }
      w.node.disconnect();
    }
    live.windows = [];
    live.gain.disconnect();
  }

  private stopVoices(): void {
    for (const live of this.voices.values()) this.release(live);
    this.voices.clear();
  }

  /**
   * Decode and schedule the next window of one voice.
   *
   * The window is measured in timeline seconds and the source span behind it
   * scales with the clip's speed, so a clip at 2× reads twice as much file to
   * fill the same stretch of timeline.
   */
  private async fill(id: string, live: LiveVoice): Promise<void> {
    if (!this.ctx || !this.anchor) return;
    live.filling = true;
    try {
      const stretched = Math.abs(live.speed - 1) > 1e-3;
      const span = stretched ? WINDOW_STRETCHED_S : WINDOW_S;
      const from = live.scheduled;
      const sourceFrom = live.in + (from - live.start) * live.speed;
      if (sourceFrom >= live.out - 1e-3) {
        live.dead = true;
        return;
      }
      const sourceTo = Math.min(live.out, sourceFrom + span * live.speed);
      const key = `${live.url}|${sourceFrom.toFixed(3)}|${sourceTo.toFixed(3)}|${live.speed}`;
      let buffer = this.decoded.get(key) ?? null;
      if (!buffer) {
        // The read is the only part of this that says anything about the
        // source, so it is the only part a miss is spent on.
        const raw = await decodeAudioSpan(live.url, sourceFrom, sourceTo).catch(() => null);
        if (!raw) {
          this.miss(live);
          return;
        }
        buffer = stretched ? this.stretch(raw, 1 / live.speed) : raw;
        // A handful of windows is all that's worth keeping — stepping back over
        // a cut replays them, and everything older is a full decode away anyway.
        if (this.decoded.size > 24) this.decoded.clear();
        this.decoded.set(key, buffer);
      }
      // The mixer may have been stopped, or the voice dropped, while decoding.
      if (this.voices.get(id) !== live || !this.anchor || !this.ctx) return;
      // Reading the clock can restart the voices (`restart`), so it happens
      // before the placement below is computed — and a restarted voice, moved
      // to a different position while this window decoded, abandons it.
      const tNow = this.now();
      if (live.scheduled !== from) return;
      const until = from + buffer.duration;
      if (until <= tNow) {
        // The decode outlived the window it was for — a long read, or a tab
        // that was in the background. Skip it and let the next fill catch up.
        live.scheduled = Math.max(live.scheduled, tNow);
        return;
      }
      const node = this.ctx.createBufferSource();
      node.buffer = buffer;
      node.connect(live.gain);
      const at = this.anchor.ctx + (from - this.anchor.timeline);
      const now = this.ctx.currentTime;
      if (at >= now) {
        node.start(at);
      } else {
        // Late: start where the clock actually is, so the sound stays lined up
        // with the picture instead of replaying what has already gone by.
        node.start(now, now - at);
      }
      live.windows.push({ node, until });
      live.scheduled = until;
      live.misses = 0;
    } catch {
      // Past the read, everything is scheduling: a context closed or swapped
      // under the voice while this window decoded. The source is fine, so the
      // voice spaces out its next attempt and keeps every one of its reads.
      this.backOff(live, live.misses + 1);
    } finally {
      live.filling = false;
    }
  }

  /** A read that came back empty or threw. The source may simply not be there
   * yet — a just-imported file still on its way to storage — so the voice
   * waits and asks again, and stays silent only once its tries are spent. */
  private miss(live: LiveVoice): void {
    live.misses += 1;
    if (live.misses >= READ_RETRIES) {
      live.dead = true;
      return;
    }
    this.backOff(live, live.misses);
  }

  /** Hold the voice off until the next attempt, `step` failures in. */
  private backOff(live: LiveVoice, step: number): void {
    live.retryAt =
      performance.now() + Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.max(0, step - 1));
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
