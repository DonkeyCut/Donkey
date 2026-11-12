import { expect, test } from "bun:test";
import { stubModule } from "@/lib/testing/stubModule";
import { ConnectionLostError } from "./network";
import type { PendingImport } from "./media";
import { serializeDoc, useEditor } from "./store";
import type { MediaAsset } from "./types";

await stubModule<typeof import("./mediaSync")>("./mediaSync", import.meta.url, {
  storedMediaUrl: async (_projectId: string, fileName: string) => `stored:${fileName}`,
});
const { startUpload, uploadsSettled } = await import("./importQueue");

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

test("a headless save waits for the project's copies to land, so the clip they carry is saved", async () => {
  // A library clip the worker added: on screen at once, stored only once its
  // copy lands, and missing from the saved document until then.
  const asset: MediaAsset = { id: "dog", fileName: "pending-dog", name: "dog.mp4", type: "video", duration: 7, url: "https://src/dog.mp4", upload: { progress: 0 } };
  useEditor.setState({ projectId: "q", assets: [asset] });
  let land: (name: string) => void = () => {};
  startUpload("q", { asset, localUrl: asset.url, send: () => new Promise<string>((r) => { land = r; }) });
  expect(serializeDoc(useEditor.getState()).assets).toEqual([]);

  let settled = false;
  const waiting = uploadsSettled("q").then(() => { settled = true; });
  await settle();
  expect(settled).toBe(false);
  land("dog.mp4");
  await waiting;
  expect(serializeDoc(useEditor.getState()).assets?.map((a) => a.fileName)).toEqual(["dog.mp4"]);
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
