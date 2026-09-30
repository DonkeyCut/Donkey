import { expect, spyOn, test } from "bun:test";
import { movieHeader } from "./fixtures/movieHeader";
import { probeMediaColor } from "./mediaRead";

test("an import's probe and the lazy fill of the same file share one walk", async () => {
  const file = new File([movieHeader({ primaries: 9, transfer: 16, matrix: 9 }) as BlobPart], "pq.mp4");
  const slices = spyOn(file, "slice");
  const [a, b] = await Promise.all([probeMediaColor(file), probeMediaColor(file)]);
  expect(a).toBe(b);
  expect(a.detected).toBe("pq");
  // The whole file is one block: one read, however many ask.
  expect(slices.mock.calls.length).toBe(1);
});
