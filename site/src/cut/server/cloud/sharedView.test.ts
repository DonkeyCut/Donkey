import { describe, expect, test } from "bun:test";

import type { ProjectDoc, ShareFeatures } from "@/cut/lib/types";
import { filterDocForShare } from "./sharedView";

// The doc a viewer receives is also the copy's manifest: a share copy moves the
// media of exactly the assets that survive this filter, so what a shared project
// carries into someone else's account is decided here.
const features = (on: Partial<ShareFeatures> = {}): ShareFeatures =>
  ({ chat: false, media: false, genai: false, subtitles: false, details: false, ...on }) as ShareFeatures;

const doc = {
  version: 1,
  name: "p",
  createdAt: 0,
  updatedAt: 0,
  assets: [
    { id: "imported", fileName: "imported.mp4", type: "video", duration: 1 },
    { id: "placed", fileName: "placed.mp4", type: "video", duration: 1, origin: "chat", chatId: "t1" },
    { id: "card", fileName: "card.png", type: "image", duration: 0, origin: "chat", chatId: "t1" },
    { id: "made", fileName: "made.mp4", type: "video", duration: 1, origin: "generated" },
  ],
  clips: [{ id: "c1", assetId: "placed", track: 0, start: 0, in: 0, out: 1, muted: false }],
  audioClips: [],
  overlays: [],
} as unknown as ProjectDoc;

const ids = (d: ProjectDoc) => d.assets.map((a) => a.id).sort();

describe("filterDocForShare", () => {
  test("chat-created media travels only when chat is shared", () => {
    expect(ids(filterDocForShare(doc, features({ chat: true })))).toEqual(["card", "placed"]);
    expect(ids(filterDocForShare(doc, features()))).toEqual(["placed"]);
  });

  test("a clip's own media always travels — playback is the point", () => {
    // "placed" is chat-created and on the timeline: shared either way.
    expect(ids(filterDocForShare(doc, features()))).toEqual(["placed"]);
  });

  test("each panel carries its own assets", () => {
    expect(ids(filterDocForShare(doc, features({ media: true })))).toEqual(["imported", "placed"]);
    expect(ids(filterDocForShare(doc, features({ genai: true })))).toEqual(["made", "placed"]);
  });

  test("chat's renders ride with chat, and nothing else does", () => {
    const withRenders = { ...doc, renders: [{ id: "r1" }] } as unknown as ProjectDoc;
    expect(filterDocForShare(withRenders, features({ chat: true })).renders?.length).toBe(1);
    expect(filterDocForShare(withRenders, features({ media: true })).renders).toBeUndefined();
  });

  test("what playback draws travels with the clip that uses it", () => {
    const playback = {
      ...doc,
      assets: [
        ...doc.assets,
        { id: "m1", fileName: "m1.mp4", type: "video", duration: 1, origin: "matte" },
        { id: "fill", fileName: "fill.png", type: "image", duration: 0 },
        { id: "sticker", fileName: "s.png", type: "image", duration: 0, origin: "cutout" },
        { id: "font1", fileName: "f.ttf", type: "font", duration: 0 },
      ],
      clips: [
        {
          ...(doc.clips[0] as object),
          removal: {
            mode: "auto",
            matte: { assetId: "m1", fingerprint: "fp", quality: "local", in: 0 },
            backdrop: { kind: "image", assetId: "fill" },
          },
        },
      ],
      overlays: [
        { id: "o1", kind: "sticker", assetId: "sticker", start: 0, end: 1, x: 0, y: 0, w: 0.2 },
        { id: "o2", kind: "text", text: "hi", font: "asset:font1", start: 0, end: 1, x: 0, y: 0 },
      ],
    } as unknown as ProjectDoc;
    expect(ids(filterDocForShare(playback, features()))).toEqual([
      "fill",
      "font1",
      "m1",
      "placed",
      "sticker",
    ]);
  });

  test("a caption font travels only when subtitles are shared", () => {
    const captioned = {
      ...doc,
      assets: [...doc.assets, { id: "font1", fileName: "f.ttf", type: "font", duration: 0 }],
      subtitles: { cues: [], font: "asset:font1" },
    } as unknown as ProjectDoc;
    expect(ids(filterDocForShare(captioned, features({ subtitles: true })))).toEqual([
      "font1",
      "placed",
    ]);
    expect(ids(filterDocForShare(captioned, features()))).toEqual(["placed"]);
  });
});
