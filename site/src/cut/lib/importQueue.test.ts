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
      if (sends === 1) throw new ConnectionLostError("upload_failed", "Upload failed.");
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

test("every file of a long drop is held at once while its uploads wait their turn", async () => {
  const ids = ["a", "b", "c", "d", "e", "f"];
  const assets: MediaAsset[] = ids.map((id) => ({ id, fileName: `pending:${id}:${id}.mov`, name: `${id}.mov`, type: "video", duration: 5, url: `blob:${id}`, upload: { progress: 0 } }));
  useEditor.setState({ projectId: "p", assets });
  const held: string[] = [];
  let sending = 0;
  for (const asset of assets) {
    startUpload("p", {
      asset,
      localUrl: asset.url,
      hold: async () => {
        held.push(asset.id);
      },
      send: () => {
        sending++;
        return new Promise<string>(() => {});
      },
    });
  }
  await settle();
  expect(held).toEqual(ids);
  expect(sending).toBe(3);
});
