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
 * own volume, its fades, the duck under a live voiceover, and the whole-project
 * fade. The ramps themselves are the frame plan's, so the mix follows the same
 * description the picture does.
 */

import { decodeAudioSpan } from "./mediaRead";
import { timeStretch } from "./timeStretch";

/** How much of a voice is decoded and scheduled at once, in timeline seconds. */
const WINDOW_S = 20;
/** A stretched window is resynthesised on the main thread, so it is kept short
 * enough that the work lands inside a frame or two. */
const WINDOW_STRETCHED_S = 4;
/** Schedule the next window once the playhead is this close to running out. */
const AHEAD_S = 2;

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
  /** Set when the source can't be read; the voice stays silent rather than
   * retrying every frame. */
  dead: boolean;
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
    }
    return this.ctx;
  }

  /**
   * Where the playhead is, from the sound's own clock.
   *
   * This is the whole point of the arrangement: the number the picture is drawn
   * against comes from the same clock the samples leave on, so they cannot
   * drift apart no matter what the main thread is doing.
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
    const audio = this.anchor.timeline + (this.ctx.currentTime - this.anchor.ctx);
    if (Math.abs(audio - wall) > 0.25) {
      this.anchor.ctx = this.ctx.currentTime - (wall - this.anchor.timeline);
      return wall;
    }
    return audio;
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
      if (!live.dead && !live.filling && live.scheduled < t + AHEAD_S) void this.fill(v.id, live);
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
    this.decoded.clear();
    void this.ctx?.close();
    this.ctx = null;
    this.master = null;
  }

  private open(v: Voice, t: number): LiveVoice | null {
    const ctx = this.ctx;
    if (!ctx || !this.master) return null;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    gain.connect(this.master);
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
        const raw = await decodeAudioSpan(live.url, sourceFrom, sourceTo);
        if (!raw) {
          live.dead = true;
          return;
        }
        buffer = stretched ? this.stretch(raw, 1 / live.speed) : raw;
        // A handful of windows is all that's worth keeping — stepping back over
        // a cut replays them, and everything older is a full decode away anyway.
        if (this.decoded.size > 24) this.decoded.clear();
        this.decoded.set(key, buffer);
      }
      // The mixer may have been stopped, or the voice dropped, while decoding.
      const still = this.voices.get(id);
      if (!still || still !== live || !this.anchor || !this.ctx) return;
      const node = this.ctx.createBufferSource();
      node.buffer = buffer;
      node.connect(live.gain);
      const at = this.anchor.ctx + (from - this.anchor.timeline);
      const now = this.ctx.currentTime;
      const until = from + buffer.duration;
      if (until <= this.now()) {
        // The decode outlived the window it was for — a long read, or a tab
        // that was in the background. Skip it and let the next fill catch up.
        live.scheduled = Math.max(live.scheduled, this.now());
        return;
      }
      if (at >= now) {
        node.start(at);
      } else {
        // Late: start where the clock actually is, so the sound stays lined up
        // with the picture instead of replaying what has already gone by.
        node.start(now, now - at);
      }
      live.windows.push({ node, until });
      live.scheduled = until;
    } catch {
      live.dead = true;
    } finally {
      live.filling = false;
    }
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
