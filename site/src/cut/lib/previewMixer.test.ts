import { describe, expect, mock, test } from "bun:test";
import { AudioBuffer } from "node-web-audio-api";

/**
 * The preview's sound, against a link that only just keeps up.
 *
 * This is how a cloud project actually plays: the file arrives over
 * the network at about the rate it is watched, a little of it already here.
 * Every case below plays a single long clip through and measures the one thing
 * a listener measures — how much of the cut made a sound — because every way
 * this has failed looked identical from outside. The picture went on playing
 * and the sound stopped, once, for good.
 */

const RATE = 48_000;
/** How much source audio one read off the walk hands back. */
const PART_S = 0.2;
const CLIP_S = 70;
/** The link: bytes arrive at the rate the clip plays, with a little of the
 * file already resident when playback starts. A voice that has to read far
 * ahead of the playhead can never be satisfied here; one that reads where the
 * picture reads is comfortable. */
const LINK_RATE = 1;
const HEAD_START_S = 2.5;

// ── the clock everything shares ─────────────────────────────────────────────
let wall = 0;
let ctxTime = 0;
let resumes = 0;
const globals = globalThis as Record<string, unknown>;
globals.AudioBuffer ??= AudioBuffer;
globals.performance = { now: () => wall * 1000 } as Performance;

// ── the sound leaving the graph ─────────────────────────────────────────────
interface Played {
  from: number;
  to: number;
}
let played: Played[] = [];

class FakeGain {
  gain = { value: 0 };
  connect() {}
  disconnect() {}
}

class FakeSource {
  buffer: { duration: number } | null = null;
  connect() {}
  disconnect() {}
  start(when: number, offset = 0) {
    const length = (this.buffer?.duration ?? 0) - offset;
    if (length > 0) played.push({ from: when, to: when + length });
  }
  stop() {}
}

class FakeContext {
  state = "running";
  baseLatency = 0;
  outputLatency = 0;
  destination = {};
  get currentTime() {
    return ctxTime;
  }
  createGain() {
    return new FakeGain();
  }
  createBufferSource() {
    return new FakeSource();
  }
  resume() {
    resumes++;
    this.state = "running";
    return Promise.resolve();
  }
  close() {
    return Promise.resolve();
  }
}
globals.AudioContext = FakeContext;

// ── the file, arriving over the link ────────────────────────────────────────
/** Reads that throw, and reads that never answer, over a stretch of wall time. */
let failUntil = 0;
let hangUntil = 0;
/** A walk that reports itself over before the track really is — bytes that
 * never came, a decoder closed under it. Spent the first time it fires. */
let endEarlyAt = Infinity;
/** Where the track truly stops, which can be short of the clip. */
let trackEnd = CLIP_S;

const waiting: { at: number; wake: () => void }[] = [];

/** Resolves once the link has delivered the file as far as `sourceTime`. */
function delivered(sourceTime: number): Promise<void> {
  const at = Math.max(0, (sourceTime - HEAD_START_S) / LINK_RATE);
  if (wall >= at) return Promise.resolve();
  return new Promise((wake) => waiting.push({ at, wake }));
}

const walks = { opened: 0 };

const openAudioWalk = (_url: string, from: number, to?: number) => {
  walks.opened++;
  const end = to ?? CLIP_S;
  // This walk's own false ending, spent on opening: a walk that gives up stays
  // given up, and the walk sent after it reads the file properly.
  const givesUpAt = endEarlyAt;
  endEarlyAt = Infinity;
  let pos = from;
  let closed = false;
  let done = false;
  return {
    async next() {
      if (closed || done) return null;
      if (wall < hangUntil) return new Promise<null>(() => {});
      await delivered(pos + PART_S);
      if (closed) return null;
      if (wall < failUntil) throw new Error("the link dropped");
      if (pos >= givesUpAt) {
        done = true;
        return null;
      }
      if (pos >= Math.min(end, trackEnd) - 1e-6) return null;
      const duration = Math.min(PART_S, end - pos);
      const part = {
        buffer: new AudioBuffer({
          length: Math.round(duration * RATE),
          numberOfChannels: 1,
          sampleRate: RATE,
        }),
        timestamp: pos,
        duration,
      };
      pos += duration;
      return part;
    },
    close() {
      closed = true;
    },
  };
};

const assembleAudio = (
  parts: { timestamp: number; duration: number }[],
  from: number,
  to?: number
) => {
  if (parts.length === 0) return null;
  const last = parts[parts.length - 1];
  const end = Math.min(to ?? Infinity, last.timestamp + last.duration);
  return new AudioBuffer({
    length: Math.max(1, Math.round((end - from) * RATE)),
    numberOfChannels: 1,
    sampleRate: RATE,
  });
};

const reMints = { asked: 0 };

/** A span asked for in one go, which the link cannot answer until it has
 * delivered the file as far as the span's end. */
const decodeAudioSpan = async (_url: string, from: number, to: number) => {
  await delivered(to);
  if (wall < failUntil) throw new Error("the link dropped");
  if (from >= CLIP_S - 1e-6) return null;
  const end = Math.min(to, CLIP_S);
  return new AudioBuffer({
    length: Math.max(1, Math.round((end - from) * RATE)),
    numberOfChannels: 1,
    sampleRate: RATE,
  });
};

// Only the reads are stood in for. A module mock replaces the whole module for
// every test file in the run, so the rest of each one is carried through as it
// really is.
const media = await import("./mediaRead");
const links = await import("./mediaLinks");
mock.module("./mediaRead", () => ({ ...media, openAudioWalk, assembleAudio, decodeAudioSpan }));
mock.module("./mediaLinks", () => ({
  ...links,
  reportMediaUrlError: () => {
    reMints.asked++;
  },
}));

const { PreviewMixer } = await import("./previewMixer");

// ── driving a play ──────────────────────────────────────────────────────────
const FRAME_S = 0.05;

/** Let everything the frame set going settle before the clock moves again. */
async function settle(): Promise<void> {
  for (let i = 0; i < 32; i++) await Promise.resolve();
}

function step(): void {
  wall += FRAME_S;
  ctxTime += FRAME_S;
  for (const w of waiting.splice(0)) {
    if (w.at <= wall) w.wake();
    else waiting.push(w);
  }
}

const voice = {
  id: "clip",
  url: "clip.mp4",
  start: 0,
  in: 0,
  out: CLIP_S,
  speed: 1,
  gain: 1,
};

/** Play the clip through, running `during` on each frame at the timeline time
 * it is drawing. Answers what was heard. */
async function play(
  during?: (t: number, ctx: FakeContext) => void,
  file: { endEarlyAt?: number; trackEnd?: number } = {}
): Promise<Played[]> {
  wall = 0;
  ctxTime = 0;
  resumes = 0;
  played = [];
  waiting.length = 0;
  walks.opened = 0;
  reMints.asked = 0;
  failUntil = 0;
  hangUntil = 0;
  endEarlyAt = file.endEarlyAt ?? Infinity;
  trackEnd = file.trackEnd ?? CLIP_S;
  const mixer = new PreviewMixer();
  mixer.start(0);
  try {
    for (let t = 0; t < CLIP_S; ) {
      step();
      t = Math.min(mixer.now(), CLIP_S);
      during?.(t, (mixer as unknown as { ctx: FakeContext }).ctx);
      mixer.update(t, [voice]);
      await settle();
    }
  } finally {
    mixer.dispose();
  }
  return played;
}

/** How much of `[from, to)` made a sound. */
function heard(sound: Played[], from: number, to: number): number {
  const spans = sound
    .map((p) => ({ from: Math.max(from, p.from), to: Math.min(to, p.to) }))
    .filter((p) => p.to > p.from)
    .sort((a, b) => a.from - b.from);
  let covered = 0;
  let at = from;
  for (const s of spans) {
    if (s.to <= at) continue;
    covered += s.to - Math.max(at, s.from);
    at = s.to;
  }
  return covered / (to - from);
}

describe("the preview's sound over a link that only just keeps up", () => {
  test("plays the whole clip through", async () => {
    const sound = await play();
    // The failure this is here for is a cut that sounds for its first stretch
    // and then plays out in silence, so the end of it is what matters.
    expect(heard(sound, 0, CLIP_S)).toBeGreaterThan(0.95);
    expect(heard(sound, CLIP_S - 20, CLIP_S)).toBeGreaterThan(0.95);
    // One file, one reader: a walk is opened once and kept.
    expect(walks.opened).toBe(1);
  });

  test("comes back from a long outage", async () => {
    const sound = await play((t) => {
      if (t >= 20 && t < 45) failUntil = 45;
    });
    expect(heard(sound, 0, 18)).toBeGreaterThan(0.9);
    expect(heard(sound, 50, CLIP_S)).toBeGreaterThan(0.9);
    // A read that fails has no element to reload; only a re-mint heals a URL
    // past its signing window, so the voice asks for one.
    expect(reMints.asked).toBeGreaterThan(0);
  });

  test("disowns a read that stops answering", async () => {
    const sound = await play((t) => {
      if (t >= 20 && t < 30) hangUntil = 30;
    });
    expect(heard(sound, 0, 18)).toBeGreaterThan(0.9);
    expect(heard(sound, 50, CLIP_S)).toBeGreaterThan(0.9);
  });

  test("goes after the sound a walk stopped short of", async () => {
    // The failure this is here for: a walk reports the same ending whether it
    // read the track's last sample or gave up on it, and a voice that believes
    // an ending five seconds into a long clip plays the rest of it in silence.
    const sound = await play(undefined, { endEarlyAt: 5 });
    expect(heard(sound, 0, 5)).toBeGreaterThan(0.9);
    expect(heard(sound, 10, CLIP_S)).toBeGreaterThan(0.9);
    expect(walks.opened).toBeGreaterThan(1); // it went back for the rest
  });

  test("believes an ending two walks agree on", async () => {
    // A track really can stop before the picture does. One walk goes back for
    // what it missed; a second that gets no further has found the end.
    const sound = await play(undefined, { trackEnd: 30 });
    expect(heard(sound, 0, 29)).toBeGreaterThan(0.9);
    expect(heard(sound, 32, CLIP_S)).toBe(0);
    expect(walks.opened).toBeLessThan(4);
  });

  test("picks its context back up when the browser puts it down", async () => {
    const sound = await play((t, ctx) => {
      if (t >= 20 && t < 20.1) ctx.state = "suspended";
    });
    expect(resumes).toBeGreaterThan(1);
    expect(heard(sound, 25, CLIP_S)).toBeGreaterThan(0.9);
  });
});
