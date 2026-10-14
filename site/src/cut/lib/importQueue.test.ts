import { expect, test } from "bun:test";
import { stubModule } from "@/lib/testing/stubModule";
import { ConnectionLostError } from "./network";
import type { PendingImport } from "./media";
import { useEditor } from "./store";
import type { MediaAsset } from "./types";

await stubModule<typeof import("./mediaSync")>("./mediaSync", import.meta.url, {
  storedMediaUrl: async (_projectId: string, fileName: string) => `stored:${fileName}`,
});
const { startUpload } = await import("./importQueue");

const settle = () => new Promise((r) => setTimeout(r, 20));

test("an upload the connection dropped picks back up when the connection returns", async () => {
  const asset: MediaAsset = { id: "take", fileName: "pending:take:take.mov", name: "take.mov", type: "video", duration: 12, url: "blob:take", upload: { progress: 0 } };
  useEditor.setState({ projectId: "p", assets: [asset] });
  let sends = 0;
  const pending: PendingImport = {
    asset,
    localUrl: "blob:take",
    send: async () => {
      sends++;
      if (sends === 1) throw new ConnectionLostError("Upload failed.");
      return "take.mov";
    },
  };
  startUpload("p", pending);
  await settle();
  expect(useEditor.getState().assets[0].upload?.error).toBe("Upload failed.");

  globalThis.dispatchEvent(new Event("online"));
  await settle();
  expect(sends).toBe(2);
  expect(useEditor.getState().assets[0]).toMatchObject({ fileName: "take.mov", url: "stored:take.mov", upload: undefined });
});
