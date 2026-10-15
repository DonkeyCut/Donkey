import { beforeEach, describe, expect, test } from "bun:test";
import { runAiTool } from "./aiTools";
import { useEditor } from "./store";
import { emptySubtitles, isTextOverlay } from "./types";
import { fontCycleCuts } from "@donkeycut/effects-kit";

/** A title's font cycle and its heavy weights through the assistant's tools. */

const reset = () =>
  useEditor.setState({
    projectId: "p1",
    aspect: "9:16",
    assets: [],
    clips: [],
    overlays: [],
    subtitles: emptySubtitles(),
    background: "#000000",
  });

const titles = () => useEditor.getState().overlays.filter(isTextOverlay);
const aTitle = async () => {
  await runAiTool("add_text_sequence", {
    look: "serif-mood",
    lines: [{ text: "STAY TUNED", start: 0, end: 4 }],
  });
  return titles()[0];
};
const failure = async (args: Record<string, unknown>) => {
  try {
    await runAiTool("set_overlay_animation", args);
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  return "";
};

describe("set_overlay_animation font cycle", () => {
  beforeEach(reset);

  test("each face can hold its own time and set italic", async () => {
    const o = await aTitle();
    await runAiTool("set_overlay_animation", {
      id: o.id,
      font_cycle: [{ font: "impact", hold: 0.25 }, { font: "serif", italic: true, hold: 99 }, { font: "mono", hold: 0 }],
    });
    expect(titles()[0].anim?.fonts?.faces).toEqual([
      { font: "impact", hold: 0.25 },
      { font: "serif", italic: true, hold: 10 },
      { font: "mono" },
    ]);
  });

  test("a new cycle runs the title's length at the default rate", async () => {
    const o = await aTitle();
    await runAiTool("set_overlay_animation", {
      id: o.id,
      font_cycle: [{ font: "impact", weight: 900, scale: 1.4 }, { font: "mono", tracking: 0.1 }],
    });
    expect(titles()[0].anim?.fonts).toEqual({
      faces: [{ font: "impact", weight: 900, scale: 1.4 }, { font: "mono", tracking: 0.1 }],
      at: 0,
      seconds: 4,
      rate: 15,
    });
  });

  test("timing holds inside the title and the rate in range", async () => {
    const o = await aTitle();
    await runAiTool("set_overlay_animation", {
      id: o.id,
      font_cycle: [{ font: "serif" }],
      font_cycle_at: 3,
      font_cycle_seconds: 9,
      font_cycle_rate: 400,
    });
    expect(titles()[0].anim?.fonts).toMatchObject({ at: 3, seconds: 1, rate: 30 });
    // Timing alone retimes the cycle the title already has.
    await runAiTool("set_overlay_animation", { id: o.id, font_cycle_at: 1 });
    expect(titles()[0].anim?.fonts).toMatchObject({ at: 1, faces: [{ font: "serif" }] });
  });

  test("an empty list removes the cycle", async () => {
    const o = await aTitle();
    await runAiTool("set_overlay_animation", { id: o.id, font_cycle: [{ font: "serif" }] });
    await runAiTool("set_overlay_animation", { id: o.id, font_cycle: [] });
    expect(titles()[0].anim?.fonts).toBeUndefined();
  });

  test("an unknown font or weight is refused", async () => {
    const o = await aTitle();
    expect(await failure({ id: o.id, font_cycle: [{ font: "no-such-face" }] })).toContain("Unknown font id");
    expect(await failure({ id: o.id, font_cycle: [{ font: "serif", weight: 450 }] })).toContain("weight");
  });

  test("a title takes the heavy weights", async () => {
    const o = await aTitle();
    await runAiTool("update_overlay", { id: o.id, weight: 900 });
    expect(titles()[0].weight).toBe(900);
  });
});

describe("set_overlay_animation font cycle timed to switches and beats", () => {
  beforeEach(reset);

  /** A title from `start` to `end` on the timeline. */
  const titleAt = async (start: number, end: number) => {
    await runAiTool("add_text_sequence", { look: "serif-mood", lines: [{ text: "TRAVEL", start, end }] });
    return titles()[0];
  };
  /** A song on the soundtrack at timeline `start`, its grid already detected. */
  const song = (beats: number[], start = 0, inAt = 0) =>
    useEditor.setState({
      assets: [{ id: "song", fileName: "song.mp3", name: "Song", type: "audio", duration: 30, url: "", beats: { beats, bpm: 120 } }],
      audioClips: [{ id: "a1", assetId: "song", start, in: inAt, out: 30, volume: 1 }],
    } as never);
  const faceTimes = () => {
    const c = titles()[0].anim!.fonts!;
    let t = c.at;
    return c.faces.map((f) => {
      const at = t;
      t += f.hold!;
      return [f.font, +at.toFixed(4)];
    });
  };

  test("switch times set every face's hold, faces repeating in order", async () => {
    const o = await titleAt(2, 6);
    await runAiTool("set_overlay_animation", {
      id: o.id,
      font_cycle: [{ font: "impact" }, { font: "serif", hold: 3 }],
      font_cycle_switches: [2.5, 3, 3.25, 4, 5],
    });
    const c = titles()[0].anim!.fonts!;
    expect(c.at).toBe(0.5);
    expect(c.seconds).toBe(2.5);
    expect(c.faces.map((f) => [f.font, f.hold])).toEqual([
      ["impact", 0.5],
      ["serif", 0.25],
      ["impact", 0.75],
      ["serif", 1],
    ]);
    // Every renderer cuts its pictures at the face changes: the times passed,
    // from the title's start.
    expect(fontCycleCuts(titles()[0], 4)).toEqual([0.5, 1, 1.25, 2, 3]);
  });

  test("switches outside the title are dropped, and two are needed", async () => {
    const o = await titleAt(2, 6);
    await runAiTool("set_overlay_animation", {
      id: o.id,
      font_cycle: [{ font: "impact" }],
      font_cycle_switches: [1, 2, 3, 9],
    });
    expect(titles()[0].anim!.fonts).toMatchObject({ at: 0, seconds: 1 });
    expect(await failure({ id: o.id, font_cycle_switches: [3] })).toContain("two");
  });

  test("the music's beats set the switches through the clip that plays it", async () => {
    // Beats at 0.5s steps in the source; the song sits 1s into the timeline.
    song([0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5], 1);
    const o = await titleAt(2, 4.2);
    await runAiTool("set_overlay_animation", {
      id: o.id,
      font_cycle: [{ font: "impact" }, { font: "serif" }, { font: "mono" }],
      font_cycle_beats: "a1",
    });
    expect(faceTimes()).toEqual([
      ["impact", 0],
      ["serif", 0.5],
      ["mono", 1],
      ["impact", 1.5],
      ["serif", 2],
    ]);
    // The last face holds to the title's end: 0.2s past the last beat.
    expect(titles()[0].anim!.fonts!.seconds).toBe(2.2);
  });

  test("a beat step takes every other beat, or splits each beat", async () => {
    song([0, 0.5, 1, 1.5, 2, 2.5, 3]);
    const o = await titleAt(0, 2);
    await runAiTool("set_overlay_animation", {
      id: o.id,
      font_cycle: [{ font: "impact" }, { font: "serif" }],
      font_cycle_beats: "a1",
      font_cycle_beat_step: 2,
    });
    expect(faceTimes()).toEqual([
      ["impact", 0],
      ["serif", 1],
    ]);
    await runAiTool("set_overlay_animation", { id: o.id, font_cycle_beats: "a1", font_cycle_beat_step: 0.5, font_cycle_seconds: 1 });
    expect(faceTimes()).toEqual([
      ["impact", 0],
      ["serif", 0.25],
      ["impact", 0.5],
      ["serif", 0.75],
    ]);
    // Every other beat counts from the run's first beat.
    await runAiTool("set_overlay_animation", { id: o.id, font_cycle_beats: "a1", font_cycle_beat_step: 2, font_cycle_at: 0.5, font_cycle_seconds: 1.5 });
    expect(faceTimes()).toEqual([
      ["impact", 0.5],
      ["serif", 1.5],
    ]);
  });

  test("a clip with no beat grid sends the model to detect_beats", async () => {
    useEditor.setState({
      assets: [{ id: "song", fileName: "song.mp3", name: "Song", type: "audio", duration: 30, url: "" }],
      audioClips: [{ id: "a1", assetId: "song", start: 0, in: 0, out: 30, volume: 1 }],
    } as never);
    const o = await titleAt(0, 2);
    expect(await failure({ id: o.id, font_cycle: [{ font: "impact" }], font_cycle_beats: "a1" })).toContain("detect_beats");
  });

  test("more switches than a cycle holds is refused with what to do", async () => {
    song(Array.from({ length: 60 }, (_, i) => i * 0.25));
    const o = await titleAt(0, 14);
    expect(await failure({ id: o.id, font_cycle: [{ font: "impact" }], font_cycle_beats: "a1" })).toContain("font_cycle_beat_step");
  });
});
