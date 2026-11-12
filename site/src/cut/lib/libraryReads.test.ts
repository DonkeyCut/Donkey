import { afterAll, expect, test } from "bun:test";
import { stubModule } from "@/lib/testing/stubModule";
import { cutMode, setCutMode } from "./backend";
import type { LibraryAsset } from "./library";
import { useEditor } from "./store";
import type { MediaAsset } from "./types";

// A Library file the user attached works by its id in any tool that takes the
// project's media: the first call brings it into the project, and every later
// call uses that copy.
const shelf: LibraryAsset = {
  id: "lib-take",
  name: "IMG_6236.mov",
  fileName: "lib-take.mov",
  type: "video",
  duration: 7.4,
  residency: "cloud",
} as LibraryAsset;
const short: LibraryAsset = { ...shelf, id: "lib-short", name: "IMG_6232.mov", fileName: "lib-short.mov", duration: 4.9 };
// The longer take copies slower, so a call made first finishes its copy last.
const COPY_MS: Record<string, number> = { "lib-take": 40, "lib-short": 0 };
const imports: string[] = [];
await stubModule<typeof import("./library")>("./library", import.meta.url, {
  fetchLibrary: async () => ({ assets: [shelf, short], folders: [], templates: [] }) as never,
  importLibraryAsset: async (_projectId: string, lib: LibraryAsset) => {
    imports.push(lib.id);
    await new Promise((done) => setTimeout(done, COPY_MS[lib.id]));
    const id = lib.id.replace("lib-", "proj-");
    const asset: MediaAsset = { id, fileName: `${id}.mov`, name: lib.name, type: "video", duration: lib.duration, url: `blob:${id}` };
    useEditor.getState().addAsset(asset);
    return asset;
  },
});
await stubModule<typeof import("./media")>("./media", import.meta.url, {
  renderAudioSpanWav: async () => new Blob([new Uint8Array(64)], { type: "audio/wav" }),
});
await stubModule<typeof import("./watch/sweep")>("./watch/sweep", import.meta.url, { queueWatchSweep: () => {} });
const { runAiTool } = await import("./aiTools");

const ambient = cutMode();
setCutMode("cloud");
afterAll(() => setCutMode(ambient));

test("a Library id works in any media tool and lands in the project once", async () => {
  useEditor.setState({ projectId: "p", clips: [], overlays: [], transitions: [], audioClips: [], assets: [] });

  await runAiTool("listen_audio", { asset_id: "lib-take", to: 0.5 });
  await runAiTool("add_clip", { asset_id: "lib-take" });

  expect(imports).toEqual(["lib-take"]);
  expect(useEditor.getState().assets.map((a) => a.id)).toEqual(["proj-take"]);
  expect(useEditor.getState().clips.map((c) => c.assetId)).toEqual(["proj-take"]);
});

test("clips sent together land in the order the calls were made", async () => {
  imports.length = 0;
  useEditor.setState({ projectId: "q", clips: [], overlays: [], transitions: [], audioClips: [], assets: [] });

  await Promise.all([runAiTool("add_clip", { asset_id: "lib-take" }), runAiTool("add_clip", { asset_id: "lib-short" })]);

  expect(useEditor.getState().clips.map((c) => c.assetId)).toEqual(["proj-take", "proj-short"]);
});

test("an id neither the project nor the Library holds gets the tool's own answer", async () => {
  const error = await runAiTool("add_clip", { asset_id: "nowhere" }).then(() => "", (e: Error) => e.message);
  expect(error).toContain("No project asset with id nowhere");
});
