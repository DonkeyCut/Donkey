import { describe, expect, test } from "bun:test";
import { readCodecs, type CodecProbes } from "./codecSupport";

/** A storage that keeps what it is given, like a browser's localStorage. */
function memoryStorage(): Pick<Storage, "getItem" | "setItem"> {
  const held = new Map<string, string>();
  return { getItem: (k) => held.get(k) ?? null, setItem: (k, v) => void held.set(k, v) };
}

/** Probes that answer `answer` and count how often they ran. */
function probes(answer: { h264: boolean; aac: boolean }, storage = memoryStorage(), agent = "Opera/136") {
  const ran = { h264: 0, aac: 0 };
  const io: CodecProbes = {
    h264: async () => (ran.h264++, answer.h264),
    aac: async () => (ran.aac++, answer.aac),
    storage,
    agent,
  };
  return { io, ran, storage };
}

describe("browser codecs", () => {
  test("probes once and remembers the answer for this browser", async () => {
    const first = probes({ h264: true, aac: false });
    expect(await readCodecs(first.io)).toEqual({ h264: true, aac: false });

    // A later session in the same browser reads the stored answer.
    const later = probes({ h264: true, aac: true }, first.storage);
    expect(await readCodecs(later.io)).toEqual({ h264: true, aac: false });
    expect(later.ran).toEqual({ h264: 0, aac: 0 });
  });

  test("a browser update probes again", async () => {
    const before = probes({ h264: true, aac: false }, memoryStorage(), "Opera/136");
    await readCodecs(before.io);

    const updated = probes({ h264: true, aac: true }, before.storage, "Opera/137");
    expect(await readCodecs(updated.io)).toEqual({ h264: true, aac: true });
    expect(updated.ran).toEqual({ h264: 1, aac: 1 });
  });

  test("no storage still answers", async () => {
    const { io } = probes({ h264: false, aac: true });
    io.storage = null;
    expect(await readCodecs(io)).toEqual({ h264: false, aac: true });
  });
});
