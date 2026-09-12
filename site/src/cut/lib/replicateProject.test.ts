import { afterAll, beforeEach, describe, expect, test } from "bun:test";

import { runAiTool } from "./aiTools";
import { richDoc, RICH_CLIP_S } from "./fixtures/richDoc";
import { setHostDocStore } from "./projectReference";
import { useEditor } from "./store";
import { emptySubtitles, isTextOverlay, type MediaAsset, type ProjectDoc } from "./types";

/**
 * A Donkey Cut link pasted into another project's chat is read as its
 * document and rebuilt on that project's own media. What the reference's
 * assets carried — notes, transcript, beats — travels with a copy, a font
 * the reference uploaded is the font the titles set in it point at, and
 * everything the transplant had to trim is named.
 */

const asset = (id: string, type: MediaAsset["type"], duration: number, extra: Partial<MediaAsset> = {}): MediaAsset => ({
  id,
  fileName: `${id}.bin`,
  name: id,
  type,
  duration,
  url: "",
  ...extra,
});

const docs = new Map<string, ProjectDoc>([["rich", richDoc()]]);
const copies: { src: string; file: string; dst: string }[] = [];

setHostDocStore({
  readDoc: async (id) => docs.get(id) ?? null,
  copyMedia: async (src, file, dst) => {
    copies.push({ src, file, dst });
    return `copy-${file}`;
  },
});
afterAll(() => setHostDocStore(null));

type Result = {
  clipIds: string[];
  audioClipIds: string[];
  overlayIds: string[];
  transitionIds: string[];
  cueIds: string[];
  mapped: { sourceId: string; assetId: string }[];
  assetIds: string[];
  copied: { sourceId: string; assetId: string; kind: string }[];
  adjustments: { item: string; field: string; from: number; to: number; reason: string }[];
  frame: boolean;
  captionLook: boolean;
  captions: string;
};

describe("replicate_project", () => {
  beforeEach(() => {
    copies.length = 0;
    useEditor.setState({
      projectId: "p2",
      clips: [],
      transitions: [],
      audioClips: [],
      overlays: [],
      // B's footage is shorter than the reference's second clip, so its trim
      // has to give.
      assets: [asset("b0", "video", 30), asset("b1", "video", 6), asset("bs", "image", 0)],
      subtitles: emptySubtitles(),
      selection: null,
      multiSelection: [],
      aspect: "9:16",
    });
  });

  test("the whole edit lands on the mapped media, copies the rest, and names every trim", async () => {
    const out = (await runAiTool("replicate_project", {
      link: "rich",
      media: [
        { source_asset_id: "v0", asset_id: "b0" },
        { source_asset_id: "v1", asset_id: "b1" },
        { source_asset_id: "s0", asset_id: "bs" },
      ],
    })) as Result;
    const s = useEditor.getState();
    expect(out.clipIds).toHaveLength(3);
    expect(out.audioClipIds).toHaveLength(1);
    expect(out.overlayIds).toHaveLength(4);
    expect(out.transitionIds).toHaveLength(3);
    // Cues are B's speech to write; the look is the reference's.
    expect(out.cueIds).toHaveLength(0);
    expect(out.captions).toBe("none copied");
    expect(out.captionLook).toBe(true);
    expect(s.subtitles.style).toBe("bubble");
    expect(s.subtitles.wordsPerCue).toBe(3);
    // The frame follows for a whole replicate.
    expect(out.frame).toBe(true);
    expect(s.aspect).toBe("16:9");
    expect(s.background).toBe("#102030");
    // The music bed and the font had no counterpart, so they copied across
    // with what the reference knew about them.
    expect(copies.map((c) => c.file).sort()).toEqual(["brand.ttf", "music.m4a"]);
    expect(copies.every((c) => c.src === "rich" && c.dst === "p2")).toBe(true);
    expect(out.copied.map((c) => c.kind).sort()).toEqual(["audio", "font"]);
    const music = s.assets.find((a) => a.fileName === "copy-music.m4a")!;
    expect(music).toMatchObject({ type: "audio", origin: "generated", beats: { bpm: 120 } });
    expect(s.audioClips[0].assetId).toBe(music.id);
    // The brand title now points at the copied font.
    const font = s.assets.find((a) => a.type === "font")!;
    const brand = s.overlays.filter(isTextOverlay).find((o) => o.text === "Brand line")!;
    expect(brand.font).toBe(`asset:${font.id}`);
    // b1 runs 6s where the reference's clip ran 10s, so its out was trimmed.
    const c1 = s.clips.find((c) => c.assetId === "b1")!;
    expect(c1.out).toBe(6);
    expect(out.adjustments).toEqual([{ item: "clip c1", field: "out", from: RICH_CLIP_S, to: 6, reason: "the mapped source is shorter" }]);
    // One undo step reverts the items and the caption look. The frame is a
    // project setting, outside history like every frame change.
    s.undo();
    const back = useEditor.getState();
    expect(back.clips).toHaveLength(0);
    expect(back.audioClips).toHaveLength(0);
    expect(back.overlays).toHaveLength(0);
    expect(back.transitions).toHaveLength(0);
    expect(back.subtitles.style).toBe(emptySubtitles().style);
    expect(back.aspect).toBe("16:9");
  });

  test("chosen items land alone, leaving the frame and captions as they were", async () => {
    const out = (await runAiTool("replicate_project", {
      link: "rich",
      items: ["t0", "t1"],
    })) as Result;
    const s = useEditor.getState();
    expect(out.clipIds).toHaveLength(0);
    expect(out.overlayIds).toHaveLength(2);
    expect(out.frame).toBe(false);
    expect(out.captionLook).toBe(false);
    expect(s.aspect).toBe("9:16");
    expect(s.overlays.filter(isTextOverlay).map((o) => o.text).sort()).toEqual(["Brand line", "Everything test"]);
    // The titles keep their group.
    const [g0, g1] = s.overlays.map((o) => o.groupId);
    expect(g0).toBeDefined();
    expect(g0).toBe(g1);
    // Only the font copied: nothing else the titles need.
    expect(copies.map((c) => c.file)).toEqual(["brand.ttf"]);
  });

  test("refuses an unknown item, an unknown asset, and a role the media cannot play", async () => {
    await expect(runAiTool("replicate_project", { link: "rich", items: ["nope"] })).rejects.toThrow("no items with ids nope");
    await expect(
      runAiTool("replicate_project", { link: "rich", media: [{ source_asset_id: "v0", asset_id: "zz" }] })
    ).rejects.toThrow("No asset with id zz in this project");
    await expect(
      runAiTool("replicate_project", { link: "rich", media: [{ source_asset_id: "v9", asset_id: "b0" }] })
    ).rejects.toThrow("No asset with id v9 in the reference");
    await expect(
      runAiTool("replicate_project", { link: "rich", media: [{ source_asset_id: "m0", asset_id: "b0" }] })
    ).rejects.toThrow("cannot play that part");
    expect(useEditor.getState().clips).toHaveLength(0);
  });

  test("a link nothing answers is a plain error", async () => {
    await expect(runAiTool("replicate_project", { link: "https://donkeycut.com/app/p/missing" })).rejects.toThrow(
      "No project with id missing"
    );
    await expect(runAiTool("read_project", { link: "https://youtube.com/watch?v=abc" })).rejects.toThrow(
      "Pass a Donkey Cut project link"
    );
  });
});

describe("read_project", () => {
  test("hands back the reference as an editor state, naming the sources nothing describes", async () => {
    useEditor.setState({ projectId: "p2", assets: [], clips: [], overlays: [] });
    const out = (await runAiTool("read_project", { link: "https://donkeycut.com/app/p/rich" })) as {
      source: { kind: string; id: string; name: string; residency: string };
      reference: { videoTrack: { id: string }[]; media: { id: string }[]; subtitles: { cues: unknown[] } };
      unobserved: string[];
    };
    expect(out.source).toEqual({ kind: "project", id: "rich", name: "Rich edit", residency: "local" });
    expect(out.reference.videoTrack.map((c) => c.id)).toEqual(["c0", "c1"]);
    // Fonts list under `fonts`, like the open project's.
    expect(out.reference.media.map((m) => m.id).sort()).toEqual(["m0", "s0", "v0", "v1"]);
    expect(out.reference.subtitles.cues).toHaveLength(2);
    // v0 carries notes and a transcript; v1 carries neither.
    expect(out.unobserved).toEqual(["v1"]);
    expect(useEditor.getState().clips).toHaveLength(0);
  });
});

describe("copy_project_media", () => {
  test("lands the chosen assets on this project's cards and places nothing", async () => {
    copies.length = 0;
    useEditor.setState({ projectId: "p2", assets: [], clips: [], audioClips: [], overlays: [] });
    const out = (await runAiTool("copy_project_media", { link: "rich", asset_ids: ["v0", "s0"] })) as {
      assets: { assetId: string; sourceId: string; kind: string; duration: number }[];
    };
    expect(out.assets.map((a) => [a.sourceId, a.kind])).toEqual([
      ["v0", "video"],
      ["s0", "image"],
    ]);
    const s = useEditor.getState();
    expect(s.assets).toHaveLength(2);
    expect(s.assets[0]).toMatchObject({ fileName: "copy-clip-0.mp4", watch: { notes: [{ from: 0 }] } });
    expect(s.assets[0].speech?.segments).toHaveLength(1);
    expect(s.clips).toHaveLength(0);
    await expect(runAiTool("copy_project_media", { link: "rich", asset_ids: [] })).rejects.toThrow("asset_ids is required");
  });
});
