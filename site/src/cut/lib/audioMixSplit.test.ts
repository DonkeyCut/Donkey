import { describe, expect, test } from "bun:test";
import { stubModule } from "@/lib/testing/stubModule";
import { AudioBuffer, OfflineAudioContext } from "node-web-audio-api";

// Where the offline fold lands a clip's sound when it leaves its picture: a
// split edit reaching past either edge, and a recording bound to the video.
// Each file reads back silence with one click at a source second of its own,
// so where the click lands in the mix says exactly which source second played
// at which timeline second.
const RATE = 44100;

const globals = globalThis as Record<string, unknown>;
globals.AudioBuffer ??= AudioBuffer;
globals.OfflineAudioContext ??= OfflineAudioContext;

/** Each file's click, in its own source seconds, and its length. */
const FILES: Record<string, { click?: number; duration: number }> = {
  "quiet.mp4": { duration: 60 },
  "lead.mp4": { click: 4.8, duration: 60 },
  "tail.mp4": { click: 4.3, duration: 60 },
  "cam.mp4": { click: 12, duration: 60 },
  "rec.wav": { click: 8.5, duration: 60 },
  "late.wav": { click: 1, duration: 60 },
  "layer.mp4": { click: 4.7, duration: 60 },
};

await stubModule<typeof import("./mediaRead")>("./mediaRead", import.meta.url, {
  decodeAudioSpan: (async (file: string, from: number, to: number) => {
    const f = FILES[file];
    const lo = Math.max(0, from);
    const hi = Math.min(f.duration, to);
    const buf = new AudioBuffer({ length: Math.max(1, Math.round((hi - lo) * RATE)), numberOfChannels: 1, sampleRate: RATE });
    if (f.click !== undefined && f.click >= lo && f.click < hi) {
      const at = Math.round((f.click - lo) * RATE);
      const ch = buf.getChannelData(0);
      for (let i = 0; i < 32 && at + i < ch.length; i++) ch[at + i] = 1;
    }
    return buf;
  }) as never,
});

const { renderMix } = await import("./audioMix");
type Spec = Parameters<typeof renderMix>[0];

const render = async (spec: Spec) => {
  const buffer = await renderMix(spec, { sampleRate: RATE, channels: 1, resolve: (f) => f });
  expect(buffer).not.toBeNull();
  return buffer!.getChannelData(0);
};

/** The timeline second the click starts at, or null when none sounds. */
const clickAt = (data: Float32Array) => {
  for (let i = 0; i < data.length; i++) if (Math.abs(data[i]) > 0.5) return i / RATE;
  return null;
};

const near = (got: number | null, want: number) => {
  expect(got).not.toBeNull();
  expect(Math.abs(got! - want)).toBeLessThan(2 / RATE);
};

describe("split edits in the offline fold", () => {
  test("a J-cut plays the incoming clip's sound ahead of its picture", async () => {
    // b's picture starts at 4 on source 5; its sound leads by half a second,
    // so source 4.8 plays at 3.8 — over a's picture.
    const mix = await render({
      duration: 8,
      clips: [
        { file: "quiet.mp4", in: 0, out: 4, muted: false },
        { file: "lead.mp4", in: 5, out: 9, muted: false, soundLead: 0.5, soundBack: 0.5, splitFade: 0.03 },
      ],
      items: [],
    });
    near(clickAt(mix), 3.8);
  });

  test("the lead's ramp starts it from silence", async () => {
    // A click inside the ramp: 0.01 s into a 0.03 s fade plays at a third.
    FILES["ramp.mp4"] = { click: 4.51, duration: 60 };
    const mix = await render({
      duration: 8,
      clips: [
        { file: "quiet.mp4", in: 0, out: 4, muted: false },
        { file: "ramp.mp4", in: 5, out: 9, muted: false, soundLead: 0.5, soundBack: 0.5, splitFade: 0.03 },
      ],
      items: [],
    });
    const at = Math.round(3.51 * RATE);
    expect(mix[at]).toBeGreaterThan(0.25);
    expect(mix[at]).toBeLessThan(0.42);
  });

  test("an L-cut carries the outgoing clip's sound past its picture", async () => {
    // a's picture ends at 4 on source 4; its sound runs on, so source 4.3
    // plays at 4.3 — under b's picture.
    const mix = await render({
      duration: 8,
      clips: [
        { file: "tail.mp4", in: 0, out: 4, muted: false, soundTail: 0.5, soundAhead: 0.5, splitFade: 0.03 },
        { file: "quiet.mp4", in: 0, out: 4, muted: false },
      ],
      items: [],
    });
    near(clickAt(mix), 4.3);
  });

  test("without a split edit the trimmed-away sound stays silent", async () => {
    const mix = await render({
      duration: 8,
      clips: [
        { file: "tail.mp4", in: 0, out: 4, muted: false },
        { file: "lead.mp4", in: 5, out: 9, muted: false },
      ],
      items: [],
    });
    expect(clickAt(mix)).toBeNull();
  });

  test("a layer clip's lead lands ahead of its start", async () => {
    const mix = await render({
      duration: 8,
      clips: [{ file: "", in: 0, out: 8, muted: true }],
      items: [{ file: "layer.mp4", in: 5, out: 7, start: 2, volume: 1, soundLead: 0.4, soundBack: 0.4, splitFade: 0.03 }],
    });
    near(clickAt(mix), 1.7);
  });
});

describe("a recording bound to the video", () => {
  test("plays the recording through the offset, and the camera's track stays out", async () => {
    // Recording second = video second − 3, so recording 8.5 is video 11.5,
    // which this clip (in 10, at 0) plays at 1.5. The camera's own click at
    // video 12 must not sound.
    const mix = await render({
      duration: 4,
      clips: [{ file: "cam.mp4", in: 10, out: 14, muted: false, soundFrom: { file: "rec.wav", offset: -3, duration: 60 } }],
      items: [],
    });
    near(clickAt(mix), 1.5);
    expect(Math.abs(mix[Math.round(2 * RATE) + 4])).toBeLessThan(0.01);
  });

  test("a recording that rolled after the camera leaves silence before it, in time", async () => {
    // The recording starts at video second 2; the clip starts on video
    // second 1. Recording 1 is video 3, played at timeline 2.
    const mix = await render({
      duration: 4,
      clips: [{ file: "cam.mp4", in: 1, out: 5, muted: false, soundFrom: { file: "late.wav", offset: -2, duration: 60 } }],
      items: [],
    });
    near(clickAt(mix), 2);
  });

  test("a speed change runs the recording through the clip's own map", async () => {
    // At 2× the clip covers video 10..14 in two seconds: video 11.5 plays at 0.75.
    const mix = await render({
      duration: 2,
      clips: [{ file: "cam.mp4", in: 10, out: 14, speed: 2, muted: false, soundFrom: { file: "rec.wav", offset: -3, duration: 60 } }],
      items: [],
    });
    const got = clickAt(mix);
    expect(got).not.toBeNull();
    // The stretch smears a click over a few milliseconds.
    expect(Math.abs(got! - 0.75)).toBeLessThan(0.03);
  });

  test("a reversed clip plays the recording backward from its out point", async () => {
    // Reversed, timeline 0 shows video 14 and timeline 4 video 10: video
    // 11.5 lands at 2.5.
    const mix = await render({
      duration: 4,
      clips: [{ file: "cam.mp4", in: 10, out: 14, reverse: true, muted: false, soundFrom: { file: "rec.wav", offset: -3, duration: 60 } }],
      items: [],
    });
    let peak = 0;
    let at = 0;
    for (let i = 0; i < mix.length; i++) if (Math.abs(mix[i]) > peak) { peak = Math.abs(mix[i]); at = i / RATE; }
    expect(Math.abs(at - 2.5)).toBeLessThan(0.002);
  });
});

describe("stems from the document", () => {
  test("the dialogue stem plays the bound recording and the split edit; a lane keeps its own sound", async () => {
    const { mixSpecFor, stemMixSpec } = await import("./exportRender");
    const media = (id: string, type: "video" | "audio", over: Record<string, unknown> = {}) => ({
      id,
      fileName: id,
      name: id,
      type,
      duration: 60,
      url: "",
      ...over,
    });
    // Video second t plays recording t − 2: the recording's click at 8.5 is
    // video 10.5, which clip a (video 10..12) plays at 0.5. Clip b starts at
    // 2 on source 5 and leads by half a second: source 4.8 plays at 1.8. The
    // soundtrack's click at its own 1.0 sits on lane 0.
    const doc = {
      aspect: "16:9",
      assets: [
        media("cam.mp4", "video", { soundFrom: { assetId: "rec.wav", offset: -2 } }),
        media("rec.wav", "audio"),
        media("lead.mp4", "video"),
        media("late.wav", "audio"),
      ],
      clips: [
        { id: "a", assetId: "cam.mp4", start: 0, in: 10, out: 12, track: 0, muted: false },
        { id: "b", assetId: "lead.mp4", start: 2, in: 5, out: 9, track: 0, muted: false, audioLead: 0.5 },
      ],
      audioClips: [{ id: "s", assetId: "late.wav", start: 0, in: 0, out: 4, volume: 1, lane: 0 }],
      overlays: [],
      subtitles: { cues: [] },
    } as unknown as Parameters<typeof mixSpecFor>[0];
    const spec = mixSpecFor(doc, (a) => a.fileName);
    const clicks = (data: Float32Array) => {
      const at: number[] = [];
      let quietSince = -RATE;
      for (let i = 0; i < data.length; i++) {
        if (Math.abs(data[i]) <= 0.5) continue;
        if (i - quietSince > RATE * 0.1) at.push(i / RATE);
        quietSince = i;
      }
      return at;
    };
    const dialogue = clicks(await render(stemMixSpec(spec, { name: "Dialogue", file: "1 Dialogue.wav", lane: null })));
    expect(dialogue).toHaveLength(2);
    near(dialogue[0], 0.5);
    near(dialogue[1], 1.8);
    const lane = clicks(await render(stemMixSpec(spec, { name: "late", file: "2 late.wav", lane: 0 })));
    expect(lane).toHaveLength(1);
    near(lane[0], 1);
  });
});
