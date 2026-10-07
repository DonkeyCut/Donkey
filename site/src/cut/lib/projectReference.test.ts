import { afterAll, beforeEach, describe, expect, test } from "bun:test";

import { landReferenceAssets, setHostDocStore, type ReferenceProject } from "./projectReference";
import { useEditor } from "./store";
import type { StoredAsset } from "./types";

/**
 * A reference's media landing in the open project: a video bound to a
 * separate recording brings the recording along, unless the caller plays
 * that recording's part from an asset of its own.
 */

const copies: string[] = [];
setHostDocStore({
  readDoc: async () => null,
  copyMedia: async (_src, file) => {
    copies.push(file);
    return `copy-${file}`;
  },
});
afterAll(() => setHostDocStore(null));

const video: StoredAsset = {
  id: "v0",
  fileName: "cam.mp4",
  name: "cam",
  type: "video",
  duration: 30,
  soundFrom: { assetId: "r0", offset: 0.25 },
};
const rec: StoredAsset = { id: "r0", fileName: "lav.wav", name: "lav", type: "audio", duration: 60 };
const ref: ReferenceProject = {
  link: { kind: "project", id: "ref" },
  projectId: "ref",
  doc: { assets: [video, rec] } as ReferenceProject["doc"],
  residency: "local",
  backend: null,
  partial: [],
};

describe("landReferenceAssets", () => {
  beforeEach(() => {
    copies.length = 0;
    useEditor.setState({ projectId: "p", assets: [] });
  });

  test("a bound video brings its recording and binds to the copy", async () => {
    const [landed] = await landReferenceAssets(ref, [video], "p");
    expect(copies).toEqual(["cam.mp4", "lav.wav"]);
    const copy = useEditor.getState().assets.find((a) => a.fileName === "copy-lav.wav")!;
    expect(landed.asset.soundFrom).toEqual({ assetId: copy.id, offset: 0.25 });
  });

  test("a recording the caller maps to its own asset stays behind", async () => {
    const [landed] = await landReferenceAssets(ref, [video], "p", { mapped: new Set(["r0"]) });
    expect(copies).toEqual(["cam.mp4"]);
    expect(landed.asset.soundFrom).toBeUndefined();
  });
});
