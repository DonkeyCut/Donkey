import { describe, expect, test } from "bun:test";

import { buildAiContext, describeDoc } from "./aiContext";
import { richDoc } from "./fixtures/richDoc";
import { useEditor } from "./store";
import type { MediaAsset } from "./types";

/**
 * A document described on its own reads exactly like the same project open
 * in the editor. That is what lets another project be read as a reference
 * in the shape the model already knows.
 */

describe("describeDoc", () => {
  test("matches the live snapshot's core for the same document", async () => {
    const doc = richDoc();
    const assets: MediaAsset[] = doc.assets.map((a) => ({ ...a, url: "" }));
    await useEditor.getState().openProjectDoc("rich", doc, assets);
    const live = buildAiContext({ fullCues: true, chatId: null });
    const read = describeDoc(doc, { fullCues: true });
    for (const key of ["project", "media", "videoTrack", "overlayVideo", "transitions", "soundtrack", "overlays", "subtitles"] as const) {
      expect(read[key]).toEqual(live[key]);
    }
    expect(read.media[0]).toMatchObject({
      id: "v0",
      observed: [{ from: 0, to: 10, text: "a host talks to camera" }],
      speech: "transcribed",
      transcript: [{ start: 0, end: 4, text: "hello and welcome" }],
    });
    expect(read.videoTrack[1]).toMatchObject({ id: "c1", colorGrade: { brightness: 5 }, animOut: { style: "zoom", seconds: 0.5 } });
    expect(read.subtitles).toMatchObject({ style: "bubble", size: 60, wordsPerCue: 3, wordHighlight: true, accentColor: "#FF3366" });
    expect(read.project).toMatchObject({ id: "rich", name: "Rich edit", aspect: "16:9", background: "#102030", fadeIn: 0.3, fadeOut: 0.4 });
  });

  test("carries no live-only fields", () => {
    const read = describeDoc(richDoc()) as Record<string, unknown>;
    for (const key of ["playhead", "selection", "renders", "view", "fonts", "playing"]) {
      expect(key in read).toBe(false);
    }
  });

  test("another chat's unplaced media stays out of a reference, as it does out of the open project", () => {
    const doc = richDoc();
    doc.assets.push({ id: "g1", fileName: "g1.mp4", name: "their render", type: "video", duration: 4, origin: "chat", chatId: "thread-a" });
    const own = describeDoc(doc, { fullCues: true, chatId: "thread-a" });
    expect(own.media.some((m) => m.id === "g1")).toBe(true);
    const other = describeDoc(doc, { fullCues: true, chatId: "thread-b" });
    expect(other.media.some((m) => m.id === "g1")).toBe(false);
    expect(describeDoc(doc, { fullCues: true }).media.some((m) => m.id === "g1")).toBe(false);
  });
});
