import { describe, expect, mock, test } from "bun:test";
import { retimeOf } from "@donkeycut/effects-kit";
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
/** How much of the file is already here when a case starts. */
let headStart = HEAD_START_S;

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
  private span: Played | null = null;
  connect() {}
  disconnect() {}
  start(when: number, offset = 0) {
    const length = (this.buffer?.duration ?? 0) - offset;
    if (length > 0) {
      this.span = { from: when, to: when + length };
      played.push(this.span);
    }
  }
  /** Stopping a scheduled source silences what it had not played yet, so what
   * was heard ends here — the difference between a voice let alone and a voice
   * taken down mid-sound. */
  stop() {
    if (this.span) this.span.to = Math.max(this.span.from, Math.min(this.span.to, ctxTime));
  }
}

/** While the wall is short of this, a suspended context refuses to come back —
 * an output device being switched, a tab the browser has put down. */
let resumeBlockedUntil = 0;
let liveCtx: FakeContext | null = null;

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
    if (wall >= resumeBlockedUntil) this.state = "running";
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

/** What the first read off a newly opened walk costs before it answers: a
 * container parsed from nothing over the link. A voice that reopens mid-play
 * pays it; one that keeps its reader does not. */
let openCostS = 0;

const waiting: { at: number; wake: () => void }[] = [];

/** Resolves `seconds` of wall time from now. */
function after(seconds: number): Promise<void> {
  if (seconds <= 0) return Promise.resolve();
  return new Promise((wake) => waiting.push({ at: wall + seconds, wake }));
}

/** Resolves once the link has delivered the file as far as `sourceTime`. */
function delivered(sourceTime: number): Promise<void> {
  const at = Math.max(0, (sourceTime - headStart) / LINK_RATE);
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
  const cost = openCostS;
  let opened = false;
  let pos = from;
  let closed = false;
  let done = false;
  return {
    async next() {
      if (closed || done) return null;
      if (!opened) {
        opened = true;
        await after(cost);
        if (closed) return null;
      }
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
    get position() {
      return pos;
    },
    seek(next: number) {
      pos = next;
      done = false;
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
  // The graph's clock is the context's, and a context that is not running does
  // not keep one.
  if (liveCtx?.state === "running") ctxTime += FRAME_S;
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
  retime: retimeOf({ in: 0, out: CLIP_S, speed: 1 }),
  gain: 1,
};

/** Put every control back where a case starts. */
function reset(file: { endEarlyAt?: number; trackEnd?: number } = {}): void {
  wall = 0;
  ctxTime = 0;
  resumes = 0;
  played = [];
  waiting.length = 0;
  walks.opened = 0;
  reMints.asked = 0;
  failUntil = 0;
  hangUntil = 0;
  openCostS = 0;
  resumeBlockedUntil = 0;
  headStart = HEAD_START_S;
  liveCtx = null;
  endEarlyAt = file.endEarlyAt ?? Infinity;
  trackEnd = file.trackEnd ?? CLIP_S;
  voice.url = "clip.mp4";
}

/** Play the clip through, running `during` on each frame at the timeline time
 * it is drawing. Answers what was heard. */
async function play(
  during?: (t: number, ctx: FakeContext) => void,
  file: {
    endEarlyAt?: number;
    trackEnd?: number;
    /** Frames the cut has nothing to show on: the clock is held rather than
     * carried, which is what the engine does with a stalled picture. */
    holdWhile?: (t: number) => boolean;
  } = {}
): Promise<Played[]> {
  reset(file);
  const mixer = new PreviewMixer();
  mixer.start(0);
  liveCtx = (mixer as unknown as { ctx: FakeContext }).ctx;
  try {
    for (let t = 0; t < CLIP_S; ) {
      step();
      t = Math.min(mixer.now(), CLIP_S);
      during?.(t, (mixer as unknown as { ctx: FakeContext }).ctx);
      if (file.holdWhile?.(t)) mixer.hold(t);
      else mixer.update(t, [voice]);
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

  test("catches the clock up after an open that took seconds", async () => {
    // The failure this is here for, and the shape every report of it took: the
    // sound plays, stops somewhere in the first minute, and never comes back
    // while the picture rolls on to the end. One read fails, the walk that
    // replaces it takes a few seconds to parse the file, and the sound it
    // finally brings back is for a moment that has gone by — so the voice
    // gives the walk up, opens another, and is late again by exactly as much.
    // It pays the open for the rest of the play and never catches the clock.
    const sound = await play((t) => {
      if (t < 20) return;
      openCostS = 5;
      if (t < 21) failUntil = 21;
    });
    expect(heard(sound, 0, 18)).toBeGreaterThan(0.9);
    expect(heard(sound, 32, CLIP_S)).toBeGreaterThan(0.95);
    // One open answered for; the walk is re-aimed after that, not replaced.
    expect(walks.opened).toBeLessThan(4);
  });

  test("plays on when the same sound moves to a new address", async () => {
    // The failure this is here for: a clip dragged in from the library plays
    // from the library's own URL while its bytes are copied into the project
    // behind the editor, and the asset moves to the stored file the moment
    // they land — mid-play, without a note of the sound changing. Taking the
    // voice down there stops what was already scheduled and puts the sound
    // out for as long as a cold open of a long file takes.
    const sound = await play((t) => {
      if (t < 20) return;
      openCostS = 5;
      voice.url = "landed.mp4";
    });
    // What the voice had already read plays out across the swap. It is the
    // reader that moves, and it moves while that sound is playing. The lead in
    // hand at the move is at least the lookahead less the group a fill was
    // mid-extension on, so the second past it is the guaranteed part.
    expect(heard(sound, 18, 21)).toBeGreaterThan(0.95);
    expect(heard(sound, 30, CLIP_S)).toBeGreaterThan(0.95);
    // The new address is read by a walk of its own; the old one is let go.
    expect(walks.opened).toBe(2);
  });

  test("stands still while the cut has nothing to show", async () => {
    // A play whose picture has decoded nothing has nothing to play. Carrying
    // the clock through it spends a stretch of the cut nobody saw or heard and
    // lands somewhere further on when the file opens; the sound plays on over
    // a picture that is not moving. The clock stops instead, and the play
    // carries on from where it stopped.
    const held: number[] = [];
    const sound = await play(undefined, {
      holdWhile: (t) => {
        const stalled = t >= 20 && wall < 27;
        if (stalled) held.push(t);
        return stalled;
      },
    });
    // Seven seconds of wall went by and the playhead stayed where it was.
    expect(held.length).toBeGreaterThan(100);
    expect(Math.max(...held) - Math.min(...held)).toBeLessThan(0.3);
    // Nothing plays on over a picture standing still.
    expect(heard(sound, 22, 26)).toBe(0);
    // And the cut picks up where it stopped rather than further on.
    expect(heard(sound, 27, 40)).toBeGreaterThan(0.9);
  });

  test("a play's first sound is not a whole group away", async () => {
    // The failure this is here for: the picture opens on a frame it already
    // holds while the sound assembles a whole group before scheduling its
    // first window, so a play or a landed seek starts with the picture moving
    // and the sound a group-read behind it. From a standing start the first
    // window is short, and the sound joins the first frame.
    reset();
    headStart = 0.6; // the head of the file is here; a whole group is not
    const mixer = new PreviewMixer();
    mixer.start(0);
    liveCtx = (mixer as unknown as { ctx: FakeContext }).ctx;
    for (let i = 0; i < 30; i++) {
      step();
      mixer.update(Math.min(mixer.now(), CLIP_S), [voice]);
      await settle();
    }
    mixer.dispose();
    expect(played.length).toBeGreaterThan(0);
    expect(Math.min(...played.map((p) => p.from))).toBeLessThan(0.4);
    expect(walks.opened).toBe(1);
  });

  test("a seek keeps its reader and lands with its sound", async () => {
    // The failure this is here for: picking a position mid-play re-anchors the
    // clock, and a voice that gave up its walk there paid a fresh open — a
    // container parsed out of a long file — before the first window after the
    // seek, so the picture jumped and the sound came in seconds later.
    reset();
    headStart = CLIP_S; // the link is not the subject; the reader is
    const mixer = new PreviewMixer();
    mixer.start(0);
    liveCtx = (mixer as unknown as { ctx: FakeContext }).ctx;
    for (let i = 0; i < 20; i++) {
      step();
      mixer.update(Math.min(mixer.now(), CLIP_S), [voice]);
      await settle();
    }
    // Opening a file costs seconds from here on; a voice that keeps its
    // reader never pays it.
    openCostS = 5;
    played = [];
    mixer.start(10);
    const pressed = ctxTime;
    for (let i = 0; i < 20; i++) {
      step();
      mixer.update(Math.min(mixer.now(), CLIP_S), [voice]);
      await settle();
    }
    mixer.dispose();
    expect(played.length).toBeGreaterThan(0);
    expect(Math.min(...played.map((p) => p.from)) - pressed).toBeLessThan(0.5);
    // The file it read after the seek was the one it already had open.
    expect(walks.opened).toBe(1);
  });

  test("a hold pays the sound's open before it releases", async () => {
    // A play held for a picture still opening used to leave the sound waiting
    // too: nothing read during the hold, and the release paid the file's open
    // before the first window. The hold primes each voice at the held moment,
    // so the open runs beside the picture's and the release finds both ready.
    reset();
    headStart = CLIP_S;
    const mixer = new PreviewMixer();
    mixer.start(0);
    liveCtx = (mixer as unknown as { ctx: FakeContext }).ctx;
    for (let i = 0; i < 20; i++) {
      step();
      mixer.update(Math.min(mixer.now(), CLIP_S), [voice]);
      await settle();
    }
    // What an outage leaves behind: the reader given up, the voice backed
    // off on the long cadence.
    const live = (
      mixer as unknown as {
        voices: Map<string, { walk: { close(): void } | null; retryAt: number }>;
      }
    ).voices.get("clip")!;
    live.walk?.close();
    live.walk = null;
    live.retryAt = performance.now() + 10_000;
    const opens = walks.opened;
    // The picture stalls; opening the sound's file costs seconds now.
    openCostS = 3;
    played = [];
    const holdUntil = wall + 4;
    let first = true;
    while (wall < holdUntil) {
      step();
      mixer.hold(Math.min(mixer.now(), CLIP_S));
      await settle();
      // Entering the hold is what primes: the walk opens there, during it.
      if (first) {
        first = false;
        expect(walks.opened).toBe(opens + 1);
      }
    }
    expect(played.length).toBe(0); // a hold schedules nothing
    const released = ctxTime;
    for (let i = 0; i < 20; i++) {
      step();
      mixer.update(Math.min(mixer.now(), CLIP_S), [voice]);
      await settle();
    }
    mixer.dispose();
    expect(played.length).toBeGreaterThan(0);
    expect(Math.min(...played.map((p) => p.from)) - released).toBeLessThan(0.5);
  });

  test("has the file open before the play begins", async () => {
    // The failure this is here for: the picture starts on the frame and the
    // sound comes in seconds after it, worst right after a seek. The sound
    // opened its file once the clock was already running — a container parsed,
    // a decoder configured, a seek into the middle of a long file — while the
    // picture had had a decoder open on that clip the whole time it was parked
    // there. The playhead standing over a clip is the notice the sound needs.
    reset();
    openCostS = 5;
    headStart = CLIP_S; // the link is not the subject here; the open is
    const mixer = new PreviewMixer();
    // A page that has played once has a context; warming waits for one.
    mixer.start(0);
    liveCtx = (mixer as unknown as { ctx: FakeContext }).ctx;
    mixer.stop();
    // Parked at 0:40, six seconds of frames going by.
    for (let i = 0; i < 160; i++) {
      step();
      mixer.warm(40, [voice]);
      await settle();
    }
    played = [];
    const pressed = ctxTime;
    mixer.start(40);
    for (let i = 0; i < 40; i++) {
      step();
      mixer.update(Math.min(mixer.now(), CLIP_S), [voice]);
      await settle();
    }
    mixer.dispose();
    expect(played.length).toBeGreaterThan(0);
    // Sound within a couple of frames of the press, not a cold open later.
    expect(Math.min(...played.map((p) => p.from)) - pressed).toBeLessThan(0.5);
    // The file it read was the one it already had open.
    expect(walks.opened).toBe(1);
  });

  test("keeps its readers when the clock jumps", async () => {
    // A context that sat suspended — an output device switched, a tab the
    // browser put down — comes back with its clock seconds behind the wall,
    // and every voice is re-aimed at where the playhead now is. They are in
    // the same files they were reading a moment ago, so they keep them.
    const sound = await play((t, ctx) => {
      if (t < 20 || t > 20.1) return;
      ctx.state = "suspended";
      resumeBlockedUntil = wall + 5;
    });
    expect(heard(sound, 0, 18)).toBeGreaterThan(0.9);
    // The context's clock stood still while it was down, so what is heard from
    // here on runs that much behind the timeline; it is unbroken either way.
    expect(heard(sound, 28, 60)).toBeGreaterThan(0.95);
    // One file, one container parse: the jump moved the reader, it did not
    // cost a new one.
    expect(walks.opened).toBe(1);
  });

  test("picks its context back up when the browser puts it down", async () => {
    const sound = await play((t, ctx) => {
      if (t >= 20 && t < 20.1) ctx.state = "suspended";
    });
    expect(resumes).toBeGreaterThan(1);
    expect(heard(sound, 25, CLIP_S)).toBeGreaterThan(0.9);
  });
});
