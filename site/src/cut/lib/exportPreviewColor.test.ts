import { afterEach, expect, spyOn, test } from "bun:test";
import * as opfs from "./backend/browser/opfs";
import * as exportClient from "./exportClient";
import * as exportRender from "./exportRender";
import type { RenderSnapshot } from "./renderSnapshot";

const restores: (() => void)[] = [];
afterEach(() => {
  for (const restore of restores.splice(0)) restore();
});

const hdrDoc = {
  aspect: "16:9",
  assets: [],
  clips: [],
  audioClips: [],
  overlays: [],
  subtitles: { cues: [], showOnVideo: false, showOnTimeline: false },
  colorSpace: "hlg",
} as unknown as RenderSnapshot["doc"];

test("an HDR delivery never renders in the tab", async () => {
  const settings = exportClient.previewSettings("16:9");
  expect(await exportRender.canRenderInBrowser(hdrDoc, settings, "hlg")).toBe(false);
});

test("the hover preview of an HDR project asks for an SDR render", async () => {
  const dir = spyOn(opfs, "projectDir").mockResolvedValue({} as FileSystemDirectoryHandle);
  restores.push(() => dir.mockRestore());
  const asked: unknown[] = [];
  const probe = spyOn(exportRender, "canRenderInBrowser").mockImplementation(async (_doc, _settings, output) => {
    asked.push(output);
    throw new Error("stop here");
  });
  restores.push(() => probe.mockRestore());
  const snapshot = {
    operation: { projectId: "p", backend: { kind: "browser" } },
    revision: "r",
    doc: hdrDoc,
  } as unknown as RenderSnapshot;
  await expect(exportClient.submitPreviewSnapshot(snapshot)).rejects.toThrow("stop here");
  // The hover preview is an SDR web picture: the tab carries it, and the
  // project's media stays home.
  expect(asked).toEqual(["sdr"]);
});
