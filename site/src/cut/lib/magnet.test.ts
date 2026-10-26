import { beforeEach, describe, expect, test } from "bun:test";
import type React from "react";
import { closeTrack0, serializeDoc, useEditor } from "./store";
import { runAiTool } from "./aiTools";
import { startDrag } from "./drag";
import { emptySubtitles } from "./types";
import type { AudioClip, SubtitleCue, TextOverlay, VideoClip } from "./types";

// The magnet keeps track 0 closed up, and everything timed against it rides
// the footage under its start: same length, never stretched, never stacked.

const vclip = (id: string, track: number, start: number, len: number): VideoClip => ({
  id,
  assetId: "x",
  track,
  start,
  in: 0,
  out: len,
  muted: false,
});
const aclip = (id: string, start: number, len: number, lane = 0): AudioClip => ({ id, assetId: "x", start, in: 0, out: len, volume: 1, lane });
const title = (id: string, start: number, end: number): TextOverlay => ({
  id,
  text: "T",
  start,
  end,
  x: 0.5,
  y: 0.5,
  size: 88,
  font: "sf",
  weight: 700,
  color: "#fff",
  shadow: true,
  plate: false,
});
const cue = (id: string, start: number, end: number): SubtitleCue => ({
  id,
  start,
  end,
  text: "hi",
  words: [{ w: "hi", t0: start, t1: end }],
});
const doc = (o: Partial<Parameters<typeof closeTrack0>[0]>) => ({
  clips: [],
  transitions: [],
  audioClips: [],
  overlays: [],
  cues: [],
  ...o,
});

const s = () => useEditor.getState();
const startOf = (id: string) => s().clips.find((c) => c.id === id)?.start;

beforeEach(() => {
  useEditor.setState({
    clips: [],
    transitions: [],
    audioClips: [],
    overlays: [],
    assets: [],
    subtitles: emptySubtitles(),
    selection: null,
    multiSelection: [],
    magnet: false,
    readOnly: false,
  });
});

describe("closing up track 0", () => {
  test("the gap shuts and every follower rides the footage under its start", () => {
    // A 0–5, a 4s gap, C 9–15: C pulls back to 5.
    const out = closeTrack0(
      doc({
        clips: [vclip("A", 0, 0, 5), vclip("C", 0, 9, 6), vclip("broll", 1, 2, 2), vclip("pip", 1, 10, 2)],
        overlays: [title("over-c", 10, 12)],
        audioClips: [aclip("music", 0, 20), aclip("in-gap", 7, 1, 1)],
        cues: [cue("q", 11, 12)],
      })
    );
    const at = (id: string) => out.clips.find((c) => c.id === id)!.start;
    expect(at("C")).toBe(5);
    expect(at("broll")).toBe(2);
    expect(at("pip")).toBe(6);
    expect(out.overlays[0]).toMatchObject({ start: 6, end: 8 });
    expect(out.audioClips.map((a) => a.start)).toEqual([0, 5]);
    expect(out.cues[0]).toMatchObject({ start: 7, end: 8, words: [{ w: "hi", t0: 7, t1: 8 }] });
  });

  test("a head gap closes to zero", () => {
    const out = closeTrack0(doc({ clips: [vclip("A", 0, 3, 2)], overlays: [title("t", 1, 2)] }));
    expect(out.clips[0].start).toBe(0);
    expect(out.overlays[0]).toMatchObject({ start: 0, end: 1 });
  });

  test("a row the move crowds pushes its later item right", () => {
    // over-a stays at 4–6; over-c lands on 5 and slides to 6.
    const out = closeTrack0(
      doc({
        clips: [vclip("A", 0, 0, 5), vclip("C", 0, 9, 6)],
        overlays: [title("over-a", 4, 6), title("over-c", 9, 10)],
      })
    );
    expect(out.overlays.map((o) => [o.start, o.end])).toEqual([[4, 6], [6, 7]]);
  });

  test("a closed track 0 is the same document back", () => {
    const d = doc({ clips: [vclip("A", 0, 0, 5), vclip("B", 0, 5, 2)] });
    expect(closeTrack0(d)).toBe(d);
  });
});

describe("the magnet in the editor", () => {
  test("turning it on closes every gap, and one undo brings them back off", () => {
    useEditor.setState({ clips: [vclip("A", 0, 0, 5), vclip("C", 0, 9, 6)] });
    s().toggleMagnet();
    expect(s().magnet).toBe(true);
    expect(startOf("C")).toBe(5);
    s().undo();
    expect(s().magnet).toBe(false);
    expect(startOf("C")).toBe(9);
  });

  test("deleting a track-0 clip pulls the rest left", () => {
    useEditor.setState({ clips: [vclip("A", 0, 0, 5), vclip("B", 0, 5, 4), vclip("C", 0, 9, 6)], magnet: true });
    s().select({ kind: "clip", id: "B" });
    s().deleteSelection();
    expect(startOf("C")).toBe(5);
  });

  test("off, track 0 keeps its gaps", () => {
    useEditor.setState({ clips: [vclip("A", 0, 0, 5), vclip("C", 0, 9, 6)] });
    expect(startOf("C")).toBe(9);
  });

  test("a drop aimed below track 0 inserts into it", () => {
    useEditor.setState({
      assets: [{ id: "x", fileName: "x.mp4", name: "x", type: "video", duration: 2, url: "" }],
      clips: [vclip("A", 0, 0, 5)],
      magnet: true,
    });
    s().addVideoFromAsset("x", { kind: "insert", level: 0 }, 1);
    expect(s().clips.every((c) => c.track === 0)).toBe(true);
    expect(startOf("A")).toBe(2);
  });

  test("a drag holds the close-up until release", () => {
    const saved = new Map(["window", "document", "requestAnimationFrame", "cancelAnimationFrame"].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    try {
      const events = new EventTarget();
      Object.defineProperty(globalThis, "window", { configurable: true, value: events });
      Object.defineProperty(globalThis, "document", { configurable: true, value: { activeElement: null } });
      Object.defineProperty(globalThis, "requestAnimationFrame", { configurable: true, value: (cb: () => void) => (cb(), 0) });
      Object.defineProperty(globalThis, "cancelAnimationFrame", { configurable: true, value: () => {} });
      useEditor.setState({ clips: [vclip("A", 0, 0, 5), vclip("C", 0, 5, 6)], magnet: true });

      // The gesture parts C away from A; the slot stays open under the pointer.
      const down = { button: 0, clientX: 0, clientY: 0, currentTarget: {}, preventDefault() {}, stopPropagation() {} } as unknown as React.PointerEvent;
      startDrag(down, { onMove: () => s().updateClipTransient("C", { start: 8 }) });
      events.dispatchEvent(Object.assign(new Event("pointermove"), { clientX: 30, clientY: 0 }));
      const held = startOf("C");
      events.dispatchEvent(Object.assign(new Event("pointerup"), { clientX: 30, clientY: 0 }));
      expect(held).toBe(8);
      expect(startOf("C")).toBe(5);
    } finally {
      for (const [key, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    }
  });

  test("chat turns it on and editor_state carries it", async () => {
    useEditor.setState({ clips: [vclip("A", 0, 0, 5), vclip("C", 0, 9, 6)] });
    await runAiTool("set_magnet", { on: true });
    expect(s().magnet).toBe(true);
    expect(startOf("C")).toBe(5);
    expect(serializeDoc(s()).magnet).toBe(true);
  });
});
