import { afterEach, expect, spyOn, test } from "bun:test";
import * as urlImport from "../urlImport";
import { libraryApi } from "./library";

const restores: (() => void)[] = [];
afterEach(() => {
  for (const restore of restores.splice(0)) restore();
});

const post = (key: string) =>
  libraryApi.importUrl(new Request("http://engine/api/cut/library/import-url", {
    method: "POST",
    body: JSON.stringify({ url: "https://www.youtube.com/watch?v=abc", key }),
  }));

test("a link asked for again under its key waits on the download already running", async () => {
  let land: ((assets: Awaited<ReturnType<typeof urlImport.importFromUrl>>) => void) | undefined;
  const fetchLink = spyOn(urlImport, "importFromUrl").mockImplementation(() => new Promise((resolve) => { land = resolve; }));
  restores.push(() => fetchLink.mockRestore());
  const key = crypto.randomUUID();
  const first = post(key);
  const again = post(key);
  await new Promise((r) => setTimeout(r, 0));
  land!([{ id: "yt", fileName: "yt.mp4", name: "Video", type: "video", duration: 1, addedAt: 0 } as never]);
  expect(await (await first).json()).toEqual(await (await again).json());
  expect(((await (await post(key)).json()) as { id: string }[]).map((a) => a.id)).toEqual(["yt"]);
  expect(fetchLink.mock.calls.length).toBe(1);
});

test("a failed link runs again under the same key", async () => {
  const fetchLink = spyOn(urlImport, "importFromUrl").mockImplementation(async () => { throw new Error("Site refused"); });
  restores.push(() => fetchLink.mockRestore());
  const key = crypto.randomUUID();
  expect((await post(key)).ok).toBe(false);
  expect((await post(key)).ok).toBe(false);
  expect(fetchLink.mock.calls.length).toBe(2);
});
