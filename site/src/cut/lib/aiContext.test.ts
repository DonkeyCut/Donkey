import { describe, expect, test } from "bun:test";
import { BUILTIN_LUTS } from "./builtinLuts";

import { buildAiContext, describeDoc } from "./aiContext";
import { richDoc } from "./fixtures/richDoc";
import { storedAssets, useEditor } from "./store";
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
    expect(read.project).toMatchObject({ id: "rich", name: "Rich edit", aspect: "16:9", background: "#102030" });
  });

  test("carries no live-only fields", () => {
    const read = describeDoc(richDoc()) as Record<string, unknown>;
    for (const key of ["playhead", "selection", "renders", "view", "fonts", "playing"]) {
      expect(key in read).toBe(false);
    }
  });

  test("file metadata survives saving and reaches live and headless chat", async () => {
    const doc = richDoc();
    doc.assets[0] = { ...doc.assets[0], sizeBytes: 21_000_001, width: 320, height: 240 };
    const assets = doc.assets.map((a) => ({ ...a, url: "" }));
    doc.assets = storedAssets(assets);
    await useEditor.getState().openProjectDoc("file-info", doc, assets);
    const expected = { fileName: doc.assets[0].fileName, sizeBytes: 21_000_001, fileSize: "20 MB", width: 320, height: 240 };
    expect(buildAiContext({ chatId: null }).media[0]).toMatchObject(expected);
    expect(describeDoc(doc).media[0]).toMatchObject(expected);
    expect(describeDoc(doc).media[0].duration).toBe(doc.assets[0].duration);
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

  test("colour reads as the grading tools take it: source colour, LUT, wheels by name", async () => {
    const doc = richDoc();
    doc.assets[0] = {
      ...doc.assets[0],
      color: { matrix: "bt2020nc", fullRange: false, bitDepth: 10, detected: "apple-log" },
      colorProfile: "rec709",
    };
    doc.clips[1] = {
      ...doc.clips[1],
      grade: { exposure: 4, fade: 10, lut: { id: "lut:abc", amount: 0.5 }, wheels: { s: [1, 2, 0], o: [0, 0, 3] } },
    };
    const assets = doc.assets.map((a) => ({ ...a, url: "" }));
    await useEditor.getState().openProjectDoc("colour", doc, assets);
    const live = buildAiContext({ chatId: null });
    expect(live.media[0]).toMatchObject({ sourceColor: { profile: "rec709", detected: "apple-log" } });
    expect(live.videoTrack[1]).toMatchObject({
      lut: { id: "lut:abc", amount: 0.5 },
      grade: { exposure: 4, fade: 10 },
      wheels: ["lift", "offset"],
    });
    // Every built-in LUT reaches the chat by the id set_color_lut takes.
    expect(live.luts.slice(0, BUILTIN_LUTS.length)).toEqual(
      BUILTIN_LUTS.map((l) => ({ id: `lut:${l.key}`, label: l.label, builtIn: true }))
    );
    expect(Array.isArray(live.savedGrades)).toBe(true);
    expect(describeDoc(doc).media[0]).toMatchObject({ sourceColor: { profile: "rec709", detected: "apple-log" } });
  });
});
