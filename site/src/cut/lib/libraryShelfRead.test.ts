import { afterEach, expect, spyOn, test } from "bun:test";
import { cloudBackend } from "@/cut/lib/backend/cloud";
import { fetchLibrary, type LibraryData } from "@/cut/lib/library";

const restores: (() => void)[] = [];
afterEach(() => {
  for (const restore of restores.splice(0)) restore();
});

const STATUS_UNAVAILABLE = 503;

test("a shelf whose read fails keeps the listing already held for it", async () => {
  const read = spyOn(cloudBackend, "fetch").mockResolvedValue(new Response("down", { status: STATUS_UNAVAILABLE }));
  restores.push(() => read.mockRestore());
  const held: LibraryData = {
    assets: [{ id: "a1", fileName: "a1.mp4", name: "Clip", type: "video", duration: 1, addedAt: 0, residency: "cloud" }],
    folders: [{ id: "f1", name: "B-Roll", createdAt: 0, residency: "cloud" }],
    templates: [],
  };
  const data = await fetchLibrary({ remembered: true, held });
  expect(data.assets.map((a) => a.id)).toEqual(["a1"]);
  expect(data.folders.map((f) => f.id)).toEqual(["f1"]);
});
