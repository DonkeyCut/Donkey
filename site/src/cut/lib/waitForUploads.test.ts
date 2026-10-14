import { expect, test } from "bun:test";
import { stubModule } from "@/lib/testing/stubModule";
import { useEditor } from "./store";
import type { MediaAsset } from "./types";

await stubModule<typeof import("./mediaSync")>("./mediaSync", import.meta.url, {
  storedMediaUrl: async (_projectId: string, fileName: string) => `stored:${fileName}`,
});
const { runAiTool } = await import("./aiTools");
const { startUpload } = await import("./importQueue");

const take = (upload?: MediaAsset["upload"]): MediaAsset => ({
  id: "take",
  fileName: "take.mov",
  name: "take.mov",
  type: "video",
  duration: 12,
  url: upload ? "blob:take" : "stored:take.mov",
  ...(upload ? { upload } : {}),
});

test("waiting on uploads returns once the files land in storage", async () => {
  const uploading = take({ progress: 0.4 });
  useEditor.setState({ projectId: "p", assets: [uploading] });
  let land!: (fileName: string) => void;
  const send = () => new Promise<string>((resolve) => (land = resolve));
  startUpload("p", { asset: uploading, localUrl: "blob:take", send });
  setTimeout(() => land("take.mov"), 50);
  const out = await runAiTool("wait_for_uploads", {});
  expect(out).toEqual({ uploads: [{ assetId: "take", name: "take.mov", status: "done" }] });
});

test("with nothing uploading the wait answers straight away", async () => {
  useEditor.setState({ projectId: "p", assets: [take()] });
  expect(await runAiTool("wait_for_uploads", {})).toMatchObject({ uploads: [] });
});

test("a call turned down for its input says so, offline or not", async () => {
  useEditor.setState({ projectId: "p", assets: [take()] });
  const online = Object.getOwnPropertyDescriptor(globalThis.navigator, "onLine");
  Object.defineProperty(globalThis.navigator, "onLine", { value: false, configurable: true });
  try {
    const error = await runAiTool("listen_audio", { asset_id: "nope" }).then(() => "", (e: Error) => e.message);
    expect(error).toContain("No project asset with id nope");
    expect(error).not.toContain("wait_for_uploads");
  } finally {
    if (online) {
      Object.defineProperty(globalThis.navigator, "onLine", online);
    } else {
      delete (globalThis.navigator as { onLine?: boolean }).onLine;
    }
  }
});
