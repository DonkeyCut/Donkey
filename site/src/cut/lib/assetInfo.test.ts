import { afterEach, expect, test } from "bun:test";
import { runAiTool } from "@/cut/lib/aiTools";
import { registerBlobFile, forgetRegistered } from "@/cut/lib/backend/browser/registry";
import { readMediaFileSize } from "@/cut/lib/mediaRead";
import { useEditor } from "@/cut/lib/store";
import type { MediaAsset } from "@/cut/lib/types";

const initial = useEditor.getState();
const path = "/api/cut/projects/file-info/media/test.png";
const asset: MediaAsset = {
  id: "asset", name: "Source", fileName: "test.png", type: "image", duration: 0,
  width: 320, height: 240, url: "",
};
afterEach(() => { useEditor.setState(initial, true); forgetRegistered(path); });

test("file size reads bytes without needing a decodable container", async () => {
  expect(await readMediaFileSize(new Blob([new Uint8Array(1234)]))).toBe(1234);
});

test("existing browser assets can report file size without saved metadata", async () => {
  const url = registerBlobFile(path, new File([new Uint8Array(4321)], "test.png"));
  useEditor.setState({ assets: [{ ...asset, url }] });
  expect(await runAiTool("get_asset_info", { asset_id: asset.id })).toMatchObject({
    sizeBytes: 4321, fileSize: "4 KB", duration: 0, width: 320, height: 240, fileName: "test.png",
  });
});

test("saved file size needs no media request", async () => {
  useEditor.setState({ assets: [{ ...asset, sizeBytes: 21_988_779 }] });
  expect(await runAiTool("get_asset_info", { asset_id: asset.id })).toMatchObject({ sizeBytes: 21_988_779, fileSize: "21 MB" });
});

test("a generated placeholder has no source file", async () => {
  useEditor.setState({ assets: [{ ...asset, block: { label: "Scene", color: "#000000" } }] });
  expect(runAiTool("get_asset_info", { asset_id: asset.id })).rejects.toThrow("no source file");
});
