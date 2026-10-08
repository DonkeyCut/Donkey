import { beforeEach, expect, test } from "bun:test";
import type { UIMessage } from "ai";
import { runAiTool } from "./aiTools";
import { attachedRefKeys, cardIsAttached } from "./chatCards";
import { useEditor } from "./store";

// A chat card shows media a tool made. Media the user already holds — the
// source a swap points at, a stock sound they attached — gets no second card.

beforeEach(() => {
  useEditor.setState({
    clips: [],
    overlays: [],
    transitions: [],
    audioClips: [],
    assets: [
      { id: "tick", fileName: "tick.mp3", name: "Tick", type: "audio", duration: 1, url: "" },
      { id: "shutter", fileName: "shutter.mp3", name: "Shutter", type: "audio", duration: 1.5, url: "" },
      { id: "cam", fileName: "cam.mp4", name: "Cam", type: "video", duration: 10, sizeBytes: 1000, url: "" },
    ],
  });
});

test("a swap names its source without a card", async () => {
  useEditor.getState().addAudioFromAsset("tick", 0);
  const audio = useEditor.getState().audioClips[0]!;
  const out = (await runAiTool("replace_item", { id: audio.id, asset_id: "shutter" })) as Record<string, unknown>;
  expect(out.assetId).toBeUndefined();
  expect(out.sourceId).toBe("shutter");
});

test("reading or retagging a source makes no card", async () => {
  const info = (await runAiTool("get_asset_info", { asset_id: "cam" })) as Record<string, unknown>;
  expect(info.assetId).toBeUndefined();
  expect(info.id).toBe("cam");
  const color = (await runAiTool("set_source_color", { assetId: "cam", profile: "hlg" })) as Record<string, unknown>;
  expect(color.assetId).toBeUndefined();
  expect(color.id).toBe("cam");
});

test("an import of an attached stock item gets no card", () => {
  const messages = [
    {
      id: "u1",
      role: "user",
      parts: [{ type: "text", text: "Replace the ticks" }],
      metadata: { attachments: [{ scope: "stock", id: "camera-shutter-2", name: "Camera Shutter 2", kind: "audio", url: "/stock/sfx/camera-shutter-2.mp3" }] },
    },
  ] as UIMessage[];
  const attached = attachedRefKeys(messages);
  expect(cardIsAttached({ assetId: "a1", fromRef: { scope: "stock", id: "camera-shutter-2" } }, attached)).toBe(true);
  expect(cardIsAttached({ assetId: "a2", fromRef: { scope: "stock", id: "whoosh" } }, attached)).toBe(false);
  expect(cardIsAttached({ assetId: "a3" }, attached)).toBe(false);
});
