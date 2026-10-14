import { expect, test } from "bun:test";
import { stubModule } from "@/lib/testing/stubModule";
import type { MediaAsset } from "./types";

// The mix itself is the shared fold's to test; what is pinned here is where
// each file's sound is read from.
const resolved: string[] = [];
await stubModule<typeof import("./audioMix")>("./audioMix", import.meta.url, {
  renderMix: async (spec, opts) => {
    for (const c of spec.clips) resolved.push(opts.resolve(c.file));
    return null;
  },
});
const { renderMix } = await import("./cloudTranscribe");

test("a file still uploading is read from the bytes in hand", async () => {
  const uploading: MediaAsset = {
    id: "take",
    fileName: "take.mov",
    name: "take.mov",
    type: "video",
    duration: 12,
    url: "blob:take",
    upload: { progress: 0.4, stored: true },
  };
  await renderMix("p", { duration: 12, clips: [{ file: "take.mov", in: 0, out: 12, muted: false }], audio: [] }, [uploading]);
  expect(resolved).toEqual(["blob:take"]);
});
