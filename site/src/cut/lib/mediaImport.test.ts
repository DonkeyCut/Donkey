import { expect, test } from "bun:test";
import { stubModule } from "@/lib/testing/stubModule";
import type { CutBackend } from "./backend";

await stubModule<typeof import("./mediaRead")>("./mediaRead", import.meta.url, {
  probeMediaFile: (async () => ({ hasVideo: false, duration: 1, sizeBytes: 3 })) as never,
});
const { prepareImport } = await import("./media");

// A copy onto this machine is the whole transfer, so it waits for the import
// queue's window; holding it up front would start every file of a drop at once.
test("an import onto this machine has no hold outside the queue's window", async () => {
  const backend = { kind: "engine" } as unknown as CutBackend;
  const file = new File([new Uint8Array(3)], "song.mp3", { type: "audio/mpeg" });
  const pending = await prepareImport("p", file, backend);
  expect(pending).not.toBeNull();
  expect(pending?.hold).toBeUndefined();
});
