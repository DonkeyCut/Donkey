import { describe, expect, test } from "bun:test";
import { DOC_SAVE_HEADER, docSaveOf, savedAt } from "./docSave";
import { personAssets } from "../store";
import type { MediaAsset } from "../types";

describe("a project save", () => {
  test("is an edit unless it says it only settles the media", () => {
    // Headless jobs and older pages send no marker; their saves are edits.
    const put = (save?: string) =>
      new Request("http://x/api/cut/projects/p", { method: "PUT", headers: save ? { [DOC_SAVE_HEADER]: save } : {} });
    expect(docSaveOf(put())).toBe("edit");
    expect(docSaveOf(put("edit"))).toBe("edit");
    expect(docSaveOf(put("settle"))).toBe("settle");
    expect(docSaveOf(put("bogus"))).toBe("edit");
  });

  test("a settle keeps the project's edited time; an edit moves it", () => {
    expect(savedAt("settle", 1000, 5000)).toBe(1000);
    expect(savedAt("edit", 1000, 5000)).toBe(5000);
    // A doc with no time yet takes the save's.
    expect(savedAt("settle", undefined, 5000)).toBe(5000);
  });
});

describe("which asset changes are the person's", () => {
  const clip = { id: "a", fileName: "a.mp4", name: "Clip", type: "video", duration: 4, url: "blob:a" } as MediaAsset;

  test("analysis landing on open is not an edit", () => {
    // Opening a project hears its speech, finds beats and scene cuts, reads
    // its color, and lands a proxy; none of it is the person's doing.
    const analysed = {
      ...clip,
      duration: 4.02,
      width: 1920,
      height: 1080,
      sizeBytes: 9,
      language: "en",
      speech: { words: [] },
      beats: { bpm: 120, times: [] },
      sceneCuts: [1, 2],
      proxy: { fileName: "a.proxy.mp4", sizeBytes: 3 },
    } as unknown as MediaAsset;
    expect(JSON.stringify(personAssets([analysed]))).toBe(JSON.stringify(personAssets([clip])));
  });

  test("a rename, a move or a new file is", () => {
    const base = JSON.stringify(personAssets([clip]));
    expect(JSON.stringify(personAssets([{ ...clip, name: "Intro" }]))).not.toBe(base);
    expect(JSON.stringify(personAssets([{ ...clip, folderId: "f" }]))).not.toBe(base);
    expect(JSON.stringify(personAssets([clip, { ...clip, id: "b", fileName: "b.mp4" }]))).not.toBe(base);
  });
});
