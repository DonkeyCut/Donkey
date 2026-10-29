import { expect, test } from "bun:test";
import { stubModule } from "@/lib/testing/stubModule";
import type { CutBackend } from "./backend";

await stubModule<typeof import("./mediaRead")>("./mediaRead", import.meta.url, {
  probeMediaFile: (async () => ({ hasVideo: false, duration: 1, sizeBytes: 3 })) as never,
});
const { prepareImport } = await import("./media");

// A copy onto this machine is the whole transfer. Each one starts as the
// import does, so a reload finds every file of a drop stored, and they run
// one at a time, so a long drop never swamps the engine socket or the store.
test("imports onto this machine hold their bytes up front, one copy at a time", async () => {
  let running = 0;
  let most = 0;
  const backend = {
    kind: "engine",
    fetch: async () => {
      running++;
      most = Math.max(most, running);
      await new Promise((r) => setTimeout(r, 5));
      running--;
      return new Response(JSON.stringify({ fileName: "song.mp3" }), { status: 200 });
    },
  } as unknown as CutBackend;
  const file = () => new File([new Uint8Array(3)], "song.mp3", { type: "audio/mpeg" });
  const drop = await Promise.all([prepareImport("p", file(), backend), prepareImport("p", file(), backend)]);
  expect(drop.every((pending) => pending?.hold)).toBe(true);

  await Promise.all(drop.map((pending) => pending!.hold!()));
  expect(most).toBe(1);
  expect(await drop[0]!.send()).toBe("song.mp3");
});
