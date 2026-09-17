import { expect, test } from "bun:test";
import { boundMedia, runCommandBatch } from "./commandBatch";

test("a batch runs in order and stops at the first failure", async () => {
  const seen: string[] = [];
  const results = await runCommandBatch(
    "p",
    [{ name: "a", input: { n: 1 } }, { name: "b", input: {} }, { name: "c", input: {} }],
    async (name, input) => {
      seen.push(name);
      if (name === "b") throw new Error("b broke");
      return { input };
    }
  );
  expect(seen).toEqual(["a", "b"]);
  expect(results).toEqual([
    { name: "a", ok: true, output: { input: { n: 1 } } },
    { name: "b", ok: false, error: "b broke" },
  ]);
});

test("progress is reported per command and cancellation stops the batch", async () => {
  const fractions: number[] = [];
  let canceled = false;
  await expect(
    runCommandBatch(
      "p",
      [{ name: "a", input: {} }, { name: "b", input: {} }],
      async () => { canceled = true; return null; },
      { isCanceled: () => canceled, onProgress: (f) => fractions.push(f) }
    )
  ).rejects.toThrow("Canceled.");
  expect(fractions).toEqual([0]);
});

test("inline media past the budget is dropped with a note", () => {
  const big = `data:image/png;base64,${"x".repeat(2 * 1024 * 1024)}`;
  const results = [
    { name: "capture_frame", ok: true, output: { image: big } },
    { name: "capture_frame", ok: true, output: { image: big } },
    { name: "watch_video", ok: true, output: { images: [big, "https://cdn/x.png"] } },
  ];
  boundMedia(results);
  expect(results[0].output.image).toBe(big);
  expect(typeof results[1].output.image === "string" && results[1].output.image.startsWith("[dropped")).toBe(true);
  expect(results[2].output.images?.[1]).toBe("https://cdn/x.png");
});
